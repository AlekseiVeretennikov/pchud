/* Тема «Матрица» — базовая: дождь символов на фоне, шифрование подписей,
 * помехи в названиях, заставка-«взлом». Четыре палитры (настройка «Цвет»).
 * Разметка и стили — общие web/index.html и web/style.css; палитры —
 * html[data-palette] в style.css и PALETTES ниже (для фона на canvas).
 */
(() => {
  // цвета фона на canvas: под каждую палитру из style.css
  const PALETTES = {
    cyan:  { bg: "#060810", colors: ["#2a9484", "#38e1c4", "#f5b942", "#e4fff9", "#ff5470"], glow: true },
    green: { bg: "#010401", colors: ["#0c4f1b", "#1fa03f", "#f5b942", "#b8f5c6", "#ff5470"], glow: true },
    dark:  { bg: "#000000", colors: ["#333333", "#d6d6d6", "#e0e0e0", "#ffffff", "#ff5470"], glow: false },
    light: { bg: "#ececec", colors: ["#b4b4b4", "#3a3a3a", "#202020", "#000000", "#cc2747"], glow: false },
  };

  const background = () => (window.HudBackgrounds || {})["cipher-rain"];

  // ── «Свой цвет»: вся палитра из одного выбранного цвета ──
  // Фон и карточки — почти чёрные с оттенком цвета, цифры почти белые, а шкалы,
  // графики и дождь — сам цвет. Слишком тёмный или бледный цвет подтягиваем до
  // читаемого: на тёмном фоне акцент должен светиться.
  const CUSTOM_VARS = ["--bg", "--panel", "--panel-2", "--line", "--ink", "--ink-dim", "--cyan", "--track",
    "--bg-rgb", "--panel-rgb", "--panel2-rgb", "--ink-rgb", "--dim-rgb", "--accent-rgb"];
  const DEFAULT_CUSTOM = "#b06cff";

  function hexToHsl(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hsl(h, s, l) {          // → [r, g, b] 0..255
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  }
  const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  const list = (c) => c.join(", ");

  const customCache = {};
  function customPalette(color) {
    if (customCache[color]) return customCache[color];
    const [h, s0] = hexToHsl(/^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_CUSTOM);
    const [, , l0] = hexToHsl(color);
    const s = s0;
    const accent = hsl(h, Math.min(1, s0 * 1.05), Math.min(0.72, Math.max(0.52, l0)));
    const tint = Math.min(s, 0.45);                        // насколько фон окрашен цветом
    const inkTint = Math.min(1, s / 0.3);                  // серый цвет — серые цифры, без розового
    const c = {
      bg: hsl(h, tint * 0.6, 0.025), panel: hsl(h, tint * 0.5, 0.055), panel2: hsl(h, tint * 0.5, 0.045),
      line: hsl(h, tint * 0.5, 0.14), ink: hsl(h, 0.3 * inkTint, 0.93), dim: hsl(h, 0.12 * inkTint, 0.6),
      track: hsl(h, tint * 0.5, 0.1), accent,
    };
    const vars = {
      "--bg": hex(c.bg), "--panel": hex(c.panel), "--panel-2": hex(c.panel2), "--line": hex(c.line),
      "--ink": hex(c.ink), "--ink-dim": hex(c.dim), "--cyan": hex(c.accent), "--track": hex(c.track),
      "--bg-rgb": list(c.bg), "--panel-rgb": list(c.panel), "--panel2-rgb": list(c.panel2),
      "--ink-rgb": list(c.ink), "--dim-rgb": list(c.dim), "--accent-rgb": list(c.accent),
    };
    const rain = {
      bg: hex(c.bg),
      colors: [hex(hsl(h, s * 0.7, 0.3)), hex(c.accent), "#f5b942", hex(hsl(h, 0.6 * inkTint, 0.93)), "#ff5470"],
      glow: true,
    };
    return (customCache[color] = { vars, rain });
  }

  function applyCustomVars(settings) {
    const root = document.documentElement;
    if (settings.palette === "custom") {
      const { vars } = customPalette(settings.custom_color);
      for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    } else {
      CUSTOM_VARS.forEach((k) => root.style.removeProperty(k));
    }
    // кружок у варианта «Свой» — текущим цветом
    document.querySelectorAll('.settings__choice button[data-value="custom"] .settings__swatch')
      .forEach((dot) => { dot.style.background = settings.custom_color; });
  }

  // «Яркость интерфейса» k = 0.4…1.
  // Тёмные палитры: всё темнеет к чёрному фону — brightness(k).
  // Светлая: темнеть ей нельзя (белые карточки становятся грязно-серыми), поэтому
  // приглушаем наоборот — тёмные буквы и графики бледнеют к белому, а белое остаётся белым:
  // contrast(k) сводит всё к серому, brightness(1 / (0.5k + 0.5)) возвращает белый на место.
  function dimFilter(palette, k) {
    if (palette === "light") return `contrast(${k}) brightness(${(1 / (0.5 * k + 0.5)).toFixed(3)})`;
    return `brightness(${k})`;
  }

  window.HudThemes.register({
    id: "matrix",
    name: "Матрица",
    description: "Дождь символов, шифрование подписей, заставка-взлом. Четыре палитры и свой цвет",
    preview: "themes/previews/matrix.jpg",
    defaults: {
      palette: "cyan", custom_color: DEFAULT_CUSTOM, ui_brightness: 100,
      background: "cipher-rain", bg_brightness: 100, bg_field: true, bg_drops: true, bg_words: true,
      label_glitch: true, name_noise: true, fx_rate: "normal",
      boot_mode: "hacker",
    },
    sections: [
      { title: "Цвет", items: [
        { key: "palette", type: "choice", options: [
          ["cyan", "Циан", "#38e1c4"], ["green", "Зелёная", "#22b345"],
          ["dark", "Тёмная", "#000000"], ["light", "Белая", "#ffffff"],
          ["custom", "Свой", DEFAULT_CUSTOM],
        ] },
        { key: "custom_color", type: "color", label: "Свой цвет",
          hint: "остальные цвета HUD подберёт сам", showIf: ["palette", "custom"] },
        { key: "ui_brightness", type: "range", label: "Яркость интерфейса", min: 40, max: 100, step: 5, unit: "%",
          hint: "цифры, шкалы и графики; яркость фона — ниже, в «Фоне»" },
      ] },
      { title: "Фон", items: [
        { key: "background", type: "toggle", label: "Анимированный фон", on: "cipher-rain", off: "none" },
        { key: "bg_brightness", type: "range", label: "Яркость", min: 10, max: 100, step: 5, unit: "%", needs: "background" },
        { key: "bg_field", type: "toggle", label: "Поле символов", hint: "тусклые буквы по всему экрану", needs: "background" },
        { key: "bg_drops", type: "toggle", label: "Капли", hint: "стекающие струйки", needs: "background" },
        { key: "bg_words", type: "toggle", label: "Слова", hint: "SYSTEM OK, ошибки красным", needs: "background" },
      ] },
      { title: "Эффекты", items: [
        { key: "label_glitch", type: "toggle", label: "Шифрование подписей",
          hint: "буквы в подписях вроде «Нагрузка» на миг становятся символами" },
        { key: "name_noise", type: "toggle", label: "Помехи в названиях CPU и GPU",
          hint: "название модели изредка рябит, как плохой сигнал" },
        { key: "fx_rate", type: "choice", label: "Частота",
          options: [["low", "Редко"], ["normal", "Обычно"], ["high", "Часто"]],
          hint: "для обоих эффектов", needsAny: ["label_glitch", "name_noise"] },
      ] },
      { title: "Заставка при запуске", items: [
        { key: "boot_mode", type: "choice", options: [["hacker", "Взлом"], ["short", "Короткая"], ["off", "Выкл."]],
          hint: "применится при следующем запуске" },
      ] },
    ],

    start(settings, ctx) {
      if (settings.boot_mode === "off") window.HudBoot.skip();
      else window.HudBoot.start(ctx.version, settings.boot_mode);
      // эффекты запускаются всегда, а включены ли — решает apply
      window.HudLabelGlitch.start();
      window.HudNameFx.startNoise();
    },

    apply(settings) {
      const root = document.documentElement;
      root.dataset.palette = settings.palette;
      applyCustomVars(settings);
      if (settings.ui_brightness < 100) {
        root.dataset.dim = "";
        root.style.setProperty("--hud-filter", dimFilter(settings.palette, settings.ui_brightness / 100));
      } else {
        delete root.dataset.dim;
        root.style.removeProperty("--hud-filter");
      }
      if (window.resetSparkColors) window.resetSparkColors();   // графики берут цвет из палитры
      const bg = background();
      if (bg) {
        bg.setOptions({
          palette: settings.palette === "custom" ? customPalette(settings.custom_color).rain
            : PALETTES[settings.palette] || PALETTES.cyan,
          brightness: settings.bg_brightness / 100,
          field: settings.bg_field, drops: settings.bg_drops, words: settings.bg_words,
        });
        if (settings.background === "none") bg.stop();
        else bg.start(document.getElementById("hud-bg"));
      }
      window.HudLabelGlitch.setEnabled(settings.label_glitch);
      window.HudLabelGlitch.setRate(settings.fx_rate);
      window.HudNameFx.setNoiseEnabled(settings.name_noise);
      window.HudNameFx.setNoiseRate(settings.fx_rate);
    },
  });
})();
