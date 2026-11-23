"""Мониторы Windows: список для настройки «Открывать на» и поиск выбранного при запуске.

Монитор запоминается по имени устройства Windows (\\\\.\\DISPLAY5), а в настройках
подписан названием модели из самого монитора (как в «Параметры → Дисплей») и
разрешением: «DELL U3423WE · 3440×1440».
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


def startup_monitors() -> list[dict]:
    """Границы экранов в единицах начального положения окна pywebview (96 DPI)."""
    try:
        user32 = ctypes.windll.user32
        # WinForms включает тот же режим при старте. Включаем его до перечисления:
        # иначе Windows может виртуализировать координаты для процесса без DPI awareness.
        user32.SetProcessDPIAware()
        dpi = user32.GetDpiForSystem() or 96
    except (AttributeError, OSError):
        dpi = 96
    return [_logical_bounds(mon, dpi) for mon in list_monitors()]


def _logical_bounds(mon: dict, dpi: int) -> dict:
    # Начальную позицию и размер WinForms умножает на один и тот же масштаб
    # ещё до переноса окна на целевой монитор. Общие края округляем одинаково.
    left, top = mon["x"], mon["y"]
    x, y = round(left * 96 / dpi), round(top * 96 / dpi)
    return {**mon, "x": x, "y": y,
            "width": round((left + mon["width"]) * 96 / dpi) - x,
            "height": round((top + mon["height"]) * 96 / dpi) - y}


def list_monitors() -> list[dict]:
    """[{device, x, y, width, height, primary}] — координаты в пикселях рабочего стола."""
    try:
        user32 = ctypes.windll.user32
    except AttributeError:
        return []
    out: list[dict] = []
    MONITORINFOF_PRIMARY = 1
    user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(_MONITORINFOEXW)]
    user32.GetMonitorInfoW.restype = wintypes.BOOL

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


# ── названия моделей: тот же источник, что у «Параметры → Дисплей» ──
# QueryDisplayConfig даёт пары «источник ↔ монитор»; у источника — имя \\.\DISPLAYn
# (как у EnumDisplayMonitors), у монитора — название модели из его EDID.

class _LUID(ctypes.Structure):
    _fields_ = [("LowPart", wintypes.DWORD), ("HighPart", wintypes.LONG)]


class _PATH_SOURCE(ctypes.Structure):
    _fields_ = [("adapterId", _LUID), ("id", ctypes.c_uint32),
                ("modeInfoIdx", ctypes.c_uint32), ("statusFlags", ctypes.c_uint32)]


class _PATH_TARGET(ctypes.Structure):
    _fields_ = [("adapterId", _LUID), ("id", ctypes.c_uint32), ("modeInfoIdx", ctypes.c_uint32),
                ("outputTechnology", ctypes.c_uint32), ("rotation", ctypes.c_uint32),
                ("scaling", ctypes.c_uint32), ("refreshNum", ctypes.c_uint32),
                ("refreshDen", ctypes.c_uint32), ("scanLineOrdering", ctypes.c_uint32),
                ("targetAvailable", wintypes.BOOL), ("statusFlags", ctypes.c_uint32)]


class _PATH_INFO(ctypes.Structure):
    _fields_ = [("sourceInfo", _PATH_SOURCE), ("targetInfo", _PATH_TARGET), ("flags", ctypes.c_uint32)]


class _MODE_INFO(ctypes.Structure):
    _fields_ = [("infoType", ctypes.c_uint32), ("id", ctypes.c_uint32), ("adapterId", _LUID),
                ("info", ctypes.c_uint64 * 6)]      # 48 байт режима — нам не нужны


class _HEADER(ctypes.Structure):
    _fields_ = [("type", ctypes.c_uint32), ("size", ctypes.c_uint32),
                ("adapterId", _LUID), ("id", ctypes.c_uint32)]


class _SOURCE_NAME(ctypes.Structure):
    _fields_ = [("header", _HEADER), ("viewGdiDeviceName", wintypes.WCHAR * 32)]


class _TARGET_NAME(ctypes.Structure):
    _fields_ = [("header", _HEADER), ("flags", ctypes.c_uint32), ("outputTechnology", ctypes.c_uint32),
                ("edidManufactureId", ctypes.c_uint16), ("edidProductCodeId", ctypes.c_uint16),
                ("connectorInstance", ctypes.c_uint32),
                ("monitorFriendlyDeviceName", wintypes.WCHAR * 64),
                ("monitorDevicePath", wintypes.WCHAR * 128)]


def monitor_names() -> dict[str, str]:
    """{"\\\\.\\DISPLAY5": "LG ULTRAGEAR"} — для мониторов, которые сообщают модель."""
    try:
        user32 = ctypes.windll.user32
    except AttributeError:
        return {}
    QDC_ONLY_ACTIVE_PATHS = 2
    GET_SOURCE_NAME, GET_TARGET_NAME = 1, 2
    n_paths, n_modes = ctypes.c_uint32(), ctypes.c_uint32()
    try:
        if user32.GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, ctypes.byref(n_paths), ctypes.byref(n_modes)):
            return {}
        paths = (_PATH_INFO * n_paths.value)()
        modes = (_MODE_INFO * n_modes.value)()
        if user32.QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ctypes.byref(n_paths), paths,
                                     ctypes.byref(n_modes), modes, None):
            return {}
        names = {}
        for path in paths[:n_paths.value]:
            src = _SOURCE_NAME()
            src.header.type, src.header.size = GET_SOURCE_NAME, ctypes.sizeof(_SOURCE_NAME)
            src.header.adapterId, src.header.id = path.sourceInfo.adapterId, path.sourceInfo.id
            tgt = _TARGET_NAME()
            tgt.header.type, tgt.header.size = GET_TARGET_NAME, ctypes.sizeof(_TARGET_NAME)
            tgt.header.adapterId, tgt.header.id = path.targetInfo.adapterId, path.targetInfo.id
            if user32.DisplayConfigGetDeviceInfo(ctypes.byref(src)) or \
                    user32.DisplayConfigGetDeviceInfo(ctypes.byref(tgt)):
                continue
            name = tgt.monitorFriendlyDeviceName.strip()
            if name and src.viewGdiDeviceName not in names:   # дубль экрана — первое имя
                names[src.viewGdiDeviceName] = name
        return names
    except OSError:
        return {}


def labeled_monitors() -> list[dict]:
    """Мониторы с подписями для панели «Настройки»: «DELL U3423WE · 3440×1440»,
    основной первым, дальше слева направо. Без названия модели (так бывает у
    встроенных экранов ноутбуков) — «Монитор 2 · 1920×1080»."""
    mons = list_monitors()
    if not mons:
        return []
    names = monitor_names()
    for m in mons:
        number = m["device"].rsplit("DISPLAY", 1)[-1]
        model = names.get(m["device"]) or f"Монитор {number}"
        m["label"] = f"{model} · {m['width']}×{m['height']}"
    # два одинаковых монитора — различаем номером Windows
    for m in mons:
        if sum(1 for o in mons if o["label"] == m["label"]) > 1:
            m["label"] += f" ({m['device'].rsplit('DISPLAY', 1)[-1]})"
    for m in mons:
        if m["primary"]:
            m["label"] += " · основной"
    mons.sort(key=lambda m: (not m["primary"], m["x"], m["y"]))
    return mons


def find(device: str) -> dict | None:
    return next((m for m in list_monitors() if m["device"] == device), None)


def window_device(window) -> str | None:
    """Монитор нативного окна. Для свёрнутого окна Windows берёт прежнее положение."""
    try:
        hwnd = window.native.Handle.ToInt64()
        user32 = ctypes.windll.user32
        monitor_from_window = user32.MonitorFromWindow
        monitor_from_window.argtypes = [wintypes.HWND, wintypes.DWORD]
        monitor_from_window.restype = wintypes.HMONITOR
        get_info = user32.GetMonitorInfoW
        get_info.argtypes = [wintypes.HMONITOR, ctypes.POINTER(_MONITORINFOEXW)]
        get_info.restype = wintypes.BOOL
        hmon = monitor_from_window(hwnd, 2)  # MONITOR_DEFAULTTONEAREST
        info = _MONITORINFOEXW()
        info.cbSize = ctypes.sizeof(info)
        if hmon and get_info(hmon, ctypes.byref(info)):
            return info.szDevice
    except (AttributeError, OSError):
        pass
    return None
