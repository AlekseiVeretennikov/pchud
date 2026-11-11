/* Заставка при запуске. Два режима (настройка boot_mode):

   "hacker" (~7 с) — «взлом»: сначала несётся лог подключения (адреса, порты,
     hex-дамп), затем полосы прогресса с рывками и зависаниями, перебор ключа,
     настоящие данные первого снимка и финальный ACCESS GRANTED со вспышкой.
   "short"  (~3 с) — терминал «поднимает протоколы» и печатает железо.

   После заставки карточки проявляются по очереди, названия CPU/GPU допечатываются.
   Щелчок или любая клавиша — пропустить. app.js передаёт сюда снимки через
   HudBoot.feed(snap); пока заставка не закончилась, HUD скрыт классом body.boot-pending. */

(() => {
  const CHAR_MS = 9;           // печать строки, на шаг (по 2 символа)
  const LINE_MS = 70;          // пауза между строками
  const WIDTH = 38;            // ширина «точечной» колонки до статуса
  const DATA_WAIT_MS = 5000;   // дольше данных не ждём — печатаем без них
  const BAR_CELLS = 20;
  const BAR_COL = 26;          // с какой колонки начинаются полосы прогресса
  const STREAM_LINES = 11;     // сколько строк бегущего лога видно

  let snap = null;
  let waiters = [];
  let skipped = false;
  let finished = false;
  let overlay, log, stream, streamTimer = 0;

  const sleep = (ms) => (skipped ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));
  const rnd = (n) => (Math.random() * n) | 0;
  const hex = (digits) => Array.from({ length: digits }, () => "0123456789ABCDEF"[rnd(16)]).join("");
  const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));

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
      noise.textContent = Array.from({ length: 12 }, () => glyphs[rnd(glyphs.length)]).join("");
      await sleep(45);
    }
    noise.remove();
    const s = document.createElement("span");
    s.className = "boot__status boot__status--ok";
    s.textContent = "DONE";
    line.append(s);
    await sleep(LINE_MS);
  }

  // ── «взлом» ──────────────────────────────────────────────────────────

  // одна строка бегущего лога: зонд порта, пакет, hex-дамп или попытка ключа
  function streamText(t) {
    const ts = `[${(t / 1000).toFixed(4).padStart(9)}]`;
    const ip = `${[10, 172, 192][rnd(3)]}.${rnd(256)}.${rnd(256)}.${rnd(256)}`;
    switch (rnd(5)) {
      case 0: {
        const port = [22, 80, 443, 445, 3389, 8080, 31337][rnd(7)];
        const st = ["open", "filtered", "closed", "open"][rnd(4)];
        return `${ts} probe ${pad(`${ip}:${port}`, 22)} ${st}`;
      }
      case 1:
        return `${ts} SYN -> ${pad(ip, 16)} seq=0x${hex(8)} ack=0x${hex(8)}`;
      case 2: {
        const bytes = Array.from({ length: 8 }, () => hex(2));
        const ascii = bytes.map((b) => { const c = parseInt(b, 16); return c > 32 && c < 127 ? String.fromCharCode(c) : "."; }).join("");
        return `0x${hex(8)}  ${bytes.join(" ")}  ${ascii}`;
      }
      case 3:
        return `${ts} auth: key 0x${hex(12)} ... ${Math.random() < 0.85 ? "rejected" : "partial"}`;
      default:
        return `${ts} route ${ip} -> ${[10, 172][rnd(2)]}.${rnd(256)}.${rnd(256)}.1 ttl=${32 + rnd(96)}`;
    }
  }

  function startStream() {
    stream = document.createElement("div");
    stream.className = "boot__stream";
    overlay.prepend(stream);
    const t0 = performance.now();
    const push = () => {
      const burst = stream.dataset.calm ? 1 : 2 + rnd(3);   // в начале несётся, потом «фоном»
      for (let k = 0; k < burst; k++) {
        const row = document.createElement("div");
        row.textContent = streamText(performance.now() - t0);
        stream.append(row);
      }
      while (stream.childElementCount > STREAM_LINES) stream.firstElementChild.remove();
      streamTimer = setTimeout(push, stream.dataset.calm ? 140 : 35);
    };
    push();
  }

  // "> BYPASSING FIREWALL ...... [██████████░░░░░░░░░░]  52%" — с рывками и зависанием
  async function barLine(label) {
    const line = newLine();
    await type(line, `> ${label} `);
    line.append(".".repeat(Math.max(3, BAR_COL - label.length)) + " ");   // полосы — в одну колонку
    const bar = document.createElement("span");
    bar.className = "boot__bar";
    const pct = document.createElement("span");
    pct.className = "boot__pct";
    line.append(bar, pct);
    let p = 0;
    const stallAt = 35 + rnd(45);
    let stalled = false;
    while (p < 100) {
      const filled = Math.round((p / 100) * BAR_CELLS);
      bar.textContent = `[${"█".repeat(filled)}${"░".repeat(BAR_CELLS - filled)}]`;
      pct.textContent = `${String(p).padStart(4)}%`;
      if (skipped) break;
      if (!stalled && p >= stallAt) { stalled = true; await sleep(220 + rnd(200)); }
      p = Math.min(100, p + 3 + rnd(11));
      await sleep(28 + rnd(30));
    }
    bar.textContent = `[${"█".repeat(BAR_CELLS)}]`;
    pct.textContent = " 100%";
    const s = document.createElement("span");
    s.className = "boot__status boot__status--ok";
    s.textContent = " OK";
    line.append(s);
    await sleep(LINE_MS);
  }

  // перебор ключа: символы мельтешат и фиксируются по одному слева направо
  async function crackLine() {
    const line = newLine();
    await type(line, "> CRACKING RSA-4096 KEY  ");
    const key = hex(32);
    const out = document.createElement("span");
    out.className = "boot__key";
    line.append(out);
    for (let locked = 0; locked <= key.length; locked++) {
      const tail = locked < key.length ? hex(key.length - locked) : "";
      out.innerHTML = "";
      const done = document.createElement("span");
      done.className = "boot__key-done";
      done.textContent = key.slice(0, locked);
      out.append(done, tail);
      if (skipped) break;
      await sleep(26);
    }
    out.textContent = key;
    out.className = "boot__key boot__key-done";
    await sleep(LINE_MS * 2);
  }

  async function grantedFinale(text) {
    if (stream) stream.dataset.calm = "";
    overlay.classList.add("boot--flash");
    const granted = newLine("boot__granted boot__granted--hack");
    granted.dataset.text = text;
    granted.textContent = text;
    await sleep(900);
  }

  // ── сценарии ─────────────────────────────────────────────────────────

  const name = (key) => {
    const el = document.querySelector(`[data-bind="${key}"]`);
    const text = el ? (el.dataset.full || el.textContent) : "";
    return text && text !== "—" ? text : null;
  };

  async function dataLines(s) {
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
  }

  async function runShort(version) {
    await type(newLine("boot__title"), `PC HUD ${version || ""}`.trim());
    await sleep(LINE_MS * 2);
    await statusLine("INIT CORE PROTOCOLS", "OK");
    await dataReady();
    const s = snap || {};
    await dataLines(s);
    await decryptLine();
    const granted = newLine("boot__granted");
    granted.textContent = s.source === "demo" ? "DEMO MODE" : "ACCESS GRANTED";
    await sleep(550);
    finish();
  }

  async function runHacker(version) {
    overlay.classList.add("boot--hacker");
    startStream();
    await sleep(900);                                   // лог несётся один — «подключаемся»
    await type(newLine("boot__title"), `PC HUD ${version || ""} // BREACH PROTOCOL`.trim());
    await sleep(LINE_MS * 2);
    await barLine("BYPASSING FIREWALL");
    await barLine("SPOOFING HANDSHAKE");
    await barLine("ESCALATING PRIVILEGES");
    await crackLine();
    await dataReady();
    const s = snap || {};
    await dataLines(s);
    await grantedFinale(s.source === "demo" ? "DEMO MODE" : "ACCESS GRANTED");
    finish();
  }

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(streamTimer);
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
    // mode: "hacker" | "short"
    start(version, mode = "hacker") {
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
      (mode === "short" ? runShort : runHacker)(version);
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
