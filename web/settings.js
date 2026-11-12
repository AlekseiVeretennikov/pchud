/* Панель «Настройки» (кнопка в подвале): фон, его яркость и слои, эффекты, окно, заставка.
   Изменения применяются сразу, а через полсекунды тишины уходят в config.json
   (backend: Api.save_settings — дописывает только эти ключи, остальное не трогает). */

(() => {
  const SAVE_DELAY_MS = 500;

  // описание панели: ключи совпадают с config.json
  const SECTIONS = [
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
    { title: "Окно", items: [
      { key: "start_fullscreen", type: "toggle", label: "Всегда открывать на весь экран",
        hint: "на мониторе, где HUD закрыли; F11 переключает до закрытия" },
    ] },
    { title: "Заставка при запуске", items: [
      { key: "boot_mode", type: "choice", options: [["hacker", "Взлом"], ["short", "Короткая"], ["off", "Выкл."]],
        hint: "применится при следующем запуске" },
    ] },
  ];

  let config = {};
  let panel, statusEl, saveTimer = 0;
  const pendingSave = {};

  const background = () => (window.HudBackgrounds || {})["cipher-rain"];

  // применить к живому HUD (кроме заставки — она только при запуске)
  function apply() {
    const bg = background();
    if (bg) {
      bg.setOptions({
        brightness: config.bg_brightness / 100,
        field: config.bg_field, drops: config.bg_drops, words: config.bg_words,
      });
      if (config.background === "none") bg.stop();
      else bg.start(document.getElementById("hud-bg"));
    }
    if (window.HudLabelGlitch) {
      window.HudLabelGlitch.setEnabled(config.label_glitch);
      window.HudLabelGlitch.setRate(config.fx_rate);
    }
    if (window.HudNameFx) {
      window.HudNameFx.setNoiseEnabled(config.name_noise);
      window.HudNameFx.setNoiseRate(config.fx_rate);
    }
    if (panel) {
      panel.querySelectorAll("[data-needs]").forEach((row) => {
        row.classList.toggle("settings__row--off", config[row.dataset.needs] === "none");
      });
      // «Частота» бледнеет, когда оба эффекта выключены
      panel.querySelectorAll("[data-needs-any]").forEach((row) => {
        row.classList.toggle("settings__row--off", !row.dataset.needsAny.split(" ").some((k) => config[k]));
      });
    }
  }

  function change(key, value) {
    config[key] = value;
    apply();
    pendingSave[key] = value;
    clearTimeout(saveTimer);
    setStatus("…");
    saveTimer = setTimeout(save, SAVE_DELAY_MS);
  }

  async function save() {
    const changes = { ...pendingSave };
    Object.keys(pendingSave).forEach((k) => delete pendingSave[k]);
    if (!window.pywebview) { setStatus("в браузере не сохраняется"); return; }
    let res;
    try { res = await window.pywebview.api.save_settings(changes); }
    catch (e) { res = { ok: false, error: String(e) }; }
    setStatus(res.ok ? "сохранено" : `не сохранено: ${res.error}`, !res.ok);
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

  function buildItem(item) {
    const row = el("div", `settings__row settings__row--${item.type}`);
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
      const isOn = () => (item.on ? config[item.key] !== item.off : !!config[item.key]);
      const sync = () => { sw.setAttribute("aria-pressed", String(isOn())); };
      sw.addEventListener("click", () => {
        change(item.key, item.on ? (isOn() ? item.off : item.on) : !isOn());
        sync();
      });
      sync();
      row.append(sw);
    } else if (item.type === "range") {
      const wrap = el("div", "settings__range");
      const input = el("input");
      Object.assign(input, { type: "range", min: item.min, max: item.max, step: item.step, value: config[item.key] });
      const out = el("span", "settings__value", `${config[item.key]}${item.unit}`);
      input.addEventListener("input", () => {
        out.textContent = `${input.value}${item.unit}`;
        change(item.key, Number(input.value));
      });
      wrap.append(input, out);
      row.append(wrap);
    } else if (item.type === "choice") {
      const group = el("div", "settings__choice");
      const sync = () => group.querySelectorAll("button").forEach((b) => {
        b.setAttribute("aria-pressed", String(b.dataset.value === config[item.key]));
      });
      item.options.forEach(([value, text]) => {
        const b = el("button", "", text);
        b.type = "button";
        b.dataset.value = value;
        b.addEventListener("click", () => { change(item.key, value); sync(); });
        group.append(b);
      });
      sync();
      row.append(group);
      // без подписи слева пояснение идёт под кнопками (у подписи оно уже есть)
      if (item.hint && !item.label) row.append(el("div", "settings__hint settings__hint--below", item.hint));
    }
    return row;
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
    SECTIONS.forEach((section) => {
      const box = el("div", "settings__section");
      box.append(el("div", "settings__section-title", section.title));
      section.items.forEach((item) => box.append(buildItem(item)));
      panel.append(box);
    });
    statusEl = el("div", "settings__status", "изменения сохраняются сами");
    panel.append(statusEl);
    document.body.append(panel);
    apply();
  }

  function show() { panel.hidden = false; }
  function hide() { panel.hidden = true; }
  function toggle() { panel.hidden ? show() : hide(); }

  window.HudSettings = {
    init(cfg) {
      if (panel) return;
      config = { ...cfg };
      if (config.background === "letter-glitch") config.background = "cipher-rain";   // имя до 0.1.1
      buildPanel();
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
