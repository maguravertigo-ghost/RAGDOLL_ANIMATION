'use strict';

// ============================================================
//  scene.js — рендер SVG-сцены, Onion Skin, камера, сетка и выбор фона
// ============================================================

function partTransformFrom(p, tr) {
  const size = partSize(p);
  const px = p.pivot.x * size.w, py = p.pivot.y * size.h;
  const a = [];
  a.push('translate(' + tr.position.x + ' ' + tr.position.y + ')');
  if (tr.rotation) a.push('rotate(' + tr.rotation + ')');
  if (tr.scale.x !== 1 || tr.scale.y !== 1) a.push('scale(' + tr.scale.x + ' ' + tr.scale.y + ')');
  if (tr.skew.x) a.push('skewX(' + tr.skew.x + ')');
  if (tr.skew.y) a.push('skewY(' + tr.skew.y + ')');
  a.push('translate(' + (-px) + ' ' + (-py) + ')');
  return a.join(' ');
}

function partTransform(p) {
  return partTransformFrom(p, p.transform);
}

function computeClipOffset(forceRecompute) {
  if (!App.settings || !App.settings.parts.length) {
    App.clipOffset = { x: 0, y: 0 };
    els.scene.setAttribute('transform', 'translate(0 0)');
    if (els.onion) els.onion.setAttribute('transform', 'translate(0 0)');
    return;
  }

  const saved = App.settings.clip && App.settings.clip.offset;
  if (!forceRecompute && saved && isFinite(saved.x) && isFinite(saved.y)) {
    App.clipOffset = { x: saved.x, y: saved.y };
  } else {
    els.scene.setAttribute('transform', 'translate(0 0)');
    let bbox = null;
    try { bbox = els.scene.getBBox(); } catch (e) { bbox = null; }
    if (!bbox || !bbox.width || !bbox.height) {
      App.clipOffset = { x: 0, y: 0 };
    } else {
      const cp = (App.settings.clip && App.settings.clip.pivot) || { x: 0.5, y: 0.5 };
      const pivotX = bbox.x + cp.x * bbox.width;
      const pivotY = bbox.y + cp.y * bbox.height;
      App.clipOffset = { x: -pivotX, y: -pivotY };
    }
    if (!App.settings.clip) App.settings.clip = { pivot: { x: 0.5, y: 0.5 } };
    App.settings.clip.offset = clone(App.clipOffset);
  }

  const trStr = 'translate(' + App.clipOffset.x + ' ' + App.clipOffset.y + ')';
  els.scene.setAttribute('transform', trStr);
  if (els.onion) els.onion.setAttribute('transform', trStr);
}

function renderScene() {
  els.scene.innerHTML = '';
  App._partDomMap = {};
  App._onionPoolDirty = true;
  if (els.onion) els.onion.innerHTML = '';
  App._onionPool = [];

  if (!App.settings) return;
  const parts = App.settings.parts;
  const gMap = {};

  for (const p of parts) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-part-id', p.id);
    const hid = (p.visible === false);
    let cls = 'part';
    if (p.isGroup) cls += ' part-group';
    if (hid) cls += ' part-hidden';
    g.setAttribute('class', cls);
    g.setAttribute('transform', partTransform(p));
    g.style.display = hid ? 'none' : '';
    if (p.opacity !== undefined && p.opacity !== 1) {
      g.style.opacity = String(p.opacity);
    }

    if (!p.isGroup) {
      const svgEl = App.svgCache[p.file];
      if (svgEl) {
        const inner = (typeof cloneSvgForDom === 'function')
          ? cloneSvgForDom(svgEl)
          : document.importNode(svgEl, true);
        inner.setAttribute('class', 'part-inner');
        g.appendChild(inner);
      }
    }
    gMap[p.id] = g;
  }

  for (const p of parts) {
    const g = gMap[p.id];
    if (!g) continue;
    const parentEl = (p.parent && gMap[p.parent]) ? gMap[p.parent] : els.scene;
    parentEl.appendChild(g);
  }

  App._partDomMap = gMap;
}

// Быстрое обновление трансформаций и видимости без пересоздания SVG DOM (60 FPS)
function syncSceneTransforms() {
  if (!App.settings) return;
  const gMap = App._partDomMap;
  if (!gMap) {
    renderScene();
    return;
  }
  const parts = App.settings.parts;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const g = gMap[p.id];
    if (!g) {
      renderScene();
      return;
    }
    g.setAttribute('transform', partTransform(p));
    const hid = (p.visible === false);
    g.classList.toggle('part-hidden', hid);
    g.style.display = hid ? 'none' : '';
  }
}

function updatePartTransform(part) {
  const g = (App._partDomMap && App._partDomMap[part.id]) ||
            els.scene.querySelector('[data-part-id="' + part.id + '"]');
  if (g) {
    const hid = (part.visible === false);
    g.setAttribute('transform', partTransform(part));
    g.classList.toggle('part-hidden', hid);
    g.style.display = hid ? 'none' : '';
  }
  updateSelSize();
  if (App.anim.onion) renderOnionSkins();
  Gizmo.render();
}

function updateSelSize() {
  if (!els.selSize) return;
  if (!App.selectedId || !App.settings) {
    els.selSize.textContent = '---, ---';
    return;
  }
  const part = App.settings.parts.find(p => p.id === App.selectedId);
  if (!part) {
    els.selSize.textContent = '---, ---';
    return;
  }
  const sz = partSize(part);
  const w = sz.w * Math.abs(part.transform.scale.x);
  const h = sz.h * Math.abs(part.transform.scale.y);
  els.selSize.textContent = w.toFixed(1) + ', ' + h.toFixed(1);
}

// -------- Onion Skin (луковая кожура: 75% / 50% / 25% без пересоздания DOM) --------

const ONION_OPACITIES = [0.75, 0.50, 0.25];

function createOnionSlot() {
  const wrap = document.createElementNS(SVG_NS, 'g');
  wrap.setAttribute('class', 'part-ghost');
  wrap.style.display = 'none';

  const parts = App.settings ? App.settings.parts : [];
  const gMap = {};

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const g = document.createElementNS(SVG_NS, 'g');
    if (!p.isGroup) {
      const svgEl = App.svgCache[p.file];
      if (svgEl) {
        const inner = (typeof cloneSvgForDom === 'function')
          ? cloneSvgForDom(svgEl)
          : document.importNode(svgEl, true);
        g.appendChild(inner);
      }
    }
    gMap[p.id] = g;
  }

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const g = gMap[p.id];
    if (!g) continue;
    const parentEl = (p.parent && gMap[p.parent]) ? gMap[p.parent] : wrap;
    parentEl.appendChild(g);
  }

  return { wrap, gMap };
}

function ensureOnionPool(neededCount) {
  if (!els.onion || !App.settings) return;
  if (App._onionPoolDirty) {
    els.onion.innerHTML = '';
    App._onionPool = [];
    App._onionPoolDirty = false;
  }
  while (App._onionPool.length < neededCount) {
    const slot = createOnionSlot();
    els.onion.appendChild(slot.wrap);
    App._onionPool.push(slot);
  }
}

function hideAllOnionSlots() {
  if (!App._onionPool) return;
  for (let i = 0; i < App._onionPool.length; i++) {
    App._onionPool[i].wrap.style.display = 'none';
  }
}

function renderOnionSkins() {
  if (!els.onion) return;
  if (!App.anim.onion || !App.settings) {
    hideAllOnionSlots();
    return;
  }
  const a = getCurrentAnimation();
  if (!a) {
    hideAllOnionSlots();
    return;
  }

  const before = clamp(parseInt(App.anim.onionBefore, 10) || 0, 0, 3);
  const after  = clamp(parseInt(App.anim.onionAfter, 10) || 0, 0, 3);
  if (before === 0 && after === 0) {
    hideAllOnionSlots();
    return;
  }

  const fps = (App.settings && App.settings.fps) || 60;
  const dur = a.duration || 1;
  const totalFrames = Math.max(1, Math.round(dur * fps));
  if (totalFrames <= 1) {
    hideAllOnionSlots();
    return;
  }

  // Шаг между призрачными кадрами: для 60 FPS берём заметный интервал (до 5 кадров),
  // чтобы соседние позы не сливались в 0.05px за контуром персонажа
  const stepFrames = fps >= 30 ? Math.max(1, Math.min(5, Math.floor(totalFrames / 4))) : 1;
  const stepDt = stepFrames / fps;

  const cur = App.anim.playing ? App.anim.time : snapTime(App.anim.time);
  const lo = clamp(App.anim.loopStart || 0, 0, dur);
  const hi = clamp(Math.max(lo + 0.001, App.anim.loopEnd || dur), lo + 0.001, dur);
  const span = hi - lo;

  function resolveGhostTime(rawT) {
    if (App.anim.loop && span > stepDt * 0.5) {
      return lo + ((((rawT - lo) % span) + span) % span);
    }
    if (rawT < -1e-6 || rawT > dur + 1e-6) return null;
    return clamp(rawT, 0, dur);
  }

  // Собираем список призраков от самых дальних (25%) к ближайшим (75%)
  const ghosts = [];
  const maxK = Math.max(before, after);
  for (let k = maxK; k >= 1; k--) {
    const op = ONION_OPACITIES[k - 1] || 0.25;
    if (k <= before) {
      const tb = resolveGhostTime(cur - k * stepDt);
      if (tb !== null && Math.abs(tb - cur) > 1e-5) {
        ghosts.push({ time: tb, opacity: op });
      }
    }
    if (k <= after) {
      const ta = resolveGhostTime(cur + k * stepDt);
      if (ta !== null && Math.abs(ta - cur) > 1e-5) {
        ghosts.push({ time: ta, opacity: op });
      }
    }
  }

  ensureOnionPool(ghosts.length);
  const parts = App.settings.parts;

  for (let i = 0; i < ghosts.length; i++) {
    const gh = ghosts[i];
    const slot = App._onionPool[i];
    const pose = evaluatePoseAtTime(gh.time);
    if (!pose) {
      slot.wrap.style.display = 'none';
      continue;
    }
    slot.wrap.style.display = '';
    slot.wrap.style.opacity = String(gh.opacity);

    for (let j = 0; j < parts.length; j++) {
      const p = parts[j];
      const g = slot.gMap[p.id];
      const st = pose[p.id];
      if (!g || !st) continue;
      if (!st.visible) {
        g.style.display = 'none';
      } else {
        g.style.display = '';
        g.setAttribute('transform', partTransformFrom(p, st.transform));
      }
    }
  }

  for (let i = ghosts.length; i < App._onionPool.length; i++) {
    App._onionPool[i].wrap.style.display = 'none';
  }
}

// -------- камера и сетка --------

function applyCamera() {
  const vp = els.viewport;
  const W = vp.clientWidth, H = vp.clientHeight;
  const cx = W / 2, cy = H / 2;
  const z = App.camera.zoom;
  els.world.setAttribute(
    'transform',
    'translate(' + cx + ' ' + cy + ') scale(' + z + ') ' +
    'translate(' + (-App.camera.x) + ' ' + (-App.camera.y) + ')'
  );
  els.zoomLabel.textContent = Math.round(z * 100) + '%';
  rebuildGrid();
  Gizmo.render();
  if (!App.selectedId) renderProperties();
}

function screenToWorld(sx, sy) {
  const vp = els.viewport;
  const W = vp.clientWidth, H = vp.clientHeight;
  const cx = W / 2, cy = H / 2;
  const z = App.camera.zoom;
  return {
    x: (sx - cx) / z + App.camera.x,
    y: (sy - cy) / z + App.camera.y
  };
}

function fitView() {
  if (!App.settings) return;
  App.camera.x = 0;
  App.camera.y = 0;
  App.camera.zoom = 1;
  applyCamera();
  let bbox = null;
  try { bbox = els.scene.getBBox(); } catch (e) { bbox = null; }
  if (!bbox || !bbox.width || !bbox.height) return;
  const vp = els.viewport;
  const W = vp.clientWidth, H = vp.clientHeight;
  const pad = 60;
  const z = Math.min(
    Math.max(10, W - pad * 2) / bbox.width,
    Math.max(10, H - pad * 2) / bbox.height
  );
  App.camera.zoom = clamp(z, 0.05, 20);
  App.camera.x = bbox.x + bbox.width / 2 + App.clipOffset.x;
  App.camera.y = bbox.y + bbox.height / 2 + App.clipOffset.y;
  applyCamera();
}

function zoomBy(factor) {
  const vp = els.viewport;
  const cx = vp.clientWidth / 2, cy = vp.clientHeight / 2;
  const before = screenToWorld(cx, cy);
  App.camera.zoom = clamp(App.camera.zoom * factor, 0.05, 20);
  const after = screenToWorld(cx, cy);
  App.camera.x += before.x - after.x;
  App.camera.y += before.y - after.y;
  applyCamera();
}

function rebuildGrid() {
  els.grid.innerHTML = '';
  const vp = els.viewport;
  const W = vp.clientWidth, H = vp.clientHeight;
  if (!W || !H) return;
  const z = App.camera.zoom;
  const wl = screenToWorld(0, 0).x, wt = screenToWorld(0, 0).y;
  const wr = screenToWorld(W, H).x, wb = screenToWorld(W, H).y;
  const target = 80, raw = target / z;
  const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  let step = nice[0];
  for (const n of nice) {
    if (n <= raw * 1.5) step = n;
    else break;
  }
  const x0 = Math.floor(wl / step) * step, x1 = Math.ceil(wr / step) * step;
  const y0 = Math.floor(wt / step) * step, y1 = Math.ceil(wb / step) * step;
  const frag = document.createDocumentFragment();
  for (let x = x0; x <= x1 + 1e-6; x += step) {
    const l = document.createElementNS(SVG_NS, 'line');
    l.setAttribute('x1', x); l.setAttribute('y1', y0);
    l.setAttribute('x2', x); l.setAttribute('y2', y1);
    l.setAttribute('class', 'grid-line' + (Math.abs(x) < 1e-6 ? ' grid-axis' : ''));
    l.setAttribute('vector-effect', 'non-scaling-stroke');
    frag.appendChild(l);
  }
  for (let y = y0; y <= y1 + 1e-6; y += step) {
    const l = document.createElementNS(SVG_NS, 'line');
    l.setAttribute('x1', x0); l.setAttribute('y1', y);
    l.setAttribute('x2', x1); l.setAttribute('y2', y);
    l.setAttribute('class', 'grid-line' + (Math.abs(y) < 1e-6 ? ' grid-axis' : ''));
    l.setAttribute('vector-effect', 'non-scaling-stroke');
    frag.appendChild(l);
  }
  els.grid.appendChild(frag);
}

// -------- фон окна просмотра --------

function applyBackgroundToViewport() {
  const bg = (App.settings && App.settings.frame && App.settings.frame.background) || 'grid';
  els.viewport.classList.toggle('bg-checker', bg === 'checkerboard');
  if (bg === 'checkerboard' || bg === 'grid') els.viewport.style.background = '';
  else els.viewport.style.background = bg;
}

const BG = { hue: 0, sat: 0, val: 0.08, hex: '#1a1c20', dragSV: false, dragHue: false };

function hsvToRgb(h, s, v) {
  h = h / 360;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const v = max, d = max - min;
  const s = max === 0 ? 0 : d / max;
  let h;
  if (d === 0) h = 0;
  else if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, v };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => {
    const s = clamp(Math.round(x), 0, 255).toString(16);
    return s.length === 1 ? '0' + s : s;
  }).join('');
}

function hexToRgb(hex) {
  hex = (hex || '').trim().replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length !== 6) return null;
  const n = parseInt(hex, 16);
  if (!isFinite(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function updateBgCursor() {
  const rect = els.bgSv.getBoundingClientRect();
  els.bgCursor.style.left = (BG.sat * rect.width) + 'px';
  els.bgCursor.style.top  = ((1 - BG.val) * rect.height) + 'px';
  const hrect = els.bgHue.getBoundingClientRect();
  els.bgHueCursor.style.top = ((BG.hue / 360) * hrect.height) + 'px';
  const { r, g, b } = hsvToRgb(BG.hue, BG.sat, BG.val);
  BG.hex = rgbToHex(r, g, b);
  els.bgSv.style.background =
    'linear-gradient(to top, #000, transparent),' +
    'linear-gradient(to right, #fff, hsl(' + BG.hue + ',100%,50%))';
}

function updateBgInputs() { els.bgHex.value = BG.hex; }

function setBgFromHex(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  BG.hue = hsv.h; BG.sat = hsv.s; BG.val = hsv.v;
  BG.hex = rgbToHex(rgb.r, rgb.g, rgb.b);
  updateBgCursor();
  updateBgInputs();
  return true;
}

function openBgModal() {
  if (!App.settings) { setHint('Откройте объект', 2000); return; }
  els.modalBg.hidden = false;
  const cur = (App.settings.frame && App.settings.frame.background) || 'grid';
  requestAnimationFrame(() => {
    if (cur === 'checkerboard' || cur === 'grid') setBgFromHex('#1a1c20');
    else if (!setBgFromHex(cur)) setBgFromHex('#1a1c20');
    renderBgPresets();
  });
}

function closeBgModal() { els.modalBg.hidden = true; }

function renderBgPresets() {
  const cur = (App.settings.frame && App.settings.frame.background) || 'grid';
  const presets = [
    { id: 'black',   color: '#000000' },
    { id: 'white',   color: '#ffffff' },
    { id: 'gray',    color: '#1a1c20', isGrid: true },
    { id: 'checker', checker: true },
    { id: 'custom',  custom: true, color: BG.hex }
  ];
  els.bgPresets.innerHTML = '';
  for (const p of presets) {
    const b = document.createElement('button');
    b.className = 'bg-preset';
    b.dataset.preset = p.id;
    if (p.checker) b.setAttribute('data-preset', 'checker');
    else b.style.background = p.color;
    if (p.id === 'gray' && (cur === 'grid' || cur === '#1a1c20')) b.classList.add('selected');
    if (p.id === 'black' && cur === '#000000') b.classList.add('selected');
    if (p.id === 'white' && cur === '#ffffff') b.classList.add('selected');
    if (p.id === 'checker' && cur === 'checkerboard') b.classList.add('selected');
    b.onclick = () => {
      if (p.checker) {
        App.settings.frame.background = 'checkerboard';
        applyBackgroundToViewport();
        closeBgModal();
      } else if (p.custom) {
        // остаёмся в палитре для выбора кастомного цвета
      } else {
        App.settings.frame.background = p.isGrid ? 'grid' : p.color;
        applyBackgroundToViewport();
        closeBgModal();
      }
    };
    els.bgPresets.appendChild(b);
  }
}

function setupBgPicker() {
  function svAt(clientX, clientY) {
    const r = els.bgSv.getBoundingClientRect();
    BG.sat = clamp((clientX - r.left) / r.width, 0, 1);
    BG.val = 1 - clamp((clientY - r.top) / r.height, 0, 1);
    const { r: rr, g: gg, b: bb } = hsvToRgb(BG.hue, BG.sat, BG.val);
    BG.hex = rgbToHex(rr, gg, bb);
    updateBgCursor();
    updateBgInputs();
  }
  function hueAt(clientY) {
    const r = els.bgHue.getBoundingClientRect();
    BG.hue = 360 * clamp((clientY - r.top) / r.height, 0, 1);
    const { r: rr, g: gg, b: bb } = hsvToRgb(BG.hue, BG.sat, BG.val);
    BG.hex = rgbToHex(rr, gg, bb);
    updateBgCursor();
    updateBgInputs();
  }
  els.bgSv.addEventListener('mousedown', (e) => { BG.dragSV = true; svAt(e.clientX, e.clientY); });
  els.bgHue.addEventListener('mousedown', (e) => { BG.dragHue = true; hueAt(e.clientY); });
  window.addEventListener('mousemove', (e) => {
    if (BG.dragSV) svAt(e.clientX, e.clientY);
    if (BG.dragHue) hueAt(e.clientY);
  });
  window.addEventListener('mouseup', () => { BG.dragSV = false; BG.dragHue = false; });

  els.bgHex.addEventListener('input', () => {
    const v = els.bgHex.value.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(v) || /^#?[0-9a-fA-F]{3}$/.test(v)) setBgFromHex(v);
  });
  els.bgHex.addEventListener('blur', () => {
    const v = els.bgHex.value.trim();
    if (!setBgFromHex(v)) { setBgFromHex('#1a1c20'); updateBgInputs(); }
  });
  els.bgCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(BG.hex);
      setHint('Скопировано: ' + BG.hex, 1200);
    } catch (e) { setHint('Не удалось скопировать', 1500); }
  });
  els.bgPaste.addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (setBgFromHex(t)) setHint('Вставлено: ' + BG.hex, 1200);
      else setHint('В буфере не hex', 1500);
    } catch (e) { setHint('Нет доступа к буферу', 1500); }
  });
  els.bgOk.addEventListener('click', () => {
    App.settings.frame.background = BG.hex;
    applyBackgroundToViewport();
    closeBgModal();
  });
  els.bgCancel.addEventListener('click', closeBgModal);
  els.bgClose.addEventListener('click', closeBgModal);
  els.modalBg.addEventListener('mousedown', (e) => {
    if (e.target === els.modalBg) closeBgModal();
  });
}

// -------- ввод окна просмотра --------

function setupSceneInput() {
  const vp = els.viewport;
  vp.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const rect = vp.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const before = screenToWorld(sx, sy);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    App.camera.zoom = clamp(App.camera.zoom * factor, 0.05, 20);
    const after = screenToWorld(sx, sy);
    App.camera.x += before.x - after.x;
    App.camera.y += before.y - after.y;
    applyCamera();
  }, { passive: false });

  vp.addEventListener('mousedown', (e) => {
    if (App.spaceDown || e.button === 1) {
      App.panning = true;
      App.panStart = { sx: e.clientX, sy: e.clientY, cx: App.camera.x, cy: App.camera.y };
      vp.classList.add('panning');
      e.preventDefault();
      return;
    }
    if (e.button === 0) {
      if (e.target.closest && e.target.closest('#gizmo-svg')) return;
      const partEl = e.target.closest && e.target.closest('[data-part-id]:not(.part-hidden)');
      const id = partEl ? partEl.getAttribute('data-part-id') : null;
      if (id && (e.ctrlKey || e.metaKey)) toggleSelection(id);
      else setSelected(id);
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!App.panning) return;
    const dx = e.clientX - App.panStart.sx, dy = e.clientY - App.panStart.sy;
    App.camera.x = App.panStart.cx - dx / App.camera.zoom;
    App.camera.y = App.panStart.cy - dy / App.camera.zoom;
    applyCamera();
  });

  window.addEventListener('mouseup', () => {
    if (App.panning) {
      App.panning = false;
      vp.classList.remove('panning');
    }
  });
}
