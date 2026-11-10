/* Логика дашборда: раз в интервал берём snapshot у Python-моста,
   раскидываем значения по data-bind, двигаем шкалы и бары, красим по порогам. */

const GAUGE_CIRCUMFERENCE = 327; // 2*pi*52

function colorForTemp(v) {
  if (v >= 80) return "var(--red)";
  if (v >= 65) return "var(--amber)";
  return "var(--cyan)";
}
// Для дисков общие пороги не подходят: жёсткий диск перегрет уже при 55 °C
function colorForDriveTemp(v, kind) {
  const [amber, red] = kind === "HDD" ? [45, 55] : [60, 75];
  if (v >= red) return "var(--red)";
  if (v >= amber) return "var(--amber)";
  return "var(--cyan)";
}
function colorForLoad(v) {
  if (v >= 90) return "var(--red)";
  if (v >= 70) return "var(--amber)";
  return "var(--cyan)";
}

/* ── плавный счёт чисел (по мотивам эффекта Count Up, своя реализация) ──
   Анимирует все числа в строке: "Vcore 1.136 В · SoC 1.312 В" считается по обоим значениям.
   Если текст изменился не только в числах ("--" -> "42°C"), он заменяется сразу. */
const COUNT_MS = 800;         // меньше интервала опроса, чтобы успевать дойти до значения
const COUNT_FRAME_MS = 33;    // около 30 кадров в секунду, чтобы не нагружать ПК в играх
const NUMBER_RE = /-?\d+(?:\.\d+)?/g;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const counters = new Map();   // элемент -> { from, to, decimals, parts, target, start }
let countRaf = 0;
let countLastFrame = 0;

function countText(el, value) {
  const text = String(value);
  const running = counters.get(el);
  if ((running ? running.target : el.textContent) === text) return;

  const shown = el.textContent;
  const numbers = text.match(NUMBER_RE);
  const sameShape = shown.replace(NUMBER_RE, "#") === text.replace(NUMBER_RE, "#");
  if (!numbers || !sameShape || document.hidden || REDUCED_MOTION) {
    counters.delete(el);
    el.textContent = text;
    return;
  }
  counters.set(el, {
    from: shown.match(NUMBER_RE).map(Number),
    to: numbers.map(Number),
    decimals: numbers.map((n) => (n.split(".")[1] || "").length),
    parts: text.split(NUMBER_RE),
    target: text,
    start: performance.now(),
  });
  if (!countRaf) countRaf = requestAnimationFrame(countFrame);
}

function countFrame(now) {
  countRaf = 0;
  if (now - countLastFrame >= COUNT_FRAME_MS - 1) {
    countLastFrame = now;
    for (const [el, c] of counters) {
      const t = Math.min(1, (now - c.start) / COUNT_MS);
      if (t >= 1) {
        el.textContent = c.target;
        counters.delete(el);
        continue;
      }
      const eased = 1 - (1 - t) ** 3;  // easeOut: быстро в начале, плавно к концу
      let text = c.parts[0];
      c.to.forEach((to, i) => {
        text += (c.from[i] + (to - c.from[i]) * eased).toFixed(c.decimals[i]) + c.parts[i + 1];
      });
      if (el.textContent !== text) el.textContent = text;
    }
  }
  if (counters.size) countRaf = requestAnimationFrame(countFrame);
}

function setMbTemp(id, metric, warn, crit) {
  const el = document.getElementById(id);
  if (!el) return;
  if (metric) {
    const v = Number(metric.value);
    countText(el, `${Math.round(v)}°C`);
    el.style.color = v >= crit ? "var(--red)" : v >= warn ? "var(--amber)" : "var(--cyan)";
  } else {
    countText(el, "--");
    el.style.color = "var(--ink-dim)";
  }
}

function setText(key, value) {
  document.querySelectorAll(`[data-bind="${key}"]`).forEach((el) => {
    el.textContent = value;
  });
}

function setNumber(key, value) {
  document.querySelectorAll(`[data-bind="${key}"]`).forEach((el) => countText(el, value));
}

// Проценты VRAM и RAM: тот же цвет, что у их шкалы
function setPercent(key, value) {
  setNumber(key, value != null ? Math.round(value) : "--");
  document.querySelectorAll(`[data-bind="${key}"]`).forEach((el) => {
    el.style.color = value != null ? colorForLoad(value) : "var(--ink-dim)";
  });
}

function fmt(metric, digits = 0) {
  if (!metric || metric.value === undefined || metric.value === null) return "--";
  const n = Number(metric.value);
  if (Number.isNaN(n)) return "--";
  return digits ? n.toFixed(digits) : Math.round(n).toString();
}

function updateGauge(gaugeKey, value, max, colorFn) {
  const gauge = document.querySelector(`[data-gauge="${gaugeKey}"] .gauge__fill`);
  if (!gauge) return;
  const frac = Math.max(0, Math.min(1, value / max));
  gauge.style.strokeDashoffset = String(GAUGE_CIRCUMFERENCE * (1 - frac));
  gauge.style.stroke = colorFn(value);
}

function updateBar(key, value, colorFn) {
  const bar = document.querySelector(`[data-bar="${key}"]`);
  if (!bar) return;
  bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
  bar.style.background = colorFn(value);
}

/* ── спарклайны ядер (canvas) ────────────────────────── */
const SPARK_LEN = 60; // 60 точек = окно 60 c при опросе 1 раз/с

let _sparkStroke = null, _sparkFill = null;
function sparkColors() {
  if (!_sparkStroke) {
    const c = getComputedStyle(document.documentElement).getPropertyValue("--cyan").trim() || "#3fdfb0";
    _sparkStroke = c;
    const m = /^#([0-9a-f]{6})$/i.exec(c);
    const n = m ? parseInt(m[1], 16) : 0x3fdfb0;
    _sparkFill = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.17)`;
  }
  return [_sparkStroke, _sparkFill];
}

function drawSpark(canvas, hist, maxVal = 100, minVal = 0, maxLen = SPARK_LEN, alignRight = true) {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (!cw || !ch) return;
  // держим внутренний буфер в физических пикселях, иначе линия мылится
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  const n = hist ? hist.length : 0;
  if (n < 2) return;

  const pad = 1.5; // чтобы линия на краях шкалы не срезалась канвасом
  const step = cw / (maxLen - 1);
  // ядра/сеть: история прижата к правому краю; плитки: слева направо от начала буфера
  const x0 = alignRight ? cw - (n - 1) * step : 0;
  const X = (i) => x0 + i * step;
  const span = maxVal - minVal || 1;
  const Y = (i) => {
    const v = Math.max(minVal, Math.min(maxVal, hist[i]));
    return pad + (1 - (v - minVal) / span) * (ch - 2 * pad);
  };

  // кривая через середины отрезков — quadraticCurveTo даёт мягкое сглаживание
  const trace = () => {
    ctx.moveTo(X(0), Y(0));
    for (let i = 1; i < n - 1; i++) {
      ctx.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
    }
    ctx.lineTo(X(n - 1), Y(n - 1));
  };
  const [stroke, fill] = sparkColors();

  ctx.beginPath();
  trace();
  ctx.lineTo(X(n - 1), ch);
  ctx.lineTo(X(0), ch);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  trace();
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

/* ── рендер ядер ─────────────────────────────────────── */
function renderCores(cores, groups, metrics) {
  const root = document.getElementById("core-groups");
  if (!root || !cores || cores.length === 0) return;
  if (!groups || groups.length === 0) {
    groups = [{ name: "Ядра", tag: null, vcache: false, temp_key: null, cores: cores.map((c) => c.id) }];
  }

  // DOM строится заново только при смене состава групп (другой процессор или источник)
  const layout = groups.map((g) => `${g.name}:${g.cores.join(",")}`).join("|");
  if (root.dataset.layout !== layout) {
    root.dataset.layout = layout;
    root.replaceChildren();
    // на чипы отведено две строки: одна большая группа делится на две, две группы — по строке
    const rows = groups.length === 1 && groups[0].cores.length > 8 ? 2 : 1;
    for (const g of groups) {
      const cols = Math.min(12, Math.max(1, Math.ceil(g.cores.length / rows)));
      const group = document.createElement("div");
      group.className = "ccd-group";
      const tag = g.tag
        ? `<span class="ccd-label__tag${g.vcache ? "" : " ccd-label__tag--dim"}">${g.tag}</span>`
        : "";
      group.innerHTML =
        `<div class="ccd-label">${tag}<span class="ccd-label__name">${g.name}</span>` +
        `<span class="ccd-label__rule"></span>` +
        `<span class="ccd-label__temp" data-group-temp="${g.temp_key || ""}"></span></div>` +
        `<div class="core-grid${cols > 8 ? " core-grid--dense" : ""}" style="--cols:${cols}"></div>`;
      const grid = group.querySelector(".core-grid");
      for (const id of g.cores) {
        const num = String(id + 1).padStart(2, "0");
        const badge = g.vcache ? `<span class="core-chip__badge">3D</span>` : "";
        const chip = document.createElement("div");
        chip.className = "core-chip";
        chip.innerHTML =
          `<div class="core-chip__num"><span>C·${num}</span>${badge}</div>` +
          `<div class="core-chip__clock"><span data-cc="${id}">--</span><i>МГц</i>` +
            `<span class="core-chip__pct" data-cl="${id}">--</span></div>` +
          `<canvas class="core-chip__spark" data-cv="${id}"></canvas>` +
          `<div class="core-chip__temp"><span data-ct="${id}">--</span><i>°C</i></div>`;
        grid.appendChild(chip);
      }
      root.appendChild(group);
    }
  }

  // Обновляем значения
  for (const c of cores) {
    const el = root.querySelector(`[data-cc="${c.id}"]`);
    if (!el) continue;
    // спящее ядро: Windows его припарковала, частота из HWiNFO ничего не значит
    el.closest(".core-chip").classList.toggle("core-chip--sleep", !!c.sleep);
    if (c.sleep) countText(el, "сон");
    else if (c.clock != null) countText(el, Math.round(c.clock));

    // спарклайн: история приходит из бэкенда (deque на 60 точек)
    const canvas = root.querySelector(`[data-cv="${c.id}"]`);
    if (canvas) drawSpark(canvas, c.history);

    if (c.load != null) {
      const pct = root.querySelector(`[data-cl="${c.id}"]`);
      if (pct) countText(pct, `${Math.round(Math.min(100, Math.max(0, c.load)))}%`);
    }
    const ct = root.querySelector(`[data-ct="${c.id}"]`);
    if (ct) {
      if (c.temp != null) {
        countText(ct, Math.round(c.temp));
        ct.parentElement.style.color = colorForTemp(c.temp);
      } else {
        countText(ct, "--");
        ct.parentElement.style.color = "var(--ink-dim)";
      }
    }
  }

  // Температуры групп (CCD), если датчик есть
  root.querySelectorAll("[data-group-temp]").forEach((el) => {
    const metric = metrics[el.dataset.groupTemp];
    if (metric) {
      const v = Number(metric.value);
      countText(el, `${Math.round(v)}°C`);
      el.style.color = colorForTemp(v);
    } else {
      el.textContent = "";
    }
  });
}

/* ── плитки материнской платы ────────────────────────── */
const MB_HIST_LEN = 600; // окно 10 минут при тике 1 с

// температурный спарклайн: автошкала с минимальным диапазоном 4 единицы,
// реальный разброс центрируется в окне — ровная температура рисуется
// спокойной почти горизонтальной линией, а не пилой на весь канвас
function drawTempSpark(canvas, hist) {
  if (!canvas) return;
  if (!hist || hist.length < 2) {
    drawSpark(canvas, [], 1, 0, MB_HIST_LEN, false);
    return;
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of hist) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = Math.max(hi - lo, 4);
  const mid = (hi + lo) / 2;
  drawSpark(canvas, hist, mid + span / 2, mid - span / 2, MB_HIST_LEN, false);
}

function renderMb(snap, m) {
  const hist = snap.mb_history || {};

  // цвет числа: пороги VRM/чипсет 60/80, система 40/50
  setMbTemp("mb-vrm",     m.vrm_temp,     60, 80);
  setMbTemp("mb-chipset", m.chipset_temp, 60, 80);
  setMbTemp("mb-sys",     m.mobo_temp,    40, 50);

  drawTempSpark(document.getElementById("mb-vrm-spark"),     hist.vrm);
  drawTempSpark(document.getElementById("mb-chipset-spark"), hist.chipset);
  drawTempSpark(document.getElementById("mb-sys-spark"),     hist.sys);

  const vrmSub = document.getElementById("mb-vrm-sub");
  if (vrmSub) {
    const vc  = m.vcore    ? Number(m.vcore.value).toFixed(3)    : "--";
    const soc = m.soc_volt ? Number(m.soc_volt.value).toFixed(3) : "--";
    countText(vrmSub, `Vcore ${vc} В · SoC ${soc} В`);
  }

  const chSub = document.getElementById("mb-chipset-sub");
  if (chSub) {
    countText(chSub, m.chipset_board_temp
      ? `у платы ${Math.round(Number(m.chipset_board_temp.value))} °C`
      : "--");
  }

  const sysSub = document.getElementById("mb-sys-sub");
  if (sysSub) {
    const parts = [];
    const pump = m.pump_rpm ? Math.round(Number(m.pump_rpm.value)) : 0;
    if (pump > 0) parts.push(`помпа ${pump}`);
    const fans = [m.fan_sys1, m.fan_sys2, m.fan_sys3]
      .map((f) => (f ? Math.round(Number(f.value)) : 0))
      .filter((v) => v > 0); // остановленные вентиляторы скрываем
    if (fans.length) parts.push(`вент. ${fans.join(" ")}`);
    countText(sysSub, parts.join(" · ") || "--");
  }
}

/* ── плитки температур планок RAM (SPD Hub) ──────────── */
function renderDimms(dimms) {
  const row = document.getElementById("dimm-row");
  if (!row) return;

  // Перестраиваем DOM, только если изменился набор планок
  const slots = dimms.map((d) => d.slot).join(",");
  if (row.dataset.slots !== slots) {
    row.dataset.slots = slots;
    row.replaceChildren(...dimms.map((d) => {
      const tile = document.createElement("div");
      tile.className = "mb-tile";
      tile.innerHTML = `
        <div class="mb-tile__head">
          <span class="mb-tile__title"></span>
          <span class="mb-tile__val"></span>
        </div>
        <canvas class="mb-tile__spark"></canvas>`;
      tile.querySelector(".mb-tile__title").textContent = `DIMM ${d.slot}`;
      return tile;
    }));
  }

  dimms.forEach((d, i) => {
    const tile = row.children[i];
    const v = Math.round(d.temp);
    const val = tile.querySelector(".mb-tile__val");
    countText(val, `${v}°C`);
    val.style.color = v >= 55 ? "var(--red)" : v >= 45 ? "var(--amber)" : "var(--cyan)";
    drawTempSpark(tile.querySelector("canvas"), d.history);
  });
}

/* ── плитки GPU: термики и охлаждение ────────────────── */
function renderGpuTiles(snap, m) {
  const hist = snap.gpu_history || {};

  // Hot Spot: температура крупно + дельта к температуре ГП
  setMbTemp("gpu-hs", m.gpu_hotspot, 65, 80);
  drawTempSpark(document.getElementById("gpu-hs-spark"), hist.hotspot);
  const hsSub = document.getElementById("gpu-hs-sub");
  if (hsSub) {
    if (m.gpu_hotspot && m.gpu_temp) {
      const d = Number(m.gpu_hotspot.value) - Number(m.gpu_temp.value);
      countText(hsSub, `Δ к ГП ${d.toFixed(0)} °C`);
      hsSub.style.color = d > 25 ? "var(--red)" : d > 20 ? "var(--amber)" : "var(--ink-dim)";
    } else {
      countText(hsSub, "--");
      hsSub.style.color = "var(--ink-dim)";
    }
  }

  // Вентиляторы: max RPM крупно ("стоп", если все стоят) + все по отдельности
  const fans = snap.gpu_fans || [];
  const maxRpm = fans.length ? Math.max(...fans) : null;
  const fanVal = document.getElementById("gpu-fan-val");
  if (fanVal) {
    if (maxRpm) {
      countText(fanVal, maxRpm);
      fanVal.style.color = "var(--cyan)";
    } else {
      countText(fanVal, fans.length ? "стоп" : "--");
      fanVal.style.color = "var(--ink-dim)";
    }
  }
  // шкала 0..max(2000, максимум в буфере): "стоп" — линия у нижнего края
  const fanHist = hist.fan || [];
  const fanCanvas = document.getElementById("gpu-fan-spark");
  if (fanCanvas) {
    drawSpark(fanCanvas, fanHist, Math.max(2000, ...fanHist), 0, MB_HIST_LEN, false);
  }
  const fanSub = document.getElementById("gpu-fan-sub");
  if (fanSub) {
    countText(fanSub, fans.length
      ? fans.map((v, i) => `F${i + 1} ${v}`).join(" · ")
      : "--");
  }

  // Шина: скорость PCIe крупно + спарклайн и текущая нагрузка шины
  const pcieVal = document.getElementById("gpu-pcie-val");
  if (pcieVal) {
    countText(pcieVal, m.pcie_speed
      ? `${Number(m.pcie_speed.value).toFixed(0)} GT/s`
      : "--");
    pcieVal.style.color = m.pcie_speed ? "var(--cyan)" : "var(--ink-dim)";
  }
  const busCanvas = document.getElementById("gpu-bus-spark");
  if (busCanvas) drawSpark(busCanvas, hist.bus || [], 100, 0, MB_HIST_LEN, false);
  const busSub = document.getElementById("gpu-bus-sub");
  if (busSub) {
    countText(busSub, m.bus_load
      ? `нагрузка шины ${Math.round(Number(m.bus_load.value))}%`
      : "--");
  }
}

/* ── график фреймтайма (панель FPS) ──────────────────── */
const FT_MAX_MS = 40; // фиксированная шкала 0-40 мс, всё что выше — по верхнему краю

function drawFrametime(canvas, hist) {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (!cw || !ch) return;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  const pad = 1.5;
  const yMs = (ms) => pad + (1 - Math.max(0, Math.min(FT_MAX_MS, ms)) / FT_MAX_MS) * (ch - 2 * pad);

  // Ориентиры: ось Y в мс снизу вверх (0 внизу, 40 вверху), поэтому
  // линия 16.7 мс (60 FPS) лежит НИЖЕ линии 33.3 мс (30 FPS).
  ctx.save();
  ctx.strokeStyle = "rgba(124, 138, 156, 0.35)";
  ctx.fillStyle = "rgba(124, 138, 156, 0.75)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.font = "9px 'JetBrains Mono', 'Consolas', monospace";
  ctx.textAlign = "right";
  for (const [ms, label] of [[16.7, "16.7 мс · 60 FPS"], [33.3, "33.3 мс · 30 FPS"]]) {
    const y = yMs(ms);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cw, y);
    ctx.stroke();
    ctx.fillText(label, cw - 3, y - 3);
  }
  ctx.restore();

  const n = hist ? hist.length : 0;
  if (n < 2) return;

  // шаг всегда ширина/maxlen; неполный буфер — линия короче, от левого края
  const step = cw / (SPARK_LEN - 1);
  const X = (i) => i * step;
  const Y = (i) => yMs(hist[i]);
  const trace = () => {
    ctx.moveTo(X(0), Y(0));
    for (let i = 1; i < n - 1; i++) {
      ctx.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
    }
    ctx.lineTo(X(n - 1), Y(n - 1));
  };
  const [stroke, fill] = sparkColors();

  ctx.beginPath();
  trace();
  ctx.lineTo(X(n - 1), ch);
  ctx.lineTo(X(0), ch);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  trace();
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

/* ── накопители ──────────────────────────────────────── */
function renderDrives(drives) {
  const el = document.getElementById("drives-list");
  if (!el) return;
  if (!drives || drives.length === 0) {
    el.innerHTML = '<div class="mini__sub">нет данных</div>';
    delete el.dataset.layout;
    return;
  }
  const rate = (v) => (v == null ? "--" : v >= 10 ? String(Math.round(v)) : v.toFixed(1));

  // Строки перестраиваем, только если изменился набор дисков, иначе числам нечего анимировать
  const layout = drives.map((d) => `${d.kind} ${d.letter} ${d.name}`).join("|");
  if (el.dataset.layout !== layout) {
    el.dataset.layout = layout;
    el.innerHTML = `<div class="drive drive--head">
        <span></span><span>чтение · запись</span><span>актив.</span><span>темп.</span><span class="drive__used">занято</span>
      </div>` + drives.map((d) => `<div class="drive" data-letter="${d.letter}">
        <span class="drive__name"><b class="drive__kind drive__kind--${d.kind.toLowerCase()}">${d.kind}</b><i>${d.letter}</i>${d.name}</span>
        <span class="drive__rate"></span>
        <span class="drive__act"></span>
        <span class="drive__temp"></span>
        <div class="bar"><span></span></div>
        <span class="drive__pct"></span>
      </div>`).join("");
  }

  for (const d of drives) {
    const row = el.querySelector(`[data-letter="${d.letter}"]`);
    const t = d.temp != null ? Math.round(d.temp) : null;
    const p = d.used_pct != null ? Math.round(d.used_pct) : null;
    const a = d.activity_pct != null ? Math.round(d.activity_pct) : null;
    countText(row.querySelector(".drive__rate"), `R ${rate(d.read_mbs)} · W ${rate(d.write_mbs)} MB/s`);

    const act = row.querySelector(".drive__act");
    countText(act, a != null ? `${a}%` : "--");
    act.style.color = a != null ? colorForLoad(a) : "var(--ink-dim)";

    const temp = row.querySelector(".drive__temp");
    countText(temp, t != null ? `${t}°C` : "--");
    temp.style.color = t != null ? colorForDriveTemp(t, d.kind) : "var(--ink-dim)";

    const bar = row.querySelector(".bar span");
    bar.style.width = `${p ?? 0}%`;
    bar.style.background = colorForLoad(p ?? 0);
    countText(row.querySelector(".drive__pct"), p != null ? `${p}%` : "--");
  }
}

/* ── сеть ────────────────────────────────────────────── */
function fmtMbps(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return "--";
  return n >= 100 ? String(Math.round(n)) : n.toFixed(1);
}

function renderNetwork(net) {
  const dlCanvas = document.getElementById("net-dl-spark");
  const upCanvas = document.getElementById("net-up-spark");
  if (net) {
    setNumber("net_dl", fmtMbps(net.dl_mbps));
    setNumber("net_up", fmtMbps(net.up_mbps));
    // "RealTek ... PCIe Ethernet Controller - Ethernet" -> "Ethernet"
    const parts = (net.name || "").split(" - ");
    setText("net_name", parts[parts.length - 1] || net.name || "—");
  } else {
    setNumber("net_dl", "--");
    setNumber("net_up", "--");
    setText("net_name", "нет активного адаптера");
  }
  // общая автошкала для обоих графиков: максимум по буферам, но не меньше 10 Мбит/с
  const dl = (net && net.dl_history) || [];
  const up = (net && net.up_history) || [];
  const maxY = Math.max(10, ...dl, ...up);
  if (dlCanvas) drawSpark(dlCanvas, dl, maxY);
  if (upCanvas) drawSpark(upCanvas, up, maxY);
}

/* ── главный рендер ──────────────────────────────────── */
function render(snap) {
  const m = snap.metrics || {};

  // "ЦП [#0]: AMD Ryzen 9 9950X3D: Enhanced" -> "AMD Ryzen 9 9950X3D"
  // "dGPU [#0]: NVIDIA GeForce RTX 5080: GIGABYTE ..." -> "NVIDIA GeForce RTX 5080"
  const cleanName = (s) =>
    (s || "").replace(/^.*?\[#\d+\]:\s*/, "").split(":")[0].trim();
  setText("cpu_name", cleanName(m.cpu_temp?.sensor || m.cpu_load?.sensor) || "—");
  setText("gpu_name", cleanName(m.gpu_temp?.sensor || m.gpu_load?.sensor) || "—");

  setNumber("cpu_temp",  fmt(m.cpu_temp));
  setNumber("cpu_load",  fmt(m.cpu_load,  0));
  setNumber("cpu_clock", fmt(m.cpu_clock));
  setNumber("cpu_power", fmt(m.cpu_power, 0));

  setNumber("gpu_temp",  fmt(m.gpu_temp));
  setNumber("gpu_load",  fmt(m.gpu_load,  0));
  setNumber("gpu_clock", fmt(m.gpu_clock));
  setNumber("gpu_power", fmt(m.gpu_power, 0));

  // VRAM / RAM в карточке GPU: бар + "занято X из Y GB" + проценты
  const vramUsed  = m.vram_used ? Number(m.vram_used.value) : null;
  const vramTotal = Number(snap.vram_total_gb) || null;
  const vramPct   = vramUsed != null && vramTotal ? (vramUsed / vramTotal) * 100
                  : (m.vram_load ? Number(m.vram_load.value) : null);
  setPercent("vram_pct", vramPct);
  setNumber("vram_used",  vramUsed != null ? `${vramUsed.toFixed(1)} GB` : "--");
  setNumber("vram_total", vramTotal ? `${vramTotal} GB` : "--");
  if (vramPct != null) updateBar("vram_pct", vramPct, colorForLoad);

  const ramUsed  = m.ram_used  ? Number(m.ram_used.value)  : null;
  const ramAvail = m.ram_avail ? Number(m.ram_avail.value) : null;
  const ramTotal = ramUsed != null && ramAvail != null ? ramUsed + ramAvail : null;
  const ramPct   = m.ram_load ? Number(m.ram_load.value)
                 : (ramTotal ? (ramUsed / ramTotal) * 100 : null);
  setPercent("ram_pct", ramPct);
  setNumber("ram_used",  ramUsed  != null ? `${ramUsed.toFixed(1)} GB` : "--");
  setNumber("ram_total", ramTotal != null ? `${ramTotal.toFixed(1)} GB` : "--");
  if (ramPct != null) updateBar("ram_pct", ramPct, colorForLoad);

  // правая часть второй строки VRAM: частота памяти + контроллер
  const vramExtra = document.getElementById("vram-extra");
  if (vramExtra) {
    const parts = [];
    if (m.vram_clock)     parts.push(`частота ${Math.round(Number(m.vram_clock.value))} МГц`);
    if (m.vram_ctrl_load) parts.push(`контроллер ${Math.round(Number(m.vram_ctrl_load.value))}%`);
    countText(vramExtra, parts.join(" · ") || "--");
  }

  // правая часть второй строки RAM: свободная память
  const ramExtra = document.getElementById("ram-extra");
  if (ramExtra) {
    countText(ramExtra, ramAvail != null ? `свободно ${ramAvail.toFixed(1)} GB` : "--");
  }
  renderDimms(snap.dimms || []);

  // FPS: приоритет — прямые данные RTSS (snap.fps), затем метрика источника;
  // если игры нет — панель приглушается, график пустой
  const fpsPanel = document.getElementById("fps-panel");
  const fpsApp = document.getElementById("fps-app");
  const fpsFt = document.getElementById("fps-ft");
  const fpsLow = document.getElementById("fps-low");
  const fpsCanvas = document.getElementById("fps-canvas");
  const fpsInfo = snap.fps;
  if (fpsInfo && fpsInfo.fps) {
    if (fpsPanel) fpsPanel.classList.remove("fps-panel--idle");
    setNumber("fps", Math.round(fpsInfo.fps));
    if (fpsApp) fpsApp.textContent = fpsInfo.app_name;
    if (fpsFt) countText(fpsFt, `${Number(fpsInfo.frametime_ms).toFixed(1)} мс`);
    if (fpsLow) countText(fpsLow,
      fpsInfo.low1_fps != null ? `${Math.round(fpsInfo.low1_fps)} FPS` : "--");
  } else if (m.fps && Number(m.fps.value) > 0) {
    // запасной путь: показание FPS из основного источника (без фреймтайма)
    if (fpsPanel) fpsPanel.classList.remove("fps-panel--idle");
    setNumber("fps", fmt(m.fps));
    if (fpsApp) fpsApp.textContent = "";
    if (fpsFt) countText(fpsFt, "--");
    if (fpsLow) countText(fpsLow, "--");
  } else {
    if (fpsPanel) fpsPanel.classList.add("fps-panel--idle");
    setNumber("fps", "--");
    // без RTSS FPS взять неоткуда — подсказываем, что его нужно запустить
    if (fpsApp) fpsApp.textContent = snap.rtss_running ? "нет активной игры" : "RTSS не запущен";
    if (fpsFt) countText(fpsFt, "--");
    if (fpsLow) countText(fpsLow, "--");
  }
  if (fpsCanvas) drawFrametime(fpsCanvas, fpsInfo && fpsInfo.history ? fpsInfo.history : []);

  if (m.cpu_temp)  updateGauge("cpu_temp",  Number(m.cpu_temp.value),  100, colorForTemp);
  if (m.gpu_temp)  updateGauge("gpu_temp",  Number(m.gpu_temp.value),  100, colorForTemp);
  // уголки карточек CPU и GPU показывают тот же уровень температуры, что и шкала
  if (m.cpu_temp)  document.querySelector(".card--cpu").style.setProperty("--frame", colorForTemp(Number(m.cpu_temp.value)));
  if (m.gpu_temp)  document.querySelector(".card--gpu").style.setProperty("--frame", colorForTemp(Number(m.gpu_temp.value)));
  if (m.cpu_load)  updateBar("cpu_load",  Number(m.cpu_load.value),  colorForLoad);
  if (m.gpu_load)  updateBar("gpu_load",  Number(m.gpu_load.value),  colorForLoad);
  // GPU clock: 0–3000 МГц; GPU power: 0–400 Вт
  if (m.gpu_clock) updateBar("gpu_clock", Math.min(100, Number(m.gpu_clock.value) / 30),  () => "var(--cyan)");
  if (m.gpu_power) updateBar("gpu_power", Math.min(100, Number(m.gpu_power.value) / 4),   colorForLoad);
  // CPU clock: 0–6000 МГц; CPU power: 0–200 Вт
  if (m.cpu_clock) updateBar("cpu_clock", Math.min(100, Number(m.cpu_clock.value) / 60),  () => "var(--cyan)");
  if (m.cpu_power) updateBar("cpu_power", Math.min(100, Number(m.cpu_power.value) / 2),   colorForLoad);

  renderMb(snap, m);
  renderGpuTiles(snap, m);
  renderCores(snap.cores || [], snap.core_groups, m);
  renderDrives(snap.drives);
  renderNetwork(snap.network);

  setText("source", snap.source_display || snap.source || "—");
  const dot = document.querySelector(".dot");
  if (dot) dot.dataset.state = snap.source === "demo" ? "warn" : (snap.warning ? "warn" : "ok");
  const rtssDot = document.getElementById("rtss-dot");
  if (rtssDot) rtssDot.dataset.state = snap.rtss_running ? "ok" : "off";

  const toast = document.querySelector(".toast");
  if (toast) {
    if (snap.warning) { toast.textContent = snap.warning; toast.hidden = false; }
    else { toast.hidden = true; }
    // демо-данные легко принять за настоящие — предупреждение крупнее обычного
    toast.classList.toggle("toast--demo", snap.source === "demo");
  }
}

function updateClock() {
  const d = new Date();
  setText("clock", `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
}

/* ── опрос данных ────────────────────────────────────── */
async function pollLoop(intervalMs) {
  const tick = async () => {
    try {
      if (window.pywebview && window.pywebview.api) {
        const snap = await window.pywebview.api.get_snapshot();
        render(snap);
      } else {
        render(demoSnapshot());
      }
    } catch (e) {
      console.error("snapshot error", e);
    }
    updateClock();
  };
  await tick();
  setInterval(tick, intervalMs);
}

/* ── демо для запуска index.html напрямую в браузере ─── */
function demoSnapshot() {
  const t = Date.now() / 1000;
  const w = (b, a, p) => b + a * Math.sin(t / p);
  const mk = (v, unit, sensor, label) => ({ value: v, unit, sensor, label });

  // та же модель нагрузки, что в backend/sources/demo.py: плавный шум + редкие пики
  const coreLoad = (cid, tt) => {
    let v = (cid < 8 ? 6 : 4)
      + 4 * Math.sin(tt / (3.0 + cid * 0.37) + cid * 1.3)
      + 3 * Math.sin(tt / (7.5 + cid * 0.21) + cid * 0.7);
    const s = Math.sin(tt / (11 + (cid % 5)) + cid * 2.1);
    if (s > 0.92) v += 60 * (s - 0.92) / 0.08;
    return Math.max(0, Math.min(100, v));
  };
  const cores = [];
  for (let i = 0; i < 16; i++) {
    const base = i < 8 ? 5500 : 5700;
    const history = [];
    for (let k = 59; k >= 0; k--) history.push(coreLoad(i, t - k));
    cores.push({
      id: i,
      clock: Math.round(w(base, 180, 2.0 + i * 0.27)),
      load:  Math.round(history[history.length - 1]),
      temp:  +w(i < 8 ? 40 : 47, 3, 4.0 + i * 0.3).toFixed(1),
      history,
    });
  }

  return {
    source: "demo", source_display: "Demo (браузер)", warning: null,
    cores,
    rtss_running: false,
    vram_total_gb: 16,
    mb_history: (() => {
      const gen = (base, amp, period) => {
        const out = [];
        for (let k = 599; k >= 0; k--) out.push(+(base + amp * Math.sin((t - k) / period)).toFixed(1));
        return out;
      };
      return { vrm: gen(38, 2, 45), chipset: gen(50, 3, 60), sys: gen(39, 2, 50) };
    })(),
    gpu_history: (() => {
      const gen = (base, amp, period) => {
        const out = [];
        for (let k = 599; k >= 0; k--) out.push(+(base + amp * Math.sin((t - k) / period)).toFixed(1));
        return out;
      };
      return { hotspot: gen(43, 5, 50), fan: gen(1100, 150, 40), bus: gen(30, 25, 55).map((v) => Math.max(0, v)) };
    })(),
    gpu_fans: [Math.round(w(1100, 150, 4)), Math.round(w(1080, 150, 5)), Math.round(w(1090, 150, 6))],
    dimms: [
      { slot: 1, temp: +w(38, 3, 6).toFixed(1),
        history: Array.from({ length: 600 }, (_, k) => +(38 + 2 * Math.sin((t - 599 + k) / 45)).toFixed(1)) },
      { slot: 3, temp: +w(36, 3, 7).toFixed(1),
        history: Array.from({ length: 600 }, (_, k) => +(36 + 2 * Math.sin((t - 599 + k) / 55)).toFixed(1)) },
    ],
    drives: [
      { letter: "C:", name: "Demo NVMe 1TB", kind: "NVMe", temp: +w(44, 4, 5).toFixed(1), used_pct: 63.2, used_gb: 589.1, total_gb: 931.5,
        read_mbs: +Math.max(0, w(120, 110, 4)).toFixed(1), write_mbs: +Math.max(0, w(40, 38, 6)).toFixed(1), activity_pct: 12 },
      { letter: "Z:", name: "Demo HDD 2TB", kind: "HDD", temp: +w(33, 3, 7).toFixed(1), used_pct: 41.7, used_gb: 776.9, total_gb: 1863.0,
        read_mbs: +Math.max(0, w(5, 6, 5)).toFixed(1), write_mbs: 0, activity_pct: 3 },
    ],
    network: (() => {
      const dl = [], up = [];
      for (let k = 59; k >= 0; k--) {
        dl.push(+Math.max(0, w(12, 10, 5) + 4 * Math.sin((t - k) / 3)).toFixed(2));
        up.push(+Math.max(0, w(2.5, 2, 4) + Math.sin((t - k) / 2.2)).toFixed(2));
      }
      return { name: "Demo Ethernet - Ethernet", dl_mbps: dl[dl.length - 1], up_mbps: up[up.length - 1],
               dl_history: dl, up_history: up };
    })(),
    fps: (() => {
      // фреймтайм ~8 мс с дрожанием и редкими статтерами до ~26 мс
      const hist = [];
      for (let k = 59; k >= 0; k--) {
        const tt = t - k;
        let ft = 8 + 3 * Math.sin(tt / 4) + 1.5 * Math.sin(tt / 1.7);
        if (Math.sin(tt / 13) > 0.95) ft += 18;
        hist.push(+ft.toFixed(2));
      }
      const cur = hist[hist.length - 1];
      const worst = [...hist].sort((a, b) => a - b);
      const p99 = worst[Math.min(worst.length - 1, Math.ceil(worst.length * 0.99) - 1)];
      return {
        app_name: "Demo Game", fps: Math.round(1000 / cur), frametime_ms: cur,
        history: hist, low1_fps: +(1000 / p99).toFixed(1),
      };
    })(),
    metrics: {
      cpu_temp:  mk(+w(49, 6, 3).toFixed(1),          "°C",  "CPU [#0]: AMD Ryzen 9 9950X3D", "CPU Package"),
      cpu_load:  mk(+Math.max(1, w(7, 6, 4)).toFixed(1), "%", "CPU", "Total CPU Usage"),
      cpu_clock: mk(Math.round(w(5200, 400, 2)),       "MHz", "CPU", "Core Clocks"),
      cpu_power: mk(+w(80, 20, 3).toFixed(1),          "W",   "CPU", "Package Power"),
      ccd1_temp: mk(+w(38, 3, 4).toFixed(1),           "°C",  "AMD Ryzen 9 9950X3D", "CCD1 (Tdie)"),
      ccd2_temp: mk(+w(43, 4, 5).toFixed(1),           "°C",  "AMD Ryzen 9 9950X3D", "CCD2 (Tdie)"),
      vrm_temp:  mk(+w(38, 2, 8).toFixed(1),           "°C",  "Motherboard", "MOS"),
      chipset_temp: mk(+w(50, 3, 7).toFixed(1),        "°C",  "AMD Chipset", "Chipset 1 (xHCI)"),
      chipset_board_temp: mk(+w(41, 2, 9).toFixed(1),  "°C",  "Motherboard", "Chipset A"),
      mobo_temp: mk(+w(39, 2, 6).toFixed(1),           "°C",  "Motherboard", "System"),
      vcore:     mk(+w(1.25, 0.08, 3).toFixed(3),      "В",   "Motherboard", "Vcore"),
      soc_volt:  mk(+w(1.31, 0.02, 6).toFixed(3),      "В",   "Motherboard", "CPU NB/SoC"),
      pump_rpm:  mk(Math.round(w(2850, 100, 5)),       "RPM", "Motherboard", "PUMP SYS1"),
      fan_sys1:  mk(Math.round(w(1690, 120, 6)),       "RPM", "Motherboard", "Система 1"),
      fan_sys2:  mk(Math.round(w(1500, 110, 7)),       "RPM", "Motherboard", "Система 5"),
      fan_sys3:  mk(Math.round(w(1590, 115, 8)),       "RPM", "Motherboard", "Система 6"),
      gpu_temp:  mk(+w(33, 4, 5).toFixed(1),           "°C",  "GPU [#0]: NVIDIA GeForce RTX 5080", "GPU Temperature"),
      gpu_load:  mk(+Math.max(1, w(9, 8, 3)).toFixed(1), "%", "GPU", "GPU Core Load"),
      gpu_clock: mk(Math.round(w(2535, 200, 2)),        "MHz", "GPU", "GPU Core Clock"),
      gpu_power: mk(+w(70, 15, 4).toFixed(1),           "W",   "GPU", "GPU Power"),
      gpu_hotspot: mk(+w(43, 5, 5).toFixed(1),          "°C",  "GPU", "GPU Hot Spot"),
      gpu_fan:   mk(Math.round(w(1100, 150, 4)),        "RPM", "GPU", "Fan (max)"),
      vram_clock: mk(Math.round(w(1400, 1300, 6)),      "МГц", "GPU", "Частота памяти ГП"),
      vram_ctrl_load: mk(+Math.max(0, w(14, 10, 4)).toFixed(1), "%", "GPU", "Нагрузка контроллера памяти ГП"),
      bus_load:  mk(+Math.max(0, w(30, 25, 5)).toFixed(1), "%", "GPU", "Нагрузка на шину ГП"),
      pcie_speed: mk(16, "GT/s", "GPU", "Скорость соединения PCIe"),
      ram_load:  mk(+w(46, 4, 7).toFixed(1),            "%",   "Memory", "Memory Usage"),
      ram_used:  mk(+w(14.1, 1, 7).toFixed(1),          "GB",  "Memory", "Used"),
      ram_avail: mk(+w(16.9, 1, 7).toFixed(1),          "GB",  "Memory", "Available"),
      vram_load: mk(+w(15, 5, 6).toFixed(1),            "%",   "GPU", "Memory Usage"),
      vram_used: mk(+w(2.4, 0.5, 6).toFixed(1),         "GB",  "GPU", "Memory Used"),
      fps:       mk(Math.round(Math.max(0, w(120, 40, 2))), "FPS", "Frames", "FPS"),
    },
  };
}

/* ── оформление из config.json: фон ("none" = без фона) и эффект подписей ── */
async function startEffects() {
  // значения по умолчанию: без pywebview (страница открыта в браузере)
  let config = { background: "cipher-rain", label_glitch: true };
  if (window.pywebview) config = await window.pywebview.api.get_config();
  // "letter-glitch" — старый фон до 0.1.1; в чужих config.json он ещё встречается
  const name = config.background === "letter-glitch" ? "cipher-rain" : config.background;
  const background = (window.HudBackgrounds || {})[name];
  if (background) background.start(document.getElementById("hud-bg"));
  if (config.label_glitch) window.HudLabelGlitch.start();
}

/* ── кнопка «Отчёт»: скриншот + датчики в .zip на рабочем столе ── */
function setupReportButton() {
  const btn = document.getElementById("report-btn");
  if (!btn || btn.dataset.ready) return;
  btn.dataset.ready = "1";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Сохраняю…";
    let res;
    try { res = await window.pywebview.api.save_report(); }
    catch (e) { res = { ok: false, error: String(e) }; }
    btn.disabled = false;
    btn.dataset.state = res.ok ? "ok" : "err";
    btn.textContent = res.ok ? "Сохранено на рабочий стол" : "Не удалось сохранить";
    btn.title = res.ok ? res.path : res.error;
    setTimeout(() => {
      btn.textContent = "Отчёт";
      delete btn.dataset.state;
      btn.title = "Скриншот и список датчиков одним архивом на рабочий стол — для автора";
    }, 5000);
  });
}

window.addEventListener("pywebviewready", () => {
  setupReportButton();
  startEffects();
  pollLoop(1000);
});
window.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    if (!window.pywebview) {
      // открыто в браузере: сохранять отчёт некому
      const btn = document.getElementById("report-btn");
      if (btn) btn.hidden = true;
      startEffects();
      pollLoop(1000);
    }
  }, 300);
});
