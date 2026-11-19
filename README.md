# ESP32 ECG Monitor

The classic ESP32 hosts its own Wi-Fi, live single-lead viewer, and API.
No router, internet, or laptop server is required.

## Run on the board

1. From the repository root with ESP-IDF v6.1 loaded, run `idf.py menuconfig`.
   Under **EKG Monitor**, enable **Eingebautes Testsignal statt ADC verwenden**.
   It is on for new configurations; existing local configurations may still have it off.
2. Run `idf.py build flash monitor` (add `-p PORT` before `build` if needed).
3. Join **ECG-Monitor** on a laptop or phone. The hotspot is open, has no
   internet, and accepts up to three Wi-Fi devices at a time. Stay connected if your
   client warns about no internet. Set IPv4 to automatic (DHCP) if you
   previously configured a static address for this hotspot.
4. Open **http://192.168.4.1/**. Expect a live trace labeled **Test signal**
   at the configured sample rate (250 Hz by default). To check reconnection,
   disconnect from the hotspot and rejoin; the viewer should resume.
   To check multiple clients, join from a second device and open the same URL
   while the first device is still streaming.

Use this open network only with synthetic or bench signals, not a person's
ECG. For bench ADC input, disable the test signal in menuconfig. Default AD8232
connections: OUTPUT → GPIO34, LO+ → GPIO32, LO− → GPIO33, 3V3 → 3V3, GND → GND.
This is not a medical device.

## Local API

| Endpoint | Purpose |
| --- | --- |
| `GET /` | Embedded live viewer, with no external assets |
| `GET /api/v1/devices` | Single device and stream counters |
| `ws://192.168.4.1/ws/live` | One protocol-v1 JSON ECG packet per text frame; optional `?device_id=esp32-01` filter |

The live stream is not recorded or replayed. Under network backpressure the
firmware keeps the newest waiting packet; clients can detect gaps via `seq`.
The [optional PC server](pc-server/README.md) remains available for simulated
ingest, recording, and review. The current firmware does not send samples to it.
