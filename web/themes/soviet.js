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
    [...el.querySelectorAll(".sv-drum__d")].pop().classList.add("sv-drum__d--last");
    const place = (c) => {
      const pos = c.dash ? 11 : ((c.p % 10) + 10) % 10;
      c.strip.style.transform = `translateY(${(-pos * 1.25).toFixed(3)}em)`;
    };
    cells.forEach(place);
    const d = { el, t0: 0 };
    d.step = (dt, now) => {
      const t = Math.min(1, (now - d.t0) / 900), e = 1 - (1 - t) * (1 - t);
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

  /* Газоразрядные лампы (как ИН-14) и люминесцентный индикатор (как ИВ-11).
     Лампа: цифра гаснет и вспыхивает новой. Люминесцентный: сегменты переключаются
     с коротким послесвечением; ведущие нули не горят, как в настоящих часах. */
  const SEG = { 0: "abcdef", 1: "bc", 2: "abged", 3: "abgcd", 4: "fgbc", 5: "afgcd", 6: "afgedc", 7: "abc", 8: "abcdefg", 9: "abcdfg", "-": "g", " ": "" };
  const SEG_RECT = { a: [3, 1, 14, 3.4], d: [3, 29.6, 14, 3.4], g: [3, 15.3, 14, 3.4], f: [1, 3, 3.4, 13],
                     b: [15.6, 3, 3.4, 13], e: [1, 18, 3.4, 13], c: [15.6, 18, 3.4, 13] };
  function glowInd(style, digits, frac, cls) {
    const el = document.createElement("span");
    el.className = `sv-ind sv-ind--${style} sv-ind--off ${cls}`.trim();
    const cells = [];
    for (let i = 0; i < digits + frac; i++) {
      if (style === "nixie" && frac && i === digits) {
        const sep = document.createElement("span"); sep.className = "sv-nix__sep"; sep.textContent = ","; el.append(sep);
      }
      const c = document.createElement("span");
      if (style === "nixie") {
        c.className = "sv-nix"; c.innerHTML = "<b>-</b>";
        cells.push({ el: c, d: c.firstChild, cur: "-" });
      } else {
        c.className = "sv-vfd";
        c.innerHTML = `<svg viewBox="0 0 24 34">${Object.entries(SEG_RECT).map(([k, [x, y, w, h]]) =>
          `<rect data-s="${k}" x="${x}" y="${y}" width="${w}" height="${h}" rx="1.4"/>`).join("")}` +
          `<circle cx="21.6" cy="31" r="1.8"/></svg>`;
        const seg = {};
        c.querySelectorAll("rect").forEach((r) => { seg[r.dataset.s] = r; });
        cells.push({ el: c, seg, dot: c.querySelector("circle"), cur: null });
        if (frac && i === digits - 1) c.querySelector("circle").classList.add("on");   // запятая
      }
      el.append(c);
    }
    const show = (c, ch) => {
      if (c.cur === ch) return;
      c.cur = ch;
      if (style === "nixie") {
        c.d.textContent = ch;
        c.el.classList.remove("sv-nix--in"); void c.el.offsetWidth; c.el.classList.add("sv-nix--in");
      } else {
        const on = SEG[ch] || "";
        for (const k in c.seg) c.seg[k].classList.toggle("on", on.includes(k));
      }
    };
    return {
      el,
      set(v) {
        const off = v == null || Number.isNaN(v);
        el.classList.toggle("sv-ind--off", off);
        let chars;
        if (off) chars = cells.map(() => "-");
        else {
          const n = Math.max(0, Math.min(Math.round(v * 10 ** frac), 10 ** (digits + frac) - 1));
          chars = String(n).padStart(digits + frac, "0").split("");
          if (style === "vfd") {                     // ведущие нули гаснут, единицы — всегда
            for (let i = 0; i < digits - 1 && chars[i] === "0"; i++) chars[i] = " ";
          }
        }
        cells.forEach((c, i) => show(c, chars[i]));
      },
    };
  }
  function indicator(digits, frac = 0, cls = "") {
    const style = opts.digits || "drum";
    if (style === "nixie" || style === "vfd") return glowInd(style, digits, frac, cls);
    return drum(digits, frac, `${cls} ${style === "light" ? "sv-drum--light" : ""}`);
  }
  // все индикаторы HUD: слот в разметке → индикатор; при смене «Цифр» — пересоздаём
  const inds = new Map();
  function mount(slot) {
    const r = { slot, digits: +slot.dataset.digits, frac: +(slot.dataset.frac || 0), cls: slot.dataset.cls || "", v: null };
    r.obj = indicator(r.digits, r.frac, r.cls);
    slot.replaceChildren(r.obj.el);
    inds.set(slot.dataset.ind, r);
  }
  function setInd(id, v) {
    const r = inds.get(id);
    if (!r) return;
    r.v = v; r.obj.set(v);
  }
  function remountAll() {
    for (const r of inds.values()) {
      r.obj = indicator(r.digits, r.frac, r.cls);
      r.slot.replaceChildren(r.obj.el);
      r.obj.set(r.v);
    }
  }
  const ind = (id, digits, frac = 0, cls = "") =>
    `<span class="sv-slot ${cls}" data-ind="${id}" data-digits="${digits}" data-frac="${frac}"></span>`;

  /* ── круглый прибор 270° со счётчиком в окошке (как одометр в спидометре) ── */
  function roundGauge(host, { id, size = 212, min = 20, max = 100, step = 10, minor = 2, red = 90, unit = "°C" }) {
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
      <foreignObject x="${c - 45}" y="${c + R * 0.43}" width="90" height="36"><div xmlns="http://www.w3.org/1999/xhtml" class="sv-dialwin">${ind(id, 3, 0, "sv-slot--dial")}</div></foreignObject>
      <g class="sv-needle"><line x1="${c}" y1="${c + R * 0.2}" x2="${c}" y2="${c - R + 8}" class="sv-needle__body" stroke-width="3.2"/>
        <line x1="${c}" y1="${c - R * 0.55}" x2="${c}" y2="${c - R + 8}" class="sv-needle__tip" stroke-width="3.2"/></g>
      <circle cx="${c}" cy="${c}" r="${size * 0.06}" fill="#1c1b19"/><circle cx="${c}" cy="${c}" r="${size * 0.025}" fill="#77756e"/>
      <circle cx="${c}" cy="${c}" r="${R + 4}" class="sv-glass"/></svg>`;
    host.innerHTML = `<div class="sv-bezel">${s}</div>`;
    const n = needle(host.querySelector(".sv-needle"), c, c, ang);
    return { set(v) { n.set(v); setInd(id, v == null ? null : Math.round(v)); } };
  }

  /* ── щитовой прибор: прямоугольный, дуга ±37°, зеркальная полоска, класс точности ── */
  const NICE = [100, 150, 200, 300, 400, 500, 600, 800, 1000];
  function stepFor(max) { return max <= 100 ? 20 : max <= 200 ? 50 : max <= 600 ? 100 : 200; }
  function panelMeter(host, { w = 186, h = 140, max = 100, unit = "%", red = null, grow = false }) {
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

  /* ── самописец: бумага в сетку, чернильная линия, перо у правого края ──
     f — доля секунды с последнего снимка (0…1): лента сдвигается плавно, а не рывком
     раз в секунду. Новая точка появляется под кареткой и выезжает из-под неё,
     перо стоит ровно на краю бумаги между двумя последними значениями. */
  function drawRecorder(canvas, hist, { len, lo, hi, minSpan = 10, smooth = 0, pad = 0.12 }, f = 0) {
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
    const X = (i) => (i + 1 - f) * step;              // i — номер точки в окне из n
    // вертикальная сетка привязана ко времени — бумага «едет» вместе с записью
    const minorEvery = Math.max(1, Math.round(n / 30)), majorEvery = minorEvery * 5;
    const ink = dim ? "120,40,20" : "196,92,60";
    ctx.lineWidth = 1;
    for (let i = -1; i <= n; i++) {
      const g = tick - (n - 1 - i);
      if (((g % minorEvery) + minorEvery) % minorEvery) continue;
      const x = X(i);
      if (x < 0 || x > plotW) continue;
      ctx.strokeStyle = `rgba(${ink},${g % majorEvery === 0 ? 0.45 : 0.2})`;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    ctx.strokeStyle = `rgba(${ink},0.2)`;
    for (let k = 1; k < 6; k++) {
      const y = Math.round((H * k) / 6) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
    }

    let data = (hist || []).slice(-n).map((v) => (v == null || Number.isNaN(v) ? null : v));
    const known = data.filter((v) => v != null);
    if (smooth && data.length > 2) {
      data = data.map((v, i) => {
        if (v == null) return null;
        let sum = 0, c = 0;
        for (let j = Math.max(0, i - smooth); j <= Math.min(data.length - 1, i + smooth); j++) {
          if (data[j] != null) { sum += data[j]; c++; }
        }
        return sum / c;
      });
    }
    // шкала: заданная или по данным, но не уже minSpan — иначе дрожь в 1 °C на всю высоту
    let a = lo, b = hi;
    if (known.length && (a == null || b == null)) {
      const mn = Math.min(...known), mx = Math.max(...known);
      const mid = (mn + mx) / 2, span = Math.max(minSpan, (mx - mn) * (1 + pad * 2));
      if (a == null) a = mid - span / 2;
      if (b == null) b = a + span;
    }
    if (a == null) a = 0;
    if (b == null || b <= a) b = a + minSpan;
    const Y = (v) => H - 4 - ((Math.max(a, Math.min(b, v)) - a) / (b - a)) * (H - 8);

    // кривая: через середины отрезков, сами точки — опорные (ломаная без углов)
    const off = n - data.length;
    const pts = [];
    data.forEach((v, i) => { if (v != null) pts.push([X(off + i), Y(v)]); });
    if (pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
      }
      ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      ctx.strokeStyle = INKS[opts.ink] || INKS.violet;
      ctx.globalAlpha = dim ? 0.8 : 0.9;
      ctx.lineWidth = 1.7; ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // каретка и перо: перо — на краю бумаги, между двумя последними значениями
    ctx.fillStyle = "#151513";
    ctx.fillRect(plotW, 0, PEN, H);
    let py = H - 4;
    if (pts.length > 1) {
      const p = pts[pts.length - 2], q = pts[pts.length - 1];
      py = q[0] === p[0] ? q[1] : p[1] + (q[1] - p[1]) * Math.max(0, Math.min(1, (plotW - p[0]) / (q[0] - p[0])));
    } else if (pts.length) py = pts[0][1];
    ctx.fillStyle = "#c9c4b4";
    ctx.beginPath(); ctx.moveTo(plotW - 2, py); ctx.lineTo(W, py - 5); ctx.lineTo(W, py + 5); ctx.closePath(); ctx.fill();
    // блик стекла
    const gl = ctx.createLinearGradient(0, 0, W * 0.6, H);
    gl.addColorStop(0, "rgba(255,255,255,0.18)"); gl.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gl; ctx.fillRect(0, 0, W, H);
  }

  /* Самописцы с окном в минуту (сеть, кадры) перерисовываются каждый кадр — лента
     едет плавно. У 10-минутных шаг меньше пикселя, им хватает перерисовки раз в секунду. */
  const recs = new Map();
  let lastSnap = performance.now();
  const recMover = {
    step(dt, now) {
      const f = Math.min(1, (now - lastSnap) / 1000);
      for (const [canvas, r] of recs) if (r.live) drawRecorder(canvas, r.hist, r.cfg, f);
      return [...recs.values()].some((r) => r.live) && !document.hidden;
    },
  };
  function record(canvas, hist, cfg) {
    if (!canvas) return;
    const live = cfg.len <= 120;
    recs.set(canvas, { hist, cfg, live });
    drawRecorder(canvas, hist, cfg, live ? Math.min(1, (performance.now() - lastSnap) / 1000) : 0);
    if (live) wake(recMover);
  }

  /* ── сигнальная лампочка: хромированный ободок, гранёная линза своего цвета
     (видна и погашенной), подпись рядом ── */
  const lampHtml = (id, color, label, title) =>
    `<span class="sv-lampbox" title="${title}"><i class="sv-lamp sv-lamp--${color}" data-lamp="${id}"><b></b></i><span class="sv-lampbox__t">${label}</span></span>`;
  const lampPair = (id, what) =>
    `<span class="sv-lamps">${lampHtml(`${id}-warn`, "amber", "Внимание", `${what}: тепло`)}${lampHtml(`${id}-crit`, "red", "Перегрев", `${what}: перегрев`)}</span>`;

  /* ── разметка ──────────────────────────────────────────── */
  function recHtml(id, title, unit, digits) {
    const value = ind(id, digits);
    return `<div class="sv-rec" data-rec="${id}">
      <div class="sv-rec__head"><span class="sv-rec__t">${title}</span>${value}<span class="sv-unit">${unit}</span></div>
      <div class="sv-rec__win"><canvas></canvas></div>
      <div class="sv-rec__sub" data-sub="${id}">&nbsp;</div></div>`;
  }
  function readout(id, label, unit, digits, frac = 0) {
    return `<div class="sv-readout"><span class="sv-cap">${label}</span>
      <div>${ind(id, digits, frac, "sv-slot--lg")}<span class="sv-unit sv-unit--lg">${unit}</span></div></div>`;
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
        ${ind(`${id}_pct`, 3)}<span class="sv-unit">%</span>
        <span class="sv-mem__extra" data-sub="${id}_extra"></span></div>
      <div class="sv-hbar" data-hbar="${id}"><b></b><u></u></div>
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
      <div class="sv-head"><span class="sv-plate">ЦП</span><span class="sv-name" data-name="cpu">—</span>${lampPair("cpu", "ЦП")}</div>
      ${meterRow("cpu")}
      <div class="sv-cores" data-cores></div>
      <div class="sv-sect sv-sect--foot"><b>МП</b> материнская плата</div>
      <div class="sv-recs">${recHtml("vrm", "VRM · MOS", "°C", 3)}${recHtml("chipset", "Чипсет", "°C", 3)}${recHtml("sys", "Система", "°C", 3)}</div>
    </section>
    <section class="sv-card sv-card--gpu">${screws}
      <div class="sv-head"><span class="sv-plate">ГП</span><span class="sv-name" data-name="gpu">—</span>${lampPair("gpu", "ГП")}</div>
      ${meterRow("gpu")}
      <div class="sv-memblock">
        <div class="sv-sect"><b>ОЗУ</b> память</div>
        <div class="sv-mems">${memHtml("vram", "Видео")}${memHtml("ram", "ОЗУ")}</div>
        <div class="sv-dimms" data-dimms></div>
      </div>
      <div class="sv-sect sv-sect--foot"><b>ГП</b> термики и охлаждение</div>
      <div class="sv-recs">${recHtml("hotspot", "Горячая точка", "°C", 3)}${recHtml("fan", "Вентиляторы", "об/мин", 4)}${recHtml("bus", "Шина PCIe", "%", 3)}</div>
    </section>
    <div class="sv-mini">
      <section class="sv-card sv-card--drives">${screws}
        <div class="sv-head"><span class="sv-plate">Накопители</span>${lampPair("drives", "Накопитель")}</div>
        <div class="sv-drives" data-drives></div>
      </section>
      <section class="sv-card sv-card--net">${screws}
        <div class="sv-head"><span class="sv-plate">Сеть</span><span class="sv-name" data-name="net">—</span></div>
        <div class="sv-recs sv-recs--2">${recHtml("dl", "▼ Приём", "Мбит/с", 4, true)}${recHtml("up", "▲ Передача", "Мбит/с", 4, true)}</div>
      </section>
      <section class="sv-card sv-card--fps">${screws}
        <div class="sv-head"><span class="sv-plate">Кадры</span><span class="sv-name" data-name="fps">—</span><span class="sv-lamps">${lampHtml("fps", "green", "Игра", "Игра идёт: RTSS отдаёт кадры")}</span></div>
        <div class="sv-fps">
          <div class="sv-readout"><span class="sv-cap">кадр/с</span>${ind("fps", 3, 0, "sv-slot--xl")}</div>
          <div class="sv-fps__info">
            <div><span class="sv-cap">время кадра</span>${ind("ft", 2, 1)}<span class="sv-unit">мс</span></div>
            <div><span class="sv-cap">1% худших</span>${ind("low", 3)}<span class="sv-unit">к/с</span></div>
          </div>
        </div>
        <div class="sv-rec__win sv-rec__win--fps"><canvas data-canvas="fps"></canvas></div>
      </section>
    </div>`;
    hud.insertBefore(root, hud.querySelector(".hud__foot"));
    // .sv — обёртка без своей коробки: карточки встают прямо в сетку .hud

    S.g = {
      cpu_temp: roundGauge($('[data-gauge="cpu_temp"]'), { id: "cpu_temp", red: 90 }),
      gpu_temp: roundGauge($('[data-gauge="gpu_temp"]'), { id: "gpu_temp", red: 85 }),
      cpu_load: panelMeter($('[data-gauge="cpu_load"]'), { unit: "%" }),
      gpu_load: panelMeter($('[data-gauge="gpu_load"]'), { unit: "%" }),
      cpu_power: panelMeter($('[data-gauge="cpu_power"]'), { unit: "Вт", max: 200, red: 0.85, grow: true }),
      gpu_power: panelMeter($('[data-gauge="gpu_power"]'), { unit: "Вт", max: 400, red: 0.85, grow: true }),
    };
    root.querySelectorAll("[data-ind]").forEach(mount);
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
        `<span class="sv-dimm"><span class="sv-cap">DIMM${d.slot}</span>${ind(`dimm${d.slot}`, 2, 0, "sv-slot--sm")}<span class="sv-unit">°C</span></span>`).join("") : "";
      host.querySelectorAll("[data-ind]").forEach(mount);
    }
    dimms.forEach((d) => setInd(`dimm${d.slot}`, d.temp != null ? Math.round(d.temp) : null));
  }

  /* Накопители. Шкала — плоский газоразрядный индикатор (как ИН-26): заполненность диска.
     Свечение — отдельными штрихами, погашенные штрихи видны тускло. Меняющиеся числа —
     индикаторами (как «Цифры»), объём диска не меняется — он выбит на щите. */
  const SEG_PITCH = 4;                      // шаг штрихов шкалы, px
  function segFill(bar, pct) {
    const w = bar.clientWidth;
    if (!w) return;
    const n = Math.floor(w / SEG_PITCH);
    bar.firstChild.style.width = `${Math.round((Math.max(0, Math.min(100, pct || 0)) / 100) * n) * SEG_PITCH}px`;
  }
  function renderDrives(drives) {
    const host = $("[data-drives]");
    const list = drives || [];
    const big = (d) => (d.total_gb || 0) >= 10000;          // от 10 ТБ — в терабайтах
    const layout = list.map((d) => `${d.kind} ${d.letter} ${d.name} ${big(d)} ${Math.round(d.total_gb || 0)}`).join("|");
    if (host.dataset.layout !== layout) {
      host.dataset.layout = layout;
      [...inds.keys()].filter((k) => k.startsWith("drv_")).forEach((k) => inds.delete(k));
      host.innerHTML = list.length ? list.map((d) => {
        const total = d.total_gb ? (big(d) ? `${comma((d.total_gb / 1024).toFixed(1))} ТБ` : `${Math.round(d.total_gb)} ГБ`) : "";
        return `<div class="sv-drive" data-letter="${d.letter}">
          <span class="sv-drive__l">${d.letter}</span><span class="sv-drive__k">${d.kind === "HDD" ? "ЖМД" : d.kind === "NVMe" ? "NVMe" : "ТТН"}</span>
          <div class="sv-bar2" title="Заполненность диска"><div class="sv-seg"><i></i></div></div>
          <span class="sv-drive__v">${ind(`drv_p_${d.letter}`, 3, 0, "sv-slot--xs")}<span class="sv-unit">%</span></span>
          <span class="sv-drive__v">${ind(`drv_u_${d.letter}`, big(d) ? 2 : 4, big(d) ? 1 : 0, "sv-slot--xs")}<span class="sv-drive__tot">из ${total}</span></span>
          <span class="sv-drive__v">${ind(`drv_t_${d.letter}`, 2, 0, "sv-slot--xs")}<span class="sv-unit">°C</span></span></div>`;
      }).join("") +
        `<div class="sv-drive sv-drive--rw"><span class="sv-cap">Чтение</span>${ind("rw_r", 4, 0, "sv-slot--xs")}
          <span class="sv-cap">Запись</span>${ind("rw_w", 4, 0, "sv-slot--xs")}<span class="sv-unit">МБ/с</span></div>`
        : '<div class="sv-cap">нет данных</div>';
      host.classList.toggle("sv-drives--dense", list.length > 3);
      host.querySelectorAll("[data-ind]").forEach(mount);
    }
    let hot = 0, r = 0, w = 0;
    for (const d of list) {
      const row = host.querySelector(`[data-letter="${d.letter}"]`);
      if (!row) continue;
      const p = d.used_pct != null ? Math.max(0, Math.min(100, d.used_pct)) : null;
      segFill(row.querySelector(".sv-seg"), p);
      const t = d.temp != null ? Math.round(d.temp) : null;
      const [amber, red] = d.kind === "HDD" ? [45, 55] : [60, 75];
      if (t != null) hot = Math.max(hot, t >= red ? 2 : t >= amber ? 1 : 0);
      setInd(`drv_p_${d.letter}`, p != null ? Math.round(p) : null);
      setInd(`drv_u_${d.letter}`, d.used_gb == null ? null : big(d) ? d.used_gb / 1024 : Math.round(d.used_gb));
      setInd(`drv_t_${d.letter}`, t);
      r += d.read_mbs || 0; w += d.write_mbs || 0;
    }
    setInd("rw_r", list.length ? Math.round(r) : null);
    setInd("rw_w", list.length ? Math.round(w) : null);
    lamp("drives", hot);
  }


  /* пара лампочек: level 0 — обе погашены, 1 — горит жёлтая «Внимание»,
     2 — горит и жёлтая, и мигает красная «Перегрев» */
  function lamp(id, level) {
    const lv = opts.lamps ? level : 0;
    const warn = $(`[data-lamp="${id}-warn"]`), crit = $(`[data-lamp="${id}-crit"]`);
    if (warn) warn.dataset.on = lv >= 1 ? "1" : "0";
    if (crit) crit.dataset.on = lv >= 2 ? "2" : "0";
  }
  // лента ленточного указателя: залита до отметки
  function fill(bar, pct) {
    if (!bar) return;
    const p = Math.max(0, Math.min(100, pct ?? 0));
    bar.querySelector("b").style.width = `${p}%`;
    bar.querySelector("u").style.left = `calc(${p}% - 1.5px)`;
  }
  const level = (v, [a, r]) => (v == null ? 0 : v >= r ? 2 : v >= a ? 1 : 0);

  function setRec(id, hist, cfg, value, sub) {
    const box = $(`[data-rec="${id}"]`);
    if (!box) return;
    record(box.querySelector("canvas"), hist, cfg);
    setInd(id, value);
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
    lastSnap = performance.now();
    const m = snap.metrics || {};
    const clean = (s) => (s || "").replace(/^.*?\[#\d+\]:\s*/, "").split(":")[0].trim();
    setText($('[data-name="cpu"]'), clean(m.cpu_temp?.sensor || m.cpu_load?.sensor) || "—");
    setText($('[data-name="gpu"]'), clean(m.gpu_temp?.sensor || m.gpu_load?.sensor) || "—");

    const cpuT = num(m.cpu_temp), gpuT = num(m.gpu_temp);
    S.g.cpu_temp.set(cpuT); S.g.gpu_temp.set(gpuT);
    S.g.cpu_load.set(num(m.cpu_load)); S.g.gpu_load.set(num(m.gpu_load));
    S.g.cpu_power.set(num(m.cpu_power)); S.g.gpu_power.set(num(m.gpu_power));
    const round = (v) => (v == null ? null : Math.round(v));
    setInd("cpu_clock", round(num(m.cpu_clock)));
    setInd("vcore", num(m.vcore));
    setInd("gpu_clock", round(num(m.gpu_clock)));
    setInd("vram_clock", round(num(m.vram_clock)));
    lamp("cpu", level(cpuT, LAMP.cpu));
    // у ГП перегревом считается и горячая точка
    lamp("gpu", Math.max(level(gpuT, LAMP.gpu), level(num(m.gpu_hotspot), LAMP.hotspot)));

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
      setInd(`${id}_pct`, pct != null ? Math.round(pct) : null);
      fill($(`[data-hbar="${id}"]`), pct);
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
    setInd("fps", live ? Math.round(f.fps) : fallback != null ? Math.round(fallback) : null);
    setInd("ft", live && f.frametime_ms != null ? Number(f.frametime_ms) : null);
    setInd("low", live && f.low1_fps != null ? Math.round(f.low1_fps) : null);
    setText($('[data-name="fps"]'), live ? f.app_name : fallback != null ? "" : snap.rtss_running ? "нет активной игры" : "RTSS не запущен");
    $('[data-lamp="fps"]').dataset.on = live || fallback != null ? "1" : "0";
    const fpsHist = live && f.history ? f.history.map((ft) => (ft > 0 ? 1000 / ft : null)) : [];
    record($('[data-canvas="fps"]'), fpsHist, { len: 60, minSpan: 30, smooth: 1 });

    renderDrives(snap.drives);
  }

  window.HudThemes.register({
    id: "soviet",
    name: "Приборная панель",
    description: "Щит приборов в советском духе: стрелки, барабанные счётчики, самописцы и лампочки перегрева",
    preview: "themes/previews/soviet.jpg",
    defaults: { case: "enamel", digits: "drum", overshoot: true, paper: "bright", ink: "violet", lamps: true },
    sections: [
      { title: "Корпус", items: [
        { key: "case", type: "choice", options: [["enamel", "Эмаль", "#56635b"], ["bakelite", "Карболит", "#2a201a"]],
          hint: "эмаль — серо-зелёная краска приборных шкафов, карболит — тёмная пластмасса" },
      ] },
      { title: "Цифры", items: [
        { key: "digits", type: "choice", options: [
          ["drum", "Барабан"], ["light", "Светлый барабан"], ["nixie", "Газоразрядные лампы"], ["vfd", "Люминесцентные"]],
          hint: "барабан — как у счётчиков, лампы — как ИН-14, люминесцентные — как в часах «Электроника»" },
      ] },
      { title: "Приборы", items: [
        { key: "overshoot", type: "toggle", label: "Стрелки с перелётом",
          hint: "стрелка проскакивает значение и возвращается, как у настоящего прибора" },
        { key: "lamps", type: "toggle", label: "Лампочки перегрева",
          hint: "жёлтая «Внимание» с 80 °C, красная «Перегрев» мигает с 90 °C (у ГП — с 88 °C или горячая точка с 100 °C)" },
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
      const restyle = built && settings.digits !== opts.digits;
      opts = { ...opts, ...settings };
      if (restyle) remountAll();
      const html = document.documentElement;
      html.dataset.svCase = settings.case;
      html.dataset.svDigits = settings.digits;
      if (settings.overshoot) delete html.dataset.svStill; else html.dataset.svStill = "";
      if (built) {
        // лампочки и самописцы перерисуются на следующем снимке, стрелки — сразу
        if (!opts.lamps) root.querySelectorAll("[data-lamp]").forEach((el) => { if (el.dataset.lamp !== "fps") el.dataset.on = "0"; });
      }
    },

    render,
  });
})();
