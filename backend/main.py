"""
PC HUD — лёгкий монитор железа для портативного экрана.

Источник данных: HWiNFO / LibreHardwareMonitor (автовыбор), отрисовка — HTML/CSS
в нативном окне pywebview, поэтому выглядит как обычная программа, а не как
виджет на рабочем столе или сайт в браузере.

Запуск:
    python -m backend.main             обычный запуск (окно)
    python -m backend.main --fullscreen
    python -m backend.main --demo      принудительно демо-данные
    python -m backend.main --list      вывести все сырые датчики и выйти
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
from pathlib import Path

from . import __version__
from .manager import SourceManager
from .monitors import DEVICE_RE, labeled_monitors, list_monitors, startup_monitors, window_device

APP_DIR = Path(__file__).resolve().parent.parent

# Под PyInstaller (--onefile) ресурсы распаковываются во временную папку sys._MEIPASS.
# config.json при этом лежит рядом с .exe, а web/ — внутри бандла.
def _resource_base() -> Path:
    if hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return APP_DIR

def _config_base() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return APP_DIR

WEB_DIR = _resource_base() / "web"
CONFIG_PATH = _config_base() / "config.json"

DEFAULT_CONFIG = {
    "source": "auto",
    "libre_url": "http://localhost:8085/data.json",
    "poll_interval_ms": 1000,
    "fullscreen": False,
    # maximized: открывать развёрнутым — окно само учитывает панель задач Windows.
    # x/y HUD запоминает сам при закрытии: так он открывается на том же мониторе.
    "window": {"width": 1920, "height": 1080, "x": None, "y": None, "frameless": False, "maximized": True},
    "metric_overrides": {},
    "drives": None,        # список букв (["C:", "Z:"]) или None = все диски с датчиком
    "vram_total_gb": None, # полный объём VRAM для подписи "занято/всего"
    # всё ниже меняется и в панели «Настройки» внизу HUD
    "start_fullscreen": False,  # «Всегда открывать на весь экран» — общая для всех тем
    # «Открывать на»: "auto" — на мониторе, где HUD закрыли, или имя монитора Windows
    # ("\\\\.\\DISPLAY5"); если его нет (выключен) — как "auto"
    "monitor": "auto",
    # сам запускать HWiNFO и перезапускать после 12 часов (работает после «Настроить HWiNFO»)
    "hwinfo_auto": True,
    "theme": "matrix",          # тема оформления (web/themes/)
    # настройки каждой темы отдельно: {"matrix": {"palette": "green", ...}}.
    # Значения по умолчанию и допустимые значения знает сама тема (web/themes/*.js)
    "themes": {},
}

# До 0.1.8 тем не было: эти ключи лежали в корне config.json и относились к «Матрице»
_LEGACY_MATRIX_KEYS = ("background", "bg_brightness", "bg_field", "bg_drops", "bg_words",
                       "label_glitch", "name_noise", "fx_rate", "boot_mode")

_ID = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")


def _is_scalar(v) -> bool:
    return isinstance(v, bool) or (isinstance(v, (int, float)) and abs(v) < 1e6) or \
        (isinstance(v, str) and len(v) <= 64)


def _settings_error(changes) -> str | None:
    """Что панель «Настройки» может менять. Ключи тем проверяем по форме (имя, простое
    значение) — допустимые значения знает сама тема и подставит своё при ошибке."""
    if not isinstance(changes, dict):
        return "ожидался объект"
    for key, value in changes.items():
        if key in ("start_fullscreen", "hwinfo_auto"):
            if not isinstance(value, bool):
                return key
        elif key == "monitor":
            if not isinstance(value, str) or not (value == "auto" or DEVICE_RE.match(value)):
                return key
        elif key == "theme":
            if not isinstance(value, str) or not _ID.match(value):
                return key
        elif key == "themes":
            if not isinstance(value, dict):
                return key
            for tid, opts in value.items():
                if not _ID.match(str(tid)) or not isinstance(opts, dict):
                    return f"themes.{tid}"
                for k, v in opts.items():
                    if not _ID.match(str(k)) or not _is_scalar(v):
                        return f"themes.{tid}.{k}"
        else:
            return key
    return None


def _deep_merge(base: dict, changes: dict) -> dict:
    """Вложенные словари (window, themes.matrix) дополняем, а не заменяем целиком."""
    out = dict(base)
    for key, value in changes.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    if CONFIG_PATH.exists():
        try:
            user = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            cfg = _deep_merge(cfg, {k: v for k, v in user.items() if k not in _LEGACY_MATRIX_KEYS})
            if not isinstance(cfg.get("window"), dict):
                cfg["window"] = DEFAULT_CONFIG["window"].copy()
            if not isinstance(cfg.get("themes"), dict):
                cfg["themes"] = {}
            if not isinstance(cfg["themes"].get("matrix"), dict):
                cfg["themes"]["matrix"] = {}
            # старые ключи из корня переезжают в «Матрицу», если там их ещё нет
            matrix = cfg["themes"]["matrix"]
            legacy = {k: user[k] for k in _LEGACY_MATRIX_KEYS if k in user}
            if user.get("boot_animation") is False:            # до 0.1.5
                legacy.setdefault("boot_mode", "off")
            if user.get("label_glitch") is False:              # до 0.1.5 выключал и помехи
                legacy.setdefault("name_noise", False)
            for k, v in legacy.items():
                matrix.setdefault(k, v)
            # «fullscreen» в config.json раньше означал то же, что теперь start_fullscreen
            if user.get("fullscreen") is True and "start_fullscreen" not in user:
                cfg["start_fullscreen"] = True
        except (ValueError, OSError) as e:
            print(f"[config] не удалось прочитать config.json: {e}", file=sys.stderr)
    return cfg


def save_config_keys(changes: dict) -> None:
    """Дописывает ключи в config.json, сохраняя всё остальное (например, metric_overrides).
    Повреждённый config.json не перезаписываем — лучше сообщить, чем стереть чужие настройки."""
    data = {}
    if CONFIG_PATH.exists():
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))   # ValueError, если файл битый
        if not isinstance(data, dict):
            raise ValueError("config.json не является объектом JSON")
    data = _deep_merge(data, changes)
    tmp = CONFIG_PATH.with_name(CONFIG_PATH.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, CONFIG_PATH)                                       # атомарно: файл не останется наполовину записанным


def _position_monitor(window: dict, monitors: list[dict]) -> dict | None:
    """Определить монитор по наибольшей видимой части сохранённого окна."""
    x, y = window.get("x"), window.get("y")
    if x is None or y is None or x == -32000 or y == -32000:
        return None
    width, height = window["width"], window["height"]
    inset_x, inset_y = min(8, (width - 1) // 2), min(8, (height - 1) // 2)

    def overlap(mon):
        left, top = mon["x"], mon["y"]
        visible_width = min(x + width - inset_x, left + mon["width"]) - max(x + inset_x, left)
        visible_height = min(y + height - inset_y, top + mon["height"]) - max(y + inset_y, top)
        return max(0, visible_width) * max(0, visible_height)

    return max((mon for mon in monitors if overlap(mon)), key=overlap, default=None)


def _startup_window(config: dict, monitors: list[dict], *, fill_screen: bool) -> tuple[dict, str | None]:
    """Положение при запуске и монитор, который HUD должен помнить при его отключении."""
    saved = config["window"]
    geometry = {}
    for key in ("width", "height"):
        value = saved.get(key)
        geometry[key] = value if type(value) is int and 0 < value <= 65535 else DEFAULT_CONFIG["window"][key]
    for key in ("x", "y"):
        value = saved.get(key)
        geometry[key] = value if type(value) is int and value != -32000 else None
    saved_device = saved.get("last_monitor")
    if not isinstance(saved_device, str) or not DEVICE_RE.fullmatch(saved_device):
        saved_device = None
    if not monitors:
        # Если Windows временно не дала карту экранов, размещение выбирает сама ОС.
        geometry.update(x=None, y=None)
        return geometry, saved_device

    by_device = {mon["device"]: mon for mon in monitors}
    explicit = by_device.get(config["monitor"]) if isinstance(config.get("monitor"), str) else None
    position_monitor = _position_monitor(geometry, monitors)
    remembered = by_device.get(saved_device) if saved_device else position_monitor
    target = explicit or remembered
    if target is None:
        primary = next((mon for mon in monitors if mon["primary"]), monitors[0])
        target = primary
    if not fill_screen and not explicit and remembered is not None and position_monitor is remembered:
        # После смены разрешения окно может пересекать экран только нижним краем.
        # Сохраняем точное положение, только если за заголовок можно взяться мышью.
        x, y = geometry["x"], geometry["y"]
        right = min(x + geometry["width"], target["x"] + target["width"])
        visible_width = right - max(x, target["x"])
        if visible_width >= min(64, geometry["width"]) and target["y"] <= y + 8 < target["y"] + target["height"] - 8:
            return geometry, remembered["device"]
    # Windows выбирает экран для разворачивания по стартовому прямоугольнику.
    # Помещаем его целиком на выбранный экран, даже если он уже остальных.
    for axis, size in (("x", "width"), ("y", "height")):
        geometry[size] = min(geometry[size], target[size])
        geometry[axis] = target[axis] + min(40, (target[size] - geometry[size]) // 2)
    return geometry, target["device"] if explicit or remembered else saved_device


class Api:
    """Мост, доступный из JS как window.pywebview.api.*"""

    def __init__(self, manager: SourceManager, config: dict):
        self._manager = manager
        self._config = config
        # опрос и отчёт идут из разных потоков pywebview — не даём им читать датчики одновременно
        self._lock = threading.Lock()
        self._window = None
        self._fullscreen = bool(config.get("fullscreen") or config.get("start_fullscreen"))
        self._last_monitor = None

    def set_window(self, window) -> None:
        self._window = window

    def toggle_fullscreen(self) -> dict:
        """Кнопка «Весь экран» / F11 — только до закрытия HUD. Открываться сразу на весь
        экран — отдельная настройка start_fullscreen в панели «Настройки»."""
        if self._window is None:
            return {"ok": False, "fullscreen": self._fullscreen}
        self._window.toggle_fullscreen()
        self._fullscreen = not self._fullscreen
        return {"ok": True, "fullscreen": self._fullscreen}

    # ── монитор, на котором HUD закрыли: там же он и откроется ──
    def _monitor_to_remember(self, device: str) -> str:
        if device and self._last_monitor and device != self._last_monitor:
            monitors = {mon["device"]: mon for mon in list_monitors()}
            # Windows перенесла окно на основной после отключения запомненного экрана.
            if not monitors or (self._last_monitor not in monitors and monitors.get(device, {}).get("primary")):
                return self._last_monitor
        return device

    def window_moved(self, x: int, y: int) -> None:
        if x == -32000 or y == -32000:
            return
        device = window_device(self._window)
        if device:
            self._last_monitor = self._monitor_to_remember(device)

    def window_closing(self) -> None:
        device = window_device(self._window)
        if device is None:
            return
        remembered = self._monitor_to_remember(device)
        on_fallback = remembered != device
        if on_fallback and remembered == self._config["window"].get("last_monitor"):
            return
        try:
            saved = {"last_monitor": remembered}
            # pywebview ждёт событие shown при чтении x/y. При раннем закрытии
            # не блокируем этот же поток окна ожиданием показа.
            native_state = getattr(getattr(self._window, "native", None), "WindowState", None)
            if not on_fallback and self._window.events.shown.is_set() and str(native_state) != "Minimized":
                x, y = self._window.x, self._window.y
                if x != -32000 and y != -32000:
                    saved.update(x=x, y=y)
            save_config_keys({"window": saved})
        except (OSError, ValueError):
            pass

    def quit(self) -> None:
        """Кнопка «Выйти» — на весь экран крестика нет. Монитор запоминаем, как при закрытии."""
        if self._window is not None:
            # из потока JS-моста: закрываем чуть позже, чтобы вызов успел вернуться
            threading.Timer(0.05, self._window.destroy).start()

    def get_snapshot(self) -> dict:
        with self._lock:
            return self._manager.snapshot()

    def launch_app(self, app: str) -> dict:
        """Кнопки HWiNFO / RTSS в подвале: запустить программу или открыть страницу загрузки."""
        from .launcher import launch
        return launch(app)

    def save_report(self) -> dict:
        """Кнопка «Отчёт»: скриншот + датчики в .zip на рабочем столе."""
        from .report import save_report
        with self._lock:
            return save_report(self._manager)

    def get_config(self) -> dict:
        return {
            "poll_interval_ms": self._config.get("poll_interval_ms", 1000),
            "start_fullscreen": self._config["start_fullscreen"],
            "monitor": self._config["monitor"],
            "hwinfo_auto": self._config["hwinfo_auto"],
            "monitors": [{"device": m["device"], "label": m["label"]} for m in labeled_monitors()],
            "theme": self._config["theme"],
            "themes": self._config["themes"],
            "fullscreen": self._fullscreen,
            "version": __version__,
        }

    def get_system_theme(self) -> dict:
        """Тема «Windows 11»: тёмный/светлый режим и цвет акцента из «Персонализации»."""
        from .system_theme import system_theme
        return system_theme()

    # ── «Настройки» → HWiNFO ──
    def hwinfo_status(self) -> dict:
        from .hwinfo_setup import status
        return status()

    def hwinfo_setup(self) -> dict:
        """Закрыть HWiNFO, поставить галки, создать задание, запустить незаметно.
        Windows один раз спросит разрешение (HWiNFO — в Program Files)."""
        from .hwinfo_setup import setup
        return setup()

    def hwinfo_remove(self) -> dict:
        from .hwinfo_setup import remove
        return remove()

    def save_settings(self, changes: dict) -> dict:
        """Панель «Настройки»: применить и дописать в config.json, не трогая остальные ключи."""
        bad = _settings_error(changes)
        if bad:
            return {"ok": False, "error": f"недопустимая настройка: {bad}"}
        try:
            save_config_keys(changes)
        except (OSError, ValueError) as e:
            return {"ok": False, "error": str(e)}
        self._config.update(_deep_merge(self._config, changes))
        return {"ok": True}


def run_list_mode(manager: SourceManager) -> None:
    snap = manager.snapshot()
    print(f"Активный источник: {snap['source_display']} ({snap['source']})")
    if snap["warning"]:
        print(f"Предупреждение: {snap['warning']}")
    print("\nРаспознанные метрики:")
    for key, m in snap["metrics"].items():
        print(f"  {key:12} = {m['value']} {m['unit']:4}  <- [{m['sensor']}] {m['label']}")
    raw = manager.list_raw()
    print(f"\nВсего сырых датчиков: {len(raw)}")
    print("Подсказка: привязать метрику в config.json -> metric_overrides можно")
    print('по ключу {"key": "..."} (колонка слева, только HWiNFO) или по sensor/label\n')
    for r in raw:
        key = getattr(r, "key", "") or ""
        print(f"  {key:>14} [{(r.kind or ''):6}] {r.value:>10} {r.unit:4} | {r.sensor} :: {r.label}")


def main() -> None:
    # консоль Windows по умолчанию не UTF-8 — кириллица в метках превращается в �
    if sys.stdout and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="PC HUD — монитор железа для второго экрана")
    parser.add_argument("--demo", action="store_true", help="принудительно демо-данные")
    parser.add_argument("--fullscreen", action="store_true", help="полный экран")
    parser.add_argument("--list", action="store_true", help="показать сырые датчики и выйти")
    # помощник с правами администратора: его запускает HUD (setup/remove) или задание (restart)
    for action in ("setup", "restart", "remove"):
        parser.add_argument(f"--hwinfo-{action}", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    for action in ("setup", "restart", "remove"):
        if getattr(args, f"hwinfo_{action}"):
            from .hwinfo_setup import elevated_main
            sys.exit(elevated_main(action))

    config = load_config()
    if args.demo:
        config["source"] = "demo"
    if args.fullscreen:
        config["fullscreen"] = True

    manager = SourceManager(config)

    if args.list:
        run_list_mode(manager)
        return

    snap = manager.snapshot()
    print(f"[pchud] источник: {snap['source_display']}")
    if snap["warning"]:
        print(f"[pchud] {snap['warning']}")

    try:
        import webview  # pywebview
    except ImportError:
        print(
            "Не найден pywebview. Установите зависимости:\n    pip install -r requirements.txt",
            file=sys.stderr,
        )
        sys.exit(1)

    api = Api(manager, config)
    win_cfg = config["window"]
    maximized = not api._fullscreen and win_cfg.get("maximized", True)
    geometry, api._last_monitor = _startup_window(config, startup_monitors(), fill_screen=api._fullscreen or maximized)

    window = webview.create_window(
        "PC HUD",
        url=str(WEB_DIR / "index.html"),
        js_api=api,
        **geometry,
        frameless=win_cfg.get("frameless", False),
        easy_drag=win_cfg.get("frameless", False),
        background_color="#0a0e14",
        fullscreen=api._fullscreen,
        # не на весь экран — развёрнутым: так низ окна не уходит под панель задач
        maximized=maximized,
    )
    api.set_window(window)
    window.events.moved += api.window_moved
    window.events.closing += api.window_closing

    webview.start()


if __name__ == "__main__":
    main()
