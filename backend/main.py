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
import sys
import threading
import time
from pathlib import Path

from . import __version__
from .manager import SourceManager

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
    "background": "cipher-rain",  # файл из web/backgrounds/ или "none"
    # всё ниже меняется и в панели «Настройки» внизу HUD
    "bg_brightness": 100,  # яркость фона, 10–100 %
    "bg_field": True,      # поле тусклых символов
    "bg_drops": True,      # стекающие капли
    "bg_words": True,      # проступающие слова
    "label_glitch": True,  # «шифрование» букв в подписях
    "name_noise": True,    # помехи в названиях CPU/GPU
    "fx_rate": "normal",   # как часто идут эти два эффекта: "low", "normal" или "high"
    "boot_mode": "hacker", # заставка: "hacker" (взлом), "short" (короткая) или "off"
    "start_fullscreen": False,  # «Всегда открывать на весь экран»
}

# что панель «Настройки» может менять, и как проверять значение
SETTINGS = {
    "background": lambda v: v in ("cipher-rain", "none"),
    "bg_brightness": lambda v: isinstance(v, int) and not isinstance(v, bool) and 10 <= v <= 100,
    "bg_field": lambda v: isinstance(v, bool),
    "bg_drops": lambda v: isinstance(v, bool),
    "bg_words": lambda v: isinstance(v, bool),
    "label_glitch": lambda v: isinstance(v, bool),
    "name_noise": lambda v: isinstance(v, bool),
    "fx_rate": lambda v: v in ("low", "normal", "high"),
    "boot_mode": lambda v: v in ("hacker", "short", "off"),
    "start_fullscreen": lambda v: isinstance(v, bool),
}


def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    if CONFIG_PATH.exists():
        try:
            user = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            cfg.update({k: v for k, v in user.items() if k != "window"})
            if "window" in user:
                cfg["window"].update(user["window"])
            # до 0.1.5 заставка включалась флагом boot_animation
            if user.get("boot_animation") is False and "boot_mode" not in user:
                cfg["boot_mode"] = "off"
            # «fullscreen» в config.json раньше означал то же, что теперь start_fullscreen
            if user.get("fullscreen") is True and "start_fullscreen" not in user:
                cfg["start_fullscreen"] = True
            # до 0.1.5 label_glitch выключал и помехи в названиях
            if user.get("label_glitch") is False and "name_noise" not in user:
                cfg["name_noise"] = False
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
    for key, value in changes.items():
        # вложенные словари (window) дополняем, а не заменяем целиком
        if isinstance(value, dict) and isinstance(data.get(key), dict):
            data[key] = {**data[key], **value}
        else:
            data[key] = value
    tmp = CONFIG_PATH.with_name(CONFIG_PATH.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, CONFIG_PATH)                                       # атомарно: файл не останется наполовину записанным


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
        if x > -10000 and y > -10000:          # свёрнутое окно Windows уводит на -32000
            self._last_pos = (int(x), int(y))

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
            "background": self._config["background"],
            **{key: self._config[key] for key in SETTINGS},
            "fullscreen": self._fullscreen,
            "version": __version__,
        }

    def save_settings(self, changes: dict) -> dict:
        """Панель «Настройки»: применить и дописать в config.json, не трогая остальные ключи."""
        bad = [k for k, v in (changes or {}).items() if k not in SETTINGS or not SETTINGS[k](v)]
        if bad:
            return {"ok": False, "error": f"недопустимые настройки: {', '.join(bad)}"}
        try:
            save_config_keys(changes)
        except (OSError, ValueError) as e:
            return {"ok": False, "error": str(e)}
        self._config.update(changes)
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

    window = webview.create_window(
        "PC HUD",
        url=str(WEB_DIR / "index.html"),
        js_api=api,
        width=win_cfg["width"],
        height=win_cfg["height"],
        x=win_cfg["x"],
        y=win_cfg["y"],
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
