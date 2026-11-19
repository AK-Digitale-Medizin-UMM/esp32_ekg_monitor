"""Synthetische EKG-Quelle – verhält sich für den Server exakt wie ein echter ESP32.

Das Signal wird aus Gauß-Wellen für P, Q, R, S, T zusammengesetzt (vereinfachtes
McSharry-Modell). Einstellbar sind Herzfrequenz, Rauschen, Netzbrummen und einfache
"Pathologien" – praktisch für Tests und später für das Studentenquiz.
"""
from __future__ import annotations

import asyncio
import math
import random
from dataclasses import dataclass

from ..core.hub import Hub
from ..core.packet import EcgPacket

# (Name, Zeitpunkt relativ zur R-Zacke in s, Amplitude in mV, Breite in s)
WAVES = [
    ("P", -0.20, 0.15, 0.025),
    ("Q", -0.035, -0.12, 0.010),
    ("R", 0.0, 1.20, 0.012),
    ("S", 0.035, -0.25, 0.012),
    ("T", 0.28, 0.30, 0.050),
]


@dataclass
class SyntheticConfig:
    device_id: str = "synthetic-01"
    fs: float = 250.0
    heart_rate_bpm: float = 70.0
    hrv: float = 0.03            # Schwankung der RR-Abstände (Anteil)
    noise_mv: float = 0.02
    mains_hz: float = 50.0       # Netzbrummen, 0 = aus
    mains_mv: float = 0.0
    rhythm: str = "sinus"        # "sinus" | "afib" | "st_elevation" | "av_block_1"
    samples_per_packet: int = 25
    output_unit: str = "mV"      # "mV" oder "adc_raw" (simuliert 12-bit ADC)


class SyntheticEcg:
    def __init__(self, cfg: SyntheticConfig, seed: int | None = None) -> None:
        self.cfg = cfg
        self.rng = random.Random(seed)
        self.t = 0.0
        self.beats: list[float] = [0.3]   # Zeitpunkte der R-Zacken (gleitendes Fenster)

    def _rr(self) -> float:
        base = 60.0 / self.cfg.heart_rate_bpm
        if self.cfg.rhythm == "afib":
            return base * self.rng.uniform(0.6, 1.4)
        return base * (1 + self.rng.gauss(0, self.cfg.hrv))

    def _waves(self):
        for name, dt, amp, w in WAVES:
            if name == "P":
                if self.cfg.rhythm == "afib":
                    continue
                if self.cfg.rhythm == "av_block_1":
                    dt = -0.30          # PQ-Zeit verlängert (> 200 ms)
            yield name, dt, amp, w

    def sample(self) -> float:
        t = self.t
        while self.beats[-1] < t + 1.0:          # Schläge bis 1 s in die Zukunft planen
            self.beats.append(self.beats[-1] + self._rr())
        while len(self.beats) > 1 and self.beats[0] < t - 1.0:
            self.beats.pop(0)
        v = 0.0
        for r in self.beats:
            for name, dt, amp, w in self._waves():
                v += amp * math.exp(-((t - (r + dt)) ** 2) / (2 * w * w))
            if self.cfg.rhythm == "st_elevation":   # ST-Strecke angehoben
                if r + 0.05 < t < r + 0.25:
                    v += 0.2
        if self.cfg.rhythm == "afib":               # Flimmerwellen
            v += 0.05 * math.sin(2 * math.pi * 6.3 * t + self.rng.uniform(0, 0.5))
        v += 0.05 * math.sin(2 * math.pi * 0.25 * t)  # Atmungs-Baseline
        if self.cfg.mains_mv:
            v += self.cfg.mains_mv * math.sin(2 * math.pi * self.cfg.mains_hz * t)
        v += self.rng.gauss(0, self.cfg.noise_mv)
        self.t += 1.0 / self.cfg.fs
        return v

    def packet(self, seq: int) -> EcgPacket:
        cfg = self.cfg
        t0_us = int(self.t * 1e6)
        vals = [self.sample() for _ in range(cfg.samples_per_packet)]
        if cfg.output_unit == "adc_raw":        # 0 mV ≙ 2048, 1 mV ≙ 600 Counts
            vals = [max(0, min(4095, round(2048 + 600 * x))) for x in vals]
        return EcgPacket(device_id=cfg.device_id, seq=seq, fs=cfg.fs, t0_us=t0_us,
                         samples=vals, unit=cfg.output_unit, source="synthetic")


class SyntheticSource:
    """Läuft als Hintergrund-Task und füttert den Hub in Echtzeit."""

    def __init__(self, hub: Hub, cfg: SyntheticConfig) -> None:
        self.hub, self.cfg = hub, cfg
        self.gen = SyntheticEcg(cfg)
        self._task: asyncio.Task | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self) -> None:
        if not self.running:
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        interval = self.cfg.samples_per_packet / self.cfg.fs
        start, seq = loop.time(), 0
        while True:
            await self.hub.publish(self.gen.packet(seq))
            seq += 1
            await asyncio.sleep(max(0.0, start + seq * interval - loop.time()))
