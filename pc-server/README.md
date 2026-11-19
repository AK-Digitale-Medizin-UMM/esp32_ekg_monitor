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

ESP32: siehe Abschnitt „Firmware (ESP-IDF)“ unten.

## Firmware (ESP-IDF)

Die Sender-Firmware liegt im Repo-Root unter `main/main.c` (ESP-IDF v6.1, Target `esp32`).
Umgebung und Build-Regeln: siehe Projekt-Anleitung „ESP32 firmware – instructions for coding agents“.

```bash
# im Repo-Root, mit geladener Umgebung (direnv / use flake ../esp32-dev)
idf.py menuconfig      # → "EKG Sender": WLAN, Server-URL, Pins, Testsignal
idf.py build flash monitor
# ohne direnv:
nix develop ../esp32-dev -c idf.py build
```

- **Server-URL:** IP des Laptops, auf dem der Server läuft, z. B. `http://192.168.0.10:8000/api/v1/ingest`
  (Laptop-IP: `ipconfig` / `ip a`; ESP32 und Laptop müssen im selben WLAN sein).
- **WLAN-Zugangsdaten** nur lokal in `menuconfig` setzen – sie landen in der gitignorierten
  `sdkconfig`. Nicht in `sdkconfig.defaults` übernehmen.
- **Ohne Elektroden:** „Eingebautes Testsignal statt ADC verwenden“ aktivieren.
- **Pins (Standard):** AD8232 OUTPUT → GPIO 34, LO+ → GPIO 32, LO- → GPIO 33.
- Abtastung per `esp_timer` (250 Hz), Senden in eigenem Task. Hängt das Netz, werden Pakete
  verworfen statt die Abtastung zu blockieren – der Server sieht das als Lücke in `seq`.
- Komponenten: `esp_wifi`, `esp_netif`, `esp_event`, `nvs_flash`, `esp_http_client`, `esp_adc`,
  `esp_timer`, `esp_driver_gpio` (v6: nicht mehr das alte `driver`). Kein cJSON nötig.

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
