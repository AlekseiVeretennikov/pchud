/* Заставка при запуске: терминал «поднимает протоколы» поверх фона,
   печатая строки с настоящими данными первого снимка (источник, RTSS, CPU, GPU,
   число датчиков), затем растворяется — карточки проявляются по очереди,
   названия CPU/GPU допечатываются. Щелчок или любая клавиша — пропустить.

   app.js передаёт сюда каждый снимок через HudBoot.feed(snap);
   пока заставка не закончилась, HUD скрыт классом body.boot-pending. */

(() => {
  const CHAR_MS = 9;           // печать строки, на шаг (по 2 символа)
  const LINE_MS = 70;          // пауза между строками
  const WIDTH = 38;            // ширина «точечной» колонки до статуса
  const DATA_WAIT_MS = 5000;   // дольше данных не ждём — печатаем без них

  let snap = null;
  let waiters = [];
  let skipped = false;
  let finished = false;
  let overlay, log;

  const sleep = (ms) => (skipped ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

  function dataReady() {
    if (snap) return Promise.resolve();
    return new Promise((resolve) => {
      waiters.push(resolve);
      setTimeout(resolve, DATA_WAIT_MS);
    });
  }

  function newLine(cls) {
    const line = document.createElement("div");
    line.className = `boot__line ${cls || ""}`;
    log.append(line);
    return line;
  }

  async function type(el, text) {
    if (skipped) { el.append(text); return; }
    const node = document.createTextNode("");
    el.append(node);
    for (let i = 0; i < text.length; i += 2) {
      node.data = text.slice(0, i + 2);
      await sleep(CHAR_MS);
    }
  }

  // "> LINK RTSS ............ OK"
  async function statusLine(label, status, tone = "ok") {
    const line = newLine();
    await type(line, `> ${label} `);
    line.append(".".repeat(Math.max(3, WIDTH - label.length)));   // точки — сразу, не печатаем
    const s = document.createElement("span");
    s.className = `boot__status boot__status--${tone}`;
    line.append(" ", s);
    await sleep(60);
    s.textContent = status;
    await sleep(LINE_MS);
  }

  async function infoLine(label, value) {
    const line = newLine();
    await type(line, `> ${label}  `);
    const v = document.createElement("span");
    v.className = "boot__value";
    line.append(v);
    await type(v, value);
    await sleep(LINE_MS);
  }

  // строка с «перебором» символов на конце, потом итог
  async function decryptLine() {
    const line = newLine();
    await type(line, "> DECRYPTING TELEMETRY ");
    const noise = document.createElement("span");
    noise.className = "boot__noise";
    line.append(noise);
    const glyphs = "ｱｲｳｴｵｶｷｸ0123456789ABCDEF#$%&*";
    const until = performance.now() + 450;
    while (!skipped && performance.now() < until) {
      noise.textContent = Array.from({ length: 12 }, () => glyphs[(Math.random() * glyphs.length) | 0]).join("");
      await sleep(45);
    }
    noise.remove();
    const s = document.createElement("span");
    s.className = "boot__status boot__status--ok";
    s.textContent = "DONE";
    line.append(s);
    await sleep(LINE_MS);
  }

  const name = (key) => {
    const el = document.querySelector(`[data-bind="${key}"]`);
    const text = el ? (el.dataset.full || el.textContent) : "";
    return text && text !== "—" ? text : null;
  };

  async function run(version) {
    await type(newLine("boot__title"), `PC HUD ${version || ""}`.trim());
    await sleep(LINE_MS * 2);
    await statusLine("INIT CORE PROTOCOLS", "OK");
    await dataReady();
    const s = snap || {};
    if (s.source === "demo") await statusLine("LINK SENSOR SOURCE", "DEMO", "warn");
    else await statusLine(`LINK ${(s.source_display || "SENSORS").toUpperCase()}`, s.source ? "OK" : "WAIT",
                          s.source ? "ok" : "warn");
    await statusLine("LINK RTSS", s.rtss_running ? "OK" : "OFFLINE", s.rtss_running ? "ok" : "dim");

    const cpu = name("cpu_name"), gpu = name("gpu_name");
    const cores = (s.cores || []).length;
    const vram = s.vram_total_gb;
    if (cpu) await infoLine("CPU", cores ? `${cpu} · ${cores} CORES` : cpu);
    if (gpu) await infoLine("GPU", vram ? `${gpu} · ${Math.round(vram)} GB` : gpu);
    if (s.sensor_count) await statusLine("SENSORS ONLINE", String(s.sensor_count));
    await decryptLine();

    const granted = newLine("boot__granted");
    granted.textContent = s.source === "demo" ? "DEMO MODE" : "ACCESS GRANTED";
    await sleep(550);
    finish();
  }

  function finish() {
    if (finished) return;
    finished = true;
    window.removeEventListener("keydown", skip);
    overlay.classList.add("boot--out");
    setTimeout(() => overlay.remove(), 600);
    reveal();
  }

  // карточки проявляются по очереди, названия CPU/GPU допечатываются
  function reveal() {
    const hud = document.querySelector(".hud");
    if (hud) {
      [...hud.querySelectorAll(".card, .hud__foot")].forEach((el, i) => el.style.setProperty("--i", i));
      hud.classList.add("hud--reveal");
      setTimeout(() => hud.classList.remove("hud--reveal"), 2500);
    }
    document.body.classList.remove("boot-pending");
    if (window.HudNameFx) setTimeout(() => window.HudNameFx.typeInAll(), 150);
  }

  function skip() {
    if (skipped || finished) return;
    skipped = true;          // все паузы схлопываются — строки допечатываются мгновенно
    finish();
  }

  // страховка: если настройки так и не пришли, HUD не должен остаться скрытым
  setTimeout(() => { if (!overlay) document.body.classList.remove("boot-pending"); }, 8000);

  window.HudBoot = {
    start(version) {
      if (overlay) return;
      overlay = document.createElement("div");
      overlay.className = "boot";
      log = document.createElement("div");
      log.className = "boot__log";
      const hint = document.createElement("div");
      hint.className = "boot__hint";
      hint.textContent = "щелчок или любая клавиша — пропустить";
      overlay.append(log, hint);
      document.body.append(overlay);
      overlay.addEventListener("click", skip);
      window.addEventListener("keydown", skip);
      run(version);
    },
    // заставка выключена в настройках — просто показать HUD
    skip() { document.body.classList.remove("boot-pending"); },
    feed(s) {
      if (snap || !s) return;
      snap = s;
      waiters.forEach((r) => r());
      waiters = [];
    },
  };
})();
