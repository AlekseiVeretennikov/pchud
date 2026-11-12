/* Темы оформления.
 *
 * Данные (датчики, история) у всех тем общие — их собирает app.js. Тема отвечает за
 * то, как HUD выглядит: цвета, фон, эффекты, заставка, а в будущем и свои приборы.
 *
 * Тема регистрируется так:
 *   HudThemes.register({
 *     id: "matrix", name: "Матрица",
 *     sections: [{ title, items: [{ key, type, ... }] }],  // её раздел в «Настройках»
 *     defaults: { key: value },                             // значения по умолчанию
 *     start(settings, ctx),   // один раз при запуске HUD (заставка, эффекты)
 *     apply(settings),        // применить настройки на лету (и при запуске тоже)
 *   });
 *
 * Типы пунктов настроек: toggle (вкл/выкл или on/off-значения), range (min/max/step),
 * choice (options: [[значение, подпись, цвет-образец?], ...]).
 * Настройки темы хранятся в config.json → themes.<id>.
 */
(() => {
  const themes = new Map();
  const DEFAULT_ID = "matrix";

  // значение из config.json годится, только если оно допустимо для пункта
  function valid(item, v) {
    switch (item.type) {
      case "toggle": return item.on ? v === item.on || v === item.off : typeof v === "boolean";
      case "range":  return typeof v === "number" && v >= item.min && v <= item.max;
      case "choice": return item.options.some(([value]) => value === v);
      default: return false;
    }
  }

  window.HudThemes = {
    register(theme) { themes.set(theme.id, theme); },
    get(id) { return themes.get(id) || themes.get(DEFAULT_ID); },
    list() { return [...themes.values()]; },

    // настройки темы: сохранённые значения поверх значений по умолчанию,
    // испорченные или устаревшие — заменяются значением по умолчанию
    settingsFor(theme, stored) {
      const out = { ...theme.defaults };
      const saved = stored && typeof stored === "object" ? stored : {};
      for (const section of theme.sections) {
        for (const item of section.items) {
          if (item.key in saved && valid(item, saved[item.key])) out[item.key] = saved[item.key];
        }
      }
      return out;
    },
  };
})();
