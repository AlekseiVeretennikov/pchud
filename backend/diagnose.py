"""
Подсказка, почему нет реальных данных: что именно сделать пользователю с HWiNFO.
"""

from __future__ import annotations

import configparser
import csv
import io
import subprocess
import sys
from pathlib import Path

HWINFO_PROCESSES = ("hwinfo64.exe", "hwinfo32.exe")


def hwinfo_running() -> bool:
    if sys.platform != "win32":
        return False
    try:
        out = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True, timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.lower()
    except (OSError, subprocess.SubprocessError):
        return False
    return any(f'"{name}"' in out for name in HWINFO_PROCESSES)


def hwinfo_paths() -> list[Path]:
    """Откуда запущены процессы HWiNFO (полный путь к exe)."""
    if sys.platform != "win32":
        return []
    try:
        out = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True, timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    pids = [int(row[1]) for row in csv.reader(io.StringIO(out))
            if len(row) > 1 and row[0].lower() in HWINFO_PROCESSES and row[1].isdigit()]
    paths = []
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.windll.kernel32
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    for pid in pids:
        h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            continue
        try:
            buf = ctypes.create_unicode_buffer(1024)
            size = wintypes.DWORD(len(buf))
            if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                paths.append(Path(buf.value))
        finally:
            kernel32.CloseHandle(h)
    return paths


def from_zip(exe: Path) -> bool:
    """Запущен двойным щелчком внутри zip: Windows распаковала его во временную папку
    вида …\\Temp\\<guid>_hwi_860.zip.hwi_860.zip\\HWiNFO64.exe — настройки там пропадают."""
    parts = [p.lower() for p in exe.parts]
    return "temp" in parts and any(p.endswith(".zip") for p in parts)


def shared_memory_setting(exe: Path) -> bool | None:
    """Галка Shared Memory из HWiNFO64.INI рядом с exe: True/False, None — не узнать.
    Только читаем: настройки HWiNFO HUD не меняет."""
    ini = exe.with_suffix(".INI")
    if not ini.is_file():
        return None
    parser = configparser.ConfigParser(strict=False, interpolation=None)
    try:
        parser.read_string(ini.read_text(encoding="utf-8", errors="replace"))
        value = parser.get("Settings", "SensorsSM", fallback=None)
    except (OSError, configparser.Error):
        return None
    return None if value is None else value.strip() == "1"


def hwinfo_hint(source_cls) -> str:
    """Что не так с HWiNFO: не запущен, выключена общая память или истёк лимит."""
    if source_cls is not None:
        try:
            source_cls()._ensure_mapped()
        except Exception as e:  # noqa: BLE001 — нужен только тип ошибки
            if type(e).__name__ == "HwinfoDeadError":
                return ("HWiNFO: истёк 12-часовой лимит общей памяти бесплатной версии. "
                        "Перезапустите HWiNFO — HUD подключится сам.")
        else:
            return "HWiNFO найден — подключаемся…"
    if not hwinfo_running():
        return ("HWiNFO не запущен. Запустите его и откройте окно «Датчики» — HUD подключится сам. "
                "В настройках HWiNFO должны стоять галки «Поддержка совместно используемой памяти» "
                "и «Показывать датчики при запуске».")
    paths = hwinfo_paths()
    if any(from_zip(p) for p in paths):
        return ("HWiNFO запущен прямо из zip-архива: Windows держит его во временной папке, и его "
                "настройки там не сохраняются. Установите HWiNFO установщиком (hwinfo.com → "
                "Installer) или распакуйте архив в постоянную папку и запускайте оттуда.")
    if any(shared_memory_setting(p) is False for p in paths):
        return ("В HWiNFO выключена общая память. Настройки → «Поддержка совместно используемой "
                "памяти» (Shared Memory Support), затем перезапустите HWiNFO.")
    # данные идут только пока открыто окно «Датчики» — это самая частая причина
    return ("HWiNFO запущен, но данных нет. Откройте в нём окно «Датчики» (кнопка «Датчики»). "
            "Если не помогло: Настройки → «Поддержка совместно используемой памяти» "
            "(Shared Memory Support), затем перезапустите HWiNFO.")
