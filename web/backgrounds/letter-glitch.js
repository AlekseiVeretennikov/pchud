/* Фон Letter Glitch: сетка символов на WebGL2.
   Перенесён без React из компонента LetterGlitch проекта React Bits
   (https://github.com/DavidHDev/react-bits, коммит e2eb04d).
   Copyright (c) 2026 David Haz. Лицензия: MIT + Commons Clause, см. letter-glitch.LICENSE.md.

   Отличия от оригинала: убрана реакция на курсор и клики (это фон приборной панели),
   частота кадров ограничена, чтобы HUD не отнимал ресурсы у игры. */

(() => {
  const DEFAULTS = {
    characters: "ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$&*()-_+=/[]{};:<>.,0123456789",
    fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace",
    colors: ["#ffffff", "#61dca3"],
    baseColor: "#ffffff",
    fontSize: 14,
    spacing: 0.6,
    density: 0.9,
    baseOpacity: 0.22,  // в оригинале 0.16: на портативном мониторе фон почти терялся
    glitchAmount: 0.5,
    speed: 1,
    flow: 0.5,
    intro: true,
    maxFps: 30,
  };
  const MAX_COLORS = 8;
  const INTRO_SECONDS = 1.4;
  const REST_RATE = 0.2;
  const GLITCH_RATE = 0.1;

  const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uAtlas;
uniform sampler2D uState;
uniform ivec2 uCell;
uniform ivec2 uGrid;
uniform int uAtlasColumns;
uniform vec2 uResolution;
uniform vec2 uOrigin;
uniform vec3 uBase;
uniform float uBaseOpacity;
uniform vec3 uColors[8];
uniform float uTime;
uniform float uFlow;
uniform float uFlowScale;
out vec4 outColor;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) - uOrigin;
  ivec2 q = ivec2(floor(frag));
  ivec2 cell = q / uCell;
  vec4 color = vec4(0.0);
  if (all(greaterThanEqual(q, ivec2(0))) && all(lessThan(cell, uGrid))) {
    vec4 state = texelFetch(uState, cell, 0);
    int glyph = int(state.r * 255.0 + 0.5);
    ivec2 texel = ivec2(glyph % uAtlasColumns, glyph / uAtlasColumns) * uCell + (q - cell * uCell);
    float coverage = texelFetch(uAtlas, texel, 0).a;
    if (coverage > 0.0) {
      vec2 center = vec2(cell * uCell) + vec2(uCell) * 0.5 + uOrigin;
      float seed = hash(vec2(cell) + 17.0);
      float rest = state.g * uBaseOpacity * (0.8 + 0.2 * sin(uTime * (0.5 + 1.2 * seed) + seed * 40.0));
      if (uFlow > 0.0) {
        vec2 p = center / uFlowScale;
        float n = 0.65 * noise(p + vec2(uTime * 0.05, uTime * 0.03)) + 0.35 * noise(p * 2.03 - vec2(uTime * 0.04, -uTime * 0.06));
        rest *= mix(1.0, 0.1 + 1.7 * smoothstep(0.25, 0.8, n), uFlow);
      }
      float heat = state.b;
      rest = min(rest, 1.0) * (1.0 - heat);
      vec3 tint = uColors[int(state.a * 255.0 + 0.5)];
      color = vec4((uBase * rest + tint * heat) * coverage, (rest + heat) * coverage);
    }
  }
  outColor = color;
}`;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const smoother = (value) => {
    const x = clamp(value, 0, 1);
    return x * x * x * (x * (x * 6 - 15) + 10);
  };
  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    console.error("[letter-glitch] шейдер:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }

  function link(gl) {
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vertex || !fragment) return null;
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return null;
    }
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(program, i).name.replace(/\[0\]$/, "");
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return { program, uniforms };
  }

  /* Рисует фон внутри container. Без WebGL2 ничего не делает: остаётся обычный фон страницы. */
  function start(container, options = {}) {
    const s = { ...DEFAULTS, ...options };
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    container.appendChild(canvas);

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    const program = gl && link(gl);
    if (!program) {
      canvas.remove();
      return false;
    }
    const u = program.uniforms;
    const vao = gl.createVertexArray();
    const makeTexture = () => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    };
    const atlasTexture = makeTexture();
    const stateTexture = makeTexture();
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const atlas = document.createElement("canvas");
    const atlasContext = atlas.getContext("2d");

    const colors = s.colors.slice(0, MAX_COLORS);
    const colorCount = Math.max(1, colors.length);
    const palette = new Float32Array(MAX_COLORS * 3);
    for (let i = 0; i < MAX_COLORS; i++) {
      palette.set(hexToRgb(colors[Math.min(i, colorCount - 1)]), i * 3);
    }
    const base = hexToRgb(s.baseColor);

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frameMs = 1000 / s.maxFps;
    const view = { width: 1, height: 1, ratio: 1 };
    const grid = { cols: 0, rows: 0, cellW: 0, cellH: 0, originX: 0, originY: 0, atlasColumns: 1 };
    let pool = [0];
    let typeKey = "";
    let count = 0;
    let data = new Uint8Array(0);
    let heat = new Float32Array(0);
    let peak = new Float32Array(0);
    let hold = new Float32Array(0);
    let fade = new Float32Array(0);
    let wait = new Float32Array(0);
    let delay = new Float32Array(0);
    let luck = new Float32Array(0);
    let level = new Float32Array(0);
    let born = new Float32Array(0);
    let slot = new Int32Array(0);
    let active = new Int32Array(0);
    let activeCount = 0;
    let introLeft = s.intro && !reduce;
    let clock = 0;
    let time = 0;
    let restCarry = 0;
    let glitchCarry = 0;
    let dirty = true;
    let raf = 0;
    let last = 0;

    const randomGlyph = () => pool[(Math.random() * pool.length) | 0];
    const randomColor = () => (Math.random() * colorCount) | 0;
    const restValue = (i, appear = 1) => (luck[i] < s.density ? Math.round(level[i] * 255 * appear) : 0);

    function ignite(i, strength, holdTime, fadeTime, color, after = 0) {
      if (slot[i] < 0) {
        slot[i] = activeCount;
        active[activeCount++] = i;
        heat[i] = 0;
        hold[i] = holdTime;
        peak[i] = strength;
        fade[i] = fadeTime;
        wait[i] = 0;
        delay[i] = after;
        data[i * 4 + 3] = color;
        return;
      }
      if (heat[i] < 0.15) data[i * 4 + 3] = color;
      peak[i] = hold[i] > 0 ? Math.max(peak[i], strength) : strength;
      hold[i] = Math.max(hold[i], holdTime);
      fade[i] = Math.max(fade[i], fadeTime);
      delay[i] = Math.min(delay[i], after);
    }

    function release(k) {
      const i = active[k];
      const moved = active[--activeCount];
      active[k] = moved;
      slot[moved] = k;
      slot[i] = -1;
      heat[i] = 0;
      data[i * 4 + 2] = 0;
    }

    function buildType() {
      const size = s.fontSize * view.ratio;
      const font = `${size}px ${s.fontFamily}`;
      const chars = Array.from(s.characters);
      const unique = Array.from(new Set(chars)).slice(0, 256);
      atlasContext.font = font;
      let advance = 1;
      unique.forEach((char) => {
        advance = Math.max(advance, atlasContext.measureText(char).width);
      });
      const metrics = atlasContext.measureText("M");
      const cellW = Math.max(2, Math.ceil(advance + size * s.spacing));
      const cellH = Math.max(2, Math.ceil(size * (0.95 + s.spacing)));
      const columns = Math.max(1, Math.min(unique.length, Math.floor(maxSize / cellW)));
      atlas.width = columns * cellW;
      atlas.height = Math.ceil(unique.length / columns) * cellH;
      atlasContext.font = font;
      atlasContext.textAlign = "center";
      atlasContext.textBaseline = "alphabetic";
      atlasContext.fillStyle = "#ffffff";
      const baseline = cellH / 2 + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
      unique.forEach((char, i) => {
        atlasContext.fillText(char, (i % columns) * cellW + cellW / 2, Math.floor(i / columns) * cellH + baseline);
      });
      gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
      const lookup = new Map(unique.map((char, i) => [char, i]));
      pool = chars.map((char) => lookup.get(char));
      grid.cellW = cellW;
      grid.cellH = cellH;
      grid.atlasColumns = columns;
      // размер ячейки изменился — старая сетка больше не подходит
      grid.cols = 0;
      grid.rows = 0;
    }

    function birthTime(c, r, cols, rows) {
      const dx = (c + 0.5) / cols - 0.5;
      const dy = (r + 0.5) / rows - 0.5;
      const radial = Math.min(1, Math.hypot(dx, dy * 0.8) * 1.6);
      return INTRO_SECONDS * (0.3 * radial + 0.7 * Math.random() ** 1.3);
    }

    function buildGrid() {
      const cols = Math.ceil(canvas.width / grid.cellW) + 1;
      const rows = Math.ceil(canvas.height / grid.cellH) + 1;
      grid.originX = Math.floor((canvas.width - cols * grid.cellW) / 2);
      grid.originY = Math.floor((canvas.height - rows * grid.cellH) / 2);
      if (cols === grid.cols && rows === grid.rows) return;
      const n = cols * rows;
      const nextData = new Uint8Array(n * 4);
      const nextLuck = new Float32Array(n);
      const nextLevel = new Float32Array(n);
      const nextBorn = new Float32Array(n);
      const shiftC = Math.floor((grid.cols - cols) / 2);
      const shiftR = Math.floor((grid.rows - rows) / 2);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const oc = c + shiftC;
          const or = r + shiftR;
          if (oc >= 0 && or >= 0 && oc < grid.cols && or < grid.rows) {
            const j = or * grid.cols + oc;
            nextData[i * 4] = data[j * 4];
            nextLuck[i] = luck[j];
            nextLevel[i] = level[j];
            nextBorn[i] = born[j];
          } else {
            nextData[i * 4] = randomGlyph();
            nextLuck[i] = Math.random();
            nextLevel[i] = 0.55 + 0.45 * Math.random();
            nextBorn[i] = introLeft ? birthTime(c, r, cols, rows) : -1;
          }
        }
      }
      grid.cols = cols;
      grid.rows = rows;
      count = n;
      data = nextData;
      luck = nextLuck;
      level = nextLevel;
      born = nextBorn;
      heat = new Float32Array(n);
      peak = new Float32Array(n);
      hold = new Float32Array(n);
      fade = new Float32Array(n);
      wait = new Float32Array(n);
      delay = new Float32Array(n);
      slot = new Int32Array(n).fill(-1);
      active = new Int32Array(n);
      activeCount = 0;
      for (let i = 0; i < n; i++) data[i * 4 + 1] = born[i] >= 0 ? 0 : restValue(i);
      gl.bindTexture(gl.TEXTURE_2D, stateTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      dirty = false;
    }

    function ambient(dt) {
      if (reduce || s.speed <= 0 || !count) return;
      restCarry += count * REST_RATE * s.speed * dt;
      let changes = Math.min(count, restCarry | 0);
      restCarry -= changes;
      while (changes-- > 0) {
        const i = (Math.random() * count) | 0;
        if (slot[i] < 0) {
          data[i * 4] = randomGlyph();
          dirty = true;
        }
      }
      const tempo = Math.max(s.speed, 0.2);
      glitchCarry += count * s.glitchAmount ** 1.6 * GLITCH_RATE * s.speed * dt;
      let events = Math.min(count, glitchCarry | 0);
      glitchCarry -= events;
      while (events-- > 0) {
        const i = (Math.random() * count) | 0;
        const color = randomColor();
        const strength = 0.45 + 0.55 * Math.random();
        const holdTime = (0.04 + Math.random() * 0.26) / tempo;
        const fadeTime = (0.45 + Math.random() * 0.6) / tempo;
        const roll = Math.random();
        if (roll < 0.24) {
          const c = i % grid.cols;
          const long = roll < 0.015;
          const length = Math.min(grid.cols - c, long ? 10 + ((Math.random() * 24) | 0) : 2 + ((Math.random() * 7) | 0));
          const pace = (long ? 0.012 : 0.028) / tempo;
          for (let k = 0; k < length; k++) ignite(i + k, strength, holdTime, fadeTime, color, k * pace);
        } else {
          ignite(i, strength, holdTime, fadeTime, color);
        }
      }
    }

    function settle(dt) {
      const tempo = Math.max(s.speed, 0.5);
      const attack = 1 - Math.exp(-dt / 0.05);
      for (let k = 0; k < activeCount; ) {
        const i = active[k];
        if (delay[i] > 0) {
          delay[i] -= dt;
          k++;
          continue;
        }
        let h = heat[i];
        if (hold[i] > 0) {
          hold[i] -= dt;
          h += (peak[i] - h) * attack;
        } else {
          h *= Math.exp((-dt * 4) / Math.max(fade[i], 0.05));
        }
        if (h < 0.012 && hold[i] <= 0) {
          release(k);
          dirty = true;
          continue;
        }
        heat[i] = h;
        wait[i] -= dt;
        if (wait[i] <= 0) {
          data[i * 4] = randomGlyph();
          wait[i] = ((0.045 + 0.45 * (1 - h) * (1 - h)) * (0.6 + 0.8 * Math.random())) / tempo;
        }
        data[i * 4 + 2] = Math.round(h * 255);
        dirty = true;
        k++;
      }
    }

    function reveal(dt) {
      if (!introLeft) return;
      let pending = false;
      for (let i = 0; i < count; i++) {
        const t = born[i];
        if (t < 0) continue;
        const age = clock - t;
        if (age < 0) {
          pending = true;
          continue;
        }
        if (age < dt && Math.random() < (luck[i] < s.density ? 0.45 : 0.12)) {
          ignite(i, 0.4 + 0.5 * Math.random(), 0.02, 0.35 + Math.random() * 0.35, randomColor());
        }
        const appear = smoother(age / 0.35);
        data[i * 4 + 1] = restValue(i, appear);
        if (appear >= 1) born[i] = -1;
        else pending = true;
      }
      dirty = true;
      if (!pending) introLeft = false;
    }

    function draw() {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.BLEND);
      gl.useProgram(program.program);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, stateTexture);
      if (dirty) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, grid.cols, grid.rows, gl.RGBA, gl.UNSIGNED_BYTE, data);
        dirty = false;
      }
      gl.uniform1i(u.uState, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
      gl.uniform1i(u.uAtlas, 0);
      gl.uniform2i(u.uCell, grid.cellW, grid.cellH);
      gl.uniform2i(u.uGrid, grid.cols, grid.rows);
      gl.uniform1i(u.uAtlasColumns, grid.atlasColumns);
      gl.uniform2f(u.uResolution, canvas.width, canvas.height);
      gl.uniform2f(u.uOrigin, grid.originX, grid.originY);
      gl.uniform3fv(u.uBase, base);
      gl.uniform1f(u.uBaseOpacity, s.baseOpacity);
      gl.uniform3fv(u.uColors, palette);
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uFlow, s.flow);
      gl.uniform1f(u.uFlowScale, Math.max(canvas.width, canvas.height) * 0.32);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function frame(now) {
      raf = 0;
      if (document.hidden) return;
      if (last && now - last < frameMs - 1) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = last ? clamp((now - last) / 1000, 0.0005, 0.05) : 1 / s.maxFps;
      last = now;
      clock += dt;
      if (!reduce) time += dt * s.speed;
      reveal(dt);
      ambient(dt);
      settle(dt);
      draw();
      // без анимации (системная настройка reduced motion) достаточно одного кадра
      if ((!reduce && s.speed > 0) || activeCount > 0 || introLeft) wake();
      else last = 0;
    }

    function wake() {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    }

    function resize() {
      view.width = Math.max(1, container.clientWidth);
      view.height = Math.max(1, container.clientHeight);
      view.ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(view.width * view.ratio));
      canvas.height = Math.max(1, Math.round(view.height * view.ratio));
      const key = String(s.fontSize * view.ratio);
      if (key !== typeKey) {
        typeKey = key;
        buildType();
      }
      buildGrid();
      wake();
    }

    new ResizeObserver(resize).observe(container);
    document.addEventListener("visibilitychange", () => {
      last = 0;
      wake();
    });
    resize();
    return true;
  }

  window.HudBackgrounds = window.HudBackgrounds || {};
  window.HudBackgrounds["letter-glitch"] = { start };
})();
