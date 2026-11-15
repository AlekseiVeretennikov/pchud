/* Тема «Windows 11» — спокойный системный вид, как у Диспетчера задач:
 * шрифт Segoe UI Variable, скруглённые карточки без свечения, графики тонкой линией
 * с заливкой, никаких анимаций (фона, шифрования, помех, заставки).
 * Режим (тёмный/светлый) и цвет акцента — как в Windows («Параметры →
 * Персонализация → Цвета») или вручную. Стили — themes/windows.css.
 */
(() => {
  // свои цвета акцента: [для тёмного режима, для светлого]
  const ACCENTS = {
    blue:   ["#4cc2ff", "#005fb8"],
    teal:   ["#3ad6c4", "#007a6e"],
    green:  ["#6ccb5f", "#0f7b0f"],
    purple: ["#d6a6ff", "#7a3fbf"],
    orange: ["#ffb35c", "#b35900"],
  };
  const FOLLOW_MS = 30000;      // «как в Windows»: раз в 30 с сверяемся с системой

  let current = null, system = null, followTimer = 0;

  const rgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  };

  async function readSystem() {
    try { system = window.pywebview ? await window.pywebview.api.get_system_theme() : null; }
    catch (e) { system = null; }
  }

  function paint() {
    if (!current) return;
    const root = document.documentElement;
    const light = current.mode === "light" || (current.mode === "system" && system && system.light);
    root.dataset.wmode = light ? "light" : "dark";
    let accent;
    if (current.accent === "system") {
      accent = system ? (light ? system.accent_light : system.accent_dark) : ACCENTS.blue[light ? 1 : 0];
    } else {
      accent = (ACCENTS[current.accent] || ACCENTS.blue)[light ? 1 : 0];
    }
    root.style.setProperty("--cyan", accent);
    root.style.setProperty("--accent-rgb", rgb(accent));
    if (window.resetSparkColors) window.resetSparkColors();
  }

  window.HudThemes.register({
    id: "windows",
    name: "Windows 11",
    description: "Спокойный системный вид, как у Диспетчера задач. Без анимаций; цвета — как в Windows",
    preview: "themes/previews/windows.jpg",
    defaults: { mode: "system", accent: "system" },
    sections: [
      { title: "Режим", items: [
        { key: "mode", type: "choice", options: [["system", "Как в Windows"], ["dark", "Тёмный"], ["light", "Светлый"]] },
      ] },
      { title: "Цвет акцента", items: [
        { key: "accent", type: "choice", vertical: false, options: [
          ["system", "Windows"], ["blue", "", "#4cc2ff"], ["teal", "", "#3ad6c4"],
          ["green", "", "#6ccb5f"], ["purple", "", "#d6a6ff"], ["orange", "", "#ffb35c"],
        ], hint: "«Windows» — цвет из «Параметры → Персонализация → Цвета»" },
      ] },
    ],

    start() {
      // в этой теме нет заставки, фона и эффектов «Матрицы»
      window.HudBoot.skip();
    },

    async apply(settings) {
      current = settings;
      paint();                                        // сразу — по известным цветам
      await readSystem();
      paint();
      clearInterval(followTimer);
      if (settings.mode === "system" || settings.accent === "system") {
        followTimer = setInterval(async () => { await readSystem(); paint(); }, FOLLOW_MS);
      }
    },
  });
})();
