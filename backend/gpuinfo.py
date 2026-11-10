"""
Объём видеопамяти из реестра Windows — запасной путь, когда HWiNFO его не публикует
(у Radeon нет ни «доступной», ни полной памяти, только занятая D3D).

Драйвер видеокарты пишет размер памяти в ключ своего класса устройств:
  HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-…}\\0000 …
  HardwareInformation.qwMemorySize  (QWORD, современные драйверы)
  HardwareInformation.MemorySize    (DWORD/бинарное, старые; не больше 4 ГБ)
Читается без прав администратора. Берём самую большую карту — это дискретная.
"""

from __future__ import annotations

import sys

_DISPLAY_CLASS = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
_cache: float | None | bool = False   # False — ещё не читали


def _as_int(value) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, (bytes, bytearray)):
        return int.from_bytes(value[:8], "little")
    return 0


def dedicated_vram_gb() -> float | None:
    """Полный объём VRAM самой большой видеокарты в ГБ (округлённо) или None."""
    global _cache
    if _cache is not False:
        return _cache
    _cache = None
    if sys.platform != "win32":
        return None
    try:
        import winreg
        best = 0
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, _DISPLAY_CLASS) as cls:
            i = 0
            while True:
                try:
                    name = winreg.EnumKey(cls, i)
                except OSError:
                    break
                i += 1
                if not name.isdigit():
                    continue                       # "Properties" и т. п.
                try:
                    with winreg.OpenKey(cls, name) as dev:
                        for value_name in ("HardwareInformation.qwMemorySize",
                                           "HardwareInformation.MemorySize"):
                            try:
                                best = max(best, _as_int(winreg.QueryValueEx(dev, value_name)[0]))
                                break
                            except OSError:
                                continue
                except OSError:
                    continue
        if best > 0:
            _cache = float(round(best / 1024**3))
    except OSError:
        pass
    return _cache
