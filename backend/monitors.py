"""Мониторы Windows: список для настройки «Открывать на» и поиск выбранного при запуске.

Монитор запоминается по имени устройства Windows (\\\\.\\DISPLAY5). Модель монитора
Windows обычно не знает («Универсальный монитор PnP»), поэтому в настройках он
подписан по расположению относительно основного и разрешению: «Справа · 1920×1080».
"""

from __future__ import annotations

import ctypes
import re
from ctypes import wintypes

DEVICE_RE = re.compile(r"^\\\\\.\\DISPLAY\d{1,3}$")


class _MONITORINFOEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
        ("szDevice", wintypes.WCHAR * 32),
    ]


def list_monitors() -> list[dict]:
    """[{device, x, y, width, height, primary}] — координаты в пикселях рабочего стола."""
    try:
        user32 = ctypes.windll.user32
    except AttributeError:
        return []
    out: list[dict] = []
    MONITORINFOF_PRIMARY = 1

    proc_type = ctypes.WINFUNCTYPE(ctypes.c_int, wintypes.HMONITOR, wintypes.HDC,
                                   ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)

    def callback(hmon, _hdc, _rect, _data):
        info = _MONITORINFOEXW()
        info.cbSize = ctypes.sizeof(_MONITORINFOEXW)
        if user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
            r = info.rcMonitor
            out.append({
                "device": info.szDevice,
                "x": r.left, "y": r.top,
                "width": r.right - r.left, "height": r.bottom - r.top,
                "primary": bool(info.dwFlags & MONITORINFOF_PRIMARY),
            })
        return 1

    user32.EnumDisplayMonitors.argtypes = [wintypes.HDC, ctypes.c_void_p, proc_type, wintypes.LPARAM]
    try:
        user32.EnumDisplayMonitors(None, None, proc_type(callback), 0)
    except OSError:
        return []
    return out


def _side(m: dict, primary: dict) -> str:
    """Где монитор относительно основного — по центрам."""
    dx = (m["x"] + m["width"] / 2) - (primary["x"] + primary["width"] / 2)
    dy = (m["y"] + m["height"] / 2) - (primary["y"] + primary["height"] / 2)
    if abs(dx) >= abs(dy):
        return "Справа" if dx > 0 else "Слева"
    return "Снизу" if dy > 0 else "Сверху"


def labeled_monitors() -> list[dict]:
    """Мониторы с подписями для панели «Настройки»: основной первым, дальше слева направо."""
    mons = list_monitors()
    primary = next((m for m in mons if m["primary"]), mons[0] if mons else None)
    if primary is None:
        return []
    for m in mons:
        name = "Основной" if m is primary else _side(m, primary)
        m["label"] = f"{name} · {m['width']}×{m['height']}"
    # одинаковые подписи (два монитора справа) различаем номером Windows
    for m in mons:
        if sum(1 for o in mons if o["label"] == m["label"]) > 1:
            m["label"] += f" ({m['device'].rsplit('DISPLAY', 1)[-1]})"
    mons.sort(key=lambda m: (not m["primary"], m["x"], m["y"]))
    return mons


def find(device: str) -> dict | None:
    return next((m for m in list_monitors() if m["device"] == device), None)
