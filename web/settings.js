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
    return [
      { title: "Окно", items },
      { title: "HWiNFO", items: [
        { type: "custom", render: renderHwinfo },
        { key: "hwinfo_auto", type: "toggle", label: "Запускать и перезапускать сам",
          hint: "если HWiNFO не запущен или через 12 часов отключил общую память" },
      ] },
    ];
  }

  // ── HWiNFO: состояние и кнопка «Настроить» (backend/hwinfo_setup.py) ──
  function renderHwinfo(row) {
    const text = el("div", "settings__label");
    const state = el("span", "settings__hint");
    const actions = el("div", "settings__actions");
    const setupBtn = el("button", "settings__btn", "Настроить HWiNFO");
    const removeBtn = el("button", "settings__btn settings__btn--quiet", "Убрать задание");
    setupBtn.type = removeBtn.type = "button";
    text.append("Незаметный HWiNFO", state);
    actions.append(setupBtn, removeBtn);
    row.append(text, actions);

    const api = () => window.pywebview && window.pywebview.api;
    async function refresh() {
      if (!api()) { state.textContent = "доступно только в программе"; setupBtn.disabled = removeBtn.disabled = true; return; }
      let st;
      try { st = await api().hwinfo_status(); } catch (e) { state.textContent = String(e); return; }
      removeBtn.hidden = !st.task;
      if (!st.installed) {
        state.textContent = "HWiNFO не установлен — скачайте вариант Installer на hwinfo.com";
        setupBtn.disabled = true;
      } else if (st.configured) {
        state.textContent = "настроен: запускается в трее, данные включены, после 12 часов перезапускается сам";
        setupBtn.textContent = "Настроить заново";
      } else if (st.task_moved) {
        state.textContent = "PC HUD перенесли в другую папку — нажмите, чтобы обновить задание";
      } else {
        state.textContent = "HUD сам поставит галки в HWiNFO и будет запускать его незаметно. Windows один раз спросит разрешение";
      }
      row.dataset.configured = st.configured ? "1" : "";
    }
    async function act(btn, method, busy) {
      const old = btn.textContent;
      setupBtn.disabled = removeBtn.disabled = true;
      btn.textContent = busy;
      let res;
      try { res = await api()[method](); } catch (e) { res = { ok: false, message: String(e) }; }
      btn.textContent = old;
      setupBtn.disabled = removeBtn.disabled = false;
      await refresh();
      setStatus(res.message, !res.ok);
    }
    setupBtn.addEventListener("click", () => act(setupBtn, "hwinfo_setup", "Подтвердите в окне Windows…"));
    removeBtn.addEventListener("click", () => act(removeBtn, "hwinfo_remove", "Подтвердите…"));
    refresh();
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
    // пункт виден только при нужном значении другого (например, «Свой цвет» при палитре «Свой»)
    panel.querySelectorAll("[data-show-key]").forEach((row) => {
      row.hidden = store(row.dataset.scope)[row.dataset.showKey] !== row.dataset.showVal;
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

  function setStatus(text, error = false) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle("settings__status--err", error);
  }

  // ── встроенная палитра для «Свой цвет» ──
  // Квадрат «насыщенность × яркость», полоса тона, код цвета, пипетка (EyeDropper —
  // берёт цвет с любого места экрана) и готовые цвета. onChange(hex) — на каждое движение.
  const PRESETS = ["#38e1c4", "#22b345", "#4cc2ff", "#304bd9", "#b06cff", "#ff5fa2", "#ff5470", "#ff7a1a", "#f5b942", "#e8e8e8"];

  function hexToHsv(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    let h = 0;
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, max ? d / max : 0, max];
  }
  function hsvToHex(h, s, v) {
    const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return "#" + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
  }

  function colorPicker(initial, onChange) {
    let [h, s, v] = hexToHsv(initial);
    const box = el("div", "picker");
    const sv = el("div", "picker__sv");
    const svKnob = el("span", "picker__knob");
    sv.append(svKnob);
    const hue = el("div", "picker__hue");
    const hueKnob = el("span", "picker__knob picker__knob--hue");
    hue.append(hueKnob);
    const line = el("div", "picker__line");
    const hexIn = el("input", "picker__hex");
    hexIn.spellcheck = false;
    hexIn.maxLength = 7;
    line.append(hexIn);
    if (window.EyeDropper) {
      const drop = el("button", "picker__drop", "Пипетка");
      drop.type = "button";
      drop.title = "Взять цвет с любого места экрана";
      drop.addEventListener("click", async () => {
        try { const r = await new window.EyeDropper().open(); set(r.sRGBHex, true); } catch (e) { /* Esc */ }
      });
      line.append(drop);
    }
    const presets = el("div", "picker__presets");
    PRESETS.forEach((c) => {
      const b = el("button", "picker__preset");
      b.type = "button";
      b.style.background = c;
      b.title = c.toUpperCase();
      b.addEventListener("click", () => set(c, true));
      presets.append(b);
    });
    box.append(sv, hue, line, presets);

    let frame = 0;
    const emit = () => {                    // не чаще кадра: перекраска фона не дешёвая
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; onChange(hsvToHex(h, s, v)); });
    };
    function draw() {
      sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h}, 100%, 50%))`;
      svKnob.style.left = `${s * 100}%`;
      svKnob.style.top = `${(1 - v) * 100}%`;
      svKnob.style.background = hsvToHex(h, s, v);
      hueKnob.style.left = `${(h / 360) * 100}%`;
      hueKnob.style.background = `hsl(${h}, 100%, 50%)`;
      if (document.activeElement !== hexIn) hexIn.value = hsvToHex(h, s, v).toUpperCase();
    }
    function set(hex, fire) {
      if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
      [h, s, v] = hexToHsv(hex.toLowerCase());
      draw();
      if (fire) emit();
    }
    function drag(target, move) {
      target.addEventListener("pointerdown", (e) => {
        try { target.setPointerCapture(e.pointerId); } catch (err) { /* не мышь */ }
        const go = (ev) => { const r = target.getBoundingClientRect(); move(r, ev); draw(); emit(); };
        go(e);
        const up = () => { target.removeEventListener("pointermove", go); target.removeEventListener("pointerup", up); };
        target.addEventListener("pointermove", go);
        target.addEventListener("pointerup", up);
      });
    }
    const clamp = (x) => Math.max(0, Math.min(1, x));
    drag(sv, (r, e) => { s = clamp((e.clientX - r.left) / r.width); v = 1 - clamp((e.clientY - r.top) / r.height); });
    drag(hue, (r, e) => { h = clamp((e.clientX - r.left) / r.width) * 359.9; });
    hexIn.addEventListener("input", () => {
      const t = hexIn.value.trim();
      set(t.startsWith("#") ? t : "#" + t, true);
    });
    hexIn.addEventListener("blur", draw);
    draw();
    return { el: box, layout: draw, set };
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
    if (item.type === "custom") { item.render(row); return row; }
    if (item.needs) row.dataset.needs = item.needs;
    if (item.needsAny) row.dataset.needsAny = item.needsAny.join(" ");
    if (item.showIf) { row.dataset.showKey = item.showIf[0]; row.dataset.showVal = item.showIf[1]; }
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
    } else if (item.type === "color") {
      // кнопка «● #B06CFF» раскрывает под собой встроенную палитру (colorPicker ниже)
      const btn = el("button", "settings__color");
      btn.type = "button";
      const dot = el("span", "settings__swatch");
      const out = el("span", "settings__color-hex");
      btn.append(dot, out);
      row.append(btn);
      const picker = colorPicker(values()[item.key], (hex) => {
        dot.style.background = hex;
        out.textContent = hex.toUpperCase();
        change(scope, item.key, hex);
      });
      dot.style.background = values()[item.key];
      out.textContent = values()[item.key].toUpperCase();
      picker.el.hidden = true;
      row.append(picker.el);
      btn.addEventListener("click", () => {
        picker.el.hidden = !picker.el.hidden;
        btn.classList.toggle("settings__color--open", !picker.el.hidden);
        if (!picker.el.hidden) picker.layout();
      });
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
          if (!text) dot.style.marginRight = "0";    // кружок без подписи — по центру
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

    // какая тема сейчас; сменить — в галерее «Темы» (themes/gallery.js)
    const current = el("div", "settings__theme");
    current.append(el("span", "", "Тема "), el("b", "", `«${theme.name}»`));
    if (window.HudThemes.list().length > 1 && window.HudGallery) {
      const change = el("button", "settings__link", "сменить");
      change.type = "button";
      change.addEventListener("click", (e) => { e.stopPropagation(); hide(); window.HudGallery.show(); });
      current.append(change);
    }
    panel.append(current);

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
    hide: () => { if (panel) hide(); },
    // cfg — ответ get_config; activeTheme и её настройки уже выбрал app.js
    init(cfg, activeTheme, settings) {
      if (panel) return;
      theme = activeTheme;
      themeSettings = settings;
      monitors = Array.isArray(cfg.monitors) ? cfg.monitors : [];
      // выбранный монитор сейчас не подключён — показываем «где закрыли», но не перезаписываем
      const mon = monitors.some((m) => m.device === cfg.monitor) ? cfg.monitor : "auto";
      general = { start_fullscreen: !!cfg.start_fullscreen, monitor: mon, hwinfo_auto: cfg.hwinfo_auto !== false };
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
