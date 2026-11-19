"""EKG-Server – HTTP/WebSocket-Schicht (FastAPI).

Start:  uvicorn server.main:app --host 0.0.0.0 --port 8000 --reload
Doku:   http://localhost:8000/docs   (automatisch generiert, zum Ausprobieren)
Viewer: http://localhost:8000/
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
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

STATIC = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC / "index.html")


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
    try:
        while True:
            pkt = await q.get()
            if device_id and pkt.device_id != device_id:
                continue
            await ws.send_json(pkt.to_dict())
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
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
def synthetic_start(cfg: SyntheticStart):
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


@app.post("/api/v1/recordings/start", status_code=201)
def recording_start(body: RecordingStart):
    try:
        rec = recorder.start(body.device_id, body.label, body.subject)
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
