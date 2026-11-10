"""
Менеджер источников данных.

Приоритет автовыбора:
  1. HWiNFO Shared Memory  — основной (безопаснее для античитов)
  2. AIDA64 Shared Memory  — альтернатива HWiNFO
  3. LibreHardwareMonitor   — запасной (поднимает kernel-драйвер, предупреждаем)
  4. Demo                    — если ничего нет (разработка / не-Windows)

Конфигом можно зафиксировать: source: "hwinfo"|"aida64"|"libre"|"demo"|"auto".
"""

from __future__ import annotations

import math
import time
import sys
from collections import deque

from .normalize import Metric, normalize, collect_cores, core_groups, collect_dimms, collect_drives, collect_network
from .diagnose import hwinfo_hint
from .parking import CoreParking
from .sources.demo import DemoSource

try:
    from .sources.hwinfo import HwinfoSource as HWiNFOSource
except Exception:
    HWiNFOSource = None  # type: ignore

try:
    from .sources.aida64 import Aida64Source
except Exception:
    Aida64Source = None  # type: ignore

from .sources.libre import LibreHardwareMonitorSource

try:
    from .sources.rtss import RtssSource
except Exception:
    RtssSource = None  # type: ignore


class SourceManager:
    def __init__(self, config: dict):
        self.config = config
        self.overrides = config.get("metric_overrides", {})
        self.active = None
        self.active_name = "none"
        self.warning: str | None = None
        self._broken: set[str] = set()  # источники, умершие на лету (напр. HWiNFO -> DEAD)
        # история загрузки по ядрам для спарклайнов: окно 60 с при опросе 1 раз/с
        self._core_hist: dict[int, deque] = {}
        # история фреймтайма активной игры (для графика в панели FPS)
        self._ft_hist: deque = deque(maxlen=60)
        self._ft_app: str | None = None
        # история скоростей сети (спарклайны DL/UP)
        self._net_dl: deque = deque(maxlen=60)
        self._net_up: deque = deque(maxlen=60)
        # история температур платы (VRM / чипсет / система), окно 10 минут
        self._mb_hist: dict[str, deque] = {}
        # история GPU-плиток (hot spot / max RPM вентиляторов / нагрузка шины), окно 10 минут
        self._gpu_hist: dict[str, deque] = {}
        # история температур планок RAM по слотам, окно 10 минут
        self._dimm_hist: dict[int, deque] = {}
        # RTSS — дополнительный канал (только FPS игры), работает поверх основного
        self._rtss = RtssSource() if (RtssSource is not None and sys.platform == "win32") else None
        # статус парковки ядер из Windows: спящие ядра помечаются в HUD
        self._parking = CoreParking()
        self._preferred = config.get("source", "auto")
        self._next_retry = 0.0
        self._select(self._preferred)

    def _candidates(self) -> list:
        out = []
        if HWiNFOSource is not None and sys.platform == "win32":
            out.append(HWiNFOSource())
        if Aida64Source is not None and sys.platform == "win32":
            out.append(Aida64Source())
        out.append(LibreHardwareMonitorSource(self.config.get("libre_url", "http://localhost:8085/data.json")))
        out.append(DemoSource())
        return [s for s in out if s.name not in self._broken]

    def _is_available(self, src) -> bool:
        avail = src.available
        # HWiNFOSource.available — staticmethod, у остальных обычный метод; вызывается одинаково
        try:
            return bool(avail())
        except Exception:
            return False

    def _select(self, preferred: str) -> None:
        if preferred and preferred != "auto":
            for src in self._candidates():
                if src.name == preferred and self._is_available(src):
                    self._activate(src)
                    return
            # запрошенный источник недоступен — падаем в авто
        for src in self._candidates():
            if self._is_available(src):
                self._activate(src)
                return
        self._activate(DemoSource())

    def _activate(self, src) -> None:
        self.active = src
        self.active_name = src.name
        if src.name == "aida64":
            self.warning = (
                "Источник AIDA64 использует kernel-драйвер для доступа к датчикам. "
                "В играх с агрессивными античитами предпочтительнее HWiNFO."
            )
        elif src.name == "libre":
            self.warning = (
                "Источник LibreHardwareMonitor использует kernel-драйвер для доступа "
                "к датчикам. В играх с агрессивными античитами (например, Vanguard) "
                "это может вызвать проблемы. Для таких игр предпочтительнее HWiNFO."
            )
        elif src.name == "demo" and self._preferred == "demo":
            self.warning = "Демо-режим: показаны выдуманные данные (source: demo или запуск с --demo)."
        elif src.name == "demo":
            self.warning = "Показаны демо-данные, это не ваш ПК. " + hwinfo_hint(HWiNFOSource)
        else:
            self.warning = None
        # демо умеет генерировать «прошлое» — спарклайны полны сразу, удобно отлаживать
        if src.name == "demo" and hasattr(src, "core_history"):
            self._core_hist = {
                cid: deque(vals, maxlen=60) for cid, vals in src.core_history().items()
            }

    def _read_active(self) -> list:
        """Читает активный источник; если он умер на лету — переключается.

        Главный сценарий: HWiNFO помечает shared memory как DEAD (закрыт или
        истёк 12-часовой лимит бесплатной версии) — HwinfoSource.read() кидает
        HwinfoDeadError. Исключаем умерший источник, выбираем следующий по
        приоритету и показываем это в HUD через warning.
        """
        if not self.active:
            return []
        try:
            return self.active.read()
        except Exception as e:
            died = self.active_name
            self._broken.add(died)
            self._select("auto")
            switch_note = (
                f"Источник {died} перестал отвечать ({e}). "
                f"Переключились на: {getattr(self.active, 'display_name', self.active_name)}."
            )
            self.warning = f"{switch_note} {self.warning}" if self.warning else switch_note
            try:
                return self.active.read()
            except Exception:
                return []

    def _retry_real_source(self) -> None:
        """В демо-режиме раз в 5 секунд снова ищем настоящий источник.

        HUD могли запустить раньше HWiNFO, или HWiNFO перезапустили после
        12-часового лимита — тогда переключаемся сами, без перезапуска HUD.
        """
        if self.active_name != "demo" or self._preferred == "demo":
            return
        now = time.monotonic()
        if now < self._next_retry:
            return
        self._next_retry = now + 5
        self._broken.clear()
        self._select(self._preferred)

    def snapshot(self) -> dict:
        self._retry_real_source()
        readings = self._read_active()
        metrics = normalize(readings, self.overrides)
        cores = collect_cores(readings)

        # пополняем историю загрузки и отдаём её вместе с ядрами;
        # кламп 0-100: HWiNFO Core Utility может отдавать чуть больше 100%
        for c in cores:
            hist = self._core_hist.setdefault(c["id"], deque(maxlen=60))
            load = float(c["load"]) if c["load"] is not None else 0.0
            hist.append(min(100.0, max(0.0, load)))
            c["history"] = list(hist)

        parked = self._parking.parked_cores(len(cores))
        for c in cores:
            c["sleep"] = c["id"] in parked

        cpu_metric = metrics.get("cpu_temp") or metrics.get("cpu_load")
        groups = core_groups(cores, cpu_metric.raw_sensor if cpu_metric else "")

        # У HWiNFO нет агрегированной частоты CPU — берём максимум по ядрам
        # (если пользователь не привязал cpu_clock явно в конфиге).
        # Спящие ядра не считаем: их частота в HWiNFO не отражает работу.
        if "cpu_clock" not in self.overrides:
            clocks = [c["clock"] for c in cores if c.get("clock") and not c["sleep"]]
            if clocks:
                base = metrics.get("cpu_clock")
                metrics["cpu_clock"] = Metric(
                    "cpu_clock", round(max(clocks)), "MHz",
                    base.raw_sensor if base else "CPU", "Max Core Clock",
                )

        # Вентиляторы GPU: полный список RPM (для плитки) + максимум как метрика
        gpu_fans = [
            round(float(r.value)) for r in readings
            if r.kind == "fan" and any(
                w in (r.sensor or "").lower() for w in ("gpu", "geforce", "radeon", "nvidia")
            )
        ]
        if gpu_fans and "gpu_fan" not in metrics:
            metrics["gpu_fan"] = Metric("gpu_fan", max(gpu_fans), "RPM", "GPU", "Fan (max)")

        # Термистор чипсета на плате: при двух датчиках ("Чипсет A"/"Чипсет B")
        # показываем максимум; явная привязка в конфиге отключает это поведение.
        if "chipset_board_temp" not in self.overrides:
            mobo_words = ("nuvoton", "nct", "it87", "ite ", "motherboard", "mainboard")
            chip = [
                r.value for r in readings
                if r.kind == "temp"
                and any(w in (r.sensor or "").lower() for w in mobo_words)
                and any(w in (r.label or "").lower() for w in ("чипсет", "chipset", "pch"))
            ]
            if chip:
                metrics["chipset_board_temp"] = Metric(
                    "chipset_board_temp", round(max(chip), 1), "°C", "Motherboard", "Chipset (max)"
                )

        # история температур платы для спарклайнов: окно 10 минут при тике 1 с
        for hkey, mkey in (("vrm", "vrm_temp"), ("chipset", "chipset_temp"), ("sys", "mobo_temp")):
            mtr = metrics.get(mkey)
            if mtr is not None:
                self._mb_hist.setdefault(hkey, deque(maxlen=600)).append(round(float(mtr.value), 1))

        # история GPU-плиток: hot spot, максимум оборотов, нагрузка шины
        for hkey, val in (
            ("hotspot", metrics["gpu_hotspot"].value if "gpu_hotspot" in metrics else None),
            ("fan", max(gpu_fans) if gpu_fans else None),
            ("bus", metrics["bus_load"].value if "bus_load" in metrics else None),
        ):
            if val is not None:
                self._gpu_hist.setdefault(hkey, deque(maxlen=600)).append(round(float(val), 1))

        dimms = collect_dimms(readings)
        for d in dimms:
            hist = self._dimm_hist.setdefault(d["slot"], deque(maxlen=600))
            hist.append(round(d["temp"], 1))
            d["history"] = list(hist)

        # FPS из RTSS: {"app_name", "fps", "frametime_ms"} или None (нет игры / RTSS не запущен)
        fps_info = None
        rtss_running = False
        if self._rtss is not None:
            try:
                rtss_running = self._rtss.available()
                fps_info = self._rtss.read() if rtss_running else None
            except Exception:
                fps_info = None

        # график фреймтайма: копим историю, при смене игры (или её закрытии) сбрасываем
        if fps_info:
            if fps_info["app_name"] != self._ft_app:
                self._ft_app = fps_info["app_name"]
                self._ft_hist.clear()
            self._ft_hist.append(float(fps_info["frametime_ms"]))
            fps_info["history"] = [round(v, 2) for v in self._ft_hist]
            # 1% low: 99-й перцентиль фреймтайма за окно, выраженный в FPS
            worst = sorted(self._ft_hist)
            p99 = worst[min(len(worst) - 1, max(0, math.ceil(len(worst) * 0.99) - 1))]
            fps_info["low1_fps"] = round(1000.0 / p99, 1) if p99 > 0 else None
        else:
            self._ft_app = None
            self._ft_hist.clear()

        # сеть: пополняем историю скоростей для спарклайнов
        network = collect_network(readings)
        if network:
            self._net_dl.append(network["dl_mbps"])
            self._net_up.append(network["up_mbps"])
            network["dl_history"] = [round(v, 2) for v in self._net_dl]
            network["up_history"] = [round(v, 2) for v in self._net_up]
        else:
            self._net_dl.clear()
            self._net_up.clear()

        return {
            "source": self.active_name,
            "source_display": getattr(self.active, "display_name", self.active_name),
            "warning": self.warning,
            "fps": fps_info,
            "rtss_running": rtss_running,
            "mb_history": {k: list(d) for k, d in self._mb_hist.items()},
            "gpu_history": {k: list(d) for k, d in self._gpu_hist.items()},
            "gpu_fans": gpu_fans,
            "dimms": dimms,
            "drives": collect_drives(readings, self.config.get("drives")),
            "network": network,
            # из конфига, иначе из датчиков (занятая + свободная видеопамять)
            "vram_total_gb": self.config.get("vram_total_gb")
                             or (metrics["vram_total"].value if "vram_total" in metrics else None),
            "metrics": {
                k: {"value": m.value, "unit": m.unit, "sensor": m.raw_sensor, "label": m.raw_label}
                for k, m in metrics.items()
            },
            "cores": cores,
            "core_groups": groups,
            "sensor_count": len(readings),   # для заставки при запуске
        }

    def list_raw(self) -> list:
        """Для режима --list: все сырые датчики, чтобы пользователь нашёл нужные строки."""
        return self._read_active()
