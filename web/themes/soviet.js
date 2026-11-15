/* Тема «Приборная панель» — советский щит приборов 60–80-х:
 * стрелочные приборы (круглый термометр и щитовые), барабанные счётчики,
 * профильные шкалы для ядер, самописцы вместо графиков, сигнальные лампочки.
 *
 * Данные — те же снимки, что и у остальных тем (app.js вызывает render(snap) каждую
 * секунду). Обычная разметка HUD в этой теме скрыта, тема строит свою поверх той же
 * сетки (.hud: cpu / gpu / mini / foot). Стили — themes/soviet.css, шрифты — fonts/ (OFL).
 */
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const FRAME_MS = 33;                       // ~30 кадров/с, как у счёта чисел в app.js
  const INKS = { violet: "#3b2a86", red: "#a3241c", green: "#1f6b34", blue: "#1d4f9a" };
  // пороги лампочек перегрева: [жёлтая, красная мигающая]
  const LAMP = { cpu: [80, 90], gpu: [80, 88], hotspot: [90, 100] };

  let opts = { overshoot: true, paper: "bright", ink: "violet", lamps: true };
  let built = false, tick = 0, root = null;
  const S = {};                              // приборы и барабаны после build()
  const $ = (sel) => root.querySelector(sel);

  /* ── мелочи ───────────────────────────────────────────── */
  const num = (m) => (m && m.value != null && !Number.isNaN(Number(m.value)) ? Number(m.value) : null);
  const rad = (d) => (d * Math.PI) / 180;
  const pt = (cx, cy, r, a) => [cx + r * Math.sin(rad(a)), cy - r * Math.cos(rad(a))];
  const arc = (cx, cy, r, a0, a1) => {
    const [x0, y0] = pt(cx, cy, r, a0), [x1, y1] = pt(cx, cy, r, a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  const comma = (s) => String(s).replace(".", ",");
  const gb = (v) => (v >= 1000 ? `${comma((v / 1024).toFixed(1))} ТБ` : `${Math.round(v || 0)} ГБ`);
  const screws = '<i class="sv-screw sv-screw--tl"></i><i class="sv-screw sv-screw--tr"></i>' +
                 '<i class="sv-screw sv-screw--bl"></i><i class="sv-screw sv-screw--br"></i>';
  function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }

  /* ── анимация: один цикл на все стрелки и барабаны, спит, когда всё стоит ── */
  const movers = new Set();
  let frame = 0, last = 0;
  function wake(m) { movers.add(m); if (!frame) { last = performance.now(); frame = requestAnimationFrame(loop); } }
  function loop(now) {
    frame = 0;
    if (now - last < FRAME_MS - 2) { frame = requestAnimationFrame(loop); return; }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    for (const m of movers) if (!m.step(dt, now)) movers.delete(m);
    if (movers.size) frame = requestAnimationFrame(loop);
  }

  /* Стрелка: пружина с затуханием. С «перелётом» — недодемпфированная (проскакивает
     и возвращается), без него — подходит к значению плавно, не перелетая. */
  function needle(g, cx, cy, toAngle) {
    const n = { angle: toAngle(0), vel: 0, target: toAngle(0), toAngle };
    const paint = () => g.setAttribute("transform", `rotate(${n.angle.toFixed(2)} ${cx} ${cy})`);
    n.step = (dt) => {
      const k = 60, zeta = opts.overshoot ? 0.38 : 1;
      const c = 2 * zeta * Math.sqrt(k);
      // полушаги — устойчивее при 30 кадрах
      for (let i = 0; i < 2; i++) {
        const a = k * (n.target - n.angle) - c * n.vel;
        n.vel += a * dt / 2;
        n.angle += n.vel * dt / 2;
      }
      paint();
      return Math.abs(n.target - n.angle) > 0.05 || Math.abs(n.vel) > 0.05;
    };
    n.set = (v) => { const t = n.toAngle(v); if (t !== n.target) { n.target = t; wake(n); } };
    paint();
    return n;
  }

  /* Барабанный счётчик: каждая цифра — барабан 0…9, при смене значения доворачивается
     кратчайшим путём (9 → 0 — вперёд через нижний «0»). digits — целых разрядов,
     frac — после запятой. Нет данных — на всех барабанах прочерк. */
  function drum(digits, frac = 0, cls = "") {
    const el = document.createElement("span");
    el.className = `sv-drum sv-drum--off ${cls}`.trim();
    const cells = [];
    const col = () => {
      const c = document.createElement("span");
      c.className = "sv-drum__d";
      const strip = document.createElement("span");
      strip.className = "sv-drum__col";
      strip.innerHTML = "01234567890-".split("").map((x) => `<span>${x}</span>`).join("");
      c.append(strip);
      el.append(c);
      cells.push({ strip, p: 0, from: 0, to: 0, dash: true });
    };
    for (let i = 0; i < digits; i++) col();
    if (frac) { const s = document.createElement("span"); s.className = "sv-drum__sep"; s.textContent = ","; el.append(s); }
    for (let i = 0; i < frac; i++) col();
    const place = (c) => {
      const pos = c.dash ? 11 : ((c.p % 10) + 10) % 10;
      c.strip.style.transform = `translateY(${(-pos * 1.25).toFixed(3)}em)`;
    };
    cells.forEach(place);
    const d = { el, t0: 0 };
    d.step = (dt, now) => {
      const t = Math.min(1, (now - d.t0) / 650), e = 1 - Math.pow(1 - t, 3);
      for (const c of cells) { c.p = c.from + (c.to - c.from) * e; place(c); }
      return t < 1;
    };
    d.set = (v) => {
      const off = v == null || Number.isNaN(v);
      let target = [];
      if (!off) {
        const n = Math.max(0, Math.min(Math.round(v * 10 ** frac), 10 ** (digits + frac) - 1));
        target = String(n).padStart(digits + frac, "0").split("").map(Number);
      }
      let moved = false;
      cells.forEach((c, i) => {
        if (off || c.dash) {                       // прочерк ↔ цифра — без прокрутки
          c.dash = off;
          c.p = c.from = c.to = off ? 0 : target[i];
          place(c);
          return;
        }
        const diff = (((target[i] - c.p) % 10) + 10) % 10;
        const delta = diff > 5 ? diff - 10 : diff;
        c.from = c.p; c.to = c.p + delta;
        if (Math.abs(delta) > 1e-3) moved = true;
      });
      el.classList.toggle("sv-drum--off", off);
      if (moved) { d.t0 = performance.now(); wake(d); }
    };
    return d;
  }

  /* ── круглый прибор 270° со счётчиком в окошке (как одометр в спидометре) ── */
  function roundGauge(host, { size = 196, min = 20, max = 100, step = 10, minor = 2, red = 90, unit = "°C" }) {
    const c = size / 2, R = c - 6, A0 = -135, A1 = 135;
    const ang = (v) => A0 + ((Math.max(min - 3, Math.min(max + 3, v ?? min)) - min) / (max - min)) * (A1 - A0);
    let s = `<svg class="sv-round" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${c}" cy="${c}" r="${R + 4}" class="sv-face"/>
      <path d="${arc(c, c, R - 12, ang(red), A1)}" class="sv-zone" stroke-width="9" fill="none"/>`;
    for (let v = min; v <= max + 1e-9; v += minor) {
      const a = ang(v), major = Math.abs((v - min) % step) < 1e-6;
      const [x0, y0] = pt(c, c, R - (major ? 21 : 13), a), [x1, y1] = pt(c, c, R - 6, a);
      s += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" class="sv-tick" stroke-width="${major ? 2.3 : 1.1}"/>`;
      if (major) {
        const [tx, ty] = pt(c, c, R - 36, a);
        s += `<text x="${tx}" y="${ty + 6}" class="sv-num" font-size="${(size * 0.085).toFixed(1)}">${v}</text>`;
      }
    }
    s += `<path d="${arc(c, c, R - 6, A0, A1)}" class="sv-tick" stroke-width="1.2" fill="none"/>
      <text x="${c}" y="${c + R * 0.36}" class="sv-num" font-size="${(size * 0.1).toFixed(1)}">${unit}</text>
      <foreignObject x="${c - 40}" y="${c + R * 0.43}" width="80" height="34"><div xmlns="http://www.w3.org/1999/xhtml" class="sv-round__win"></div></foreignObject>
      <g class="sv-needle"><line x1="${c}" y1="${c + R * 0.2}" x2="${c}" y2="${c - R + 8}" class="sv-needle__body" stroke-width="3.2"/>
        <line x1="${c}" y1="${c - R * 0.55}" x2="${c}" y2="${c - R + 8}" class="sv-needle__tip" stroke-width="3.2"/></g>
      <circle cx="${c}" cy="${c}" r="${size * 0.06}" fill="#1c1b19"/><circle cx="${c}" cy="${c}" r="${size * 0.025}" fill="#77756e"/>
      <circle cx="${c}" cy="${c}" r="${R + 4}" class="sv-glass"/></svg>`;
    host.innerHTML = `<div class="sv-bezel">${s}</div>`;
    const dr = drum(3, 0, "sv-drum--red");
    host.querySelector(".sv-round__win").append(dr.el);
    const n = needle(host.querySelector(".sv-needle"), c, c, ang);
    return { set(v) { n.set(v); dr.set(v == null ? null : Math.round(v)); } };
  }

  /* ── щитовой прибор: прямоугольный, дуга ±37°, зеркальная полоска, класс точности ── */
  const NICE = [100, 150, 200, 300, 400, 500, 600, 800, 1000];
  function stepFor(max) { return max <= 100 ? 20 : max <= 200 ? 50 : max <= 600 ? 100 : 200; }
  function panelMeter(host, { w = 176, h = 132, max = 100, unit = "%", red = null, grow = false }) {
    const cx = w / 2, cy = h + 30, R = h + 6, A = 37;
    const m = { max, needle: null, value: null };
    function build() {
      const step = stepFor(m.max), minor = step / 5;
      const ang = (v) => -A + (Math.max(-0.03, Math.min(1.03, (v ?? 0) / m.max))) * 2 * A;
      const redFrom = red != null ? red * m.max : null;
      let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" class="sv-face"/>
        <path d="${arc(cx, cy, R - 44, -A, A)}" class="sv-mirror" stroke-width="5" fill="none"/>`;
      if (redFrom != null) s += `<path d="${arc(cx, cy, R - 29, ang(redFrom), A)}" class="sv-zone" stroke-width="6" fill="none"/>`;
      for (let v = 0; v <= m.max + 1e-9; v += minor) {
        const a = ang(v), major = Math.abs(v % step) < 1e-6;
        const [x0, y0] = pt(cx, cy, R - (major ? 39 : 33), a), [x1, y1] = pt(cx, cy, R - 25, a);
        s += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" class="sv-tick" stroke-width="${major ? 2 : 1}"/>`;
        if (major) {
          const [tx, ty] = pt(cx, cy, R - 13, a);
          s += `<text x="${tx}" y="${ty + 5}" class="sv-num" font-size="13">${v}</text>`;
        }
      }
      s += `<svg x="0" y="0" width="${w}" height="${h - 32}" overflow="hidden">
          <g class="sv-needle"><line x1="${cx}" y1="${cy - 30}" x2="${cx}" y2="${cy - R + 6}" class="sv-needle__body" stroke-width="2"/></g></svg>
        <rect y="${h - 32}" width="${w}" height="32" fill="#1d1c1a"/>
        <text x="${cx}" y="${h - 10}" class="sv-num sv-num--light" font-size="18">${unit}</text>
        <text x="${w - 8}" y="${h - 11}" text-anchor="end" class="sv-mark">кл. 1,5</text>
        <text x="8" y="${h - 11}" class="sv-mark">⊓ ∼</text>
        <rect width="${w}" height="${h - 32}" class="sv-glass" opacity="0.6"/></svg>`;
      host.innerHTML = `<div class="sv-rbezel">${s}</div>`;
      const prev = m.needle;
      m.needle = needle(host.querySelector(".sv-needle"), cx, cy, ang);
      if (prev) { m.needle.angle = prev.angle; }       // после смены шкалы стрелка едет с места
    }
    build();
    m.set = (v) => {
      if (grow && v != null && v > m.max * 0.97) {
        const next = NICE.find((x) => x > v * 1.05);
        if (next && next !== m.max) { m.max = next; build(); }
      }
      m.needle.set(v);
    };
    return m;
  }

  /* ── самописец: бумага в сетку, чернильная линия, перо у правого края ── */
  function drawRecorder(canvas, hist, { len, lo, hi, minSpan = 10, smooth = 0, pad = 0.12 }) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dim = opts.paper === "dim";
    ctx.fillStyle = dim ? "#9d977f" : "#f2ecd9";
    ctx.fillRect(0, 0, W, H);

    const PEN = 12;                                   // правый край: каретка с пером
    // пока запись короче окна (первые минуты после запуска), лента идёт крупнее:
    // окно растёт от минуты до полного (10 минут у плиток платы и ГП)
    const filled = (hist || []).length;
    const n = Math.max(2, Math.min(len, Math.max(60, filled)));
    const plotW = W - PEN, step = plotW / (n - 1);
    // вертикальная сетка привязана ко времени — бумага «едет» вместе с записью
    const minorEvery = Math.max(1, Math.round(n / 30)), majorEvery = minorEvery * 5;
    for (let i = 0; i < n; i++) {
      const g = tick - (n - 1 - i);
      if (g % minorEvery) continue;
      const major = g % majorEvery === 0;
      ctx.strokeStyle = major ? (dim ? "rgba(120,40,20,0.45)" : "rgba(196,92,60,0.45)") : (dim ? "rgba(120,40,20,0.22)" : "rgba(196,92,60,0.2)");
      ctx.lineWidth = 1;
      const x = Math.round(i * step) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    ctx.strokeStyle = dim ? "rgba(120,40,20,0.22)" : "rgba(196,92,60,0.2)";
    for (let k = 1; k < 6; k++) {
      const y = Math.round((H * k) / 6) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
    }

    let data = (hist || []).slice(-n).filter((v) => v != null && !Number.isNaN(v));
    if (smooth && data.length > 2) {
      data = data.map((_, i) => {
        let s = 0, c = 0;
        for (let j = Math.max(0, i - smooth); j <= Math.min(data.length - 1, i + smooth); j++) { s += data[j]; c++; }
        return s / c;
      });
    }
    // шкала: заданная или по данным, но не уже minSpan — иначе дрожь в 1 °C на всю высоту
    let a = lo, b = hi;
    if (data.length && (a == null || b == null)) {
      const mn = Math.min(...data), mx = Math.max(...data);
      const mid = (mn + mx) / 2, span = Math.max(minSpan, (mx - mn) * (1 + pad * 2));
      if (a == null) a = mid - span / 2;
      if (b == null) b = a + span;
    }
    if (a == null) a = 0;
    if (b == null || b <= a) b = a + minSpan;
    const Y = (v) => H - 4 - ((Math.max(a, Math.min(b, v)) - a) / (b - a)) * (H - 8);

    if (data.length > 1) {
      const off = n - data.length;
      ctx.beginPath();
      data.forEach((v, i) => { const x = (off + i) * step, y = Y(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = INKS[opts.ink] || INKS.violet;
      ctx.globalAlpha = dim ? 0.8 : 0.9;
      ctx.lineWidth = 1.7; ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // каретка и перо
    ctx.fillStyle = "#151513";
    ctx.fillRect(plotW, 0, PEN, H);
    const py = data.length ? Y(data[data.length - 1]) : H - 4;
    ctx.fillStyle = "#c9c4b4";
    ctx.beginPath(); ctx.moveTo(plotW - 2, py); ctx.lineTo(W, py - 5); ctx.lineTo(W, py + 5); ctx.closePath(); ctx.fill();
    // блик стекла
    const gl = ctx.createLinearGradient(0, 0, W * 0.6, H);
    gl.addColorStop(0, "rgba(255,255,255,0.18)"); gl.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gl; ctx.fillRect(0, 0, W, H);
  }

  /* ── разметка ──────────────────────────────────────────── */
  function recHtml(id, title, unit, digits, frac = 0) {
    return `<div class="sv-rec" data-rec="${id}">
      <div class="sv-rec__head"><span class="sv-rec__t">${title}</span><span class="sv-lamp sv-lamp--small" data-lamp="${id}" hidden></span>
        <span class="sv-slot" data-drum="${id}" data-digits="${digits}" data-frac="${frac}"></span><span class="sv-unit">${unit}</span></div>
      <div class="sv-rec__win"><canvas></canvas></div>
      <div class="sv-rec__sub" data-sub="${id}">&nbsp;</div></div>`;
  }
  function readout(id, label, unit, digits, frac = 0) {
    return `<div class="sv-readout"><span class="sv-cap">${label}</span>
      <div><span class="sv-slot" data-drum="${id}" data-digits="${digits}" data-frac="${frac}"></span><span class="sv-unit sv-unit--lg">${unit}</span></div></div>`;
  }
  function meterRow(p) {
    return `<div class="sv-meters">
      <div class="sv-mcol"><div data-gauge="${p}_temp"></div><span class="sv-cap">Температура</span></div>
      <div class="sv-mcol"><div data-gauge="${p}_load"></div><span class="sv-cap">Нагрузка</span></div>
      <div class="sv-mcol"><div data-gauge="${p}_power"></div><span class="sv-cap">Мощность</span></div>
      <div class="sv-readouts">${p === "cpu"
        ? readout("cpu_clock", "Частота", "МГц", 4) + readout("vcore", "Напряжение", "В", 1, 2)
        : readout("gpu_clock", "Частота", "МГц", 4) + readout("vram_clock", "Частота памяти", "МГц", 5)}</div>
    </div>`;
  }
  function memHtml(id, plate) {
    return `<div class="sv-mem">
      <div class="sv-mem__row"><span class="sv-plate sv-plate--sm">${plate}</span>
        <span class="sv-slot" data-drum="${id}_pct" data-digits="3"></span><span class="sv-unit">%</span>
        <span class="sv-mem__extra" data-sub="${id}_extra"></span></div>
      <div class="sv-hbar" data-hbar="${id}"><u></u></div>
      <div class="sv-mem__sub" data-sub="${id}">&nbsp;</div></div>`;
  }

  function build() {
    const hud = document.querySelector(".hud");
    root = document.createElement("div");
    root.className = "sv";
    root.innerHTML = `
    <svg width="0" height="0" style="position:absolute"><defs><linearGradient id="sv-glass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.32"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.04"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs></svg>
    <section class="sv-card sv-card--cpu">${screws}
      <div class="sv-head"><span class="sv-plate">ЦП</span><span class="sv-name" data-name="cpu">—</span><span class="sv-lamp" data-lamp="cpu" title="Перегрев ЦП"></span></div>
      ${meterRow("cpu")}
      <div class="sv-cores" data-cores></div>
      <div class="sv-sect"><b>МП</b> материнская плата</div>
      <div class="sv-recs">${recHtml("vrm", "VRM · MOS", "°C", 3)}${recHtml("chipset", "Чипсет", "°C", 3)}${recHtml("sys", "Система", "°C", 3)}</div>
    </section>
    <section class="sv-card sv-card--gpu">${screws}
      <div class="sv-head"><span class="sv-plate">ГП</span><span class="sv-name" data-name="gpu">—</span><span class="sv-lamp" data-lamp="gpu" title="Перегрев ГП"></span></div>
      ${meterRow("gpu")}
      <div class="sv-sect"><b>ОЗУ</b> память</div>
      <div class="sv-mems">${memHtml("vram", "Видео")}${memHtml("ram", "ОЗУ")}</div>
      <div class="sv-dimms" data-dimms></div>
      <div class="sv-sect"><b>ГП</b> термики и охлаждение</div>
      <div class="sv-recs">${recHtml("hotspot", "Горячая точка", "°C", 3)}${recHtml("fan", "Вентиляторы", "об/мин", 4)}${recHtml("bus", "Шина PCIe", "%", 3)}</div>
    </section>
    <div class="sv-mini">
      <section class="sv-card sv-card--drives">${screws}
        <div class="sv-head"><span class="sv-plate">Накопители</span><span class="sv-lamp" data-lamp="drives" title="Перегрев накопителя"></span></div>
        <div class="sv-drives" data-drives></div>
      </section>
      <section class="sv-card sv-card--net">${screws}
        <div class="sv-head"><span class="sv-plate">Сеть</span><span class="sv-name" data-name="net">—</span></div>
        <div class="sv-recs sv-recs--2">${recHtml("dl", "▼ Приём", "Мбит/с", 4)}${recHtml("up", "▲ Передача", "Мбит/с", 4)}</div>
      </section>
      <section class="sv-card sv-card--fps">${screws}
        <div class="sv-head"><span class="sv-plate">Кадры</span><span class="sv-name" data-name="fps">—</span><span class="sv-lamp sv-lamp--green" data-lamp="fps" title="Игра идёт"></span></div>
        <div class="sv-fps">
          <div class="sv-readout"><span class="sv-cap">кадр/с</span><span class="sv-slot sv-slot--xl" data-drum="fps" data-digits="3"></span></div>
          <div class="sv-fps__info">
            <div><span class="sv-cap">время кадра</span><span class="sv-slot" data-drum="ft" data-digits="2" data-frac="1"></span><span class="sv-unit">мс</span></div>
            <div><span class="sv-cap">1% худших</span><span class="sv-slot" data-drum="low" data-digits="3"></span><span class="sv-unit">к/с</span></div>
          </div>
        </div>
        <div class="sv-rec__win sv-rec__win--fps"><canvas data-canvas="fps"></canvas></div>
      </section>
    </div>`;
    hud.insertBefore(root, hud.querySelector(".hud__foot"));
    // .sv — обёртка без своей коробки: карточки встают прямо в сетку .hud

    S.drums = {};
    root.querySelectorAll("[data-drum]").forEach((slot) => {
      const d = drum(+slot.dataset.digits, +(slot.dataset.frac || 0));
      slot.append(d.el);
      S.drums[slot.dataset.drum] = d;
    });
    S.g = {
      cpu_temp: roundGauge($('[data-gauge="cpu_temp"]'), { red: 90 }),
      gpu_temp: roundGauge($('[data-gauge="gpu_temp"]'), { red: 85 }),
      cpu_load: panelMeter($('[data-gauge="cpu_load"]'), { unit: "%" }),
      gpu_load: panelMeter($('[data-gauge="gpu_load"]'), { unit: "%" }),
      cpu_power: panelMeter($('[data-gauge="cpu_power"]'), { unit: "Вт", max: 200, red: 0.85, grow: true }),
      gpu_power: panelMeter($('[data-gauge="gpu_power"]'), { unit: "Вт", max: 400, red: 0.85, grow: true }),
    };
    built = true;
  }

  /* ── ядра: профильные приборы по группам (ККД) ─────────── */
  function renderCores(cores, groups, m) {
    const host = $("[data-cores]");
    if (!cores || !cores.length) { host.hidden = true; return; }
    host.hidden = false;
    if (!groups || !groups.length) groups = [{ name: "Ядра", tag: null, cores: cores.map((c) => c.id) }];
    const layout = groups.map((g) => `${g.name}:${g.cores.join(",")}`).join("|");
    if (host.dataset.layout !== layout) {
      host.dataset.layout = layout;
      host.innerHTML = groups.map((g) => {
        const name = String(g.name).replace(/^CCD/, "ККД");
        const tag = g.vcache ? '<span class="sv-plate sv-plate--sm">3D-кэш</span>' : "";
        const ids = g.cores;
        return `<div class="sv-ccd"><div class="sv-sect"><b>${name}</b>${tag}<span>ядра ${ids[0] + 1}–${ids[ids.length - 1] + 1}</span>
            <span class="sv-ccd__t" data-gtemp="${g.temp_key || ""}"></span></div>
          <div class="sv-strip">${ids.map((id) => `<div class="sv-edge" data-core="${id}">
            <span class="sv-edge__n">Я${id + 1}</span>
            <div class="sv-edge__face"><i class="sv-edge__ptr"></i></div>
            <span class="sv-edge__f">--</span></div>`).join("")}</div></div>`;
      }).join("");
      host.classList.toggle("sv-cores--one", groups.length === 1);
    }
    for (const c of cores) {
      const el = host.querySelector(`[data-core="${c.id}"]`);
      if (!el) continue;
      el.classList.toggle("sv-edge--sleep", !!c.sleep);
      const load = c.sleep || c.load == null ? 0 : Math.max(0, Math.min(100, c.load));
      el.querySelector(".sv-edge__ptr").style.bottom = `calc(4px + ${(load / 100).toFixed(3)} * (100% - 8px))`;
      setText(el.querySelector(".sv-edge__f"), c.sleep ? "сон" : c.clock != null ? comma((c.clock / 1000).toFixed(2)) : "--");
      el.title = `Ядро ${c.id + 1}: ${c.sleep ? "спит" : `${Math.round(load)} %`}${c.temp != null ? `, ${Math.round(c.temp)} °C` : ""}`;
    }
    host.querySelectorAll("[data-gtemp]").forEach((el) => {
      const v = num(m[el.dataset.gtemp]);
      setText(el, v != null ? `${Math.round(v)} °C` : "");
    });
  }

  function renderDimms(dimms) {
    const host = $("[data-dimms]");
    const slots = dimms.map((d) => d.slot).join(",");
    if (host.dataset.slots !== slots) {
      host.dataset.slots = slots;
      host.innerHTML = dimms.length ? `<span class="sv-cap">Планки</span>` + dimms.map((d) =>
        `<span class="sv-dimm"><span class="sv-cap">DIMM${d.slot}</span><span class="sv-slot" data-dimm="${d.slot}"></span><span class="sv-unit">°C</span></span>`).join("") : "";
      S.dimm = {};
      host.querySelectorAll("[data-dimm]").forEach((slot) => {
        const d = drum(2, 0, "sv-drum--sm");
        slot.append(d.el);
        S.dimm[slot.dataset.dimm] = d;
      });
    }
    dimms.forEach((d) => S.dimm[d.slot] && S.dimm[d.slot].set(d.temp != null ? Math.round(d.temp) : null));
  }

  function renderDrives(drives) {
    const host = $("[data-drives]");
    const list = drives || [];
    const layout = list.map((d) => `${d.kind} ${d.letter} ${d.name}`).join("|");
    if (host.dataset.layout !== layout) {
      host.dataset.layout = layout;
      host.innerHTML = list.length ? list.map((d) => `<div class="sv-drive" data-letter="${d.letter}">
          <span class="sv-drive__l">${d.letter}</span><span class="sv-drive__k">${d.kind === "HDD" ? "ЖМД" : d.kind === "NVMe" ? "NVMe" : "ТТН"}</span>
          <div class="sv-hbar"><u></u></div><span class="sv-drive__s"></span></div>`).join("") +
        `<div class="sv-drive sv-drive--rw"><span class="sv-cap">Чт / Зп</span><span></span>
          <div><span class="sv-slot" data-rw="r"></span><span class="sv-cap"> / </span><span class="sv-slot" data-rw="w"></span><span class="sv-unit">МБ/с</span></div><span></span></div>`
        : '<div class="sv-cap">нет данных</div>';
      host.classList.toggle("sv-drives--dense", list.length > 3);
      S.rw = {};
      host.querySelectorAll("[data-rw]").forEach((slot) => { const d = drum(4); slot.append(d.el); S.rw[slot.dataset.rw] = d; });
    }
    let hot = 0, r = 0, w = 0;
    for (const d of list) {
      const row = host.querySelector(`[data-letter="${d.letter}"]`);
      if (!row) continue;
      const p = d.used_pct != null ? Math.max(0, Math.min(100, d.used_pct)) : null;
      row.querySelector("u").style.left = `calc(${p ?? 0}% - 1.5px)`;
      const t = d.temp != null ? Math.round(d.temp) : null;
      const [amber, red] = d.kind === "HDD" ? [45, 55] : [60, 75];
      if (t != null) hot = Math.max(hot, t >= red ? 2 : t >= amber ? 1 : 0);
      const size = d.total_gb ? `${gb(d.used_gb)} / ${gb(d.total_gb)}` : (p != null ? `${Math.round(p)} %` : "");
      setText(row.querySelector(".sv-drive__s"), `${size}${t != null ? ` · ${t}°` : ""}`);
      r += d.read_mbs || 0; w += d.write_mbs || 0;
    }
    if (S.rw.r) { S.rw.r.set(list.length ? Math.round(r) : null); S.rw.w.set(list.length ? Math.round(w) : null); }
    lamp("drives", hot);
  }

  /* лампочка: 0 — погашена, 1 — жёлтая, 2 — красная мигающая */
  function lamp(id, level) {
    const el = $(`[data-lamp="${id}"]`);
    if (!el) return;
    const lv = opts.lamps ? level : 0;
    el.dataset.level = String(lv);
    if (el.classList.contains("sv-lamp--small")) el.hidden = lv === 0;
  }
  const level = (v, [a, r]) => (v == null ? 0 : v >= r ? 2 : v >= a ? 1 : 0);

  function setRec(id, hist, cfg, value, sub) {
    const box = $(`[data-rec="${id}"]`);
    if (!box) return;
    drawRecorder(box.querySelector("canvas"), hist, cfg);
    if (S.drums[id]) S.drums[id].set(value);
    if (sub !== undefined) setText($(`[data-sub="${id}"]`), sub || " ");
  }
  const minmax = (h, digits = 0) => {
    const d = (h || []).filter((v) => v != null);
    if (!d.length) return "";
    return `мин ${comma(Math.min(...d).toFixed(digits))} · макс ${comma(Math.max(...d).toFixed(digits))}`;
  };

  /* ── главный рендер ────────────────────────────────────── */
  function render(snap) {
    if (!built) build();
    tick++;
    const m = snap.metrics || {};
    const clean = (s) => (s || "").replace(/^.*?\[#\d+\]:\s*/, "").split(":")[0].trim();
    setText($('[data-name="cpu"]'), clean(m.cpu_temp?.sensor || m.cpu_load?.sensor) || "—");
    setText($('[data-name="gpu"]'), clean(m.gpu_temp?.sensor || m.gpu_load?.sensor) || "—");

    const cpuT = num(m.cpu_temp), gpuT = num(m.gpu_temp);
    S.g.cpu_temp.set(cpuT); S.g.gpu_temp.set(gpuT);
    S.g.cpu_load.set(num(m.cpu_load)); S.g.gpu_load.set(num(m.gpu_load));
    S.g.cpu_power.set(num(m.cpu_power)); S.g.gpu_power.set(num(m.gpu_power));
    S.drums.cpu_clock.set(num(m.cpu_clock));
    S.drums.vcore.set(num(m.vcore));
    S.drums.gpu_clock.set(num(m.gpu_clock));
    S.drums.vram_clock.set(num(m.vram_clock));
    lamp("cpu", level(cpuT, LAMP.cpu));
    lamp("gpu", level(gpuT, LAMP.gpu));

    renderCores(snap.cores || [], snap.core_groups, m);

    // материнская плата
    const mb = snap.mb_history || {};
    const soc = num(m.soc_volt);
    setRec("vrm", mb.vrm, { len: 600, smooth: 4 }, num(m.vrm_temp) != null ? Math.round(num(m.vrm_temp)) : null,
      soc != null ? `SoC ${comma(soc.toFixed(3))} В · ${minmax(mb.vrm)}` : minmax(mb.vrm));
    const chB = num(m.chipset_board_temp);
    setRec("chipset", mb.chipset, { len: 600, smooth: 4 }, num(m.chipset_temp) != null ? Math.round(num(m.chipset_temp)) : null,
      chB != null ? `у платы ${Math.round(chB)} °C · ${minmax(mb.chipset)}` : minmax(mb.chipset));
    const fans = [m.fan_sys1, m.fan_sys2, m.fan_sys3].map(num).filter((v) => v > 0).map(Math.round);
    const pump = num(m.pump_rpm);
    const sysSub = [pump > 0 ? `помпа ${Math.round(pump)}` : "", fans.length ? `вент. ${fans.join(" ")}` : ""].filter(Boolean).join(" · ");
    setRec("sys", mb.sys, { len: 600, smooth: 4 }, num(m.mobo_temp) != null ? Math.round(num(m.mobo_temp)) : null, sysSub || minmax(mb.sys));

    // память
    const vramUsed = num(m.vram_used), vramTotal = Number(snap.vram_total_gb) || null;
    const vramPct = vramUsed != null && vramTotal ? (vramUsed / vramTotal) * 100 : num(m.vram_load);
    const ramUsed = num(m.ram_used), ramAvail = num(m.ram_avail);
    const ramTotal = ramUsed != null && ramAvail != null ? ramUsed + ramAvail : null;
    const ramPct = num(m.ram_load) ?? (ramTotal ? (ramUsed / ramTotal) * 100 : null);
    const mem = (id, pct, used, total, extra) => {
      S.drums[`${id}_pct`].set(pct != null ? Math.round(pct) : null);
      $(`[data-hbar="${id}"] u`).style.left = `calc(${Math.max(0, Math.min(100, pct ?? 0))}% - 1.5px)`;
      setText($(`[data-sub="${id}"]`), used != null ? `занято ${comma(used.toFixed(1))} из ${total != null ? comma(Number(total).toFixed(1)) : "--"} ГБ` : " ");
      setText($(`[data-sub="${id}_extra"]`), extra);
    };
    const ctrl = num(m.vram_ctrl_load);
    mem("vram", vramPct, vramUsed, vramTotal, ctrl != null ? `контроллер ${Math.round(ctrl)} %` : "");
    mem("ram", ramPct, ramUsed, ramTotal, ramAvail != null ? `свободно ${comma(ramAvail.toFixed(1))} ГБ` : "");
    renderDimms(snap.dimms || []);

    // термики ГП
    const gh = snap.gpu_history || {};
    const hs = num(m.gpu_hotspot);
    setRec("hotspot", gh.hotspot, { len: 600, smooth: 4 }, hs != null ? Math.round(hs) : null,
      hs != null && gpuT != null ? `Δ к ГП ${Math.round(hs - gpuT)} °C · ${minmax(gh.hotspot)}` : minmax(gh.hotspot));
    lamp("hotspot", level(hs, LAMP.hotspot));
    const gfans = snap.gpu_fans || [];
    const fanHist = gh.fan || [];
    setRec("fan", fanHist, { len: 600, smooth: 4, lo: 0, hi: Math.max(2000, ...fanHist) },
      gfans.length ? Math.max(...gfans) : null, gfans.length ? gfans.map((v, i) => `В${i + 1} ${v}`).join(" · ") : "");
    const bus = num(m.bus_load), pcie = num(m.pcie_speed);
    setRec("bus", gh.bus, { len: 600, smooth: 8, lo: 0, hi: 100 }, bus != null ? Math.round(bus) : null,
      pcie != null ? `PCIe ${Math.round(pcie)} ГТ/с` : "");

    // сеть
    const net = snap.network;
    const parts = ((net && net.name) || "").split(" - ");
    setText($('[data-name="net"]'), net ? parts[parts.length - 1] || net.name : "нет активного адаптера");
    const dl = (net && net.dl_history) || [], up = (net && net.up_history) || [];
    const top = Math.max(10, ...dl, ...up);
    const mx = (h) => (h.length ? `макс ${Math.round(Math.max(...h))}` : "");
    setRec("dl", dl, { len: 60, lo: 0, hi: top }, net ? Math.round(net.dl_mbps) : null, mx(dl));
    setRec("up", up, { len: 60, lo: 0, hi: top }, net ? Math.round(net.up_mbps) : null, mx(up));

    // кадры
    const f = snap.fps;
    const card = $(".sv-card--fps");
    const live = f && f.fps;
    const fallback = !live && num(m.fps) > 0 ? num(m.fps) : null;
    card.classList.toggle("sv-card--idle", !live && fallback == null);
    S.drums.fps.set(live ? Math.round(f.fps) : fallback != null ? Math.round(fallback) : null);
    S.drums.ft.set(live && f.frametime_ms != null ? Number(f.frametime_ms) : null);
    S.drums.low.set(live && f.low1_fps != null ? Math.round(f.low1_fps) : null);
    setText($('[data-name="fps"]'), live ? f.app_name : fallback != null ? "" : snap.rtss_running ? "нет активной игры" : "RTSS не запущен");
    $('[data-lamp="fps"]').dataset.level = live || fallback != null ? "1" : "0";
    const fpsHist = live && f.history ? f.history.map((ft) => (ft > 0 ? 1000 / ft : null)) : [];
    drawRecorder($('[data-canvas="fps"]'), fpsHist, { len: 60, minSpan: 30 });

    renderDrives(snap.drives);
  }

  window.HudThemes.register({
    id: "soviet",
    name: "Приборная панель",
    description: "Щит приборов в советском духе: стрелки, барабанные счётчики, самописцы и лампочки перегрева",
    preview: "themes/previews/soviet.jpg",
    defaults: { case: "enamel", overshoot: true, paper: "bright", ink: "violet", lamps: true },
    sections: [
      { title: "Корпус", items: [
        { key: "case", type: "choice", options: [["enamel", "Эмаль", "#56635b"], ["bakelite", "Карболит", "#2a201a"]],
          hint: "эмаль — серо-зелёная краска приборных шкафов, карболит — тёмная пластмасса" },
      ] },
      { title: "Приборы", items: [
        { key: "overshoot", type: "toggle", label: "Стрелки с перелётом",
          hint: "стрелка проскакивает значение и возвращается, как у настоящего прибора" },
        { key: "lamps", type: "toggle", label: "Лампочки перегрева",
          hint: "ЦП и ГП: жёлтая от 80 °C, красная мигает от 90 (ГП — от 88)" },
      ] },
      { title: "Самописцы", items: [
        { key: "paper", type: "choice", label: "Лента", options: [["bright", "Светлая"], ["dim", "Тусклая"]],
          hint: "тусклая не так бросается в глаза в темноте" },
        { key: "ink", type: "choice", label: "Чернила", vertical: false, options: [
          ["violet", "", INKS.violet], ["red", "", INKS.red], ["green", "", INKS.green], ["blue", "", INKS.blue]] },
      ] },
    ],

    start() {
      window.HudBoot.skip();          // заставки-«взлома» здесь нет
    },

    apply(settings) {
      opts = { ...opts, ...settings };
      const html = document.documentElement;
      html.dataset.svCase = settings.case;
      if (settings.overshoot) delete html.dataset.svStill; else html.dataset.svStill = "";
      if (built) {
        // лампочки и самописцы перерисуются на следующем снимке, стрелки — сразу
        if (!opts.lamps) root.querySelectorAll("[data-lamp]").forEach((el) => { if (el.dataset.lamp !== "fps") el.dataset.level = "0"; });
      }
    },

    render,
  });
})();
