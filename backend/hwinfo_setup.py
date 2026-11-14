"""
Настройка и перезапуск HWiNFO за пользователя (кнопка «Настроить HWiNFO» в «Настройках»).

Что делает настройка (один раз, с подтверждением Windows — HWiNFO живёт в Program Files):
  1. закрывает HWiNFO;
  2. ставит галки в его HWiNFO64.INI (REQUIRED ниже): общая память, окно датчиков при
     запуске, всё свёрнуто в трей, без сводки системы, автозапуск с Windows;
  3. создаёт задание Планировщика «PC HUD - HWiNFO» с правами администратора и БЕЗ
     расписания — его запускает только HUD (schtasks /run), и Windows больше ничего
     не спрашивает;
  4. запускает HWiNFO — незаметно, сразу в трей.

Дальше HUD сам запускает HWiNFO, если тот не работает, и перезапускает его, когда
бесплатная версия через 12 часов отключает общую память (и снимает её галку):
задание закрывает HWiNFO принудительно — чтобы тот не записал снятую галку, —
возвращает SensorsSM=1 и запускает заново.

Сама программа HWiNFO не меняется — только её файл настроек, те же галки, что в её меню.
Названия ключей проверены на HWiNFO 8.60 (diff INI до/после галок в меню).
"""

from __future__ import annotations

import configparser
import ctypes
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from .launcher import find_exe, running

TASK_NAME = "PC HUD - HWiNFO"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# галки HWiNFO → ключи [Settings] в HWiNFO64.INI
REQUIRED = {
    "SensorsSM": "1",               # Поддержка совместно используемой памяти
    "OpenSensors": "1",             # Показывать датчики при запуске (иначе данных нет)
    "MinimalizeMainWnd": "1",       # Свёртывать главное окно при запуске
    "MinimalizeSensors": "1",       # Свёртывать окно датчиков при запуске
    "MinimalizeSensorsClose": "1",  # Не закрывать, а свёртывать окно датчиков
    "OpenSystemSummary": "0",       # не показывать сводку системы при запуске
    "ShowWelcomeAndProgress": "0",  # без экрана приветствия
    "Autorun": "1",                 # запускать HWiNFO вместе с Windows
}

# коды выхода повышенного помощника (--hwinfo-setup / --hwinfo-restart / --hwinfo-remove)
OK, NOT_FOUND, INI_FAILED, TASK_FAILED, START_FAILED = 0, 2, 3, 4, 5
EXIT_TEXT = {
    NOT_FOUND: "HWiNFO не найден — установите его с hwinfo.com (вариант Installer)",
    INI_FAILED: "не удалось записать настройки HWiNFO",
    TASK_FAILED: "не удалось создать задание в Планировщике",
    START_FAILED: "настройки записаны, но HWiNFO не запустился",
}


# ── где HWiNFO и его настройки ──
def hwinfo_exe() -> Path | None:
    """Сам HWiNFO64.exe (не Launcher): его запускаем напрямую."""
    exe = find_exe("hwinfo")
    if exe is None:
        return None
    direct = exe.with_name("HWiNFO64.exe")
    return direct if direct.is_file() else exe


def ini_path(exe: Path) -> Path:
    return exe.parent / "HWiNFO64.INI"


def _read_ini(path: Path) -> configparser.ConfigParser:
    parser = configparser.ConfigParser(strict=False, interpolation=None)
    parser.optionxform = str                      # HWiNFO различает регистр ключей
    if path.is_file():
        parser.read_string(path.read_text(encoding="utf-8", errors="replace"))
    if not parser.has_section("Settings"):
        parser.add_section("Settings")
    return parser


def ini_missing(exe: Path) -> list[str]:
    """Какие нужные галки не стоят (пусто — всё настроено)."""
    try:
        parser = _read_ini(ini_path(exe))
    except (OSError, configparser.Error):
        return list(REQUIRED)
    return [k for k, v in REQUIRED.items() if parser.get("Settings", k, fallback=None) != v]


def write_ini(exe: Path, keys: dict) -> None:
    """Дописывает ключи в [Settings], остальные настройки HWiNFO не трогает."""
    path = ini_path(exe)
    parser = _read_ini(path)
    for k, v in keys.items():
        parser.set("Settings", k, v)
    lines = []
    for section in parser.sections():
        lines.append(f"[{section}]")
        lines += [f"{k}={v}" for k, v in parser.items(section)]
    # newline="\r\n" сам ставит виндовые переводы строк (раньше выходили двойные \r)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\r\n")


# ── задание Планировщика ──
def _helper_command() -> tuple[str, str, str]:
    """Чем задание запускает помощника: exe-сборка или python из исходников."""
    if getattr(sys, "frozen", False):
        exe = Path(sys.executable).resolve()
        return str(exe), "--hwinfo-restart", str(exe.parent)
    root = Path(__file__).resolve().parent.parent
    py = Path(sys.executable)
    pyw = py.with_name("pythonw.exe")                 # без мелькающей консоли
    return str(pyw if pyw.is_file() else py), "-m backend.main --hwinfo-restart", str(root)


def _xml_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def create_task() -> bool:
    command, args, workdir = _helper_command()
    user = os.environ.get("USERDOMAIN", "") + "\\" + os.environ.get("USERNAME", "")
    xml = f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>PC HUD: запуск и перезапуск HWiNFO (12-часовой лимит общей памяти). Расписания нет — задание запускает только PC HUD.</Description></RegistrationInfo>
  <Principals><Principal id="Author"><UserId>{_xml_escape(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT2M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>{_xml_escape(command)}</Command><Arguments>{_xml_escape(args)}</Arguments><WorkingDirectory>{_xml_escape(workdir)}</WorkingDirectory></Exec></Actions>
</Task>
"""
    fd, tmp = tempfile.mkstemp(suffix=".xml")
    os.close(fd)
    try:
        Path(tmp).write_text(xml, encoding="utf-16")
        r = subprocess.run(["schtasks", "/create", "/tn", TASK_NAME, "/xml", tmp, "/f"],
                           capture_output=True, creationflags=NO_WINDOW, timeout=20)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False
    finally:
        Path(tmp).unlink(missing_ok=True)


def task_command() -> str | None:
    """Команда задания (None — задания нет). Чтение доступно и без прав администратора."""
    try:
        r = subprocess.run(["schtasks", "/query", "/tn", TASK_NAME, "/xml"],
                           capture_output=True, creationflags=NO_WINDOW, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    raw = r.stdout
    text = raw.decode("utf-16", errors="replace") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") \
        else raw.decode("utf-8", errors="replace")
    start, end = text.find("<Command>"), text.find("</Command>")
    return text[start + 9:end] if start >= 0 < end else ""


def run_task() -> bool:
    """Запустить задание — HWiNFO (пере)запустится с правами администратора, без вопросов."""
    try:
        r = subprocess.run(["schtasks", "/run", "/tn", TASK_NAME],
                           capture_output=True, creationflags=NO_WINDOW, timeout=15)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


# ── то, что выполняется с правами администратора ──
def _kill_hwinfo() -> None:
    """Принудительно: при обычном выходе HWiNFO записал бы снятую галку общей памяти."""
    for name in ("HWiNFO64.exe", "HWiNFO32.exe"):
        subprocess.run(["taskkill", "/F", "/IM", name], capture_output=True,
                       creationflags=NO_WINDOW, timeout=15)
    for _ in range(50):                                # до 5 с, пока процесс не исчезнет
        if not running("hwinfo"):
            return
        time.sleep(0.1)


def _start_hwinfo(exe: Path) -> bool:
    """Только через оболочку (ShellExecute): у HWiNFO в манифесте uiAccess=true, и
    CreateProcess отказывает с ошибкой 740 даже с правами администратора."""
    try:
        os.startfile(str(exe))
        return True
    except OSError:
        return False


def elevated_main(action: str) -> int:
    """Точка входа повышенного помощника: setup | restart | remove."""
    if action == "remove":
        r = subprocess.run(["schtasks", "/delete", "/tn", TASK_NAME, "/f"],
                           capture_output=True, creationflags=NO_WINDOW, timeout=20)
        return OK if r.returncode == 0 else TASK_FAILED
    exe = hwinfo_exe()
    if exe is None:
        return NOT_FOUND
    _kill_hwinfo()
    try:
        # restart — только вернуть общую память; setup — все галки
        write_ini(exe, REQUIRED if action == "setup" else {"SensorsSM": "1"})
    except OSError:
        return INI_FAILED
    if action == "setup" and not create_task():
        return TASK_FAILED
    return OK if _start_hwinfo(exe) else START_FAILED


# ── вызов из HUD (обычные права) ──
def _run_elevated(action: str) -> int | None:
    """Запускает помощника с запросом прав Windows и ждёт его. None — пользователь отказал."""
    from ctypes import wintypes

    class SHELLEXECUTEINFOW(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("fMask", ctypes.c_ulong), ("hwnd", wintypes.HWND),
                    ("lpVerb", wintypes.LPCWSTR), ("lpFile", wintypes.LPCWSTR),
                    ("lpParameters", wintypes.LPCWSTR), ("lpDirectory", wintypes.LPCWSTR),
                    ("nShow", ctypes.c_int), ("hInstApp", wintypes.HINSTANCE),
                    ("lpIDList", ctypes.c_void_p), ("lpClass", wintypes.LPCWSTR),
                    ("hkeyClass", wintypes.HKEY), ("dwHotKey", wintypes.DWORD),
                    ("hIcon", wintypes.HANDLE), ("hProcess", wintypes.HANDLE)]

    command, args, workdir = _helper_command()
    args = args.replace("--hwinfo-restart", f"--hwinfo-{action}")
    info = SHELLEXECUTEINFOW()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = 0x00000040                            # SEE_MASK_NOCLOSEPROCESS
    info.lpVerb, info.lpFile, info.lpParameters, info.lpDirectory = "runas", command, args, workdir
    info.nShow = 0
    shell32, kernel32 = ctypes.windll.shell32, ctypes.windll.kernel32
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    if not shell32.ShellExecuteExW(ctypes.byref(info)):
        return None                                    # 1223 — отказ в окне Windows
    try:
        kernel32.WaitForSingleObject(info.hProcess, 60_000)
        code = wintypes.DWORD()
        kernel32.GetExitCodeProcess(info.hProcess, ctypes.byref(code))
        return int(code.value)
    finally:
        kernel32.CloseHandle(info.hProcess)


def status() -> dict:
    """Для «Настроек»: установлен ли HWiNFO, стоят ли галки, есть ли задание HUD."""
    exe = hwinfo_exe()
    if exe is None:
        return {"installed": False, "configured": False, "task": False, "missing": []}
    missing = ini_missing(exe)
    cmd = task_command()
    helper = _helper_command()[0]
    task_ok = cmd is not None and Path(cmd).resolve() == Path(helper).resolve() if cmd else False
    return {
        "installed": True,
        "configured": not missing and task_ok,
        "task": cmd is not None,
        "task_moved": cmd is not None and not task_ok,   # PC-HUD.exe перенесли — настроить заново
        "missing": missing,
        "path": str(exe.parent),
    }


def setup() -> dict:
    if hwinfo_exe() is None:
        return {"ok": False, "message": EXIT_TEXT[NOT_FOUND]}
    code = _run_elevated("setup")
    if code is None:
        return {"ok": False, "message": "отменено в окне Windows"}
    if code != OK:
        return {"ok": False, "message": EXIT_TEXT.get(code, f"ошибка {code}")}
    return {"ok": True, "message": "готово: HWiNFO запущен незаметно, данные пойдут через несколько секунд"}


def remove() -> dict:
    code = _run_elevated("remove")
    if code is None:
        return {"ok": False, "message": "отменено в окне Windows"}
    return {"ok": code == OK,
            "message": "задание удалено; галки в HWiNFO остались" if code == OK else EXIT_TEXT.get(code, f"ошибка {code}")}


# ── автоматический (пере)запуск из HUD ──
class AutoRecover:
    """Когда данных HWiNFO нет: не запущен → запустить, запущен без общей памяти
    (12 часов истекли) → перезапустить. Не чаще раза в 90 с и не больше 6 раз в час,
    чтобы не крутить HWiNFO по кругу, если что-то сломано."""

    GAP_S, PER_HOUR, PATIENCE_S = 90, 6, 20

    def __init__(self) -> None:
        self._runs: list[float] = []
        self._missing_since: float | None = None
        self._task_checked = 0.0
        self._task_ok = False

    def _task_available(self) -> bool:
        now = time.monotonic()
        if now - self._task_checked > 300:            # schtasks — раз в 5 минут
            self._task_checked = now
            self._task_ok = task_command() is not None
        return self._task_ok

    def data_ok(self) -> None:
        self._missing_since = None

    def tick(self, enabled: bool) -> bool:
        """Вызывается, пока HUD без данных HWiNFO. True — запустили задание.
        Ждём 20 с: только что запущенный HWiNFO ещё опрашивает датчики."""
        if not enabled or sys.platform != "win32":
            return False
        now = time.monotonic()
        if self._missing_since is None:
            self._missing_since = now
        if now - self._missing_since < self.PATIENCE_S:
            return False
        self._runs = [t for t in self._runs if now - t < 3600]
        if (self._runs and now - self._runs[-1] < self.GAP_S) or len(self._runs) >= self.PER_HOUR:
            return False
        if not self._task_available():
            return False
        self._runs.append(now)
        return run_task()


if __name__ == "__main__":     # отладка: python -m backend.hwinfo_setup
    print(json.dumps(status(), ensure_ascii=False, indent=2))
