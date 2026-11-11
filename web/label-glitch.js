/* Эффект "шифрования" подписей: почти без перерыва в 1-2 новых подписях меняется
   около трети букв, одновременно таких подписей обычно 2-3. Числа и названия устройств в список не входят,
   поэтому эффект не может исказить показания. */

(() => {
  const LABELS = [
    ".stat dt", ".mem-block__title", ".mb-tile__title", ".ccd-label__name",
    ".card__kind", ".drive--head span", ".fps-panel__row > span",
  ].join(", ");
  const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ#$&*+=/<>";
  const PAUSE_MIN_MS = 600;
  const PAUSE_MAX_MS = 1200;
  const DURATION_MIN_MS = 900;   // эффекты перекрываются: подпись в эффекте повторно не выбирается
  const DURATION_MAX_MS = 1500;
  const LABELS_MIN = 3;
  const LABELS_MAX = 5;
  const LETTER_SHARE = 0.35;     // доля заменяемых букв, но не меньше двух
  const STEP_MS = 70;

  const randomInt = (max) => Math.floor(Math.random() * max);
  const randomGlyph = () => GLYPHS[randomInt(GLYPHS.length)];

  function pickLetters(chars) {
    const letters = chars.flatMap((char, i) => (/\p{L}/u.test(char) ? [i] : []));
    const picked = new Set();
    const count = Math.min(Math.max(2, Math.round(letters.length * LETTER_SHARE)), letters.length);
    while (picked.size < count) picked.add(letters[randomInt(letters.length)]);
    return picked;
  }

  function glitch(el, duration = DURATION_MIN_MS + Math.random() * (DURATION_MAX_MS - DURATION_MIN_MS)) {
    const original = el.textContent;
    const chars = Array.from(original);
    const picked = pickLetters(chars);
    if (!picked.size) return;

    // Каждая буква фиксируется по ширине из исходного текста: иначе браузер округляет
    // разбитое на части слово по-своему, и подпись сдвигается на несколько пикселей.
    const textNode = el.firstChild;
    const range = document.createRange();
    let offset = 0;
    const widths = chars.map((char) => {
      range.setStart(textNode, offset);
      offset += char.length;
      range.setEnd(textNode, offset);
      return range.getBoundingClientRect().width;
    });

    const slots = [];
    el.classList.add("label-glitching");
    el.replaceChildren(...chars.map((char, i) => {
      const cell = document.createElement("span");
      cell.className = "label-glitch-cell";
      cell.style.width = `${widths[i]}px`;
      cell.textContent = char;
      if (picked.has(i)) slots.push(cell);
      return cell;
    }));
    slots.forEach((slot) => slot.classList.add("label-glitch-cell--active"));

    const swap = () => slots.forEach((slot) => { slot.textContent = randomGlyph(); });
    swap();
    const timer = setInterval(swap, STEP_MS);
    setTimeout(() => {
      clearInterval(timer);
      el.textContent = original;
      el.classList.remove("label-glitching");
    }, duration);
  }

  function labels() {
    return [...document.querySelectorAll(LABELS)].filter(
      (el) => el.children.length === 0 && el.textContent.trim() && el.offsetParent !== null,
    );
  }

  let enabled = true;
  let started = false;
  function start() {
    if (started || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    started = true;
    const schedule = () => setTimeout(() => {
      if (enabled && !document.hidden) {
        const all = labels();
        const count = LABELS_MIN + randomInt(LABELS_MAX - LABELS_MIN + 1);
        for (let i = 0; i < count && all.length; i++) {
          glitch(all.splice(randomInt(all.length), 1)[0]);
        }
      }
      schedule();
    }, PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS));
    schedule();
  }

  // из панели настроек: выключить/включить без перезапуска
  const setEnabled = (v) => { enabled = !!v; };
  window.HudLabelGlitch = { start, setEnabled, glitch, labels };
})();
