"""
Источник данных: HWiNFO Shared Memory.

HWiNFO умеет публиковать показания всех датчиков в общую память Windows
(включается в настройках: Settings -> Main Settings -> Shared Memory Support).
Это предпочтительный источник: HWiNFO подписан, широко распространён и не поднимает
собственный kernel-драйвер из нашего процесса, поэтому к античитам относится мягче.

Формат HWiNFO_SENSORS_SHARED_MEM2 документирован в SDK HWiNFO: заголовок (44 байта)
и две таблицы — SensorElement (группы датчиков) и ReadingElement (показания).
Размеры элементов таблиц берём из заголовка, а не из sizeof наших структур:
в новых версиях HWiNFO структуры могут расти, при этом известные нам поля
остаются в начале элемента.

Важно про бесплатную версию HWiNFO: Shared Memory работает 12 часов, после чего
HWiNFO пишет в сигнатуру b"DEAD". В этом случае read() кидает HwinfoDeadError —
оркестратор должен переключиться на fallback (LibreHardwareMonitor) и показать
статус в HUD.
"""

from __future__ import annotations

import ctypes
import mmap
import sys
from dataclasses import dataclass
from typing import Any

# Имя shared-memory объекта, который создаёт HWiNFO
HWINFO_SHARED_MEM_NAME = "Global\\HWiNFO_SENS_SM2"
HWINFO_SHARED_MEM_NAME_LOCAL = "HWiNFO_SENS_SM2"

SIGNATURE_ALIVE = b"HWiS"
SIGNATURE_DEAD = b"DEAD"  # HWiNFO закрыт или истёк 12-часовой лимит бесплатной версии

# Тип показания (READING_TYPE из SDK)
READING_TYPE_NAMES = {
    0: "none",
    1: "temp",
    2: "volt",
    3: "fan",
    4: "current",
    5: "power",
    6: "clock",
    7: "usage",
    8: "other",
}


class HWiNFOSharedMemHeader(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ("dwSignature", ctypes.c_char * 4),
        ("dwVersion", ctypes.c_uint32),
        ("dwRevision", ctypes.c_uint32),
        ("poll_time", ctypes.c_int64),
        ("dwOffsetOfSensorSection", ctypes.c_uint32),
        ("dwSizeOfSensorElement", ctypes.c_uint32),
        ("dwNumSensorElements", ctypes.c_uint32),
        ("dwOffsetOfReadingSection", ctypes.c_uint32),
        ("dwSizeOfReadingElement", ctypes.c_uint32),
        ("dwNumReadingElements", ctypes.c_uint32),
    ]


HEADER_SIZE = ctypes.sizeof(HWiNFOSharedMemHeader)  # 44


class HWiNFOSensorElement(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ("dwSensorID", ctypes.c_uint32),
        ("dwSensorInst", ctypes.c_uint32),
        ("szSensorNameOrig", ctypes.c_char * 128),
        ("szSensorNameUser", ctypes.c_char * 128),
    ]


class HWiNFOReadingElement(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ("tReading", ctypes.c_uint32),
        ("dwSensorIndex", ctypes.c_uint32),
        ("dwReadingID", ctypes.c_uint32),
        ("szLabelOrig", ctypes.c_char * 128),
        ("szLabelUser", ctypes.c_char * 128),
        ("szUnit", ctypes.c_char * 16),
        ("Value", ctypes.c_double),
        ("ValueMin", ctypes.c_double),
        ("ValueMax", ctypes.c_double),
        ("ValueAvg", ctypes.c_double),
    ]


class HwinfoUnavailableError(RuntimeError):
    """Shared Memory не открывается или содержит неизвестную сигнатуру."""


class HwinfoDeadError(RuntimeError):
    """Сигнатура b"DEAD": HWiNFO закрыт или истёк лимит бесплатной версии.

    Ловится оркестратором как сигнал переключиться на fallback-источник
    (LibreHardwareMonitor) и показать статус в HUD.
    """


@dataclass
class Reading:
    """Плоское показание — общий протокол источников (см. demo/libre/aida64).

    key — уникальный идентификатор показания "sensorIndex:readingID",
    им можно точно привязать метрику в config.json -> metric_overrides.
    """

    sensor: str
    label: str
    value: float
    unit: str
    kind: str
    key: str = ""


def _decode(raw: bytes) -> str:
    # Строки в shared memory — ANSI в системной кодовой странице Windows,
    # обрезаются по первому NUL.
    raw = raw.split(b"\x00", 1)[0]
    try:
        return raw.decode("mbcs", errors="replace")
    except LookupError:  # кодек mbcs есть только на Windows (не-Windows = тесты)
        return raw.decode("cp1252", errors="replace")


def _struct_from_slice(struct_cls: type, buf: bytes) -> Any:
    # Элемент в памяти может быть больше нашей структуры (новые версии HWiNFO
    # добавляют поля в конец) — берём известное нам начало. На всякий случай
    # дополняем нулями, если он оказался короче.
    need = ctypes.sizeof(struct_cls)
    if len(buf) < need:
        buf = buf.ljust(need, b"\x00")
    return struct_cls.from_buffer_copy(buf[:need])


class HwinfoSource:
    name = "hwinfo"
    display_name = "HWiNFO Shared Memory"

    def __init__(self) -> None:
        self._mm: mmap.mmap | None = None
        self._mapped_size = 0

    # ------------------------------------------------------------------ mmap

    @staticmethod
    def _open_mmap(length: int) -> mmap.mmap:
        # mmap.mmap(-1, length, tagname=...) под Windows открывает существующий
        # именованный объект. Если объекта нет, mmap его СОЗДАСТ (пустым) —
        # такой случай отсекается проверкой сигнатуры ниже.
        # Сначала пробуем глобальное имя, затем локальное.
        last_err: OSError | None = None
        for tag in (HWINFO_SHARED_MEM_NAME, HWINFO_SHARED_MEM_NAME_LOCAL):
            try:
                return mmap.mmap(-1, length, tagname=tag, access=mmap.ACCESS_READ)
            except OSError as e:
                last_err = e
        raise HwinfoUnavailableError(f"не удалось открыть {HWINFO_SHARED_MEM_NAME}: {last_err}")

    def _check_signature(self, mm: mmap.mmap) -> None:
        sig = bytes(mm[0:4])
        if sig == SIGNATURE_ALIVE:
            return
        self.close()
        if sig == SIGNATURE_DEAD:
            raise HwinfoDeadError(
                "HWiNFO пометил shared memory как DEAD "
                "(программа закрыта или истёк 12-часовой лимит бесплатной версии)"
            )
        raise HwinfoUnavailableError(f"неизвестная сигнатура shared memory: {sig!r}")

    def _ensure_mapped(self) -> HWiNFOSharedMemHeader:
        """Открывает/переоткрывает mmap так, чтобы обе секции были в отображении.

        Сначала маппим только заголовок (44 байта), по нему считаем полный
        размер = max(конец секции сенсоров, конец секции показаний) и
        перемапливаем. Заголовок перечитываем при каждом вызове: HWiNFO может
        добавить датчики на лету, и секции вырастут.
        """
        if self._mm is None:
            self._mm = self._open_mmap(HEADER_SIZE)
            self._mapped_size = HEADER_SIZE

        self._check_signature(self._mm)
        header = _struct_from_slice(HWiNFOSharedMemHeader, bytes(self._mm[0:HEADER_SIZE]))

        needed = max(
            header.dwOffsetOfSensorSection
            + header.dwNumSensorElements * header.dwSizeOfSensorElement,
            header.dwOffsetOfReadingSection
            + header.dwNumReadingElements * header.dwSizeOfReadingElement,
        )
        if needed > self._mapped_size:
            self.close()
            self._mm = self._open_mmap(needed)
            self._mapped_size = needed
            self._check_signature(self._mm)
            header = _struct_from_slice(HWiNFOSharedMemHeader, bytes(self._mm[0:HEADER_SIZE]))
        return header

    def close(self) -> None:
        if self._mm is not None:
            self._mm.close()
            self._mm = None
            self._mapped_size = 0

    # ------------------------------------------------------------------ API

    def available(self) -> bool:
        """Доступен ли HWiNFO с включённой Shared Memory прямо сейчас."""
        if sys.platform != "win32":
            return False
        try:
            self._ensure_mapped()
            return True
        except (HwinfoDeadError, HwinfoUnavailableError):
            return False

    def read(self) -> list[Reading]:
        """Плоский список показаний — формат, который ждут manager/normalize.

        Кидает HwinfoDeadError (нужен fallback) или HwinfoUnavailableError —
        менеджер источников ловит их и переключается на запасной источник.
        """
        out: list[Reading] = []
        for sensor in self.read_grouped()["sensors"]:
            for r in sensor["readings"]:
                out.append(
                    Reading(
                        sensor=sensor["name"],
                        label=r["label"],
                        value=r["value"],
                        unit=r["unit"],
                        kind=r["type"],
                        key=r["key"],
                    )
                )
        return out

    def read_grouped(self) -> dict:
        """Считывает все показания, сгруппированные по сенсорам.

        Возвращает:
            {
              "poll_time": int,          # unix time последнего опроса HWiNFO
              "sensors": [
                {
                  "index": int,          # dwSensorIndex, на него ссылаются показания
                  "sensor_id": int,
                  "instance": int,
                  "name": str,
                  "readings": [
                    {
                      "key": "index:reading_id",  # уникальный ключ для конфига HUD
                      "reading_id": int,
                      "type": "temp" | "volt" | "fan" | ...,
                      "label": str,
                      "unit": str,
                      "value": float,
                      "min": float, "max": float, "avg": float,
                    }, ...
                  ]
                }, ...
              ]
            }

        Кидает HwinfoDeadError (нужен fallback) или HwinfoUnavailableError.
        """
        header = self._ensure_mapped()
        mm = self._mm
        assert mm is not None

        sensors: list[dict] = []
        for i in range(header.dwNumSensorElements):
            off = header.dwOffsetOfSensorSection + i * header.dwSizeOfSensorElement
            el = _struct_from_slice(
                HWiNFOSensorElement, bytes(mm[off : off + header.dwSizeOfSensorElement])
            )
            sensors.append(
                {
                    "index": i,
                    "sensor_id": el.dwSensorID,
                    "instance": el.dwSensorInst,
                    "name": _decode(el.szSensorNameUser) or _decode(el.szSensorNameOrig),
                    "readings": [],
                }
            )

        for i in range(header.dwNumReadingElements):
            off = header.dwOffsetOfReadingSection + i * header.dwSizeOfReadingElement
            el = _struct_from_slice(
                HWiNFOReadingElement, bytes(mm[off : off + header.dwSizeOfReadingElement])
            )
            reading = {
                "key": f"{el.dwSensorIndex}:{el.dwReadingID}",
                "reading_id": el.dwReadingID,
                "type": READING_TYPE_NAMES.get(el.tReading, "other"),
                "label": _decode(el.szLabelUser) or _decode(el.szLabelOrig),
                "unit": _decode(el.szUnit),
                "value": float(el.Value),
                "min": float(el.ValueMin),
                "max": float(el.ValueMax),
                "avg": float(el.ValueAvg),
            }
            if el.dwSensorIndex < len(sensors):
                sensors[el.dwSensorIndex]["readings"].append(reading)

        return {"poll_time": int(header.poll_time), "sensors": sensors}


# Совместимость со старым именем
HWiNFOSource = HwinfoSource
