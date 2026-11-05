"""
Источник данных: LibreHardwareMonitor.

LibreHardwareMonitor (LHM) — open-source утилита мониторинга. У неё есть встроенный
веб-сервер (Remote Web Server), который отдаёт все датчики в виде JSON по адресу
http://localhost:8085/data.json. Мы читаем именно его — это значит:

  * нам НЕ нужно тащить kernel-драйвер в собственный процесс;
  * драйвер (WinRing0) поднимает сам LHM, а не мы.

Важно про античиты: kernel-драйвер, который использует LHM для доступа к датчикам,
исторически вызывает вопросы у агрессивных античитов (например, Vanguard у Valorant).
Поэтому в проекте этот источник — запасной, а основным по умолчанию идёт HWiNFO.
Пользователь видит предупреждение в README и в логе при выборе LHM во время игры.

Чтобы источник заработал, пользователь должен:
  1. Запустить LibreHardwareMonitor.
  2. Options -> Remote Web Server -> Run (порт по умолчанию 8085).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass

DEFAULT_URL = "http://localhost:8085/data.json"


@dataclass
class Reading:
    sensor: str
    label: str
    value: float
    unit: str
    kind: str


# сопоставление единиц LHM с нашими типами показаний
_UNIT_TO_KIND = {
    "°C": "temp",
    "%": "usage",
    "MHz": "clock",
    "W": "power",
    "RPM": "fan",
    "V": "volt",
    "GB": "data",
    "MB": "data",
}


def _parse_value(text: str) -> tuple[float, str]:
    """LHM отдаёт значение строкой вида '49.0 °C' / '5540 MHz' / '7 %'."""
    text = (text or "").strip()
    if not text:
        return 0.0, ""
    parts = text.split(None, 1)
    raw_num = parts[0].replace(",", ".")
    unit = parts[1].strip() if len(parts) > 1 else ""
    try:
        return float(raw_num), unit
    except ValueError:
        return 0.0, unit


class LibreHardwareMonitorSource:
    name = "libre"
    display_name = "LibreHardwareMonitor (web server)"

    def __init__(self, url: str = DEFAULT_URL) -> None:
        self.url = url

    def available(self) -> bool:
        try:
            with urllib.request.urlopen(self.url, timeout=0.5) as resp:
                return resp.status == 200
        except (urllib.error.URLError, OSError, TimeoutError):
            return False

    def read(self) -> list[Reading]:
        try:
            with urllib.request.urlopen(self.url, timeout=1.0) as resp:
                tree = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError):
            return []

        out: list[Reading] = []

        def walk(node: dict, sensor_path: str) -> None:
            text = node.get("Text", "")
            value_field = node.get("Value", "")
            children = node.get("Children", [])
            # листовой узел с реальным показанием: есть Value и нет детей
            if value_field and not children:
                value, unit = _parse_value(value_field)
                out.append(
                    Reading(
                        sensor=sensor_path,
                        label=text,
                        value=value,
                        unit=unit,
                        kind=_UNIT_TO_KIND.get(unit, "other"),
                    )
                )
            new_path = f"{sensor_path} / {text}" if sensor_path and text else (text or sensor_path)
            for child in children:
                walk(child, new_path)

        walk(tree, "")
        return out
