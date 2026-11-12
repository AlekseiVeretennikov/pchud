/* Фон «Cipher Rain» — собственная реализация PC HUD (MIT).
 *
 * Три слоя, все на одной сетке символов:
 *   1. поле: тусклые символы, изредка меняющиеся местами;
 *   2. капли: яркие струйки с затухающим хвостом, стекают вниз;
 *   3. слова: раз в несколько секунд в случайном месте из шума буква за буквой
 *      проступает слово, светится пару секунд и снова рассыпается.
 *
 * Экономия: поле живёт в отдельном холсте и перерисовывается только по
 * изменившимся клеткам; в каждом кадре поверх него рисуются лишь клетки
 * капель и слов. Символы заранее отрисованы в атлас (по строке на цвет).
 * Подключение: window.HudBackgrounds["cipher-rain"].start(container).
 */
(function () {
  "use strict";

  const GLYPHS =
    "ｦｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ" +
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
    ":.=+*<>¦|";
  // латиница: hex-символы в шуме + буквы для расшифрованных слов
  const NOISE = GLYPHS.length - 20;   // в шуме без G..Z, только катакана/цифры/hex/знаки
  // обычные слова — циан, ошибки — красные
  const WORDS = [
    "SYSTEM OK", "CORE SYNC", "PC HUD", "THERMAL OK", "ONLINE", "LINK STABLE",
    "SENSORS OK", "CIPHER", "ACCESS GRANTED", "OVERCLOCK", "C0FFEE", "BOOST ON",
    "CACHE HIT", "VCORE OK", "FANS ONLINE", "LOAD BALANCED", "HANDSHAKE",
    "DECRYPTING", "UPLINK", "ALL CORES UP", "FRAME SYNC", "NOMINAL",
  ];
  const ERRORS = [
    "ERROR", "FATAL ERROR", "ACCESS DENIED", "OVERHEAT", "SEGFAULT",
    "KERNEL PANIC", "STACK OVERFLOW", "NO SIGNAL", "CRC MISMATCH", "TIMEOUT",
    "0XDEADBEEF", "THERMAL LIMIT", "PACKET LOSS", "BLUE SCREEN", "CORE DUMP",
    "LINK DOWN", "BAD SECTOR", "NULL POINTER",
  ];
  const ERROR_SHARE = 0.3;      // доля слов-ошибок
  const MAX_WORDS = 3;          // одновременно на экране

  const CELL = 18;          // шаг сетки, CSS-пиксели
  const FONT_PX = 15;
  const FPS = 30;
  // палитра по умолчанию; тема передаёт свою через options.palette
  // colors: тусклый, основной, янтарная искра, голова капли, красный для слов-ошибок
  const DEFAULT_PALETTE = {
    bg: "#060810",
    colors: ["#2a9484", "#38e1c4", "#f5b942", "#e4fff9", "#ff5470"],
    glow: true,      // свечение ярких символов; на светлом фоне выглядит грязно
  };
  const DIM = 0, CYAN = 1, AMBER = 2, HEAD = 3, RED = 4;
  const BASE_MIN = 0.12, BASE_MAX = 0.3;
  // тайминги расшифровки слова, мс
  const SCRAMBLE_MS = 700, STAGGER_MS = 90, HOLD_MS = 1800, FADE_MS = 500;

  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (n) => (Math.random() * n) | 0;

  function buildAtlas(dpr, palette) {
    const COLORS = palette.colors;
    const size = Math.ceil(CELL * dpr);
    const canvas = document.createElement("canvas");
    canvas.width = size * GLYPHS.length;
    canvas.height = size * COLORS.length;
    const g = canvas.getContext("2d");
    g.font = `${FONT_PX * dpr}px Consolas, "MS Gothic", "Yu Gothic", monospace`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    COLORS.forEach((color, row) => {
      g.fillStyle = color;
      g.shadowColor = color;
      g.shadowBlur = row === DIM || !palette.glow ? 0 : 5 * dpr;   // свечение только у ярких
      for (let i = 0; i < GLYPHS.length; i++) {
        g.save();
        g.beginPath();
        g.rect(i * size, row * size, size, size);  // свечение не залезает в соседа
        g.clip();
        g.fillText(GLYPHS[i], i * size + size / 2, row * size + size / 2 + dpr);
        g.restore();
      }
    });
    return { canvas, size };
  }

  // настройки из панели «Настройки»: яркость 0..1 и отдельные слои
  const DEFAULT_OPTIONS = { brightness: 1, field: true, drops: true, words: true, palette: DEFAULT_PALETTE };

  function create(container, options) {
    const opt = Object.assign({}, DEFAULT_OPTIONS, options);
    const canvas = document.createElement("canvas");
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d", { alpha: false });
    const field = document.createElement("canvas");
    const fctx = field.getContext("2d", { alpha: false });

    let dpr = 1, cols = 0, rows = 0, atlas = null;
    let glyph, base, tint, boost;      // по клетке
    let paint;                         // цвет слова поверх клетки в этом кадре (NO_PAINT — нет)
    const NO_PAINT = 255;
    let dirty = [], lit = [];          // изменённые клетки поля / подсвеченные в кадре
    let drops = [];
    let words = [], nextWord = 0;
    let last = 0, raf = 0;

    function setGlyph(i, g) {
      glyph[i] = g === undefined ? noiseGlyph() : g;
      dirty.push(i);
    }
    function noiseGlyph() {
      // G..Z стоят в конце латиницы — в шуме пропускаем их
      const g = randInt(NOISE);
      return g < GLYPHS.indexOf("G") ? g : g + 20;
    }
    // поле можно выключить: тогда видны только капли и слова на чёрном
    const fieldAlpha = (i) => (opt.field ? base[i] : 0);

    function lift(i, v) {
      if (boost[i] === 0) lit.push(i);
      if (v > boost[i]) boost[i] = v;
    }

    function blit(g, i, color, alpha) {
      const s = atlas.size, cell = CELL * dpr;
      const x = (i % cols) * cell, y = ((i / cols) | 0) * cell;
      g.globalAlpha = 1;
      g.fillStyle = opt.palette.bg;
      g.fillRect(x, y, s, s);
      g.globalAlpha = alpha * opt.brightness;
      g.drawImage(atlas.canvas, glyph[i] * s, color * s, s, s, x, y, s, s);
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      canvas.width = field.width = Math.round(w * dpr);
      canvas.height = field.height = Math.round(h * dpr);
      cols = Math.ceil(w / CELL);
      rows = Math.ceil(h / CELL);
      const n = cols * rows;
      glyph = new Uint8Array(n);
      base = new Float32Array(n);
      tint = new Uint8Array(n);
      boost = new Float32Array(n);
      paint = new Uint8Array(n).fill(NO_PAINT);
      dirty = []; lit = []; words = [];
      atlas = buildAtlas(dpr, opt.palette);
      for (let i = 0; i < n; i++) {
        glyph[i] = noiseGlyph();
        base[i] = rand(BASE_MIN, BASE_MAX);
        tint[i] = Math.random() < 0.012 ? AMBER : Math.random() < 0.25 ? CYAN : DIM;
      }
      repaintField();
      drops = [];
      const count = Math.max(4, Math.round(cols / 4));
      for (let i = 0; i < count; i++) drops.push(newDrop(true));
    }

    function repaintField() {
      fctx.globalAlpha = 1;
      fctx.fillStyle = opt.palette.bg;
      fctx.fillRect(0, 0, field.width, field.height);
      for (let i = 0; i < cols * rows; i++) blit(fctx, i, tint[i], fieldAlpha(i));
    }

    function newDrop(anywhere) {
      return {
        col: randInt(cols),
        y: anywhere ? rand(-rows, rows) : rand(-20, -2),
        speed: rand(6, 16),            // клеток в секунду
        len: rand(8, 22) | 0,
      };
    }

    function step(dt, now) {
      for (const i of lit) { boost[i] = 0; paint[i] = NO_PAINT; }
      lit = [];

      // капли
      for (const d of opt.drops ? drops : []) {
        d.y += d.speed * dt;
        if (d.y - d.len > rows) Object.assign(d, newDrop(false));
        const head = Math.floor(d.y);
        for (let k = 0; k < d.len; k++) {
          const r = head - k;
          if (r < 0 || r >= rows) continue;
          const i = r * cols + d.col;
          lift(i, k === 0 ? 1 : 0.75 * (1 - k / d.len));
          // голова и начало хвоста постоянно перебирают символы
          if (k < 3 && Math.random() < 0.5) setGlyph(i);
        }
      }

      // расшифровка слов: шум → буквы проступают слева направо → слово светится → рассыпается
      if (opt.words && now > nextWord && words.length < MAX_WORDS) {
        const error = Math.random() < ERROR_SHARE;
        const list = error ? ERRORS : WORDS;
        const text = list[randInt(list.length)];
        const r = randInt(rows);
        // не ставим слово в строку рядом с уже идущим — чтобы не наезжали
        const busy = words.some((w) => Math.abs(w.r - r) < 2);
        if (!busy && cols > text.length + 4) {
          words.push({
            text, r, c: 2 + randInt(cols - text.length - 4), t0: now,
            color: error ? RED : CYAN,
          });
        }
        nextWord = now + rand(900, 2200);
      }
      words = words.filter((w) => {
        const t = now - w.t0, n = w.text.length;
        let alive = false;
        for (let j = 0; j < n; j++) {
          if (w.text[j] === " ") continue;
          const i = w.r * cols + w.c + j;
          const lockAt = SCRAMBLE_MS + j * STAGGER_MS;
          const unlockAt = SCRAMBLE_MS + n * STAGGER_MS + HOLD_MS + j * 50;
          const end = unlockAt + FADE_MS;
          if (t < lockAt) {
            lift(i, 0.4);
            if (w.color === RED) paint[i] = RED;          // ошибка мельтешит красным
            if (Math.random() < 0.6) setGlyph(i);
          } else if (t < unlockAt) {
            const g = GLYPHS.indexOf(w.text[j]);
            if (glyph[i] !== g) setGlyph(i, g);
            lift(i, t - lockAt < 120 ? 1 : 0.85);       // вспышка в момент «щелчка»
            if (t - lockAt >= 120) paint[i] = w.color;
          } else if (t < end) {
            lift(i, 0.45 * (1 - (t - unlockAt) / FADE_MS));
            if (w.color === RED) paint[i] = RED;
            if (Math.random() < 0.6) setGlyph(i);
          } else continue;
          alive = true;
        }
        return alive;
      });

      // фоновое мерцание: несколько клеток меняют символ и яркость
      const flips = Math.max(1, (cols * rows * 0.003) | 0);
      for (let k = 0; k < flips; k++) {
        const i = randInt(cols * rows);
        if (Math.random() < 0.3) base[i] = rand(BASE_MIN, BASE_MAX);
        setGlyph(i);
      }

      for (const i of dirty) blit(fctx, i, tint[i], fieldAlpha(i));
      dirty = [];
    }

    function draw() {
      ctx.globalAlpha = 1;
      ctx.drawImage(field, 0, 0);
      for (const i of lit) {
        const b = boost[i];
        const color = b > 0.95 ? HEAD
          : paint[i] !== NO_PAINT ? paint[i]
          : b > 0.2 ? CYAN : tint[i];
        blit(ctx, i, color, Math.min(1, fieldAlpha(i) + b));
      }
    }

    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (document.hidden || now - last < 1000 / FPS) return;
      const dt = Math.min(0.1, (now - last) / 1000 || 0);
      last = now;
      step(dt, now);
      draw();
    }

    resize();
    nextWord = performance.now() + 2000;
    window.addEventListener("resize", resize);
    raf = requestAnimationFrame(frame);

    return {
      setOptions(o) {
        const repaint = o.palette && o.palette !== opt.palette;
        Object.assign(opt, o);
        if (repaint) atlas = buildAtlas(dpr, opt.palette);
        if (!opt.words) words = [];
        repaintField();
      },
      stop() {
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", resize);
        canvas.remove();
      },
    };
  }

  let instance = null;
  const pending = {};                // настройки, пришедшие до запуска фона
  window.HudBackgrounds = window.HudBackgrounds || {};
  window.HudBackgrounds["cipher-rain"] = {
    start(container, options) {
      if (instance || !container) return instance;
      instance = create(container, Object.assign(pending, options));
      return instance;
    },
    setOptions(o) {
      Object.assign(pending, o);
      if (instance) instance.setOptions(o);
    },
    stop() {
      if (instance) instance.stop();
      instance = null;
    },
  };
})();
