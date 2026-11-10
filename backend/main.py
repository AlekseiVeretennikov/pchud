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
    "window": {"width": 1920, "height": 1080, "x": None, "y": None, "frameless": False},
    "metric_overrides": {},
    "drives": None,        # список букв (["C:", "Z:"]) или None = все диски с датчиком
    "vram_total_gb": None, # полный объём VRAM для подписи "занято/всего"
    "background": "cipher-rain",  # файл из web/backgrounds/ или "none"
    "label_glitch": True,  # редкая замена букв в подписях
}


def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    if CONFIG_PATH.exists():
        try:
            user = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            cfg.update({k: v for k, v in user.items() if k != "window"})
            if "window" in user:
                cfg["window"].update(user["window"])
        except (ValueError, OSError) as e:
            print(f"[config] не удалось прочитать config.json: {e}", file=sys.stderr)
    return cfg


class Api:
    """Мост, доступный из JS как window.pywebview.api.*"""

    def __init__(self, manager: SourceManager, config: dict):
        self._manager = manager
        self._config = config
        # опрос и отчёт идут из разных потоков pywebview — не даём им читать датчики одновременно
        self._lock = threading.Lock()

    def get_snapshot(self) -> dict:
        with self._lock:
            return self._manager.snapshot()

    def save_report(self) -> dict:
        """Кнопка «Отчёт»: скриншот + датчики в .zip на рабочем столе."""
        from .report import save_report
        with self._lock:
            return save_report(self._manager)

    def get_config(self) -> dict:
        return {
            "poll_interval_ms": self._config.get("poll_interval_ms", 1000),
            "background": self._config["background"],
            "label_glitch": self._config["label_glitch"],
        }


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
        fullscreen=config["fullscreen"],
    )

    webview.start()


if __name__ == "__main__":
    main()
