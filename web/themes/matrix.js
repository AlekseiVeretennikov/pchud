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
    defaults: {
      palette: "cyan", ui_brightness: 100,
      background: "cipher-rain", bg_brightness: 100, bg_field: true, bg_drops: true, bg_words: true,
      label_glitch: true, name_noise: true, fx_rate: "normal",
      boot_mode: "hacker",
    },
    sections: [
      { title: "Цвет", items: [
        { key: "palette", type: "choice", options: [
          ["cyan", "Циан", "#38e1c4"], ["green", "Зелёная", "#22b345"],
          ["dark", "Тёмная", "#000000"], ["light", "Белая", "#ffffff"],
        ] },
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
          palette: PALETTES[settings.palette] || PALETTES.cyan,
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
