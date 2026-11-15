/* Галерея тем (кнопка «Темы» в подвале): карточки с превью, названием и описанием.
 * Выбор сохраняется в config.json → theme, экран HUD перезагружается в новой теме.
 * Настройки самой темы — в панели «Настройки». */
(() => {
  let overlay = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  async function choose(id, card) {
    const current = document.documentElement.dataset.theme;
    if (id === current) { hide(); return; }
    if (!window.pywebview) return;
    card.classList.add("gallery__card--busy");
    let res;
    try { res = await window.pywebview.api.save_settings({ theme: id }); }
    catch (e) { res = { ok: false, error: String(e) }; }
    if (res.ok) location.reload();
    else {
      card.classList.remove("gallery__card--busy");
      overlay.querySelector(".gallery__status").textContent = `не сохранено: ${res.error}`;
    }
  }

  function build() {
    overlay = el("div", "gallery");
    overlay.hidden = true;
    const box = el("div", "gallery__box");
    const head = el("div", "gallery__head");
    head.append(el("div", "gallery__title", "Темы"));
    const close = el("button", "settings__close", "✕");
    close.type = "button";
    close.title = "Закрыть (Esc)";
    close.addEventListener("click", hide);
    head.append(close);
    box.append(head);

    const grid = el("div", "gallery__grid");
    const current = document.documentElement.dataset.theme;
    for (const theme of window.HudThemes.list()) {
      const card = el("button", "gallery__card");
      card.type = "button";
      if (theme.id === current) card.classList.add("gallery__card--current");
      const pic = el("div", "gallery__pic");
      if (theme.preview) {
        const img = el("img");
        img.src = theme.preview;
        img.alt = theme.name;
        img.onerror = () => img.remove();         // нет превью — остаётся подложка
        pic.append(img);
      }
      const text = el("div", "gallery__text");
      const name = el("div", "gallery__name", theme.name);
      if (theme.id === current) name.append(el("span", "gallery__badge", "сейчас"));
      text.append(name, el("div", "gallery__desc", theme.description || ""));
      card.append(pic, text);
      card.addEventListener("click", () => choose(theme.id, card));
      grid.append(card);
    }
    box.append(grid);
    box.append(el("div", "gallery__status", "настройки каждой темы — в «Настройках» и сохраняются отдельно"));
    overlay.append(box);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) hide(); });
    document.body.append(overlay);
  }

  function show() {
    if (!overlay) build();
    if (window.HudSettings && window.HudSettings.hide) window.HudSettings.hide();
    overlay.hidden = false;
  }
  function hide() { if (overlay) overlay.hidden = true; }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay && !overlay.hidden) { hide(); e.stopPropagation(); }
  }, true);

  window.HudGallery = {
    init() {
      const btn = document.getElementById("themes-btn");
      if (btn && !btn.dataset.ready) {
        btn.dataset.ready = "1";
        btn.addEventListener("click", (e) => { e.stopPropagation(); overlay && !overlay.hidden ? hide() : show(); });
      }
    },
    show, hide,
  };
})();
