"""
Кнопки HWiNFO и RTSS в подвале HUD: найти программу на компьютере и запустить.

Где ищем (по порядку):
  HWiNFO — запись в «Программах и компонентах», App Paths, стандартные папки;
           у установленной версии там лежит HWiNFO64Launcher.exe, у переносной — HWiNFO64.exe.
  RTSS   — ключ установщика HKLM\\SOFTWARE\\WOW6432Node\\Unwinder\\RTSS, стандартная папка.
Обе программы требуют прав администратора, поэтому запускаем через ShellExecute
(os.startfile): Windows сама покажет запрос UAC. Не нашли — открываем страницу загрузки.
Настройки самих программ HUD не трогает.
"""

from __future__ import annotations

import os
import subprocess
import sys
import webbrowser
from pathlib import Path

APPS = {
    "hwinfo": {
        "title": "HWiNFO",
        "processes": ("hwinfo64.exe", "hwinfo32.exe"),
        "exe_names": ("HWiNFO64.exe", "HWiNFO64Launcher.exe", "HWiNFO32.exe"),
        "dirs": (r"%ProgramFiles%\HWiNFO64", r"%ProgramFiles(x86)%\HWiNFO64",
                 r"%ProgramFiles%\HWiNFO", r"%ProgramFiles(x86)%\HWiNFO32"),
        "uninstall_match": "hwinfo",
        "app_paths": ("HWiNFO64.exe",),
        "download": "https://www.hwinfo.com/download/",
    },
    "rtss": {
        "title": "RTSS",
        "processes": ("rtss.exe",),
        "exe_names": ("RTSS.exe",),
        "dirs": (r"%ProgramFiles(x86)%\RivaTuner Statistics Server",
                 r"%ProgramFiles%\RivaTuner Statistics Server"),
        "uninstall_match": "rivatuner",
        "app_paths": (),
        "download": "https://www.msi.com/Landing/afterburner/graphics-cards",
    },
}


def running(app: str) -> bool:
    if sys.platform != "win32":
        return False
    try:
        out = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True, timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.lower()
    except (OSError, subprocess.SubprocessError):
        return False
    return any(f'"{name}"' in out for name in APPS[app]["processes"])


def _registry_candidates(app: str) -> list[Path]:
    spec, found = APPS[app], []
    try:
        import winreg
    except ImportError:
        return found
    hklm = winreg.HKEY_LOCAL_MACHINE

    def value(root, path, name):
        try:
            with winreg.OpenKey(root, path) as k:
                return winreg.QueryValueEx(k, name)[0]
        except OSError:
            return None

    if app == "rtss":
        for name in ("InstallPath", "InstallDir"):
            v = value(hklm, r"SOFTWARE\WOW6432Node\Unwinder\RTSS", name)
            if v:
                p = Path(v)
                found.append(p if p.suffix.lower() == ".exe" else p / "RTSS.exe")

    for exe in spec["app_paths"]:
        v = value(hklm, rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}", "")
        if v:
            found.append(Path(v.strip('"')))

    for root_path in (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                      r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"):
        try:
            with winreg.OpenKey(hklm, root_path) as root:
                for i in range(winreg.QueryInfoKey(root)[0]):
                    sub = winreg.EnumKey(root, i)
                    name = value(hklm, rf"{root_path}\{sub}", "DisplayName") or ""
                    if spec["uninstall_match"] not in name.lower():
                        continue
                    for field in ("InstallLocation", "DisplayIcon"):
                        v = (value(hklm, rf"{root_path}\{sub}", field) or "").split(",")[0].strip('"')
                        if not v:
                            continue
                        p = Path(v)
                        found += [p] if p.suffix.lower() == ".exe" else [p / e for e in spec["exe_names"]]
        except OSError:
            continue
    return found


def find_exe(app: str) -> Path | None:
    spec = APPS[app]
    candidates = _registry_candidates(app)
    for d in spec["dirs"]:
        base = Path(os.path.expandvars(d))
        candidates += [base / e for e in spec["exe_names"]]
    for p in candidates:
        # деинсталлятор тоже бывает .exe — его не запускаем
        if p.name.lower() in {e.lower() for e in spec["exe_names"]} and p.is_file():
            return p
    return None


def launch(app: str) -> dict:
    """Результат для кнопки: status = running | started | cancelled | download | error."""
    if app not in APPS:
        return {"status": "error", "message": f"неизвестная программа {app}"}
    title = APPS[app]["title"]
    if running(app):
        return {"status": "running", "message": f"{title} уже работает"}
    exe = find_exe(app)
    if exe is None:
        webbrowser.open(APPS[app]["download"])
        return {"status": "download", "message": f"{title} не найден — открыта страница загрузки"}
    try:
        os.startfile(str(exe))            # ShellExecute: Windows спросит права администратора
    except OSError as e:
        if getattr(e, "winerror", None) == 1223:   # пользователь нажал «Нет» в запросе UAC
            return {"status": "cancelled", "message": "запуск отменён"}
        return {"status": "error", "message": f"не удалось запустить: {e}"}
    return {"status": "started", "message": f"запускаю {title}…", "path": str(exe)}
