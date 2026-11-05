"""
Источник данных: AIDA64 Shared Memory.

AIDA64 публикует показания датчиков в именованную область памяти Windows
в виде XML-строки. Чтобы это заработало, нужно включить в AIDA64:
  File → Preferences → Hardware Monitoring → Enable external applications
  to access sensor values via shared memory

Формат: XML без корневого элемента, типы элементов:
  <temp> <pwr> <fan> <volt> <curr> <duty> — датчики по типу
  <sys>  — агрегированные показатели (нагрузка ЦП/ГП, частоты, RAM, VRAM)

Каждый элемент содержит <id>, <label>, <value>.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass

MAPPING_NAME = "AIDA64_SensorValues"

# Тег XML → (kind, unit)
_TAG_KIND: dict[str, tuple[str | None, str]] = {
    "temp":  ("temp",  "°C"),
    "volt":  (None,    "V"),
    "curr":  (None,    "A"),
    "power": ("power", "W"),
    "pwr":   ("power", "W"),
    "fan":   (None,    "RPM"),
    "duty":  ("duty",  "%"),   # скважность вентилятора; duty ≠ usage
    "clk":   ("clock", "MHz"),
    "freq":  ("clock", "MHz"),
    "load":  ("usage", "%"),
}

# <sys> элементы с фиксированными id → (sensor, label, kind, unit)
_SYS_STATIC: dict[str, tuple] = {
    "SCPUCLK":    ("CPU",    "CPU Clock",        "clock", "MHz"),
    "SCPUUTI":    ("CPU",    "CPU Utilization",  "usage", "%"),
    "SGPU1CLK":   ("GPU",    "GPU Core Clock",   "clock", "MHz"),
    "SGPU1UTI":   ("GPU",    "GPU Core Load",    "usage", "%"),
    "SMEMUTI":    ("Memory", "Memory Usage",     "usage", "%"),
    "SUSEDMEM":   ("Memory", "Used Memory",      None,    "GB"),  # MB→GB
    "SFREEMEM":   ("Memory", "Available Memory", None,    "GB"),  # MB→GB
    "SVMEMUSAGE": ("GPU",    "Memory Usage",     "usage", "%"),
    "SUSEDVMEM":  ("GPU",    "Memory Used",      None,    "GB"),  # MB→GB
}
_SYS_MB_TO_GB = frozenset({"SUSEDMEM", "SFREEMEM", "SUSEDVMEM"})

# Шаблоны для per-core данных в <sys>
_RE_CORE_CLK   = re.compile(r"SCC-1-(\d+)")     # SCC-1-N → Core #N Clock (1-based)
_RE_THREAD_UTI = re.compile(r"SCPU(\d+)UTI")    # SCPU{N}UTI → per-logical-processor load


class _MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress",       ctypes.c_void_p),
        ("AllocationBase",    ctypes.c_void_p),
        ("AllocationProtect", wt.DWORD),
        ("PartitionId",       wt.WORD),
        ("RegionSize",        ctypes.c_size_t),
        ("State",             wt.DWORD),
        ("Protect",           wt.DWORD),
        ("Type",              wt.DWORD),
    ]


def _setup_k32(k32) -> None:
    k32.OpenFileMappingW.restype  = wt.HANDLE
    k32.OpenFileMappingW.argtypes = [wt.DWORD, wt.BOOL, wt.LPCWSTR]
    k32.MapViewOfFile.restype     = ctypes.c_void_p
    k32.MapViewOfFile.argtypes    = [wt.HANDLE, wt.DWORD, wt.DWORD, wt.DWORD, ctypes.c_size_t]
    k32.UnmapViewOfFile.restype   = wt.BOOL
    k32.UnmapViewOfFile.argtypes  = [ctypes.c_void_p]
    k32.CloseHandle.argtypes      = [wt.HANDLE]
    k32.VirtualQuery.restype      = ctypes.c_size_t
    k32.VirtualQuery.argtypes     = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]


@dataclass
class Reading:
    sensor: str
    label:  str
    value:  float
    unit:   str
    kind:   str | None


class Aida64Source:
    name = "aida64"
    display_name = "AIDA64 Shared Memory"

    def available(self) -> bool:
        if sys.platform != "win32":
            return False
        try:
            k32 = ctypes.windll.kernel32
            _setup_k32(k32)
            h = k32.OpenFileMappingW(0x0004, False, MAPPING_NAME)
            if h:
                k32.CloseHandle(h)
                return True
        except Exception:
            pass
        return False

    def read(self) -> list:
        if sys.platform != "win32":
            return []
        try:
            return self._read_shm()
        except Exception:
            return []

    def _read_shm(self) -> list:
        k32 = ctypes.windll.kernel32
        _setup_k32(k32)

        h = k32.OpenFileMappingW(0x0004, False, MAPPING_NAME)
        if not h:
            return []
        try:
            view = k32.MapViewOfFile(h, 0x0004, 0, 0, 0)
            if not view:
                return []
            try:
                mbi = _MEMORY_BASIC_INFORMATION()
                k32.VirtualQuery(ctypes.c_void_p(view), ctypes.byref(mbi), ctypes.sizeof(mbi))
                raw = ctypes.string_at(view, int(mbi.RegionSize))
                end = raw.find(b"\x00")
                xml_str = raw[:end].decode("utf-8", errors="replace") if end >= 0 else raw.decode("utf-8", errors="replace")
            finally:
                k32.UnmapViewOfFile(view)
        finally:
            k32.CloseHandle(h)

        return self._parse(xml_str)

    def _parse(self, xml_str: str) -> list:
        if not xml_str.strip():
            return []
        try:
            # AIDA64 не добавляет корневой элемент — оборачиваем сами
            root = ET.fromstring(f"<r>{xml_str}</r>")
        except ET.ParseError:
            return []

        readings: list[Reading] = []

        # Первый проход: типизированные датчики (temp, pwr, volt, ...)
        for elem in root:
            tag = elem.tag.lower()
            if tag == "sys":
                continue
            kind, unit = _TAG_KIND.get(tag, (None, ""))
            label_el = elem.find("label")
            value_el = elem.find("value")
            if label_el is None or value_el is None:
                continue
            label = (label_el.text or "").strip()
            try:
                value = float(value_el.text or "0")
            except ValueError:
                continue
            ll = label.lower()
            if any(w in ll for w in ("cpu", "processor", "package", "ccd", "tdie", "tctl")):
                sensor = "CPU"
            elif any(w in ll for w in ("gpu", "vga", "video card", "graphics")):
                sensor = "GPU"
            elif "memory" in ll or " ram" in ll:
                sensor = "Memory"
            else:
                sensor = ""
            readings.append(Reading(sensor, label, value, unit, kind))

        # Второй проход: <sys> — сначала статические агрегаты, потом per-core
        for elem in root:
            if elem.tag.lower() != "sys":
                continue
            id_ = (elem.findtext("id") or "").strip()
            value_str = (elem.findtext("value") or "").strip()
            try:
                value = float(value_str.replace(",", "."))
            except ValueError:
                continue

            # Статические агрегированные показатели
            entry = _SYS_STATIC.get(id_)
            if entry:
                sensor, label, kind, unit = entry
                if id_ in _SYS_MB_TO_GB:
                    value = round(value / 1024, 2)
                readings.append(Reading(sensor, label, value, unit, kind))
                continue

            # Per-core часоты: SCC-1-N (N = 1-based номер ядра)
            m = _RE_CORE_CLK.fullmatch(id_)
            if m:
                readings.append(Reading("CPU", f"Core #{m.group(1)}", value, "MHz", "clock"))
                continue

            # Per-thread нагрузка: SCPU{N}UTI (N = 1-based логический процессор)
            m = _RE_THREAD_UTI.fullmatch(id_)
            if m:
                readings.append(Reading("CPU", f"CPU Core #{m.group(1)}", value, "%", "usage"))

        return readings
