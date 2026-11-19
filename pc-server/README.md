# EKG-Projekt – PC-Server

Alle Befehle unten im Ordner `pc-server/` ausführen (`cd pc-server`).
Der bestehende ESP-IDF-Code (`main/`) und die Web-Oberfläche (`web/`) bleiben davon unberührt.

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
  static/index.html   Mini-Live-Viewer zum Testen
esp32-arduino-sender/ Arduino-Sketch (Referenz für den ESP32-Sender)
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
| POST | `/api/v1/recordings/start` | Aufnahme starten (`device_id`, `label`, `subject`) |
| POST | `/api/v1/recordings/{device_id}/stop` | Aufnahme beenden |
| GET | `/api/v1/recordings` | Liste aller Aufnahmen |
| GET | `/api/v1/recordings/{id}/csv` | Aufnahme herunterladen |

Interaktive Doku: `http://localhost:8000/docs`

## Starten

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn server.main:app --host 0.0.0.0 --port 8000 --reload
```

Dann `http://localhost:8000` öffnen → „Synthetisch starten“.
Echten Ingest-Weg ohne Hardware testen (zweites Terminal):

```bash
python -m tools.fake_esp32 --rhythm afib
```

ESP32: in `esp32-arduino-sender/ekg_sender/ekg_sender.ino` WLAN und `SERVER_URL` (IP des Laptops) eintragen.

## Hinweis zur Firmware

Der Sketch ist mit dem Arduino-Framework geschrieben, das Repo nutzt ESP-IDF (`main/main.c`).
Er dient als Referenz für das Protokoll; in ESP-IDF geht dasselbe mit `esp_http_client`.

## Server auf dem ESP32?

Möglich, aber ich würde es in zwei Stufen machen:

1. **Jetzt:** Server läuft auf dem Laptop, der ESP32 ist nur Sender. Einfach zu debuggen,
   Speicherplatz und Analyse sind kein Problem.
2. **Später:** Der ESP32 bekommt einen schlanken Webserver (z. B. `ESPAsyncWebServer`),
   der **dieselben Pfade und dasselbe JSON** bereitstellt (`/ws/live`, `/api/v1/devices`).
   Dann kann die App ohne Änderung direkt mit dem ESP32 reden (z. B. ESP32 als eigener
   WLAN-Access-Point). Aufnahmen speichert dann die App, nicht der ESP32 (wenig Flash/RAM).

Weil das Protokoll festgelegt ist, ist dieser Umzug später kein Umbau.

## Sicherheit

Während Messungen an Personen: ESP32/Arduino **nur mit Akku** betreiben, nicht am
Laptop-Netzteil oder Netzstrom. Das ist ein Lehrprojekt, kein Medizinprodukt.
Bei `subject` Kürzel statt Klarnamen verwenden.
