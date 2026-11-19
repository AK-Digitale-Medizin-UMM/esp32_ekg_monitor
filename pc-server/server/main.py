"""EKG-Server – HTTP/WebSocket-Schicht (FastAPI).

Start:  uvicorn server.main:app --host 0.0.0.0 --port 8000 --reload
Doku:   http://localhost:8000/docs   (automatisch generiert, zum Ausprobieren)
Web-UI: http://localhost:8000/        (Ordner web/ im Repo-Root, siehe EKG_WEB_DIR)

Umgebungsvariablen:
  EKG_WEB_DIR       Ordner der Web-Oberfläche (Standard: <repo>/web)
  EKG_CORS_ORIGINS  kommagetrennte Origins, die die API von außen nutzen dürfen,
                    z. B. "http://localhost:5500" – nur nötig, wenn die Oberfläche
                    von einem anderen Server ausgeliefert wird. Standard: aus.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .core.hub import Hub
from .core.packet import EcgPacket, PacketError
from .core.recorder import Recorder
from .sources.synthetic import SyntheticConfig, SyntheticSource

app = FastAPI(title="EKG-Server", version="0.1.0")
hub = Hub()
recorder = Recorder(Path(__file__).resolve().parent.parent / "data" / "recordings")
hub.add_listener(recorder.on_packet)
synthetic: dict[str, SyntheticSource] = {}

WEB_DIR = Path(os.environ.get("EKG_WEB_DIR") or Path(__file__).resolve().parents[2] / "web")

if origins := [o.strip() for o in os.environ.get("EKG_CORS_ORIGINS", "").split(",") if o.strip()]:
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["*"], allow_headers=["*"])


@app.get("/api/v1/health")
def health():
    return {"status": "ok", "time": time.time(), "live_clients": hub.subscriber_count}


# ---------------------------------------------------------------- Ingest (ESP32 → Server)
@app.post("/api/v1/ingest", status_code=202)
async def ingest_http(body: dict):
    """Ein Paket (oder eine Liste von Paketen) per HTTP POST einliefern.

    Einfachste Variante für den ESP32: alle ~100 ms ein Paket mit 25 Samples.
    """
    items = body.get("packets") if "packets" in body else [body]
    accepted = 0
    for raw in items:
        try:
            pkt = EcgPacket.from_dict(raw)
        except PacketError as e:
            raise HTTPException(422, detail=f"Paket {accepted}: {e}")
        await hub.publish(pkt)
        accepted += 1
    return {"accepted": accepted}


@app.websocket("/ws/ingest")
async def ingest_ws(ws: WebSocket):
    """Dauerverbindung für den ESP32 – weniger Overhead als HTTP, für höhere Raten.

    Jede Text-Nachricht = ein Paket (JSON wie bei /api/v1/ingest).
    Bei Fehlern antwortet der Server mit {"error": "..."} und hält die Verbindung offen.
    """
    await ws.accept()
    try:
        while True:
            msg = await ws.receive_text()
            try:
                await hub.publish(EcgPacket.from_dict(json.loads(msg)))
            except (PacketError, json.JSONDecodeError) as e:
                await ws.send_json({"error": str(e)})
    except WebSocketDisconnect:
        pass


# ---------------------------------------------------------------- Live (Server → App/Browser)
@app.websocket("/ws/live")
async def live(ws: WebSocket, device_id: str | None = None):
    """Live-Stream für Clients (Browser, App). Optional nach Gerät filtern: /ws/live?device_id=esp32-01"""
    await ws.accept()
    q = hub.subscribe()

    async def forward() -> None:
        while True:
            pkt = await q.get()
            if device_id and pkt.device_id != device_id:
                continue
            await ws.send_json(pkt.to_dict())

    async def until_closed() -> None:
        # Ohne eigenes receive() würde ein Client ohne neue Pakete nie als getrennt erkannt –
        # dann hängt auch das Beenden/Neuladen des Servers ("Waiting for background tasks").
        while (await ws.receive())["type"] != "websocket.disconnect":
            pass

    tasks = {asyncio.create_task(forward()), asyncio.create_task(until_closed())}
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        hub.unsubscribe(q)


@app.get("/api/v1/devices")
def devices():
    now = time.time()
    return [{**asdict(s), "online": now - s.last_seen < 3} for s in hub.devices.values()]


# ---------------------------------------------------------------- Synthetische Quelle
class SyntheticStart(BaseModel):
    device_id: str = "synthetic-01"
    fs: float = Field(250, ge=50, le=2000)
    heart_rate_bpm: float = Field(70, ge=20, le=250)
    noise_mv: float = Field(0.02, ge=0, le=1)
    mains_mv: float = Field(0.0, ge=0, le=1)
    rhythm: str = Field("sinus", pattern="^(sinus|afib|st_elevation|av_block_1)$")
    output_unit: str = Field("mV", pattern="^(mV|adc_raw)$")


@app.post("/api/v1/sources/synthetic/start")
async def synthetic_start(cfg: SyntheticStart):
    if cfg.device_id in synthetic and synthetic[cfg.device_id].running:
        raise HTTPException(409, "Läuft bereits")
    src = SyntheticSource(hub, SyntheticConfig(**cfg.model_dump()))
    src.start()
    synthetic[cfg.device_id] = src
    return {"started": cfg.device_id}


@app.post("/api/v1/sources/synthetic/{device_id}/stop")
async def synthetic_stop(device_id: str):
    src = synthetic.pop(device_id, None)
    if not src:
        raise HTTPException(404, "Keine solche Quelle")
    await src.stop()
    return {"stopped": device_id}


# ---------------------------------------------------------------- Aufnahmen
class RecordingStart(BaseModel):
    device_id: str
    label: str = ""
    subject: str = ""   # z. B. Proband-Kürzel – bitte keine Klarnamen speichern
    duration_s: float | None = Field(None, gt=0, le=3600)  # gesetzt → Server stoppt selbst


@app.post("/api/v1/recordings/start", status_code=201)
def recording_start(body: RecordingStart):
    try:
        rec = recorder.start(body.device_id, body.label, body.subject, body.duration_s)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"id": rec.id, "device_id": rec.device_id}


@app.post("/api/v1/recordings/{device_id}/stop")
def recording_stop(device_id: str):
    try:
        rec = recorder.stop(device_id)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"id": rec.id, "samples": rec.sample_count, "lost_packets": rec.lost_packets}


@app.get("/api/v1/recordings")
def recordings():
    return recorder.list_recordings()


@app.get("/api/v1/recordings/{rid}")
def recording_meta(rid: str):
    """Metadaten einer Aufnahme; bei laufenden Aufnahmen mit aktuellem sample_count."""
    meta = recorder.get(rid)
    if not meta:
        raise HTTPException(404, "Nicht gefunden")
    return meta


@app.get("/api/v1/recordings/{rid}/csv")
def recording_csv(rid: str):
    p = recorder.csv_path(rid)
    if not p:
        raise HTTPException(404, "Nicht gefunden")
    return FileResponse(p, media_type="text/csv", filename=p.name)


@app.on_event("shutdown")
async def _shutdown():
    for src in list(synthetic.values()):
        await src.stop()
    for rec in recorder.active():
        recorder.stop(rec.device_id)


# ---------------------------------------------------------------- Web-Oberfläche
# Zuletzt eingehängt, damit API- und WebSocket-Routen Vorrang haben.
if (WEB_DIR / "index.html").exists():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
else:
    @app.get("/", include_in_schema=False, response_class=HTMLResponse)
    def index():
        return (f"<p>Keine Web-Oberfläche gefunden unter <code>{WEB_DIR}</code>. "
                "Pfad per <code>EKG_WEB_DIR</code> setzen. API: <a href='/docs'>/docs</a></p>")
