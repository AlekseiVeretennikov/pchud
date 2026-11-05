"""
Источник FPS: RTSS (RivaTuner Statistics Server) Shared Memory.

RTSS хукает Direct3D/Vulkan/OpenGL-приложения и публикует статистику кадров
в именованную область памяти "RTSSSharedMemoryV2". Это дополнительный источник:
он даёт только FPS/frametime текущей игры и работает параллельно с основным
(HWiNFO/LHM), а не вместо него.

Формат (little-endian): заголовок с сигнатурой 'RTSS' и версией, затем массив
записей приложений. Размер записи берём из dwAppEntrySize — в новых версиях
RTSS запись растёт, читаем только нужный префикс по этому шагу.
"""

from __future__ import annotations

import ctypes
import mmap
import os
import sys

RTSS_SHARED_MEM_NAME = "RTSSSharedMemoryV2"
RTSS_SIGNATURE = 0x52545353  # 'RTSS'

# Не-игры: сам RTSS, его служебные процессы, оболочки и наш собственный webview.
_IGNORE_BASENAMES = {
    "rtss.exe",
    "rtsshookloader.exe",
    "rtsshookloader64.exe",
    "rtsshooksloader.exe",
    "rtsshooksloader64.exe",
    "encoderserver.exe",
    "encoderserver64.exe",
    "explorer.exe",
    "dwm.exe",
    "msedgewebview2.exe",   # рендерер pywebview — то есть мы сами
    "python.exe",
    "pythonw.exe",
    "steamwebhelper.exe",
    "discord.exe",
}
_IGNORE_SUBSTRINGS = ("overlay", "rivatuner", "vpn")

# Окно измерения должно обновляться прямо сейчас, иначе запись устарела
# (игра закрыта/свёрнута, слот ещё не переиспользован).
_STALE_MS = 5000
# Ниже — не игра, а фоновое окно, перерисовывающее свой GUI
# (клиент VPN, лаунчер в трее и т.п. дают единицы FPS).
_MIN_FPS = 10.0


def _tick_ms() -> int:
    """Текущий системный тик (мс с загрузки) — та же шкала, что dwTime0/dwTime1."""
    k32 = ctypes.windll.kernel32
    k32.GetTickCount64.restype = ctypes.c_uint64
    return int(k32.GetTickCount64())


def _foreground_pid() -> int:
    """PID процесса активного окна: играют обычно в него."""
    try:
        u32 = ctypes.windll.user32
        hwnd = u32.GetForegroundWindow()
        if not hwnd:
            return 0
        pid = ctypes.c_uint32()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return pid.value
    except Exception:
        return 0


class RtssHeader(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ("dwSignature", ctypes.c_uint32),
        ("dwVersion", ctypes.c_uint32),        # HIWORD = major, LOWORD = minor
        ("dwAppEntrySize", ctypes.c_uint32),
        ("dwAppArrOffset", ctypes.c_uint32),
        ("dwAppArrSize", ctypes.c_uint32),
        ("dwOSDEntrySize", ctypes.c_uint32),
        ("dwOSDArrOffset", ctypes.c_uint32),
        ("dwOSDArrSize", ctypes.c_uint32),
        ("dwOSDFrame", ctypes.c_uint32),
    ]


class RtssAppEntry(ctypes.Structure):
    """Префикс RTSS_SHARED_MEMORY_APP_ENTRY — только нужные поля.

    Полная запись длиннее (см. dwAppEntrySize в заголовке) — по массиву
    шагаем с этим шагом, а парсим только начало каждой записи.
    """

    _pack_ = 1
    _fields_ = [
        ("dwProcessID", ctypes.c_uint32),      # 0 = слот пустой
        ("szName", ctypes.c_char * 260),       # путь к exe
        ("dwFlags", ctypes.c_uint32),
        ("dwTime0", ctypes.c_uint32),          # начало окна измерения, мс
        ("dwTime1", ctypes.c_uint32),          # конец окна измерения, мс
        ("dwFrames", ctypes.c_uint32),         # кадров за окно
        ("dwFrameTime", ctypes.c_uint32),      # время кадра, мкс
    ]


def _window_rates(entry: RtssAppEntry) -> tuple[float, float] | None:
    """(FPS, frametime в мс), усреднённые за окно измерения RTSS, или None.

    dwFrameTime не используем: это время одного последнего кадра. С генерацией
    кадров он бывает порядка 170 мкс, и единичный замер давал «6000 FPS».
    """
    # тики 32-битные и заворачиваются раз в ~49.7 суток — разность по модулю
    window_ms = (entry.dwTime1 - entry.dwTime0) & 0xFFFFFFFF
    if not window_ms or not entry.dwFrames:
        return None
    return entry.dwFrames * 1000 / window_ms, window_ms / entry.dwFrames


def _is_game(basename: str) -> bool:
    if basename in _IGNORE_BASENAMES:
        return False
    return not any(s in basename for s in _IGNORE_SUBSTRINGS)


class RtssSource:
    name = "rtss"
    display_name = "RTSS Shared Memory"

    def available(self) -> bool:
        """RTSS запущен (shared memory существует и валидна).

        Не путать с read(): RTSS может работать без единой захваченной игры.
        """
        if sys.platform != "win32":
            return False
        head_size = ctypes.sizeof(RtssHeader)
        try:
            mm = mmap.mmap(-1, head_size, tagname=RTSS_SHARED_MEM_NAME, access=mmap.ACCESS_READ)
        except (OSError, ValueError):
            return False
        try:
            return RtssHeader.from_buffer_copy(mm[:head_size]).dwSignature == RTSS_SIGNATURE
        finally:
            mm.close()

    def read(self) -> dict | None:
        """FPS текущей игры: {"app_name", "fps", "frametime_ms"} или None.

        None — RTSS не запущен либо нет захваченных приложений. Любые ошибки
        доступа к памяти тоже дают None: источник дополнительный и не должен
        ронять HUD.
        """
        if sys.platform != "win32":
            return None
        # mmap с длиной 0 на этом объекте даёт WinError 87 (в отличие от HWiNFO),
        # поэтому мапим в два шага: сначала заголовок, из него — полный размер.
        head_size = ctypes.sizeof(RtssHeader)
        try:
            mm = mmap.mmap(-1, head_size, tagname=RTSS_SHARED_MEM_NAME, access=mmap.ACCESS_READ)
            try:
                header = RtssHeader.from_buffer_copy(mm[:head_size])
            finally:
                mm.close()
            if header.dwSignature != RTSS_SIGNATURE:
                return None
            total = header.dwAppArrOffset + header.dwAppArrSize * header.dwAppEntrySize
            if not head_size <= total <= 64 * 1024 * 1024:
                return None
            mm = mmap.mmap(-1, total, tagname=RTSS_SHARED_MEM_NAME, access=mmap.ACCESS_READ)
        except (OSError, ValueError):
            return None
        try:
            header = RtssHeader.from_buffer_copy(mm[:head_size])
            if header.dwSignature != RTSS_SIGNATURE:
                return None
            if (header.dwVersion >> 16) < 2:
                return None

            need = ctypes.sizeof(RtssAppEntry)
            if header.dwAppEntrySize < need:
                return None

            # Хукнутых приложений может быть несколько (лаунчер + игра).
            # Приоритет — процессу активного окна; иначе берём живую запись
            # (обновлялась только что, FPS игровой), обновлённую последней.
            now = _tick_ms() & 0xFFFFFFFF
            fg_pid = _foreground_pid()
            best: tuple[RtssAppEntry, str, float, float] | None = None
            best_fg: tuple[RtssAppEntry, str, float, float] | None = None
            for i in range(header.dwAppArrSize):
                off = header.dwAppArrOffset + i * header.dwAppEntrySize
                if off + need > len(mm):
                    break
                entry = RtssAppEntry.from_buffer_copy(mm[off:off + need])
                if not entry.dwProcessID or entry.dwProcessID == os.getpid():
                    continue
                # тики 32-битные и заворачиваются раз в ~49.7 суток — разность по модулю
                if (now - entry.dwTime1) & 0xFFFFFFFF > _STALE_MS:
                    continue

                rates = _window_rates(entry)
                if rates is None:
                    continue
                fps, frametime_ms = rates
                if fps < _MIN_FPS:
                    continue

                path = entry.szName.split(b"\x00", 1)[0].decode("mbcs", errors="replace")
                base = os.path.basename(path)
                if not _is_game(base.lower()):
                    continue
                cand = (entry, base, fps, frametime_ms)
                if fg_pid and entry.dwProcessID == fg_pid:
                    best_fg = cand
                if best is None or entry.dwTime1 > best[0].dwTime1:
                    best = cand

            best = best_fg or best
            if best is None:
                return None
            _, name, fps, frametime_ms = best
            return {
                "app_name": os.path.splitext(name)[0],
                "fps": round(fps, 1),
                "frametime_ms": round(frametime_ms, 2),
            }
        except (OSError, ValueError):
            return None
        finally:
            mm.close()
