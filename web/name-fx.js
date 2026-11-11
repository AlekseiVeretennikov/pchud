/* Эффекты названий CPU и GPU.

   1. Помехи сигнала (постоянно): раз в 8–15 с одно из названий (по очереди)
      на ~0,4 с дёргается и расслаивается на голубую и красную копии.
      Иногда помеха идёт двойным импульсом.
   2. Допечатка (только в заставке при запуске, boot.js): название печатается
      буква за буквой под блочным курсором, свежая буква вспыхивает циановым.
      Пока идёт печать, app.js не перезаписывает текст (флаг data-scanning),
      а свежее значение берётся из data-full. */

(() => {
  const SELECTOR = '[data-bind="cpu_name"], [data-bind="gpu_name"]';
  const NOISE_MIN_MS = 8000;
  const NOISE_MAX_MS = 15000;
  const NOISE_MS = 420;
  const TYPE_MS = 38;       // на символ
  const TAIL_MS = 700;      // курсор мигает после печати

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = () => [...document.querySelectorAll(SELECTOR)].filter((el) => el.offsetParent);

  // ── помехи ──
  async function noise(el) {
    if (el.dataset.scanning || el.classList.contains("name-noise")) return;
    el.dataset.text = el.textContent;              // копии в ::before/::after берут текст отсюда
    const pulses = Math.random() < 0.35 ? 2 : 1;
    for (let p = 0; p < pulses; p++) {
      el.classList.add("name-noise");
      await sleep(NOISE_MS);
      el.classList.remove("name-noise");
      if (p < pulses - 1) await sleep(120);
    }
  }

  let turn = 0;
  let noiseEnabled = true;
  function noiseTick() {
    const names = visible();
    if (noiseEnabled && names.length) noise(names[turn++ % names.length]);
    setTimeout(noiseTick, NOISE_MIN_MS + Math.random() * (NOISE_MAX_MS - NOISE_MIN_MS));
  }

  // ── допечатка ──
  function render(el, text, fresh, cursor = true) {
    el.textContent = "";
    if (fresh && text) {
      el.append(text.slice(0, -1));
      const f = document.createElement("span");
      f.className = "name-scan__fresh";
      f.textContent = text.slice(-1);
      el.append(f);
    } else {
      el.append(text);
    }
    if (cursor) {
      const c = document.createElement("span");
      c.className = "name-scan__cursor";
      el.append(c);
    }
  }

  async function typeIn(el) {
    if (el.dataset.scanning) return;
    const text = el.textContent;
    if (!text || text === "—") return;
    el.dataset.full = text;
    el.dataset.scanning = "1";
    el.style.minWidth = `${el.getBoundingClientRect().width}px`;   // строка не «прыгает»
    try {
      for (let n = 0; n <= text.length; n++) {
        render(el, el.dataset.full.slice(0, n), n > 0);
        await sleep(TYPE_MS);
      }
      el.classList.add("name-scan--blink");
      await sleep(TAIL_MS);
    } finally {
      el.classList.remove("name-scan--blink");
      el.textContent = el.dataset.full;
      el.style.minWidth = "";
      delete el.dataset.scanning;
    }
  }

  let started = false;
  window.HudNameFx = {
    startNoise(firstDelay = 6000) {
      if (started) return;
      started = true;
      setTimeout(noiseTick, firstDelay);
    },
    setNoiseEnabled(v) { noiseEnabled = !!v; },
    typeInAll: () => Promise.all(visible().map(typeIn)),
    noise,
    typeIn,
  };
})();
