"""EKG-Datenpaket: das zentrale Austauschformat zwischen Quellen, Server und Clients.

Egal ob die Daten vom ESP32, aus einer Datei oder vom Synthesizer kommen –
alles wird in ein EcgPacket umgewandelt. Dadurch sind die Quellen austauschbar.

JSON-Format (Version 1), das der ESP32 schickt:

{
  "v": 1,                      # Protokollversion
  "device_id": "esp32-01",     # eindeutige Geräte-ID
  "seq": 1234,                 # fortlaufende Paketnummer (Lücken-Erkennung)
  "fs": 250,                   # Abtastrate in Hz
  "t0_us": 987654321,          # Gerätezeit (micros()) des ersten Samples
  "unit": "adc_raw",           # "adc_raw" | "mV"
  "adc_bits": 12,              # nur bei adc_raw relevant
  "lead_off": false,           # Elektrode lose? (AD8232 LO+/LO-)
  "samples": [2048, 2051, ...] # Messwerte, 1 Kanal
}
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict
from typing import Any

PROTOCOL_VERSION = 1
MAX_SAMPLES_PER_PACKET = 1000
ALLOWED_UNITS = {"adc_raw", "mV"}


class PacketError(ValueError):
    """Ungültiges Paket – wird als HTTP 422 an den Sender zurückgegeben."""


@dataclass
class EcgPacket:
    device_id: str
    seq: int
    fs: float
    t0_us: int
    samples: list[float]
    unit: str = "adc_raw"
    adc_bits: int = 12
    lead_off: bool = False
    source: str = "device"          # "device" | "synthetic" | "replay"
    received_at: float = field(default_factory=time.time)  # Serverzeit (Unix, s)
    v: int = PROTOCOL_VERSION

    @classmethod
    def from_dict(cls, d: dict[str, Any], source: str = "device") -> "EcgPacket":
        if not isinstance(d, dict):
            raise PacketError("Paket muss ein JSON-Objekt sein")
        v = d.get("v", PROTOCOL_VERSION)
        if v != PROTOCOL_VERSION:
            raise PacketError(f"Nicht unterstützte Protokollversion: {v}")

        try:
            device_id = str(d["device_id"]).strip()
            seq = int(d["seq"])
            fs = float(d["fs"])
            t0_us = int(d["t0_us"])
            samples = d["samples"]
        except KeyError as e:
            raise PacketError(f"Pflichtfeld fehlt: {e.args[0]}") from None
        except (TypeError, ValueError) as e:
            raise PacketError(f"Ungültiger Feldwert: {e}") from None

        if not device_id or len(device_id) > 64:
            raise PacketError("device_id muss 1–64 Zeichen lang sein")
        if seq < 0:
            raise PacketError("seq muss >= 0 sein")
        if not (1 <= fs <= 10_000):
            raise PacketError("fs muss zwischen 1 und 10000 Hz liegen")
        if not isinstance(samples, list) or not samples:
            raise PacketError("samples muss eine nicht-leere Liste sein")
        if len(samples) > MAX_SAMPLES_PER_PACKET:
            raise PacketError(f"Max. {MAX_SAMPLES_PER_PACKET} Samples pro Paket")
        try:
            samples = [float(x) for x in samples]
        except (TypeError, ValueError):
            raise PacketError("samples darf nur Zahlen enthalten") from None

        unit = str(d.get("unit", "adc_raw"))
        if unit not in ALLOWED_UNITS:
            raise PacketError(f"unit muss eines von {sorted(ALLOWED_UNITS)} sein")

        return cls(
            device_id=device_id, seq=seq, fs=fs, t0_us=t0_us, samples=samples,
            unit=unit, adc_bits=int(d.get("adc_bits", 12)),
            lead_off=bool(d.get("lead_off", False)), source=source,
        )

    @property
    def duration_s(self) -> float:
        return len(self.samples) / self.fs

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
