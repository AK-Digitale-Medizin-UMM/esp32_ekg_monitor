"""Simuliert einen ESP32 von außen: schickt synthetische Pakete per HTTP an /api/v1/ingest.

Nutzt nur die Standardbibliothek. Damit testet ihr den echten Ingest-Weg,
bevor die Hardware fertig ist.

    python -m tools.fake_esp32 --url http://localhost:8000 --rhythm afib
"""
import argparse
import json
import time
import urllib.request

from server.sources.synthetic import SyntheticConfig, SyntheticEcg


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--device-id", default="fake-esp32")
    ap.add_argument("--rhythm", default="sinus")
    ap.add_argument("--hr", type=float, default=72)
    args = ap.parse_args()

    cfg = SyntheticConfig(device_id=args.device_id, rhythm=args.rhythm,
                          heart_rate_bpm=args.hr, output_unit="adc_raw")
    gen = SyntheticEcg(cfg)
    interval = cfg.samples_per_packet / cfg.fs
    seq, start = 0, time.monotonic()
    while True:
        pkt = gen.packet(seq).to_dict()
        body = {k: pkt[k] for k in ("v", "device_id", "seq", "fs", "t0_us", "unit", "adc_bits", "lead_off", "samples")}
        req = urllib.request.Request(f"{args.url}/api/v1/ingest", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            urllib.request.urlopen(req, timeout=1).read()
        except Exception as e:
            print("Fehler:", e)
        seq += 1
        time.sleep(max(0.0, start + seq * interval - time.monotonic()))


if __name__ == "__main__":
    main()
