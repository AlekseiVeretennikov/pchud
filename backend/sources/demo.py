"""
Демо-источник данных.

Генерирует правдоподобные показания, чтобы можно было разрабатывать и
показывать дашборд на любой машине (в т.ч. не-Windows, без HWiNFO/LHM).
Включается автоматически, если реальные источники недоступны, либо
принудительно флагом --demo.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass


@dataclass
class Reading:
    sensor: str
    label: str
    value: float
    unit: str
    kind: str


class DemoSource:
    name = "demo"
    display_name = "Demo (синтетические данные)"

    def available(self) -> bool:
        return True

    @staticmethod
    def _core_load(cid: int, t: float) -> float:
        """Загрузка ядра в момент t: плавный шум + редкие пики.

        Детерминирована по (cid, t) — так можно сгенерировать «прошлое»
        для мгновенного заполнения спарклайнов (см. core_history).
        """
        base = 6 if cid < 8 else 4
        v = base
        v += 4 * math.sin(t / (3.0 + cid * 0.37) + cid * 1.3)
        v += 3 * math.sin(t / (7.5 + cid * 0.21) + cid * 0.7)
        # редкий пик: узкая верхушка длиннопериодного синуса
        s = math.sin(t / (11 + cid % 5) + cid * 2.1)
        if s > 0.92:
            v += 60 * (s - 0.92) / 0.08
        return round(max(0.0, min(100.0, v)), 1)

    def core_history(self, n: int = 60) -> dict[int, list[float]]:
        """История загрузки за последние n секунд — для отладки спарклайнов."""
        now = time.time()
        return {
            cid: [self._core_load(cid, now - (n - 1 - k)) for k in range(n)]
            for cid in range(16)
        }

    def read(self) -> list[Reading]:
        t = time.time()
        wobble = lambda base, amp, period: base + amp * math.sin(t / period)

        readings = [
            Reading("CPU [#0]: AMD Ryzen 9 9950X3D", "CPU Package", round(wobble(49, 6, 3), 1), "°C", "temp"),
            Reading("CPU [#0]: AMD Ryzen 9 9950X3D", "Total CPU Usage", round(max(1, wobble(7, 6, 4)), 1), "%", "usage"),
            Reading("CPU [#0]: AMD Ryzen 9 9950X3D", "Core Clocks", round(wobble(5200, 400, 2)), "MHz", "clock"),
            Reading("CPU [#0]: AMD Ryzen 9 9950X3D", "CPU Package Power", round(wobble(80, 20, 3), 2), "W", "power"),
            # CCD temperatures: CCD1 = 3D V-Cache (cores 1-8), CCD2 = standard (cores 9-16)
            Reading("AMD Ryzen 9 9950X3D", "CCD1 (Tdie)", round(wobble(38, 3, 4), 1), "°C", "temp"),
            Reading("AMD Ryzen 9 9950X3D", "CCD2 (Tdie)", round(wobble(43, 4, 5), 1), "°C", "temp"),
            Reading("Motherboard (Nuvoton NCT6687D)", "System", round(wobble(39, 2, 6), 1), "°C", "temp"),
            Reading("Motherboard (Nuvoton NCT6687D)", "MOS", round(wobble(38, 2, 8), 1), "°C", "temp"),
            Reading("Motherboard (Nuvoton NCT6687D)", "Chipset A", round(wobble(41, 2, 9), 1), "°C", "temp"),
            Reading("AMD Chipset", "Chipset 1 (xHCI)", round(wobble(50, 3, 7), 1), "°C", "temp"),
            Reading("Motherboard (Nuvoton NCT6687D)", "Vcore", round(wobble(1.25, 0.08, 3), 3), "В", "volt"),
            Reading("Motherboard (Nuvoton NCT6687D)", "CPU NB/SoC", round(wobble(1.31, 0.02, 6), 3), "В", "volt"),
            Reading("Motherboard (Nuvoton NCT6687D)", "PUMP SYS1", round(wobble(2850, 100, 5)), "RPM", "fan"),
            Reading("Motherboard (Nuvoton NCT6687D)", "Chipset", round(wobble(41, 2, 9), 1), "°C", "temp"),

            Reading("GPU [#0]: NVIDIA GeForce RTX 5080", "GPU Temperature", round(wobble(33, 4, 5), 1), "°C", "temp"),
            Reading("GPU [#0]: NVIDIA GeForce RTX 5080", "GPU Core Load", round(max(1, wobble(9, 8, 3)), 1), "%", "usage"),
            Reading("GPU [#0]: NVIDIA GeForce RTX 5080", "GPU Core Clock", round(wobble(2535, 200, 2)), "MHz", "clock"),
            Reading("GPU [#0]: NVIDIA GeForce RTX 5080", "GPU Power", round(wobble(70, 15, 4), 2), "W", "power"),
            Reading("GPU [#0]: NVIDIA GeForce RTX 5080", "GPU Memory Usage", round(wobble(15, 5, 6), 1), "%", "usage"),
            Reading("GPU [#0]: NVIDIA GeForce RTX 5080", "GPU Memory Used", round(wobble(2.4, 0.5, 6), 1), "GB", "data"),
            Reading("GPU [#0]: NVIDIA GeForce RTX 5080", "GPU Hot Spot Temperature", round(wobble(43, 5, 5), 1), "°C", "temp"),
            Reading("GPU [#0]: NVIDIA GeForce RTX 5080", "GPU Fan1", round(wobble(1100, 150, 4)), "RPM", "fan"),
            Reading("GPU [#0]: NVIDIA GeForce RTX 5080", "GPU Fan2", round(wobble(1080, 150, 5)), "RPM", "fan"),
            Reading("GPU [#0]: NVIDIA GeForce RTX 5080", "GPU Fan3", round(wobble(1090, 150, 6)), "RPM", "fan"),
            Reading("GPU [#0]: NVIDIA GeForce RTX 5080", "Частота памяти ГП", round(wobble(1400, 1300, 6)), "МГц", "clock"),
            Reading("GPU [#0]: NVIDIA GeForce RTX 5080", "Нагрузка контроллера памяти ГП", round(max(0, wobble(14, 10, 4)), 1), "%", "usage"),
            Reading("GPU [#0]: NVIDIA GeForce RTX 5080", "Нагрузка на шину ГП", round(max(0, wobble(30, 25, 5)), 1), "%", "usage"),
            Reading("GPU [#0]: NVIDIA GeForce RTX 5080", "Скорость соединения PCIe", 16.0, "GT/s", "other"),

            Reading("DDR5 DIMM [#1]: Demo DDR5 (CHANNEL A)", "SPD Hub Температура", round(wobble(38, 3, 6), 1), "°C", "temp"),
            Reading("DDR5 DIMM [#3]: Demo DDR5 (CHANNEL B)", "SPD Hub Температура", round(wobble(36, 3, 7), 1), "°C", "temp"),

            Reading("Memory", "Memory Usage", round(wobble(46, 4, 7), 1), "%", "usage"),
            Reading("Memory", "Used Memory", round(wobble(14.1, 1, 7), 1), "GB", "data"),
            Reading("Memory", "Available Memory", round(wobble(16.9, 1, 7), 1), "GB", "data"),

            Reading("Frames", "FPS", round(max(0, wobble(120, 40, 2))), "FPS", "other"),

            # Диски и сеть — для панелей "Накопители" и "Сеть"
            Reading("S.M.A.R.T.: Demo NVMe 1TB (0000) [C:]", "Температура диска",
                    round(wobble(44, 4, 5), 1), "°C", "temp"),
            Reading("S.M.A.R.T.: Demo NVMe 2TB (0001) [Z:]", "Температура диска",
                    round(wobble(33, 3, 7), 1), "°C", "temp"),
            Reading("Сеть: Demo Ethernet - Ethernet", "Текущая скорость скачивания",
                    round(max(0, wobble(1500, 1200, 5)), 1), "KB/s", "other"),
            Reading("Сеть: Demo Ethernet - Ethernet", "Текущая скорость отправки",
                    round(max(0, wobble(300, 250, 4)), 1), "KB/s", "other"),
            Reading("Сеть: Demo Ethernet - Ethernet", "Всего скачано", 102400.0, "МБ", "other"),
        ]

        # Per-core data: CCD1 cores 1-8 (max ~5550), CCD2 cores 9-16 (max ~5725)
        for i in range(1, 17):
            base_clk = 5500 if i <= 8 else 5700
            clk = round(wobble(base_clk, 180, 2.0 + i * 0.27))
            readings.append(Reading("AMD Ryzen 9 9950X3D", f"Core #{i}", clk, "MHz", "clock"))
        for i in range(1, 17):
            load = self._core_load(i - 1, t)
            readings.append(Reading("AMD Ryzen 9 9950X3D", f"CPU Core #{i}", load, "%", "usage"))
        # Per-core temps (HWiNFO style, 0-based): CCD1 ~40°C, CCD2 ~47°C
        for i in range(16):
            base_temp = 40 if i < 8 else 47
            temp = round(wobble(base_temp, 3, 4.0 + i * 0.3), 1)
            readings.append(Reading("AMD Ryzen 9 9950X3D", f"Core {i}", temp, "°C", "temp"))

        return readings
