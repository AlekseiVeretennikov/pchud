/* Эффект «идентификации устройства» для названий CPU и GPU.
   Раз в 12–20 с одно из названий (по очереди) стирается под блочным курсором,
   затем печатается заново буква за буквой — свежая буква на миг вспыхивает циановым.
   Пока идёт анимация, app.js не перезаписывает текст (флаг data-scanning),
   а свежее значение берётся из data-full. */

(() => {
  const SELECTOR = '[data-bind="cpu_name"], [data-bind="gpu_name"]';
  const PAUSE_MIN_MS = 12000;
  const PAUSE_MAX_MS = 20000;
  const ERASE_MS = 22;      // на символ
  const GAP_MS = 380;       // пустая строка с мигающим курсором
  const TYPE_MS = 48;       // на символ
  const TAIL_MS = 900;      // курсор мигает после печати

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let turn = 0;

  function render(el, text, fresh) {
    el.textContent = "";
    if (fresh) {
      el.append(text.slice(0, -1));
      const f = document.createElement("span");
      f.className = "name-scan__fresh";
      f.textContent = text.slice(-1);
      el.append(f);
    } else {
      el.append(text);
    }
    const cursor = document.createElement("span");
    cursor.className = "name-scan__cursor";
    el.append(cursor);
  }

  async function scan(el) {
    if (el.dataset.scanning) return;               // уже идёт: второй запуск съел бы хвост названия
    const full = () => el.dataset.full || "";
    const original = el.textContent;
    if (!original || original === "—") return;
    el.dataset.full = original;
    el.dataset.scanning = "1";
    el.style.minWidth = `${el.getBoundingClientRect().width}px`;   // строка не «схлопывается»
    try {
      for (let n = original.length; n >= 0; n--) {
        render(el, original.slice(0, n), false);
        await sleep(ERASE_MS);
      }
      await sleep(GAP_MS);
      const target = full();                      // если за это время название сменилось — печатаем новое
      for (let n = 1; n <= target.length; n++) {
        render(el, target.slice(0, n), true);
        await sleep(TYPE_MS + (target[n - 1] === " " ? 40 : 0));
      }
      render(el, full(), false);
      el.classList.add("name-scan--blink");
      await sleep(TAIL_MS);
    } finally {
      el.classList.remove("name-scan--blink");
      el.textContent = full();
      el.style.minWidth = "";
      delete el.dataset.scanning;
    }
  }

  function tick() {
    const names = [...document.querySelectorAll(SELECTOR)].filter((el) => el.offsetParent);
    if (names.length) {
      const el = names[turn % names.length];
      turn++;
      scan(el);
    }
    setTimeout(tick, PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS));
  }

  let started = false;
  window.HudNameScan = {
    start(firstDelay = 4000) {
      if (started) return;
      started = true;
      setTimeout(tick, firstDelay);
    },
    scan,
  };
})();
