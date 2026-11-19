"""Recorder: schreibt Pakete eines Geräts strukturiert auf die Platte.

Pro Aufnahme entstehen zwei Dateien in data/recordings/:
  <id>.csv        – eine Zeile pro Sample: sample_index, t_s, value, lead_off, seq
  <id>.meta.json  – Metadaten (Gerät, fs, Einheit, Start/Ende, Proband, Notiz, Verluste)
CSV lässt sich direkt in Python/Excel/MATLAB öffnen und später in der App wiederverwenden.
"""
from __future__ import annotations

import csv
import json
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path

from .packet import EcgPacket


@dataclass
class Recording:
    id: str
    device_id: str
    label: str = ""
    subject: str = ""
    started_at: float = field(default_factory=time.time)
    stopped_at: float | None = None
    fs: float | None = None
    unit: str | None = None
    adc_bits: int | None = None
    sample_count: int = 0
    lost_packets: int = 0
    _last_seq: int | None = None


class Recorder:
    def __init__(self, base_dir: str | Path = "data/recordings") -> None:
        self.base = Path(base_dir)
        self.base.mkdir(parents=True, exist_ok=True)
        self._active: dict[str, tuple[Recording, object, csv.writer]] = {}  # device_id → …

    def start(self, device_id: str, label: str = "", subject: str = "") -> Recording:
        if device_id in self._active:
            raise ValueError(f"Für {device_id} läuft bereits eine Aufnahme")
        rid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        rec = Recording(id=rid, device_id=device_id, label=label, subject=subject)
        fh = open(self.base / f"{rid}.csv", "w", newline="")
        w = csv.writer(fh)
        w.writerow(["sample_index", "t_s", "value", "lead_off", "seq"])
        self._active[device_id] = (rec, fh, w)
        self._write_meta(rec)
        return rec

    def stop(self, device_id: str) -> Recording:
        if device_id not in self._active:
            raise ValueError(f"Keine aktive Aufnahme für {device_id}")
        rec, fh, _ = self._active.pop(device_id)
        fh.close()
        rec.stopped_at = time.time()
        self._write_meta(rec)
        return rec

    def on_packet(self, pkt: EcgPacket) -> None:
        """Wird vom Hub für jedes Paket aufgerufen."""
        entry = self._active.get(pkt.device_id)
        if entry is None:
            return
        rec, fh, w = entry
        if rec.fs is None:
            rec.fs, rec.unit, rec.adc_bits = pkt.fs, pkt.unit, pkt.adc_bits
        if rec._last_seq is not None and pkt.seq > rec._last_seq + 1:
            rec.lost_packets += pkt.seq - rec._last_seq - 1
        rec._last_seq = pkt.seq
        for x in pkt.samples:
            i = rec.sample_count
            w.writerow([i, f"{i / rec.fs:.4f}", x, int(pkt.lead_off), pkt.seq])
            rec.sample_count += 1
        fh.flush()

    def active(self) -> list[Recording]:
        return [r for r, _, _ in self._active.values()]

    def list_recordings(self) -> list[dict]:
        out = []
        for p in sorted(self.base.glob("*.meta.json"), reverse=True):
            out.append(json.loads(p.read_text()))
        return out

    def csv_path(self, rid: str) -> Path | None:
        p = self.base / f"{Path(rid).name}.csv"
        return p if p.exists() else None

    def _write_meta(self, rec: Recording) -> None:
        meta = {k: v for k, v in asdict(rec).items() if not k.startswith("_")}
        meta["duration_s"] = rec.sample_count / rec.fs if rec.fs else 0
        (self.base / f"{rec.id}.meta.json").write_text(json.dumps(meta, indent=2))
