/* Панель «Настройки» (кнопка в подвале).
   Сверху — выбор темы (когда тем больше одной), дальше — разделы текущей темы
   (их описывает сама тема, web/themes/*.js), внизу — общие для всех тем.
   Изменения применяются сразу, а через полсекунды тишины уходят в config.json
   (backend: Api.save_settings — дописывает только эти ключи, остальное не трогает).
   Смена темы сохраняется сразу и перезагружает экран HUD. */

(() => {
  const SAVE_DELAY_MS = 500;

  // общие для всех тем: ключи в корне config.json; список мониторов приходит из get_config
  function generalSections(monitors) {
    const items = [];
    if (monitors.length > 1) {
      items.push({ key: "monitor", type: "choice", label: "Открывать на", vertical: true,
        options: [["auto", "Мониторе, где HUD закрыли"], ...monitors.map((m) => [m.device, m.label])],
        hint: "применится при следующем запуске" });
    }
    items.push({ key: "start_fullscreen", type: "toggle", label: "Всегда открывать на весь экран",
      hint: "F11 переключает до закрытия HUD" });
    return [{ title: "Окно", items }];
  }
  let monitors = [];

  let theme = null;
  let themeSettings = {};      // настройки текущей темы → themes.<id>
  let general = {};            // общие → корень config.json
  let panel, statusEl, saveTimer = 0;
  let pendingTheme = {}, pendingGeneral = {};

  // где лежит значение пункта: у темы или в общих
  const store = (scope) => (scope === "theme" ? themeSettings : general);

  // применить к живому HUD (кроме заставки — она только при запуске)
  function apply() {
    theme.apply(themeSettings);
    if (!panel) return;
    panel.querySelectorAll("[data-needs]").forEach((row) => {
      const v = store(row.dataset.scope)[row.dataset.needs];
      row.classList.toggle("settings__row--off", v === "none" || v === false);
    });
    // пункт бледнеет, когда выключено всё, от чего он зависит
    panel.querySelectorAll("[data-needs-any]").forEach((row) => {
      const s = store(row.dataset.scope);
      row.classList.toggle("settings__row--off", !row.dataset.needsAny.split(" ").some((k) => s[k]));
    });
  }

  function change(scope, key, value) {
    store(scope)[key] = value;
    if (scope === "theme") pendingTheme[key] = value;
    else pendingGeneral[key] = value;
    apply();
    clearTimeout(saveTimer);
    setStatus("…");
    saveTimer = setTimeout(save, SAVE_DELAY_MS);
  }

  async function send(changes) {
    if (!window.pywebview) return { ok: false, error: "в браузере не сохраняется" };
    try { return await window.pywebview.api.save_settings(changes); }
    catch (e) { return { ok: false, error: String(e) }; }
  }

  async function save() {
    clearTimeout(saveTimer);
    const changes = { ...pendingGeneral };
    if (Object.keys(pendingTheme).length) changes.themes = { [theme.id]: { ...pendingTheme } };
    pendingTheme = {}; pendingGeneral = {};
    if (!Object.keys(changes).length) return { ok: true };
    const res = await send(changes);
    setStatus(res.ok ? "сохранено" : `не сохранено: ${res.error}`, !res.ok);
    return res;
  }

  // другая тема: сначала дописываем несохранённое, потом перезагружаем экран HUD
  async function switchTheme(id) {
    if (id === theme.id) return;
    setStatus("переключаю тему…");
    await save();
    const res = await send({ theme: id });
    if (res.ok) location.reload();
    else setStatus(`не сохранено: ${res.error}`, true);
  }

  function setStatus(text, error = false) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle("settings__status--err", error);
  }

  // ── разметка ──
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // item.onPick — свой обработчик вместо сохранения (выбор темы)
  function buildItem(item, scope) {
    const values = () => store(scope);
    const row = el("div", `settings__row settings__row--${item.type}`);
    row.dataset.scope = scope;
    if (item.needs) row.dataset.needs = item.needs;
    if (item.needsAny) row.dataset.needsAny = item.needsAny.join(" ");
    if (item.label) {
      const label = el("div", "settings__label", item.label);
      if (item.hint) label.append(el("span", "settings__hint", item.hint));
      row.append(label);
    }

    if (item.type === "toggle") {
      const sw = el("button", "settings__switch");
      sw.type = "button";
      const isOn = () => (item.on ? values()[item.key] !== item.off : !!values()[item.key]);
      const sync = () => { sw.setAttribute("aria-pressed", String(isOn())); };
      sw.addEventListener("click", () => {
        change(scope, item.key, item.on ? (isOn() ? item.off : item.on) : !isOn());
        sync();
      });
      sync();
      row.append(sw);
    } else if (item.type === "range") {
      const wrap = el("div", "settings__range");
      const input = el("input");
      Object.assign(input, { type: "range", min: item.min, max: item.max, step: item.step, value: values()[item.key] });
      const out = el("span", "settings__value", `${values()[item.key]}${item.unit}`);
      input.addEventListener("input", () => {
        out.textContent = `${input.value}${item.unit}`;
        change(scope, item.key, Number(input.value));
      });
      wrap.append(input, out);
      row.append(wrap);
    } else if (item.type === "choice") {
      const group = el("div", `settings__choice${item.vertical ? " settings__choice--vertical" : ""}`);
      const current = () => (item.value ? item.value() : values()[item.key]);
      const sync = () => group.querySelectorAll("button").forEach((b) => {
        b.setAttribute("aria-pressed", String(b.dataset.value === current()));
      });
      item.options.forEach(([value, text, swatch]) => {
        const b = el("button", "", text);
        b.type = "button";
        b.dataset.value = value;
        if (swatch) {
          const dot = el("span", "settings__swatch");
          dot.style.background = swatch;
          b.prepend(dot);
        }
        b.addEventListener("click", () => {
          if (item.onPick) item.onPick(value);
          else change(scope, item.key, value);
          sync();
        });
        group.append(b);
      });
      sync();
      row.append(group);
      // без подписи слева пояснение идёт под кнопками (у подписи оно уже есть)
      if (item.hint && !item.label) row.append(el("div", "settings__hint settings__hint--below", item.hint));
    }
    return row;
  }

  function buildSection(section, scope, extraClass = "") {
    const box = el("div", `settings__section${extraClass}`);
    box.append(el("div", "settings__section-title", section.title));
    section.items.forEach((item) => box.append(buildItem(item, scope)));
    return box;
  }

  function buildPanel() {
    panel = el("div", "settings");
    panel.hidden = true;
    const head = el("div", "settings__head");
    head.append(el("div", "settings__title", "Настройки"));
    const close = el("button", "settings__close", "✕");
    close.type = "button";
    close.title = "Закрыть (Esc)";
    close.addEventListener("click", hide);
    head.append(close);
    panel.append(head);

    const themes = window.HudThemes.list();
    if (themes.length > 1) {
      panel.append(buildSection({ title: "Тема", items: [{
        key: "theme", type: "choice",
        options: themes.map((t) => [t.id, t.name]),
        value: () => theme.id,
        onPick: switchTheme,
        hint: "у каждой темы свои настройки ниже",
      }] }, "general"));
    }
    theme.sections.forEach((section) => panel.append(buildSection(section, "theme")));
    generalSections(monitors).forEach((section) => panel.append(buildSection(section, "general", " settings__section--general")));

    statusEl = el("div", "settings__status", "изменения сохраняются сами");
    panel.append(statusEl);
    document.body.append(panel);
  }

  function show() { panel.hidden = false; }
  function hide() { panel.hidden = true; }
  function toggle() { panel.hidden ? show() : hide(); }

  window.HudSettings = {
    // cfg — ответ get_config; activeTheme и её настройки уже выбрал app.js
    init(cfg, activeTheme, settings) {
      if (panel) return;
      theme = activeTheme;
      themeSettings = settings;
      monitors = Array.isArray(cfg.monitors) ? cfg.monitors : [];
      // выбранный монитор сейчас не подключён — показываем «где закрыли», но не перезаписываем
      const mon = monitors.some((m) => m.device === cfg.monitor) ? cfg.monitor : "auto";
      general = { start_fullscreen: !!cfg.start_fullscreen, monitor: mon };
      buildPanel();
      apply();
      const btn = document.getElementById("settings-btn");
      if (btn && !btn.dataset.ready) {
        btn.dataset.ready = "1";
        btn.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
      }
      document.addEventListener("keydown", (e) => {
        // Esc при открытой панели только закрывает её — дальше (к выходу из полного экрана) не пускаем
        if (e.key === "Escape" && !panel.hidden) { hide(); e.stopPropagation(); }
      });
      document.addEventListener("click", (e) => {
        if (!panel.hidden && !panel.contains(e.target)) hide();
      });
    },
  };
})();
