"""Hub: nimmt Pakete von beliebigen Quellen an und verteilt sie an alle Abnehmer.

Quellen (ESP32, Synthesizer, Replay)  ──publish()──▶  Hub  ──▶  Abonnenten
                                                              (Live-Clients, Recorder,
                                                               später: Analyse-Modul)
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from .packet import EcgPacket

Listener = Callable[[EcgPacket], Awaitable[None] | None]


@dataclass
class DeviceStats:
    device_id: str
    source: str
    fs: float
    packets: int = 0
    samples: int = 0
    lost_packets: int = 0
    last_seq: int | None = None
    last_seen: float = field(default_factory=time.time)
    lead_off: bool = False


class Hub:
    def __init__(self, queue_size: int = 200) -> None:
        self._queues: set[asyncio.Queue[EcgPacket]] = set()
        self._listeners: list[Listener] = []
        self._queue_size = queue_size
        self.devices: dict[str, DeviceStats] = {}

    # --- Eingang -----------------------------------------------------------
    async def publish(self, pkt: EcgPacket) -> None:
        self._update_stats(pkt)
        for fn in list(self._listeners):
            res = fn(pkt)
            if asyncio.iscoroutine(res):
                await res
        for q in list(self._queues):
            if q.full():            # langsamer Client: ältestes Paket verwerfen
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(pkt)

    def _update_stats(self, pkt: EcgPacket) -> None:
        st = self.devices.get(pkt.device_id)
        if st is None:
            st = self.devices[pkt.device_id] = DeviceStats(pkt.device_id, pkt.source, pkt.fs)
        if st.last_seq is not None:
            gap = pkt.seq - st.last_seq - 1
            if gap > 0:
                st.lost_packets += gap
            elif pkt.seq <= st.last_seq and pkt.seq < 5:
                pass                # Gerät neu gestartet – seq beginnt wieder bei 0
        st.last_seq = pkt.seq
        st.packets += 1
        st.samples += len(pkt.samples)
        st.fs = pkt.fs
        st.lead_off = pkt.lead_off
        st.last_seen = time.time()

    # --- Ausgang -----------------------------------------------------------
    def subscribe(self) -> asyncio.Queue[EcgPacket]:
        q: asyncio.Queue[EcgPacket] = asyncio.Queue(maxsize=self._queue_size)
        self._queues.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[EcgPacket]) -> None:
        self._queues.discard(q)

    def add_listener(self, fn: Listener) -> None:
        self._listeners.append(fn)

    @property
    def subscriber_count(self) -> int:
        return len(self._queues)
