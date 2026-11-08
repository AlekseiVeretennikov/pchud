"""
Нормализация датчиков.

Главная задача — кросс-машинность. Имена датчиков у разных людей разные:
Intel vs AMD, NVIDIA vs Radeon, разные платы и SSD. Поэтому мы не хардкодим
конкретные метки, а описываем каждую метрику набором правил подбора
(по типу показания + ключевым словам в имени группы/метки).

Пользователь может переопределить любую метрику в config.json, явно указав
точные строки sensor/label со своего ПК (их видно в режиме --list).
"""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass, field


@dataclass
class MetricRule:
    key: str                       # стабильный идентификатор метрики (cpu_temp, gpu_load, ...)
    kind: str | None               # ожидаемый тип показания (temp/clock/usage/power) или None
    sensor_any: list[str] = field(default_factory=list)   # хотя бы одно слово в имени группы
    label_any: list[str] = field(default_factory=list)    # хотя бы одно слово в имени метки
    label_all: list[str] = field(default_factory=list)    # все слова в имени метки
    label_not: list[str] = field(default_factory=list)    # ни одного из этих слов в метке


# Порядок важен: первое сработавшее правило выигрывает.
DEFAULT_RULES: list[MetricRule] = [
    MetricRule("cpu_temp", "temp", sensor_any=["cpu", "core", "ryzen", "intel"],
               label_any=["package", "tctl", "tdie", "cpu"], label_not=["gpu"]),
    MetricRule("cpu_load", "usage", label_all=["total"], label_any=["cpu"],
               label_not=["gpu", "memory"]),
    # HWiNFO с русской локализацией: "Общая загрузка ЦП"
    MetricRule("cpu_load", "usage", label_any=["общая загрузка цп"]),
    MetricRule("cpu_load", "usage", sensor_any=["cpu", "ryzen", "intel"],
               label_any=["total", "usage", "utilization"], label_not=["gpu", "memory", "core #"]),
    MetricRule("cpu_clock", "clock", sensor_any=["cpu", "ryzen", "intel", "core"],
               label_any=["core", "cpu", "clock"], label_not=["gpu", "bus", "memory"]),
    # мощность всего процессора, а не отдельного домена (PPT, ядра)
    MetricRule("cpu_power", "power",
               label_any=["полная потребляемая мощность цп", "cpu package power"]),
    MetricRule("cpu_power", "power", sensor_any=["cpu", "ryzen", "intel"],
               label_any=["package", "cpu", "ppt"], label_not=["gpu"]),
    MetricRule("ccd1_temp", "temp", sensor_any=["cpu", "ryzen", "amd"],
               label_any=["ccd1", "ccd #1"], label_not=["gpu"]),
    MetricRule("ccd2_temp", "temp", sensor_any=["cpu", "ryzen", "amd"],
               label_any=["ccd2", "ccd #2"], label_not=["gpu"]),

    # Материнская плата: у HWiNFO сенсор называется по чипу мониторинга
    # (Nuvoton NCT..., ITE IT87...), у LHM — по модели платы
    MetricRule("mobo_temp", "temp",
               sensor_any=["nuvoton", "nct", "it87", "ite ", "motherboard", "mainboard"],
               label_any=["system", "система", "motherboard", "mainboard", "systin"]),
    # VRM: HWiNFO на Nuvoton называет датчик "MOS", встречаются "VR MOS" / "CPU VRM"
    MetricRule("vrm_temp", "temp",
               sensor_any=["nuvoton", "nct", "it87", "ite ", "motherboard", "mainboard"],
               label_any=["vr mos", "cpu vrm", "vrm", "mos"]),
    # Чипсет: предпочтительно кристалл (сенсор "AMD Чипсет" -> "Чипсет 1 (xHCI)"),
    # термистор платы ("Чипсет A") — отдельной метрикой для сравнения
    MetricRule("chipset_temp", "temp",
               sensor_any=["amd чипсет", "amd chipset", "pch"],
               label_any=["чипсет", "chipset", "pch"]),
    MetricRule("chipset_temp", "temp",
               sensor_any=["nuvoton", "nct", "it87", "ite ", "motherboard", "mainboard"],
               label_any=["чипсет", "chipset", "pch"]),
    MetricRule("chipset_board_temp", "temp",
               sensor_any=["nuvoton", "nct", "it87", "ite ", "motherboard", "mainboard"],
               label_any=["чипсет a", "chipset a"]),
    # Напряжения и вертушки с мониторинговой микросхемы платы
    MetricRule("vcore", "volt",
               sensor_any=["nuvoton", "nct", "it87", "ite ", "motherboard", "mainboard"],
               label_any=["vcore"]),
    MetricRule("soc_volt", "volt",
               sensor_any=["nuvoton", "nct", "it87", "ite ", "motherboard", "mainboard"],
               label_any=["nb/soc", "vsoc", "soc voltage"]),
    MetricRule("pump_rpm", "fan",
               sensor_any=["nuvoton", "nct", "it87", "ite ", "motherboard", "mainboard"],
               label_any=["pump", "помпа"]),

    MetricRule("gpu_temp", "temp", sensor_any=["gpu", "geforce", "radeon", "nvidia"],
               label_any=["gpu", "core", "hot spot", "температура гп"], label_not=["memory", "vram"]),
    # Hot Spot / junction: HWiNFO (рус.) называет это "Температура соединений в ГП"
    MetricRule("gpu_hotspot", "temp", sensor_any=["gpu", "geforce", "radeon", "nvidia"],
               label_any=["hot spot", "hotspot", "junction", "соединений"]),
    # Память GPU: у части карт (обычно топовых) есть отдельный датчик
    MetricRule("gpu_mem_temp", "temp", sensor_any=["gpu", "geforce", "radeon", "nvidia"],
               label_any=["memory junction", "memory temperature", "температура памяти"]),
    MetricRule("gpu_load", "usage", sensor_any=["gpu", "geforce", "radeon", "nvidia"],
               label_any=["core", "gpu", "d3d", "3d", "нагрузка на ядро"],
               label_not=["memory", "vram", "controller", "памяти"]),
    MetricRule("gpu_clock", "clock", sensor_any=["gpu", "geforce", "radeon", "nvidia"],
               label_any=["core", "gpu", "clock", "частота гп"],
               label_not=["memory", "vram", "video", "памяти", "эффективная", "видео"]),
    MetricRule("gpu_power", "power", sensor_any=["gpu", "geforce", "radeon", "nvidia"],
               label_any=["gpu", "power", "tgp", "asic"]),
    # HWiNFO: "Выделенная память ГП" / "GPU Memory Allocated" — вся занятая видеопамять
    # (в отличие от "Выделенная память D3D ГП", где только память Direct3D)
    MetricRule("vram_used", None, sensor_any=["gpu", "geforce", "radeon", "nvidia"],
               label_any=["выделенная память гп", "gpu memory allocated"]),
    MetricRule("vram_used", None, sensor_any=["gpu", "geforce", "radeon", "nvidia"],
               label_any=["memory used", "vram used", "used dedicated"]),
    # свободная видеопамять: вместе с занятой даёт полный объём VRAM
    MetricRule("vram_avail", None, sensor_any=["gpu", "geforce", "radeon", "nvidia"],
               label_any=["доступная память гп", "gpu memory available"]),
    MetricRule("vram_load", "usage", sensor_any=["gpu", "geforce", "radeon", "nvidia"],
               label_any=["использование памяти гп"]),
    MetricRule("vram_load", "usage", sensor_any=["gpu", "geforce", "radeon", "nvidia"],
               label_any=["memory", "vram"], label_all=["usage"]),
    # LHM называет этот датчик просто "GPU Memory" (без слова usage в метке)
    MetricRule("vram_load", "usage", sensor_any=["gpu", "geforce", "radeon", "nvidia"],
               label_any=["memory", "vram"],
               label_not=["controller", "video", "used", "free", "total", "dedicated", "shared"]),
    MetricRule("vram_clock", "clock", sensor_any=["gpu", "geforce", "radeon", "nvidia"],
               label_any=["частота памяти гп", "memory clock"],
               label_not=["эффективная", "effective"]),
    MetricRule("vram_ctrl_load", "usage", sensor_any=["gpu", "geforce", "radeon", "nvidia"],
               label_any=["контроллера памяти", "memory controller"]),
    MetricRule("bus_load", "usage", sensor_any=["gpu", "geforce", "radeon", "nvidia"],
               label_any=["нагрузка на шину", "bus interface", "bus load"]),
    # GT/s; у систем с iGPU сенсоров два — на этой машине dGPU привязан в конфиге
    MetricRule("pcie_speed", None, sensor_any=["dgpu", "geforce", "nvidia", "radeon", "gpu"],
               label_any=["скорость соединения pcie", "pcie link speed"]),

    # HWiNFO отдаёт показатели физической памяти с типом "other", поэтому тип не проверяем
    MetricRule("ram_load", None, label_any=["загрузка физической памяти", "physical memory load"]),
    MetricRule("ram_used", None, label_any=["используемая физическая память", "physical memory used"]),
    MetricRule("ram_avail", None, label_any=["доступная физическая память", "physical memory available"]),
    MetricRule("ram_load", "usage", label_any=["memory"], label_all=["usage"],
               label_not=["gpu", "vram", "virtual"]),
    # LHM: метка "Memory" в группе "Total Memory"
    MetricRule("ram_load", "usage", sensor_any=["total memory", "physical memory"],
               label_any=["memory"], label_not=["gpu", "vram"]),

    MetricRule("ram_used", None, label_any=["used memory", "physical memory used"],
               label_not=["virtual", "gpu"]),
    # LHM: "Memory Used" в группе "Total Memory" (не Virtual Memory)
    MetricRule("ram_used", None, sensor_any=["total memory", "physical memory"],
               label_any=["memory used"], label_not=["gpu"]),

    MetricRule("ram_avail", None, label_any=["available memory", "physical memory available"],
               label_not=["virtual", "gpu"]),
    # LHM: "Memory Available" в группе "Total Memory"
    MetricRule("ram_avail", None, sensor_any=["total memory", "physical memory"],
               label_any=["memory available"], label_not=["gpu"]),

    # label_not=["fullscreen"] исключает "-1" от iGPU (AMD Radeon / Fullscreen FPS)
    MetricRule("fps", None, label_any=["fps", "framerate", "frame rate"],
               label_not=["fullscreen"]),
]


@dataclass
class Metric:
    key: str
    value: float
    unit: str
    raw_sensor: str
    raw_label: str


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


_GPU_WORDS = ("gpu", "geforce", "radeon", "nvidia")
_MOBO_WORDS = ("nuvoton", "nct", "it87", "ite ", "motherboard", "mainboard")


def _gpu_score(sensor: str) -> int:
    """Чем выше, тем вероятнее это основная (дискретная) видеокарта.

    HWiNFO при двух видеокартах пишет "dGPU [#0]" и "iGPU [#1]"; LHM и HWiNFO
    с одной картой — просто имя модели, тогда встроенную узнаём по названию.
    """
    s = _norm(sensor)
    if "igpu" in s:
        return -10
    score = 10 if "dgpu" in s else 0
    if any(w in s for w in ("geforce", "rtx", "gtx", "radeon rx", "arc a", "arc b")):
        score += 5
    if any(w in s for w in ("radeon(tm) graphics", "radeon graphics", "uhd graphics",
                            "iris", "hd graphics")):
        score -= 5
    return score


def _fan_number(label: str) -> int:
    m = re.search(r"\d+", label)
    return int(m.group()) if m else 0


def _matches(reading, rule: MetricRule) -> bool:
    if rule.kind is not None and getattr(reading, "kind", None) != rule.kind:
        return False
    sensor = _norm(reading.sensor)
    label = _norm(reading.label)
    if rule.sensor_any and not any(w in sensor for w in rule.sensor_any):
        return False
    if rule.label_any and not any(w in label for w in rule.label_any):
        return False
    if rule.label_all and not all(w in label for w in rule.label_all):
        return False
    if rule.label_not and any(w in label for w in rule.label_not):
        return False
    return True


def normalize(readings: list, overrides: dict | None = None) -> dict[str, Metric]:
    """
    Превращает список сырых Reading в словарь {metric_key: Metric}.

    overrides — из конфига, формат:
        {"cpu_temp": {"sensor": "...", "label": "CPU Package"}}   — по именам, или
        {"cpu_temp": {"key": "4:16777216"}}                        — по ключу HWiNFO
                     (sensorIndex:readingID, видно в --list и tools/dump_hwinfo.py)
    Точное совпадение имеет приоритет над правилами.
    """
    overrides = overrides or {}
    result: dict[str, Metric] = {}

    # 1) явные переопределения пользователя
    for key, spec in overrides.items():
        want_key = spec.get("key", "")
        want_sensor = _norm(spec.get("sensor", ""))
        want_label = _norm(spec.get("label", ""))
        for r in readings:
            if want_key:
                if getattr(r, "key", None) != want_key:
                    continue
            else:
                if want_label and _norm(r.label) != want_label:
                    continue
                if want_sensor and want_sensor not in _norm(r.sensor):
                    continue
            result[key] = Metric(key, r.value, r.unit, r.sensor, r.label)
            break

    # 2) правила по умолчанию (не перетирают то, что уже задал пользователь).
    # Для датчиков видеокарты сначала смотрим основную карту, а не встроенную.
    gpu_first = sorted(readings, key=lambda r: -_gpu_score(r.sensor))
    for rule in DEFAULT_RULES:
        if rule.key in result:
            continue
        pool = gpu_first if any(w in rule.sensor_any for w in _GPU_WORDS) else readings
        for r in pool:
            if _matches(r, rule):
                result[rule.key] = Metric(rule.key, r.value, r.unit, r.sensor, r.label)
                break

    # 3) вентиляторы корпуса с платы: работающие, кроме процессорного и помпы
    if not any(k.startswith("fan_sys") for k in overrides):
        fans = [
            r for r in readings
            if r.kind == "fan" and r.value > 0
            and any(w in _norm(r.sensor) for w in _MOBO_WORDS)
            and not any(w in _norm(r.label) for w in ("pump", "помпа", "cpu", "цп"))
        ]
        fans.sort(key=lambda r: _fan_number(r.label))
        for i, r in enumerate(fans[:3], start=1):
            result[f"fan_sys{i}"] = Metric(f"fan_sys{i}", r.value, r.unit, r.sensor, r.label)

    # 4) объёмы памяти приводим к ГБ (HWiNFO отдаёт МБ, дашборд рассчитан на ГБ)
    for m in result.values():
        if m.unit.strip().lower() in ("мб", "mb"):
            m.value = round(m.value / 1024, 1)
            m.unit = "GB"

    # 5) полный объём видеопамяти = занятая + свободная, округлённо до целых ГБ
    used, avail = result.get("vram_used"), result.get("vram_avail")
    if used and avail and used.unit == avail.unit == "GB":
        result["vram_total"] = Metric("vram_total", round(used.value + avail.value), "GB",
                                      used.raw_sensor, "занято + доступно")

    return result


def collect_cores(readings: list) -> list:
    """
    Собирает данные по физическим ядрам CPU.
    Возвращает [{id: 0-based, clock: float|None, load: float|None}].
    Поддерживает LHM (Core #N / CPU Core #N) и HWiNFO (Core N / CPU Core N Usage).
    """
    clocks: dict[int, float] = {}
    thread0: dict[int, float] = {}
    thread1: dict[int, float] = {}
    temps:   dict[int, float] = {}
    ccds:    dict[int, int] = {}    # номер CCD из подписи HWiNFO "Core8 (CCD2)"

    for r in readings:
        sensor = _norm(r.sensor)
        label  = _norm(r.label)

        # Пропускаем GPU-датчики
        if any(w in sensor for w in ("gpu", "geforce", "radeon", "nvidia")):
            continue

        if r.kind == "clock":
            # LHM: "Core #N" (без суффикса "(Effective)")
            m = re.fullmatch(r"core\s*#(\d+)", label)
            if m:
                clocks[int(m.group(1)) - 1] = float(r.value)  # 1-based → 0-based
            else:
                # HWiNFO: "Core N Частота (perf #X)" / "Core N Clock";
                # эффективную частоту ("Core N T0 Эффективная...") пропускаем
                m = re.search(r"\bcore\s+(\d+)\b", label)
                if m and not any(w in label for w in ("bus", "memory", "effective", "эффективн")):
                    cid = int(m.group(1))
                    if cid not in clocks:
                        clocks[cid] = float(r.value)

        elif r.kind == "usage":
            # LHM: "CPU Core #N"
            # N=1-16 → поток 0 каждого ядра; N=17-32 → поток 1
            m = re.fullmatch(r"cpu\s+core\s*#(\d+)", label)
            if m:
                n = int(m.group(1))
                if 1 <= n <= 16:
                    thread0[n - 1] = float(r.value)
                elif 17 <= n <= 32:
                    thread1[n - 17] = float(r.value)
            else:
                # HWiNFO: "Core N T0 Использование" / "Core N T1 Usage" (0-based)
                m = re.match(r"core\s+(\d+)\s+t(\d+)\b", label)
                if m:
                    cid, tid = int(m.group(1)), int(m.group(2))
                    (thread0 if tid == 0 else thread1)[cid] = float(r.value)
                else:
                    # HWiNFO (англ., без SMT-потоков): "CPU Core N Usage"
                    m = re.search(r"\bcpu\s+core\s+(\d+)\s+usage\b", label)
                    if m:
                        thread0[int(m.group(1))] = float(r.value)

        elif r.kind == "temp":
            # HWiNFO: "Core N" или "CoreN (CCDX)" (0-based)
            # LHM не предоставляет per-core temp для AMD — только CCD1/CCD2 (Tdie)
            m = re.fullmatch(r"core\s*(\d+)(?:\s*\(ccd(\d+)\))?", label)
            if m:
                temps[int(m.group(1))] = float(r.value)
                if m.group(2):
                    ccds[int(m.group(1))] = int(m.group(2))

    # Усредняем оба потока на ядро
    for cid, t1 in thread1.items():
        if cid in thread0:
            thread0[cid] = round((thread0[cid] + t1) / 2, 1)
        else:
            thread0[cid] = round(t1, 1)

    # HWiNFO (Core Utility) может отдавать чуть больше 100% — клампим
    def _pct(v):
        return None if v is None else round(min(100.0, max(0.0, v)), 1)

    all_ids = sorted(set(list(clocks) + list(thread0)))
    return [
        {"id": cid, "clock": clocks.get(cid), "load": _pct(thread0.get(cid)),
         "temp": temps.get(cid), "ccd": ccds.get(cid)}
        for cid in all_ids
    ]


def core_groups(cores: list, cpu_name: str) -> list:
    """Группы ядер для панели CPU: по CCD, если HWiNFO их подписал, иначе одна группа.

    3D V-Cache у моделей X3D: при двух CCD кэш стоит на первом (7950X3D, 9950X3D),
    при одном CCD (7800X3D, 9800X3D) — на всех ядрах.
    Возвращает [{name, tag, vcache, temp_key, cores: [id]}].
    """
    x3d = "x3d" in _norm(cpu_name)
    ccd_ids = sorted({c["ccd"] for c in cores if c.get("ccd")})
    if ccd_ids and all(c.get("ccd") for c in cores):
        groups = []
        for i, ccd in enumerate(ccd_ids):
            vcache = x3d and (i == 0 or len(ccd_ids) == 1)
            tag = "3D V-Cache" if vcache else ("Standard" if x3d else None)
            groups.append({
                "name": f"CCD{ccd}", "tag": tag, "vcache": vcache, "temp_key": f"ccd{ccd}_temp",
                "cores": [c["id"] for c in cores if c["ccd"] == ccd],
            })
        return groups
    return [{
        "name": "Ядра", "tag": "3D V-Cache" if x3d else None, "vcache": x3d,
        "temp_key": None, "cores": [c["id"] for c in cores],
    }]


# Сенсор диска HWiNFO: "S.M.A.R.T.: SAMSUNG MZVL21T0HCLR-00B00 (S676NL0W662063) [C:]"
_RE_SMART = re.compile(r"s\.m\.a\.r\.t\.:\s*(.+?)\s*\([^)]*\)\s*\[([a-z]):\]", re.IGNORECASE)
_DRIVE_TEMP_LABELS = ("температура диска", "drive temperature")
# Сенсор активности диска: "Drive: XPG GAMMIX S11 Pro (2O422LC91Q1L) [Z:]"
_RE_DRIVE_ACT = re.compile(r"^drive:.*\[([a-z]):\]")


def collect_drives(readings: list, only: list | None = None) -> list:
    """
    Диски: температура из S.M.A.R.T.-сенсоров HWiNFO, занятое место — из ОС
    (HWiNFO не публикует объём разделов). Буква диска берётся из имени сенсора.

    only — список букв из конфига (["C:", "Z:"]), None = все диски с датчиком.
    Возвращает [{letter, name, kind, temp, used_pct, used_gb, total_gb,
    read_mbs, write_mbs, activity_pct}]: сначала NVMe, затем SSD и HDD.
    """
    want = {w.rstrip(":").upper() for w in only} if only else None
    out: list[dict] = []
    seen: set[str] = set()

    # Тип диска определяем по набору S.M.A.R.T.-показаний: "доступный резерв" есть
    # только у NVMe, ресурс — у SSD. SATA SSD без датчика ресурса попадёт в HDD.
    nvme: set[str] = set()
    ssd: set[str] = set()
    for r in readings:
        m = _RE_SMART.search(r.sensor)
        if not m:
            continue
        label = _norm(r.label)
        if "резерв" in label or "spare" in label:
            nvme.add(m.group(2).upper())
        elif "срок службы" in label or "remaining life" in label:
            ssd.add(m.group(2).upper())

    for r in readings:
        if r.kind != "temp" or _norm(r.label) not in _DRIVE_TEMP_LABELS:
            continue
        m = _RE_SMART.search(r.sensor)
        if not m:
            continue
        model, letter = m.group(1), m.group(2).upper()
        if letter in seen or (want is not None and letter not in want):
            continue
        seen.add(letter)

        used_pct = used_gb = total_gb = None
        try:
            u = shutil.disk_usage(f"{letter}:\\")
            used_pct = round(u.used / u.total * 100, 1)
            used_gb = round(u.used / 1024**3, 1)
            total_gb = round(u.total / 1024**3, 1)
        except (OSError, ZeroDivisionError):
            pass

        out.append({
            "letter": f"{letter}:",
            "name": model,
            "kind": "NVMe" if letter in nvme else "SSD" if letter in ssd else "HDD",
            "temp": float(r.value),
            "used_pct": used_pct,
            "used_gb": used_gb,
            "total_gb": total_gb,
            "read_mbs": None,
            "write_mbs": None,
            "activity_pct": None,
        })

    # Текущие скорости и активность — из отдельных сенсоров "Drive: ... [X:]"
    by_letter = {d["letter"][0]: d for d in out}
    for r in readings:
        m = _RE_DRIVE_ACT.match(_norm(r.sensor))
        if not m:
            continue
        d = by_letter.get(m.group(1).upper())
        if d is None:
            continue
        label = _norm(r.label)
        if "скорость чтения" in label or "read rate" in label:
            d["read_mbs"] = round(float(r.value), 1)
        elif "скорость записи" in label or "write rate" in label:
            d["write_mbs"] = round(float(r.value), 1)
        elif "общая активность" in label or "total activity" in label:
            d["activity_pct"] = round(float(r.value), 1)

    rank = {"NVMe": 0, "SSD": 1, "HDD": 2}
    out.sort(key=lambda d: (rank[d["kind"]], d["letter"]))
    return out


# Виртуальные адаптеры, которые не интересны в HUD
_VIRTUAL_NIC = ("vpn", "virtual", "vmware", "hyper-v", "vethernet", "loopback",
                "hamachi", "radmin", "tap-", "tun", "bluetooth")


# Сенсор планки памяти: "DDR5 DIMM [#1]: A-DATA Technology ... (P0 CHANNEL A/DIMMA2)"
_RE_DIMM = re.compile(r"ddr\d+\s+dimm\s*\[#(\d+)\]", re.IGNORECASE)


def collect_dimms(readings: list) -> list:
    """
    Температуры планок RAM (SPD Hub) со всех сенсоров "DDR5 DIMM [#N]".
    Номера слотов не хардкодим — берём все, что публикует HWiNFO.
    Возвращает [{slot, temp}], отсортировано по номеру слота.
    """
    out = []
    for r in readings:
        if r.kind != "temp" or "spd hub" not in _norm(r.label):
            continue
        m = _RE_DIMM.search(_norm(r.sensor))
        if m:
            out.append({"slot": int(m.group(1)), "temp": float(r.value)})
    out.sort(key=lambda d: d["slot"])
    return out


def collect_network(readings: list) -> dict | None:
    """
    Сеть: текущие скорости самого активного физического адаптера.

    HWiNFO создаёт сенсор "Сеть: <адаптер>" на каждый интерфейс; берём тот,
    у которого наибольший суммарный трафик (виртуальные с нулевым трафиком
    отпадают сами, явные VPN/виртуалки отфильтрованы по имени).
    Возвращает {"name", "dl_mbps", "up_mbps"} или None.
    """
    adapters: dict[str, dict] = {}
    for r in readings:
        sensor_l = _norm(r.sensor)
        if not sensor_l.startswith(("сеть:", "network:")):
            continue
        name = r.sensor.split(":", 1)[1].strip()
        if any(w in sensor_l for w in _VIRTUAL_NIC):
            continue
        a = adapters.setdefault(name, {"dl": 0.0, "up": 0.0, "total": 0.0})
        label = _norm(r.label)
        v = float(r.value)
        if "скорость скачивания" in label or "dl rate" in label:
            a["dl"] = v          # KB/s
        elif "скорость отправки" in label or "up rate" in label:
            a["up"] = v          # KB/s
        elif "всего" in label or "total" in label:
            a["total"] += v      # МБ суммарного трафика — мера активности

    best_name, best = None, None
    for name, a in adapters.items():
        act = a["total"] + a["dl"] + a["up"]
        if best is None or act > best[0]:
            best_name, best = name, (act, a)
    if best is None or best[0] == 0:
        return None

    a = best[1]
    kbps_to_mbit = 1024 * 8 / 1_000_000
    return {
        "name": best_name,
        "dl_mbps": round(a["dl"] * kbps_to_mbit, 2),
        "up_mbps": round(a["up"] * kbps_to_mbit, 2),
    }
