"""
Отчёт для автора: скриншот окна HUD + текст с датчиками, одним .zip на рабочем столе.

Нужен тестерам, у которых нет консоли (в .exe нет окна для вывода --list):
нажал кнопку «Отчёт» внизу HUD — отправил получившийся архив.
В отчёт попадают только названия железа и показания датчиков.
"""

from __future__ import annotations

import ctypes
import os
import platform
import struct
import subprocess
import time
import zipfile
import zlib
from ctypes import wintypes
from pathlib import Path

from . import __version__
from .normalize import DEFAULT_RULES

WINDOW_TITLE = "PC HUD"


# ── текст ──────────────────────────────────────────────────────────────

def report_lines(manager) -> list[str]:
    """Тот же состав, что у --list, плюс сводка: что не определилось, ядра, диски."""
    snap = manager.snapshot()
    lines = [
        f"PC HUD {__version__}",
        f"Windows: {platform.platform()}",
        f"Время: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"Источник: {snap['source_display']} ({snap['source']}), RTSS: "
        f"{'запущен' if snap.get('rtss_running') else 'не запущен'}",
    ]
    if snap["warning"]:
        lines.append(f"Предупреждение: {snap['warning']}")

    found = snap["metrics"]
    expected = sorted({r.key for r in DEFAULT_RULES})
    # fps бывает только во время игры — его состояние уже видно по строке RTSS
    missing = [k for k in expected if k not in found and k != "fps"]
    lines += ["", "Не определились: " + (", ".join(missing) if missing else "всё найдено")]

    lines += ["", "Распознанные метрики:"]
    for key, m in found.items():
        lines.append(f"  {key:18} = {m['value']} {m['unit']:4}  <- [{m['sensor']}] {m['label']}")

    lines += ["", "Группы ядер:"]
    for g in snap.get("core_groups") or []:
        lines.append(f"  {g.get('name')} [{g.get('tag') or '-'}]: ядра {g.get('cores')}")
    sleeping = [c.get("id") for c in snap.get("cores", []) if c.get("sleep")]
    lines.append(f"  спят: {sleeping or 'нет'}")

    lines += ["", "Диски:"]
    for d in snap.get("drives") or []:
        lines.append(f"  {d.get('letter')} {d.get('kind')} {d.get('name')}")

    raw = manager.list_raw()
    lines += ["", f"Все датчики ({len(raw)}):"]
    for r in raw:
        key = getattr(r, "key", "") or ""
        lines.append(f"  {key:>14} [{(r.kind or ''):6}] {r.value:>10} {r.unit:4} | {r.sensor} :: {r.label}")
    return lines


# ── скриншот своего окна (Win32, без сторонних библиотек) ───────────────

class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD), ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG), ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD),
    ]


def _find_own_window() -> int:
    user32 = ctypes.windll.user32
    pid = os.getpid()
    found = []
    proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def check(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(64)
            user32.GetWindowTextW(hwnd, buf, 64)
            if buf.value == WINDOW_TITLE:
                found.append(hwnd)
                return False
        return True

    user32.EnumWindows(proc(check), 0)
    return found[0] if found else 0


def _gdi():
    """user32/gdi32 с явными типами: дескрипторы на x64 не влезают в int по умолчанию."""
    user32, gdi32 = ctypes.WinDLL("user32"), ctypes.WinDLL("gdi32")
    H = ctypes.c_void_p
    user32.GetDC.restype = H; user32.GetDC.argtypes = [H]
    user32.ReleaseDC.argtypes = [H, H]
    user32.GetClientRect.argtypes = [H, ctypes.POINTER(wintypes.RECT)]
    user32.PrintWindow.argtypes = [H, H, wintypes.UINT]
    gdi32.CreateCompatibleDC.restype = H; gdi32.CreateCompatibleDC.argtypes = [H]
    gdi32.CreateCompatibleBitmap.restype = H; gdi32.CreateCompatibleBitmap.argtypes = [H, ctypes.c_int, ctypes.c_int]
    gdi32.SelectObject.restype = H; gdi32.SelectObject.argtypes = [H, H]
    gdi32.DeleteObject.argtypes = [H]
    gdi32.DeleteDC.argtypes = [H]
    gdi32.GetDIBits.argtypes = [H, H, wintypes.UINT, wintypes.UINT, ctypes.c_void_p,
                                ctypes.c_void_p, wintypes.UINT]
    return user32, gdi32


def capture_window_png() -> bytes | None:
    """PNG клиентской области окна HUD; None, если окно не нашлось."""
    user32, gdi32 = _gdi()
    hwnd = _find_own_window()
    if not hwnd:
        return None
    rect = wintypes.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rect))
    w, h = rect.right - rect.left, rect.bottom - rect.top
    if w <= 0 or h <= 0:
        return None

    hdc = user32.GetDC(hwnd)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    old = gdi32.SelectObject(mem, bmp)
    try:
        # 1 = только клиентская часть, 2 = PW_RENDERFULLCONTENT (нужно для WebView2)
        user32.PrintWindow(hwnd, mem, 3)
        info = _BITMAPINFOHEADER()
        info.biSize = ctypes.sizeof(info)
        info.biWidth, info.biHeight = w, -h      # отрицательная высота: строки сверху вниз
        info.biPlanes, info.biBitCount = 1, 32
        pixels = ctypes.create_string_buffer(w * h * 4)
        gdi32.GetDIBits(mem, bmp, 0, h, pixels, ctypes.byref(info), 0)
    finally:
        gdi32.SelectObject(mem, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem)
        user32.ReleaseDC(hwnd, hdc)
    return _png_from_bgra(pixels.raw, w, h)


def _png_from_bgra(data: bytes, w: int, h: int) -> bytes:
    # BGRA → RGB, к каждой строке байт фильтра 0
    rows = bytearray()
    stride = w * 4
    for y in range(h):
        row = data[y * stride:(y + 1) * stride]
        rgb = bytearray(w * 3)
        rgb[0::3], rgb[1::3], rgb[2::3] = row[2::4], row[1::4], row[0::4]
        rows += b"\x00" + rgb

    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 6))
            + chunk(b"IEND", b""))


# ── куда сохранить ──────────────────────────────────────────────────────

def _desktop() -> Path:
    """Рабочий стол с учётом переноса в OneDrive; если не вышло — домашняя папка."""
    try:
        guid = (ctypes.c_ubyte * 16).from_buffer_copy(
            bytes.fromhex("3ACCBFB42CDB4C42B0297FE99A87C641"))  # FOLDERID_Desktop
        path = ctypes.c_wchar_p()
        if ctypes.windll.shell32.SHGetKnownFolderPath(guid, 0, None, ctypes.byref(path)) == 0:
            result = Path(path.value)
            ctypes.windll.ole32.CoTaskMemFree(path)
            if result.is_dir():
                return result
    except (OSError, AttributeError, ValueError):
        pass
    return Path.home()


def save_report(manager) -> dict:
    """Собирает архив и показывает его в Проводнике. Возвращает {ok, path | error}."""
    try:
        png = capture_window_png()
        text = "\n".join(report_lines(manager)) + "\n"
        name = f"PC-HUD-report-{time.strftime('%Y%m%d-%H%M%S')}.zip"
        target = _desktop() / name
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("report.txt", text.encode("utf-8-sig"))  # BOM — чтобы Блокнот не путал кодировку
            if png:
                z.writestr("screenshot.png", png)
        subprocess.Popen(f'explorer /select,"{target}"')
        return {"ok": True, "path": str(target), "screenshot": bool(png)}
    except Exception as e:  # отчёт не должен ронять HUD
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
