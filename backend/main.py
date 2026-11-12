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
from .monitors import DEVICE_RE

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
        if key == "start_fullscreen":
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


from .monitors import find as find_monitor, labeled_monitors  # noqa: E402


def _on_screen(x, y) -> bool:
    """Есть ли сейчас монитор в точке окна (x, y — левый верхний угол; у развёрнутого
    окна он на 8 px за краем монитора, поэтому смотрим чуть внутрь)."""
    if x is None or y is None:
        return False
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        user32.MonitorFromPoint.restype = wintypes.HMONITOR
        user32.MonitorFromPoint.argtypes = [wintypes.POINT, wintypes.DWORD]
        MONITOR_DEFAULTTONULL = 0
        return bool(user32.MonitorFromPoint(wintypes.POINT(int(x) + 50, int(y) + 50), MONITOR_DEFAULTTONULL))
    except (AttributeError, OSError):
        return True    # не Windows — проверить нечем, верим сохранённому


class Api:
    """Мост, доступный из JS как window.pywebview.api.*"""

    def __init__(self, manager: SourceManager, config: dict):
        self._manager = manager
        self._config = config
        # опрос и отчёт идут из разных потоков pywebview — не даём им читать датчики одновременно
        self._lock = threading.Lock()
        self._window = None
        self._fullscreen = bool(config.get("fullscreen") or config.get("start_fullscreen"))
        self._last_pos = None
        # где окно было до последнего перемещения: сначала — запомненное в config.json
        win = config.get("window") or {}
        self._prev_pos = (win["x"], win["y"]) if win.get("x") is not None and win.get("y") is not None else None

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
    def window_moved(self, x: int, y: int) -> None:
        if x <= -10000 or y <= -10000:         # свёрнутое окно Windows уводит на -32000
            return
        # Монитор, где было окно, пропал (портативный уснул или выключился) — это Windows
        # сама перенесла окна на основной. Такой перенос не запоминаем: иначе HUD
        # «забудет» портативный монитор и в следующий раз откроется на основном.
        if self._prev_pos is not None and not _on_screen(*self._prev_pos):
            return
        self._last_pos = self._prev_pos = (int(x), int(y))

    def window_closing(self) -> None:
        if self._last_pos is None:
            return
        try:
            save_config_keys({"window": {"x": self._last_pos[0], "y": self._last_pos[1]}})
        except (OSError, ValueError):
            pass

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
            "monitors": [{"device": m["device"], "label": m["label"]} for m in labeled_monitors()],
            "theme": self._config["theme"],
            "themes": self._config["themes"],
            "fullscreen": self._fullscreen,
            "version": __version__,
        }

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
    args = parser.parse_args()

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
    x, y = win_cfg["x"], win_cfg["y"]
    # «Открывать на» конкретном мониторе — если он сейчас подключён
    chosen = config.get("monitor", "auto")
    if chosen != "auto":
        mon = find_monitor(chosen)
        if mon:
            x, y = mon["x"] + 40, mon["y"] + 40     # развёрнутое окно займёт этот монитор целиком
        else:
            print(f"[pchud] монитора {chosen} сейчас нет — открываю там, где закрыли")
    # запомненного монитора сейчас нет (портативный выключен) — открываемся на основном,
    # а не за краем экрана; сам запомненный монитор в config.json остаётся
    if x is not None and not _on_screen(x, y):
        print(f"[pchud] монитора в точке {x},{y} сейчас нет — открываю на основном")
        x = y = None

    window = webview.create_window(
        "PC HUD",
        url=str(WEB_DIR / "index.html"),
        js_api=api,
        width=win_cfg["width"],
        height=win_cfg["height"],
        x=x,
        y=y,
        frameless=win_cfg.get("frameless", False),
        easy_drag=win_cfg.get("frameless", False),
        background_color="#0a0e14",
        fullscreen=api._fullscreen,
        # не на весь экран — развёрнутым: так низ окна не уходит под панель задач
        maximized=not api._fullscreen and win_cfg.get("maximized", True),
    )
    api.set_window(window)
    window.events.moved += api.window_moved
    window.events.closing += api.window_closing

    webview.start()


if __name__ == "__main__":
    main()
