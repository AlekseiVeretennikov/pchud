"""
Парковка ядер: Windows усыпляет ядра (например, драйвер AMD 3D V-Cache на время игры
паркует второй CCD). Нагрузка такого ядра 0%, а частота в HWiNFO выглядит обычной,
поэтому без этого статуса спящее ядро не отличить от сбоя датчика.

Источник — счётчик производительности "Processor Information(*)\\Parking Status".
Он добавляется по английскому имени (PdhAddEnglishCounterW), поэтому работает
на Windows с любым языком.
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes

PDH_FMT_LONG = 0x00000100
PDH_MORE_DATA = 0x800007D2
COUNTER = r"\Processor Information(*)\Parking Status"


class _Value(ctypes.Union):
    _fields_ = [("longValue", ctypes.c_long), ("doubleValue", ctypes.c_double),
                ("largeValue", ctypes.c_longlong)]


class _FmtValue(ctypes.Structure):
    _fields_ = [("CStatus", wintypes.DWORD), ("value", _Value)]


class _Item(ctypes.Structure):
    _fields_ = [("szName", wintypes.LPWSTR), ("FmtValue", _FmtValue)]


class CoreParking:
    """Читает статус парковки логических процессоров. Ошибки не роняют HUD: тогда пусто."""

    def __init__(self) -> None:
        self._query = ctypes.c_void_p()
        self._counter = ctypes.c_void_p()
        self._ok = False
        if sys.platform != "win32":
            return
        try:
            pdh = ctypes.WinDLL("pdh")
            self._pdh = pdh
            if pdh.PdhOpenQueryW(None, None, ctypes.byref(self._query)) != 0:
                return
            if pdh.PdhAddEnglishCounterW(self._query, COUNTER, None, ctypes.byref(self._counter)) != 0:
                return
            pdh.PdhCollectQueryData(self._query)
            self._ok = True
        except OSError:
            self._ok = False

    def parked_logical(self) -> dict[int, bool]:
        """{номер логического процессора: припаркован ли он}."""
        if not self._ok:
            return {}
        pdh = self._pdh
        if pdh.PdhCollectQueryData(self._query) != 0:
            return {}
        size, count = wintypes.DWORD(0), wintypes.DWORD(0)
        status = pdh.PdhGetFormattedCounterArrayW(
            self._counter, PDH_FMT_LONG, ctypes.byref(size), ctypes.byref(count), None
        ) & 0xFFFFFFFF
        if status != PDH_MORE_DATA or not size.value:
            return {}
        buffer = ctypes.create_string_buffer(size.value)
        if pdh.PdhGetFormattedCounterArrayW(
            self._counter, PDH_FMT_LONG, ctypes.byref(size), ctypes.byref(count), buffer
        ) != 0:
            return {}
        items = ctypes.cast(buffer, ctypes.POINTER(_Item))
        out: dict[int, bool] = {}
        for i in range(count.value):
            name = items[i].szName or ""
            group, _, index = name.partition(",")   # "0,5" -> группа 0, процессор 5
            if group.isdigit() and index.isdigit():
                out[int(group) * 64 + int(index)] = items[i].FmtValue.value.longValue != 0
        return out

    def parked_cores(self, core_count: int) -> set[int]:
        """Номера физических ядер, у которых припаркованы все логические процессоры.

        Потоки одного ядра Windows нумерует подряд, поэтому ядро = логический // потоков на ядро.
        """
        logical = self.parked_logical()
        if not logical or not core_count or len(logical) % core_count:
            return set()
        threads = len(logical) // core_count
        ordered = sorted(logical)
        return {
            core for core in range(core_count)
            if all(logical[ordered[core * threads + t]] for t in range(threads))
        }
