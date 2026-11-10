"""
Подсказка, почему нет реальных данных: что именно сделать пользователю с HWiNFO.
"""

from __future__ import annotations

import subprocess
import sys

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
    # данные идут только пока открыто окно «Датчики» — это самая частая причина
    return ("HWiNFO запущен, но данных нет. Откройте в нём окно «Датчики» (кнопка «Датчики»). "
            "Если не помогло: Настройки → «Поддержка совместно используемой памяти» "
            "(Shared Memory Support), затем перезапустите HWiNFO.")
