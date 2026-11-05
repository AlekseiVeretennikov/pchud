"""
Дамп всех показаний HWiNFO Shared Memory.

Печатает каждое показание с уникальным ключом "sensorIndex:readingID" —
эти ключи вставляются в конфиг HUD (metric_overrides / выбор метрик).

Запуск (из корня проекта, HWiNFO должен работать с включённой Shared Memory):
    .venv\\Scripts\\python tools\\dump_hwinfo.py
    .venv\\Scripts\\python tools\\dump_hwinfo.py --type temp   # только температуры
    .venv\\Scripts\\python tools\\dump_hwinfo.py --grep cpu    # фильтр по подстроке
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.sources.hwinfo import HwinfoDeadError, HwinfoSource, HwinfoUnavailableError


def main() -> int:
    # консоль Windows по умолчанию не UTF-8 — иначе кириллица и ° превращаются в �
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Дамп показаний HWiNFO Shared Memory")
    parser.add_argument("--type", dest="kind", help="фильтр по типу: temp, clock, usage, power, fan, volt, current, other")
    parser.add_argument("--grep", help="фильтр по подстроке в имени сенсора или метке (без учёта регистра)")
    args = parser.parse_args()

    src = HwinfoSource()
    try:
        data = src.read_grouped()
    except HwinfoDeadError as e:
        print(f"HWiNFO мёртв: {e}", file=sys.stderr)
        return 2
    except HwinfoUnavailableError as e:
        print(f"HWiNFO недоступен: {e}", file=sys.stderr)
        print("Проверьте: HWiNFO запущен, Settings -> Main Settings -> Shared Memory Support включён.", file=sys.stderr)
        return 1

    total = 0
    for sensor in data["sensors"]:
        readings = sensor["readings"]
        if args.kind:
            readings = [r for r in readings if r["type"] == args.kind]
        if args.grep:
            needle = args.grep.lower()
            readings = [
                r for r in readings
                if needle in r["label"].lower() or needle in sensor["name"].lower()
            ]
        if not readings:
            continue

        print(f"\n=== [{sensor['index']}] {sensor['name']} ===")
        for r in readings:
            print(f"  {r['key']:>16}  {r['type']:<8} {r['label']:<50} {r['value']:>12.3f} {r['unit']}")
        total += len(readings)

    poll = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(data["poll_time"]))
    print(f"\nВсего показаний: {total}, последний опрос HWiNFO: {poll}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
