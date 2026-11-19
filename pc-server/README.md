# EKG-Projekt – PC-Server

Alle Befehle unten im Ordner `pc-server/` ausführen (`cd pc-server`).
Der PC-Server ist optional. Die [aktuelle Firmware](../README.md) hostet ihren
eigenen Live-Viewer und sendet keine Pakete an den PC-Server. Das folgende
Schema beschreibt kompatible Sender (z. B. `fake_esp32`) und den PC-Server.

## Architektur

```
 ┌────────────┐   POST /api/v1/ingest      ┌───────────────────────────────┐
 │ ESP32      │──── oder WS /ws/ingest ───▶│            Server             │
 │ (Matteo)   │                            │                               │
 └────────────┘                            │  EcgPacket (einheitl. Format) │
 ┌────────────┐                            │             │                 │
 │ fake_esp32 │──── gleicher Endpunkt ────▶│            Hub ───▶ Recorder  │──▶ data/recordings/*.csv
 └────────────┘                            │             │      (CSV+JSON) │
 ┌────────────┐                            │             ├───▶ (Analyse)   │
 │ Synthetisch│──── intern ───────────────▶│             │                 │
 └────────────┘                            └─────────────┼─────────────────┘
                                                         ▼  WS /ws/live
                                              Browser-Viewer / spätere App
```

**Idee:** Jede Quelle liefert dasselbe `EcgPacket`. Dem Server ist egal, ob die Daten
echt oder synthetisch sind. Neue Quellen (z. B. Replay einer CSV, PhysioNet-Datensätze)
werden einfach als weiteres Modul unter `server/sources/` ergänzt.

```
server/
  core/packet.py      Datenformat + Validierung (reines Python)
  core/hub.py         Verteilung an alle Abnehmer, Paketverlust-Statistik
  core/recorder.py    Aufnahmen als CSV + Metadaten-JSON
  sources/synthetic.py  synthetisches EKG (Sinus, VHF, ST-Hebung, AV-Block I°)
  main.py             HTTP/WebSocket-Endpunkte (FastAPI)
tools/fake_esp32.py   simuliert einen ESP32 von außen
```

## Datenformat (Protokoll v1)

```json
{
  "v": 1,
  "device_id": "esp32-01",
  "seq": 1234,
  "fs": 250,
  "t0_us": 987654321,
  "unit": "adc_raw",
  "adc_bits": 12,
  "lead_off": false,
  "samples": [2048, 2051, 2060, ...]
}
```

| Feld | Bedeutung |
|---|---|
| `seq` | fortlaufende Nummer → der Server erkennt verlorene Pakete |
| `fs` | Abtastrate in Hz (250 Hz reicht für Lehrzwecke, 500 Hz ist klinischer Standard) |
| `t0_us` | `micros()` des ersten Samples – Gerätezeit, damit Jitter im WLAN egal ist |
| `samples` | **gebündelt**, 25 Werte pro Paket = 10 Pakete/s statt 250 Einzelanfragen |

## Endpunkte

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/v1/ingest` | **ESP32 schickt Daten** (ein Paket oder `{"packets":[...]}`) → 202 |
| WS | `/ws/ingest` | wie oben, als Dauerverbindung (effizienter) |
| WS | `/ws/live?device_id=…` | Live-Stream für Browser/App |
| GET | `/api/v1/devices` | aktive Geräte, Paketverluste, online/offline |
| POST | `/api/v1/sources/synthetic/start` | synthetische Quelle starten (`rhythm`, `heart_rate_bpm`, …) |
| POST | `/api/v1/sources/synthetic/{id}/stop` | stoppen |
| POST | `/api/v1/recordings/start` | Aufnahme starten (`device_id`, `label`, `subject`, optional `duration_s` → Server stoppt selbst) |
| POST | `/api/v1/recordings/{device_id}/stop` | Aufnahme beenden |
| GET | `/api/v1/recordings` | Liste aller Aufnahmen |
| GET | `/api/v1/recordings/{id}` | Metadaten einer Aufnahme (läuft sie noch, mit aktuellem `sample_count`) |
| GET | `/api/v1/recordings/{id}/csv` | Aufnahme herunterladen |

Interaktive Doku: `http://localhost:8000/docs`

## Starten

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn server.main:app --host 0.0.0.0 --port 8000 --reload
```

Benötigt **Python ≥ 3.10** (macOS-System-Python 3.9 reicht nicht), z. B. `uv venv --python 3.13 .venv`.

Dann `http://localhost:8000` öffnen → ECG Studio (Ordner `web/`) → „Start synthetic“.

## Web-Oberfläche (`web/`)

Der Server liefert den Ordner `web/` im Repo-Root aus, kennt aber dessen Inhalt nicht –
Oberfläche und Server sprechen nur über die Endpunkte oben. Änderungen in `web/` brauchen
keinen Server-Neustart, nur ein Neuladen im Browser.

```
web/
  index.html, review.html, styles.css
  js/live-client.js   einzige Stelle mit Server-Wissen (REST, WebSocket, Reconnect, ADC→mV)
  js/trace.js         Zeichnen auf EKG-Papier (25/50 mm/s, 10 mm/mV)
  js/monitor.js       Live-Monitor: Quellenauswahl, Live-Kurve, Aufnahme
  js/review.js        Aufnahmen vom Server ansehen
```

- **Anderer Ordner:** `EKG_WEB_DIR=/pfad/zur/ui uvicorn server.main:app …`
- **Oberfläche getrennt ausliefern** (z. B. eigener Dev-Server auf Port 5500):
  `EKG_CORS_ORIGINS=http://localhost:5500 uvicorn server.main:app …` und die Seite mit
  `index.html?server=<host>:8000` öffnen. Ohne `EKG_CORS_ORIGINS` ist CORS aus.
Echten Ingest-Weg ohne Hardware testen (zweites Terminal):

```bash
python -m tools.fake_esp32 --rhythm afib
```

Für Live-Daten direkt vom ESP32 siehe [Firmware-Schnellstart](../README.md).

## Sicherheit

Während Messungen an Personen: ESP32/Arduino **nur mit Akku** betreiben, nicht am
Laptop-Netzteil oder Netzstrom. Das ist ein Lehrprojekt, kein Medizinprodukt.
Bei `subject` Kürzel statt Klarnamen verwenden.
