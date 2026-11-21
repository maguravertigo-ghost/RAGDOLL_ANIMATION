'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';
const $  = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const TL = {
  CELL_W: 12,   // px на один кадр
  ROW_H: 22,
  SUB_ROW_H: 20,
};

const App = {
  current:    null,
  settings:   null,
  svgCache:   {},
  selectedId: null,
  selectedIds: new Set(),
  camera:     { x: 0, y: 0, zoom: 1 },
  clipOffset: { x: 0, y: 0 },
  spaceDown:  false,
  panning:    false,
  panStart:   null,
  onChange:   null,
  _dragLayerId: null,
  _animSelectedName: null,
  _propsCollapsed: false,
  anim: {
    time: 0,
    playing: false,
    raf: null,
    lastTs: 0,
    loop: true,
    loopStart: 0,
    loopEnd: 1,
    onion: false,
    focus: null,
    selectedKey: null,
    expanded: new Set(),
  },
};

const els = {};
function cacheEls() {
  els.svg          = $('#scene-svg');
  els.world        = $('#world');
  els.grid         = $('#grid');
  els.scene        = $('#scene');
  els.viewport     = $('#viewport');
  els.zoomLabel    = $('#zoom-label');
  els.objName      = $('#obj-name');
  els.animName     = $('#anim-name');
  els.layersList   = $('#layers-list');
  els.hint         = $('#hint');
  els.modalObjects = $('#modal-objects');
  els.objectsList  = $('#objects-list');
  els.btnObjects   = $('#btn-objects');
  els.btnSave      = $('#btn-save');
  els.btnSettings  = $('#btn-settings');
  els.btnAnim      = $('#btn-anim');
  els.btnGroup     = $('#btn-group');
  els.btnUngroup   = $('#btn-ungroup');
  els.propsTitle   = $('#props-title');
  els.props        = $('#props');
  els.btnPropsCollapse = $('#btn-props-collapse');
  els.propsCollapseIcon = $('#props-collapse-icon');
  els.modalRename  = $('#modal-rename');
  els.renameTitle  = $('#rename-title');
  els.renameInput  = $('#rename-input');
  els.renameOk     = $('#rename-ok');
  els.renameCancel = $('#rename-cancel');
  els.modalAnims   = $('#modal-anims');
  els.animsList    = $('#anims-list');
  els.modalAnimsClose = $('#modal-anims-close');
  els.animAdd      = $('#anim-add');
  els.animRename   = $('#anim-rename');
  els.animDelete   = $('#anim-delete');
  els.animOk       = $('#anim-ok');
  els.modalBg      = $('#modal-bg');
  els.bgPresets    = $('#bg-presets');
  els.bgSv         = $('#bg-sv');
  els.bgCursor     = $('#bg-cursor');
  els.bgHue        = $('#bg-picker').querySelector('.bg-hue');
  els.bgHueCursor  = $('#bg-hue-cursor');
  els.bgHex        = $('#bg-hex');
  els.bgCopy       = $('#bg-copy');
  els.bgPaste      = $('#bg-paste');
  els.bgOk         = $('#bg-ok');
  els.bgCancel     = $('#bg-cancel');
  els.bgClose      = $('#bg-close');
  els.pbFirst      = $('#pb-first');
  els.pbPrev       = $('#pb-prev');
  els.pbPlay       = $('#pb-play');
  els.pbStop       = $('#pb-stop');
  els.pbNext       = $('#pb-next');
  els.pbLast       = $('#pb-last');
  els.pbKeyAdd     = $('#pb-key-add');
  els.pbKeyDel     = $('#pb-key-del');
  els.pbLoop       = $('#pb-loop');
  els.pbOnion      = $('#pb-onion');
  els.pbLoopStart  = $('#pb-loop-set-start');
  els.pbLoopEnd    = $('#pb-loop-set-end');
  els.pbDuration   = $('#pb-duration');
  els.tcLoopStart  = $('#tc-loop-start');
  els.tcCurrent    = $('#tc-current');
  els.tcLoopEnd    = $('#tc-loop-end');
  els.btnBg        = $('#btn-bg');
  els.tlRuler      = $('#tl-ruler');
  els.tlRulerPlayhead = $('#tl-ruler-playhead');
  els.tlNamesInner = $('#tl-names-inner');
  els.tlTracks     = $('#tl-tracks');
  els.tlTracksInner= $('#tl-tracks-inner');
  els.tlPlayheadLine = $('#tl-playhead-line');
}
App.els = els;

let hintTimer = null;
function setHint(text, ms) {
  els.hint.textContent = text || '';
  els.hint.classList.toggle('visible', !!text);
  if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
  if (text && ms) hintTimer = setTimeout(() => setHint(''), ms);
}

// -------- утилиты --------

function getSvgSize(svgEl) {
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const m = vb.trim().split(/[\s,]+/).map(parseFloat);
    if (m.length === 4 && m[2] > 0 && m[3] > 0) return { w: m[2], h: m[3] };
  }
  const w = parseFloat(svgEl.getAttribute('width'));
  const h = parseFloat(svgEl.getAttribute('height'));
  if (isFinite(w) && isFinite(h) && w > 0 && h > 0) return { w, h };
  return { w: 100, h: 100 };
}
App.getSvgSize = getSvgSize;

function partSize(part) {
  if (part.isGroup) return part.size || { w: 100, h: 100 };
  const svgEl = App.svgCache[part.file];
  return svgEl ? getSvgSize(svgEl) : { w: 100, h: 100 };
}
App.partSize = partSize;

function uniqueId(prefix) {
  return (prefix || 'g') + '_' + Date.now().toString(36) + '_' +
         Math.random().toString(36).slice(2, 6);
}
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const min = Math.floor(t / 60);
  const sec = Math.floor(t % 60);
  const ms  = Math.floor((t * 1000) % 1000);
  return String(min).padStart(2,'0') + ':' +
         String(sec).padStart(2,'0') + ':' +
         String(ms).padStart(3,'0');
}

// -------- matrices --------

function matrixFromPart(part, size) {
  const m = new DOMMatrix();
  const t = part.transform;
  m.translateSelf(t.position.x, t.position.y);
  if (t.rotation) m.rotateSelf(t.rotation);
  if (t.scale.x !== 1 || t.scale.y !== 1) m.scaleSelf(t.scale.x, t.scale.y);
  if (t.skew.x) m.skewXSelf(t.skew.x);
  if (t.skew.y) m.skewYSelf(t.skew.y);
  if (part.pivot.x || part.pivot.y) {
    m.translateSelf(-part.pivot.x * size.w, -part.pivot.y * size.h);
  }
  return m;
}
function transformFromMatrix(m) {
  const a = m.a, b = m.b, c = m.c, d = m.d, e = m.e, f = m.f;
  const a2 = a * a + b * b;
  if (a2 < 1e-12) {
    return { position: { x: e, y: f }, rotation: 0,
             scale: { x: 0, y: Math.sqrt(c * c + d * d) }, skew: { x: 0, y: 0 } };
  }
  const sx = Math.sqrt(a2);
  const theta = Math.atan2(b, a);
  const sinT = Math.sin(theta), cosT = Math.cos(theta);
  const sy = cosT * d - sinT * c;
  const tK = (sinT * d + cosT * c) / sx;
  const kx = Math.atan(tK) * 180 / Math.PI;
  return { position: { x: e, y: f }, rotation: theta * 180 / Math.PI,
           scale: { x: sx, y: sy }, skew: { x: kx, y: 0 } };
}
function worldMatrixOf(part, byId) {
  const size = partSize(part);
  const m = matrixFromPart(part, size);
  if (part.parent && byId[part.parent]) {
    return worldMatrixOf(byId[part.parent], byId).multiply(m);
  }
  return m;
}
function partBBoxInParent(part) {
  const size = partSize(part);
  const m = matrixFromPart(part, size);
  const pts = [{x:0,y:0},{x:size.w,y:0},{x:size.w,y:size.h},{x:0,y:size.h}];
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const p of pts) {
    const q = new DOMPoint(p.x, p.y).matrixTransform(m);
    if (q.x < minX) minX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.x > maxX) maxX = q.x;
    if (q.y > maxY) maxY = q.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// -------- загрузка --------

async function fetchObjects() {
  const r = await fetch('/api/objects'); if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function fetchObjectData(name) {
  const r = await fetch('/api/object/' + encodeURIComponent(name));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function fetchSvg(name, file) {
  const url = 'anim/' + encodeURIComponent(name) + '/' + encodeURIComponent(file);
  const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + file);
  const text = await r.text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('SVG parse error: ' + file);
  const root = doc.documentElement;
  const vb = root.getAttribute('viewBox');
  if (vb) {
    const m = vb.trim().split(/[\s,]+/).map(parseFloat);
    if (m.length === 4 && m[2] > 0 && m[3] > 0) {
      root.setAttribute('width', m[2]);
      root.setAttribute('height', m[3]);
    }
  } else {
    const w = parseFloat(root.getAttribute('width'));
    const h = parseFloat(root.getAttribute('height'));
    if (!isFinite(w) || w <= 0) root.setAttribute('width', 100);
    if (!isFinite(h) || h <= 0) root.setAttribute('height', 100);
  }
  return root;
}

async function openObject(name) {
  try {
    setHint('Загрузка ' + name + '…');
    stopPlayback();
    const data = await fetchObjectData(name);
    App.current    = name;
    App.settings   = data.settings;
    App.svgCache   = {};
    App.selectedId = null;
    App.selectedIds = new Set();
    Gizmo.setMode(1);

    if (!App.settings.animations || !App.settings.animations.length) {
      App.settings.animations = [{ name: 'idle', duration: 1, loop: true, tracks: [] }];
    }
    if (!App.settings.frame) App.settings.frame = { width: 512, height: 512, background: 'grid' };
    if (!App.settings.clip) App.settings.clip = { pivot: { x: 0.5, y: 0.5 } };

    for (const p of App.settings.parts) {
      p._baseTransform = clone(p.transform);
    }
    for (const p of App.settings.parts) {
      if (p.isGroup || !p.file) continue;
      try { App.svgCache[p.file] = await fetchSvg(name, p.file); }
      catch (e) { console.warn('Не загрузился', p.file, e); }
    }

    els.objName.value  = name;
    App._animSelectedName = App.settings.animations[0].name;
    const a = getCurrentAnimation();
    App.anim.time = 0;
    App.anim.loopStart = 0;
    App.anim.loopEnd = a.duration || 1;
    App.anim.loop = a.loop !== false;
    App.anim.focus = null;
    App.anim.selectedKey = null;
    App.anim.expanded = new Set();

    applyAnimationAtTime(0);
    renderScene();
    computeClipOffset();
    renderLayers();
    renderProperties();
    renderTimeline();
    updatePlaybackUI();
    applyBackgroundToViewport();
    fitView();
    Gizmo.render();
    setHint('Объект "' + name + '": частей ' + App.settings.parts.length, 2500);
  } catch (e) {
    setHint('Ошибка: ' + e.message, 4000);
  }
}

// -------- сохранение --------

async function saveObject() {
  if (!App.current || !App.settings) { setHint('Нечего сохранять', 2000); return; }
  try {
    const out = clone(App.settings);
    for (const p of out.parts) {
      if (p._baseTransform) { p.transform = p._baseTransform; delete p._baseTransform; }
    }
    const r = await fetch('/api/object/' + encodeURIComponent(App.current) + '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(out)
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    setHint('Сохранено: anim/' + App.current + '/settings.json', 1800);
  } catch (e) { setHint('Ошибка сохранения: ' + e.message, 3000); }
}

// -------- animation model --------

function getCurrentAnimation() {
  if (!App.settings || !App.settings.animations) return null;
  return App.settings.animations.find(a => a.name === App._animSelectedName)
      || App.settings.animations[0] || null;
}
function getTrack(partId, property) {
  const a = getCurrentAnimation(); if (!a) return null;
  return a.tracks.find(t => t.partId === partId && t.property === property);
}
function ensureTrack(partId, property) {
  const a = getCurrentAnimation(); if (!a) return null;
  let t = getTrack(partId, property);
  if (!t) { t = { partId, property, keys: [] }; a.tracks.push(t); }
  return t;
}
function removeTrack(partId, property) {
  const a = getCurrentAnimation(); if (!a) return;
  const i = a.tracks.findIndex(t => t.partId === partId && t.property === property);
  if (i >= 0) a.tracks.splice(i, 1);
}
function interpolateValue(a, b, k) {
  if (typeof a === 'number') return a + (b - a) * k;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}
function sampleTrack(track, time) {
  const keys = track.keys;
  if (!keys.length) return null;
  if (time <= keys[0].time) return clone(keys[0].value);
  if (time >= keys[keys.length-1].time) return clone(keys[keys.length-1].value);
  for (let i = 0; i < keys.length - 1; i++) {
    if (keys[i].time <= time && time <= keys[i+1].time) {
      const span = keys[i+1].time - keys[i].time;
      const k = span > 0 ? (time - keys[i].time) / span : 0;
      return interpolateValue(keys[i].value, keys[i+1].value, k);
    }
  }
  return clone(keys[0].value);
}
function ensureBase(part) {
  if (!part._baseTransform) part._baseTransform = clone(part.transform);
}
function applyAnimationAtTime(time) {
  const a = getCurrentAnimation(); if (!a) return;
  for (const p of App.settings.parts) {
    ensureBase(p);
    const base = p._baseTransform;
    const tr = { position: clone(base.position), rotation: base.rotation,
                 scale: clone(base.scale), skew: clone(base.skew) };
    let has = false;
    for (const prop of ['position', 'rotation', 'scale', 'skew']) {
      const t = a.tracks.find(x => x.partId === p.id && x.property === prop);
      if (!t || !t.keys.length) continue;
      has = true;
      const v = sampleTrack(t, time);
      if (v != null) tr[prop] = v;
    }
    p.transform = has ? tr : clone(base);
  }
}

// -------- clip offset --------

function computeClipOffset() {
  if (!App.settings || !App.settings.parts.length) {
    App.clipOffset = { x: 0, y: 0 };
    els.scene.setAttribute('transform', 'translate(0 0)'); return;
  }
  els.scene.setAttribute('transform', 'translate(0 0)');
  let bbox = null;
  try { bbox = els.scene.getBBox(); } catch (e) { bbox = null; }
  if (!bbox || !bbox.width || !bbox.height) { App.clipOffset = { x: 0, y: 0 }; return; }
  const cp = (App.settings.clip && App.settings.clip.pivot) || { x: 0.5, y: 0.5 };
  const pivotX = bbox.x + cp.x * bbox.width;
  const pivotY = bbox.y + cp.y * bbox.height;
  App.clipOffset = { x: -pivotX, y: -pivotY };
  els.scene.setAttribute('transform',
    'translate(' + App.clipOffset.x + ' ' + App.clipOffset.y + ')');
}

// -------- сцена --------

function partTransform(p) {
  const size = partSize(p);
  const px = p.pivot.x * size.w, py = p.pivot.y * size.h;
  const t = p.transform;
  const a = [];
  a.push('translate(' + t.position.x + ' ' + t.position.y + ')');
  if (t.rotation) a.push('rotate(' + t.rotation + ')');
  if (t.scale.x !== 1 || t.scale.y !== 1) a.push('scale(' + t.scale.x + ' ' + t.scale.y + ')');
  if (t.skew.x) a.push('skewX(' + t.skew.x + ')');
  if (t.skew.y) a.push('skewY(' + t.skew.y + ')');
  a.push('translate(' + (-px) + ' ' + (-py) + ')');
  return a.join(' ');
}
function renderScene() {
  els.scene.innerHTML = '';
  if (!App.settings) return;
  const parts = App.settings.parts;
  const gMap = {};
  for (const p of parts) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-part-id', p.id);
    g.setAttribute('class', 'part' + (p.isGroup ? ' part-group' : ''));
    g.setAttribute('transform', partTransform(p));
    if (!p.isGroup) {
      const svgEl = App.svgCache[p.file];
      if (svgEl) {
        const inner = document.importNode(svgEl, true);
        inner.setAttribute('class', 'part-inner');
        g.appendChild(inner);
      }
    }
    gMap[p.id] = g;
  }
  for (const p of parts) {
    const g = gMap[p.id]; if (!g) continue;
    const parentEl = (p.parent && gMap[p.parent]) ? gMap[p.parent] : els.scene;
    parentEl.appendChild(g);
  }
}
function updatePartTransform(part) {
  const g = els.scene.querySelector('[data-part-id="' + part.id + '"]');
  if (g) g.setAttribute('transform', partTransform(part));
  Gizmo.render();
}

// -------- камера --------

function applyCamera() {
  const vp = els.viewport;
  const W = vp.clientWidth, H = vp.clientHeight;
  const cx = W / 2, cy = H / 2;
  const z = App.camera.zoom;
  els.world.setAttribute('transform',
    'translate(' + cx + ' ' + cy + ') scale(' + z + ') ' +
    'translate(' + (-App.camera.x) + ' ' + (-App.camera.y) + ')');
  els.zoomLabel.textContent = Math.round(z * 100) + '%';
  rebuildGrid();
  Gizmo.render();
  renderProperties();
}
function screenToWorld(sx, sy) {
  const vp = els.viewport;
  const W = vp.clientWidth, H = vp.clientHeight;
  const cx = W / 2, cy = H / 2;
  const z = App.camera.zoom;
  return { x: (sx - cx) / z + App.camera.x, y: (sy - cy) / z + App.camera.y };
}
function fitView() {
  if (!App.settings) return;
  App.camera.x = 0; App.camera.y = 0; App.camera.zoom = 1;
  applyCamera();
  const bbox = els.scene.getBBox();
  if (!bbox.width || !bbox.height) return;
  const vp = els.viewport;
  const W = vp.clientWidth, H = vp.clientHeight;
  const pad = 60;
  const z = Math.min((W - pad*2) / bbox.width, (H - pad*2) / bbox.height);
  App.camera.zoom = Math.max(0.05, Math.min(20, z));
  App.camera.x = bbox.x + bbox.width / 2 + App.clipOffset.x;
  App.camera.y = bbox.y + bbox.height / 2 + App.clipOffset.y;
  applyCamera();
}
function zoomBy(factor) {
  const vp = els.viewport;
  const cx = vp.clientWidth / 2, cy = vp.clientHeight / 2;
  const before = screenToWorld(cx, cy);
  App.camera.zoom = Math.max(0.05, Math.min(20, App.camera.zoom * factor));
  const after = screenToWorld(cx, cy);
  App.camera.x += before.x - after.x;
  App.camera.y += before.y - after.y;
  applyCamera();
}

// -------- сетка сцены --------

function rebuildGrid() {
  els.grid.innerHTML = '';
  const vp = els.viewport;
  const W = vp.clientWidth, H = vp.clientHeight;
  const z = App.camera.zoom;
  const wl = screenToWorld(0, 0).x, wt = screenToWorld(0, 0).y;
  const wr = screenToWorld(W, H).x, wb = screenToWorld(W, H).y;
  const target = 80, raw = target / z;
  const nice = [1,2,5,10,20,25,50,100,200,250,500,1000,2000,5000];
  let step = nice[0];
  for (const n of nice) { if (n <= raw * 1.5) step = n; else break; }
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

// -------- слои --------

function buildChildrenIndex() {
  const parts = App.settings ? App.settings.parts : [];
  const byId = {}; for (const p of parts) byId[p.id] = p;
  const childrenOf = {}; const roots = [];
  for (const p of parts) {
    if (p.parent && byId[p.parent]) (childrenOf[p.parent] = childrenOf[p.parent] || []).push(p);
    else roots.push(p);
  }
  return { byId, childrenOf, roots };
}

function renderLayers() {
  els.layersList.innerHTML = '';
  if (!App.settings) return;
  const { childrenOf, roots } = buildChildrenIndex();
  function renderOne(p, depth, container) {
    const li = document.createElement('li');
    li.dataset.id = p.id;
    li.className = 'layer depth-' + Math.min(depth, 6) + (p.isGroup ? ' group' : '');
    li.draggable = true;
    const iconName = p.isGroup ? 'folder' : 'crop_square';
    li.innerHTML = '<span class="material-icons layer-icon">' + iconName + '</span>' +
                   '<span class="layer-name"></span>';
    li.querySelector('.layer-name').textContent = p.id;
    if (App.selectedIds.has(p.id)) li.classList.add('selected');
    attachLayerEvents(li, p);
    container.appendChild(li);
    for (const c of (childrenOf[p.id] || [])) renderOne(c, depth + 1, container);
  }
  for (const r of roots) renderOne(r, 0, els.layersList);
}

function attachLayerEvents(li, p) {
  li.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) toggleSelection(p.id);
    else if (e.shiftKey && App.selectedId) rangeSelect(p.id);
    else setSelection([p.id], p.id);
  });
  li.addEventListener('dblclick', (e) => {
    e.stopPropagation(); e.preventDefault();
    promptText('Переименовать слой', p.id, (newName) => renamePart(p.id, newName));
  });
  li.addEventListener('dragstart', (e) => {
    App._dragLayerId = p.id; li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', p.id); } catch (_) {}
  });
  li.addEventListener('dragend', () => {
    App._dragLayerId = null; li.classList.remove('dragging');
    els.layersList.querySelectorAll('li').forEach(x =>
      x.classList.remove('drop-before','drop-after','drop-into'));
  });
  li.addEventListener('dragover', (e) => {
    const dragged = App._dragLayerId;
    if (!dragged || dragged === p.id) return;
    if (isDescendantOf(p.id, dragged)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    els.layersList.querySelectorAll('li').forEach(x =>
      x.classList.remove('drop-before','drop-after','drop-into'));
    const rect = li.getBoundingClientRect();
    const y = e.clientY - rect.top, h = rect.height;
    if (y < h * 0.25) li.classList.add('drop-before');
    else if (y > h * 0.75) li.classList.add('drop-after');
    else li.classList.add('drop-into');
  });
  li.addEventListener('dragleave', () => {
    li.classList.remove('drop-before','drop-after','drop-into');
  });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    const dragged = App._dragLayerId;
    if (!dragged || dragged === p.id) return;
    let mode = 'into';
    if (li.classList.contains('drop-before')) mode = 'before';
    else if (li.classList.contains('drop-after')) mode = 'after';
    els.layersList.querySelectorAll('li').forEach(x =>
      x.classList.remove('drop-before','drop-after','drop-into'));
    movePartTo(dragged, p.id, mode);
  });
}

function setSelection(ids, primaryId) {
  App.selectedIds = new Set(ids);
  App.selectedId = primaryId || (ids.length ? ids[0] : null);
  els.layersList.querySelectorAll('li').forEach(li => {
    li.classList.toggle('selected', App.selectedIds.has(li.dataset.id));
  });
  if (!App.selectedId) Gizmo.setMode(1);
  Gizmo.render();
  renderProperties();
  renderTimeline();
}
function toggleSelection(id) {
  const s = new Set(App.selectedIds);
  if (s.has(id)) s.delete(id); else s.add(id);
  setSelection(Array.from(s), id);
}
function rangeSelect(id) {
  const all = Array.from(els.layersList.querySelectorAll('li')).map(x => x.dataset.id);
  const a = all.indexOf(App.selectedId), b = all.indexOf(id);
  if (a < 0 || b < 0) { setSelection([id], id); return; }
  setSelection(all.slice(Math.min(a,b), Math.max(a,b)+1), id);
}
function setSelected(id) { setSelection(id ? [id] : [], id); }

// -------- структура --------

function isDescendantOf(childId, ancestorId) {
  if (childId === ancestorId) return true;
  const byId = {}; for (const p of App.settings.parts) byId[p.id] = p;
  let cur = byId[childId];
  while (cur && cur.parent) {
    if (cur.parent === ancestorId) return true;
    cur = byId[cur.parent];
  }
  return false;
}
function reparentPart(part, newParentId) {
  const oldParentId = part.parent || null;
  if ((newParentId || null) === oldParentId) return;
  const byId = {}; for (const p of App.settings.parts) byId[p.id] = p;
  const oldWorld = worldMatrixOf(part, byId);
  part.parent = newParentId;
  const newParent = newParentId ? byId[newParentId] : null;
  const newParentWorld = newParent ? worldMatrixOf(newParent, byId) : new DOMMatrix();
  const newLocal = newParentWorld.inverse().multiply(oldWorld);
  const size = partSize(part);
  const pivPx = { x: part.pivot.x * size.w, y: part.pivot.y * size.h };
  const N = newLocal.translate(pivPx.x, pivPx.y);
  part.transform = transformFromMatrix(N);
  part._baseTransform = clone(part.transform);
}
function movePartTo(partId, targetId, mode) {
  const parts = App.settings.parts;
  const part = parts.find(p => p.id === partId);
  const target = parts.find(p => p.id === targetId);
  if (!part || !target || part.id === target.id) return;
  if (isDescendantOf(target.id, part.id)) return;
  let newParentId;
  if (mode === 'into') newParentId = target.id;
  else newParentId = target.parent || null;
  reparentPart(part, newParentId);
  const pi = parts.indexOf(part); parts.splice(pi, 1);
  const ti = parts.indexOf(target);
  if (mode === 'before') parts.splice(ti, 0, part);
  else if (mode === 'after') parts.splice(ti + 1, 0, part);
  else parts.push(part);
  refreshAfterStructureChange();
}
function groupSelected() {
  const ids = Array.from(App.selectedIds);
  if (!ids.length) { setHint('Выберите слои для группы', 2000); return; }
  const parts = App.settings.parts;
  const byId = {}; for (const p of parts) byId[p.id] = p;
  const children = ids.map(id => byId[id]).filter(Boolean);
  if (!children.length) return;
  const parentId = children[0].parent || null;
  if (!children.every(c => (c.parent || null) === parentId)) {
    setHint('Группировать можно только слои с одним родителем', 2500); return;
  }
  let bbox = null;
  for (const c of children) {
    const cb = partBBoxInParent(c);
    if (!bbox) bbox = { ...cb };
    else {
      const x1 = Math.min(bbox.x, cb.x), y1 = Math.min(bbox.y, cb.y);
      const x2 = Math.max(bbox.x + bbox.w, cb.x + cb.w);
      const y2 = Math.max(bbox.y + bbox.h, cb.y + cb.h);
      bbox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
  }
  if (!bbox || !isFinite(bbox.w) || bbox.w <= 0) bbox = { x: 0, y: 0, w: 100, h: 100 };
  if (!isFinite(bbox.h) || bbox.h <= 0) bbox.h = 100;
  const gid = uniqueId('group');
  const group = {
    id: gid, isGroup: true, parent: parentId,
    size: { w: bbox.w, h: bbox.h },
    pivot: { x: 0.5, y: 0.5 },
    transform: {
      position: { x: bbox.x + bbox.w/2, y: bbox.y + bbox.h/2 },
      rotation: 0, scale: { x: 1, y: 1 }, skew: { x: 0, y: 0 }
    },
    visible: true, opacity: 1
  };
  group._baseTransform = clone(group.transform);
  for (const c of children) {
    c.parent = gid;
    c.transform.position.x -= bbox.x;
    c.transform.position.y -= bbox.y;
    if (c._baseTransform) {
      c._baseTransform.position.x -= bbox.x;
      c._baseTransform.position.y -= bbox.y;
    }
  }
  let maxIdx = 0;
  for (const c of children) { const i = parts.indexOf(c); if (i > maxIdx) maxIdx = i; }
  parts.splice(maxIdx, 0, group);
  setSelection([gid], gid);
  refreshAfterStructureChange();
  setHint('Создана группа ' + gid, 1800);
}
function ungroupSelected() {
  const id = App.selectedId;
  if (!id) { setHint('Выберите группу', 2000); return; }
  const parts = App.settings.parts;
  const byId = {}; for (const p of parts) byId[p.id] = p;
  const g = byId[id];
  if (!g || !g.isGroup) { setHint('Выбранный слой не является группой', 2000); return; }
  const children = parts.filter(p => p.parent === g.id);
  if (children.length) {
    const groupMat = matrixFromPart(g, g.size || { w: 100, h: 100 });
    for (const c of children) {
      const cSize = partSize(c);
      const cMat = matrixFromPart(c, cSize);
      const M = groupMat.multiply(cMat);
      const pivPx = { x: c.pivot.x * cSize.w, y: c.pivot.y * cSize.h };
      const N = M.translate(pivPx.x, pivPx.y);
      c.transform = transformFromMatrix(N);
      c._baseTransform = clone(c.transform);
      c.parent = g.parent;
    }
  }
  const i = parts.indexOf(g); if (i >= 0) parts.splice(i, 1);
  setSelection(children.map(c => c.id), children[0] ? children[0].id : null);
  refreshAfterStructureChange();
  setHint('Разгруппировано', 1500);
}
function renamePart(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  if (App.settings.parts.some(p => p.id === newId)) {
    setHint('Слой с таким именем уже есть', 2000); return;
  }
  for (const p of App.settings.parts) {
    if (p.id === oldId) p.id = newId;
    if (p.parent === oldId) p.parent = newId;
  }
  for (const a of App.settings.animations || []) {
    for (const t of a.tracks || []) if (t.partId === oldId) t.partId = newId;
  }
  if (App.selectedIds.has(oldId)) { App.selectedIds.delete(oldId); App.selectedIds.add(newId); }
  if (App.selectedId === oldId) App.selectedId = newId;
  if (App.anim.focus && App.anim.focus.partId === oldId) App.anim.focus.partId = newId;
  refreshAfterStructureChange();
  setHint('Переименовано: ' + oldId + ' → ' + newId, 1500);
}
function refreshAfterStructureChange() {
  renderScene(); renderLayers(); renderTimeline();
  Gizmo.render(); renderProperties();
}

// -------- свойства --------

function renderProperties() {
  const props = els.props;
  if (!App.selectedId || !App.settings) {
    els.propsTitle.textContent = 'Свойства';
    const vp = els.viewport;
    const tl = screenToWorld(0, 0);
    props.innerHTML =
      '<div class="h">Размер фрэйма, px</div>' +
      '<div class="row"><span class="val">' + vp.clientWidth + ' × ' + vp.clientHeight + '</span></div>' +
      '<div class="h">Масштаб</div>' +
      '<div class="row"><span class="val">' + Math.round(App.camera.zoom * 100) + '%</span></div>' +
      '<div class="h">Левый верхний угол</div>' +
      '<div class="row"><span class="val">X ' + tl.x.toFixed(1) + '</span>' +
      '<span class="val">Y ' + tl.y.toFixed(1) + '</span></div>';
    return;
  }
  const part = App.settings.parts.find(p => p.id === App.selectedId);
  if (!part) return;
  els.propsTitle.textContent = (part.isGroup ? 'Группа: ' : 'Слой: ') + part.id;
  const t = part.transform;
  const RESET = {
    'pos.x':0,'pos.y':0,'rot':0,
    'scl.x':1,'scl.y':1,
    'skw.x':0,'skw.y':0,
    'piv.x':0.5,'piv.y':0.5
  };
  function row(label, key, value, step) {
    return '<div class="prow">' +
        '<span class="plabel">' + label + '</span>' +
        '<div class="pinput-wrap">' +
          '<input type="number" data-key="' + key + '" step="' + (step || 0.1) +
            '" value="' + (+value).toFixed(3) + '">' +
          '<div class="pspin">' +
            '<button type="button" data-spin="up" data-key="' + key + '" tabindex="-1">' +
              '<span class="material-icons">expand_less</span></button>' +
            '<button type="button" data-spin="down" data-key="' + key + '" tabindex="-1">' +
              '<span class="material-icons">expand_more</span></button>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="preset" data-reset="' + key + '" title="Сбросить">' +
          '<span class="material-icons">restart_alt</span></button>' +
      '</div>';
  }
  props.innerHTML =
    '<div class="pgroup"><div class="pgroup-title">Позиция</div>' +
      row('X','pos.x',t.position.x,0.5) + row('Y','pos.y',t.position.y,0.5) + '</div>' +
    '<div class="pgroup"><div class="pgroup-title">Поворот, °</div>' +
      row('R','rot',t.rotation,1) + '</div>' +
    '<div class="pgroup"><div class="pgroup-title">Масштаб</div>' +
      row('X','scl.x',t.scale.x,0.01) + row('Y','scl.y',t.scale.y,0.01) + '</div>' +
    '<div class="pgroup"><div class="pgroup-title">Скос, °</div>' +
      row('X','skw.x',t.skew.x,1) + row('Y','skw.y',t.skew.y,1) + '</div>' +
    '<div class="pgroup"><div class="pgroup-title">Pivot (0..1)</div>' +
      row('X','piv.x',part.pivot.x,0.01) + row('Y','piv.y',part.pivot.y,0.01) + '</div>';

  function getValue(key) {
    if (key === 'pos.x') return t.position.x;
    if (key === 'pos.y') return t.position.y;
    if (key === 'rot')   return t.rotation;
    if (key === 'scl.x') return t.scale.x;
    if (key === 'scl.y') return t.scale.y;
    if (key === 'skw.x') return t.skew.x;
    if (key === 'skw.y') return t.skew.y;
    if (key === 'piv.x') return part.pivot.x;
    if (key === 'piv.y') return part.pivot.y;
    return 0;
  }
  function setValue(key, v) {
    if (key === 'pos.x') t.position.x = v;
    else if (key === 'pos.y') t.position.y = v;
    else if (key === 'rot')   t.rotation   = v;
    else if (key === 'scl.x') t.scale.x    = v;
    else if (key === 'scl.y') t.scale.y    = v;
    else if (key === 'skw.x') t.skew.x     = v;
    else if (key === 'skw.y') t.skew.y     = v;
    else if (key === 'piv.x') part.pivot.x = v;
    else if (key === 'piv.y') part.pivot.y = v;
    updatePartTransform(part);
  }
  props.querySelectorAll('input[type="number"]').forEach(inp => {
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value); if (isFinite(v)) setValue(inp.dataset.key, v);
    });
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value); if (isFinite(v)) setValue(inp.dataset.key, v);
    });
  });
  props.querySelectorAll('[data-spin]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      const dir = btn.dataset.spin === 'up' ? 1 : -1;
      const inp = props.querySelector('input[data-key="' + key + '"]');
      const step = parseFloat(inp.step) || 0.1;
      const v = getValue(key) + dir * step;
      setValue(key, v);
      inp.value = (+v).toFixed(3);
    });
  });
  props.querySelectorAll('[data-reset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.reset;
      const v = RESET[key]; setValue(key, v);
      const inp = props.querySelector('input[data-key="' + key + '"]');
      if (inp) inp.value = (+v).toFixed(3);
    });
  });
}
function syncPropertyInputs() {
  if (!App.selectedId || !App.settings) return;
  const part = App.settings.parts.find(p => p.id === App.selectedId);
  if (!part) return;
  const t = part.transform;
  const vals = {
    'pos.x': t.position.x, 'pos.y': t.position.y,
    'rot': t.rotation,
    'scl.x': t.scale.x, 'scl.y': t.scale.y,
    'skw.x': t.skew.x, 'skw.y': t.skew.y,
    'piv.x': part.pivot.x, 'piv.y': part.pivot.y
  };
  els.props.querySelectorAll('input[type="number"]').forEach(inp => {
    if (document.activeElement === inp) return;
    const key = inp.dataset.key;
    if (!(key in vals)) return;
    const s = (+vals[key]).toFixed(3);
    if (inp.value !== s) inp.value = s;
  });
}
function togglePropsCollapse() {
  App._propsCollapsed = !App._propsCollapsed;
  els.props.classList.toggle('collapsed', App._propsCollapsed);
  els.propsCollapseIcon.textContent = App._propsCollapsed ? 'expand_less' : 'expand_more';
}

// -------- timeline helpers --------

function totalFrames() {
  const a = getCurrentAnimation(); if (!a) return 1;
  const fps = (App.settings && App.settings.fps) || 60;
  return Math.max(1, Math.round((a.duration || 1) * fps));
}
function totalWidth() { return totalFrames() * TL.CELL_W; }
function timeToX(time) {
  const fps = (App.settings && App.settings.fps) || 60;
  return time * fps * TL.CELL_W;
}
function xToTime(x) {
  const fps = (App.settings && App.settings.fps) || 60;
  return x / (fps * TL.CELL_W);
}
function snapTime(t) {
  const fps = (App.settings && App.settings.fps) || 60;
  return Math.round(t * fps) / fps;
}

// -------- timeline render --------

function renderTimeline() {
  const a = getCurrentAnimation();
  if (!a) {
    els.tlRuler.innerHTML = '';
    els.tlRuler.appendChild(els.tlRulerPlayhead);
    els.tlNamesInner.innerHTML = '';
    els.tlTracksInner.innerHTML = '';
    els.tlTracksInner.appendChild(els.tlPlayheadLine);
    return;
  }
  const frames = totalFrames();
  const w = totalWidth();

  // ruler
  els.tlRuler.innerHTML = '';
  els.tlRuler.style.width = w + 'px';
  for (let f = 0; f <= frames; f++) {
    const x = f * TL.CELL_W;
    const el = document.createElement('div');
    const isMajor = (f % 10 === 0);
    el.className = 'tl-mark' + (isMajor ? ' major' : '');
    el.style.left = x + 'px';
    if (isMajor) el.textContent = String(f);
    els.tlRuler.appendChild(el);
  }
  els.tlRuler.appendChild(els.tlRulerPlayhead);

  // names + tracks
  const parts = App.settings.parts;
  const byId = {}; for (const p of parts) byId[p.id] = p;
  const childrenOf = {}; const roots = [];
  for (const p of parts) {
    if (p.parent && byId[p.parent]) (childrenOf[p.parent] = childrenOf[p.parent] || []).push(p);
    else roots.push(p);
  }
  const PROPS = [
    { key: 'position', label: 'position' },
    { key: 'rotation', label: 'rotation' },
    { key: 'scale',    label: 'scale'    },
    { key: 'skew',     label: 'skew'     },
  ];

  els.tlNamesInner.innerHTML = '';
  els.tlTracksInner.innerHTML = '';
  els.tlTracksInner.appendChild(els.tlPlayheadLine);

  function addRow(part, isSub, property) {
    const expanded = !isSub && App.anim.expanded.has(part.id);

    // names
    const nameDiv = document.createElement('div');
    nameDiv.className = 'tl-row-name' + (isSub ? ' sub' : '');
    if (!isSub) {
      nameDiv.innerHTML =
        '<button class="tl-row-expand" type="button" tabindex="-1">' +
        '<span class="material-icons">' + (expanded ? 'expand_more' : 'chevron_right') + '</span>' +
        '</button>' +
        '<span class="tl-row-label"></span>';
      nameDiv.querySelector('.tl-row-label').textContent = part.id;
    } else {
      nameDiv.textContent = property;
    }
    if (isSub && App.anim.focus &&
        App.anim.focus.partId === part.id &&
        App.anim.focus.property === property) {
      nameDiv.classList.add('focused');
    }
    if (!isSub && App.selectedIds.has(part.id)) nameDiv.classList.add('focused');
    nameDiv.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!isSub && e.target.closest('.tl-row-expand')) {
        if (App.anim.expanded.has(part.id)) App.anim.expanded.delete(part.id);
        else App.anim.expanded.add(part.id);
        renderTimeline();
        return;
      }
      if (isSub) {
        App.anim.focus = { partId: part.id, property };
        renderTimeline();
      } else {
        setSelection([part.id], part.id);
      }
    });
    els.tlNamesInner.appendChild(nameDiv);

    // tracks
    const trackDiv = document.createElement('div');
    trackDiv.className = 'tl-row-track' + (isSub ? ' sub' : '');
    if (isSub && App.anim.focus &&
        App.anim.focus.partId === part.id &&
        App.anim.focus.property === property) {
      trackDiv.classList.add('focused');
    }
    trackDiv.style.width = w + 'px';
    if (isSub) {
      const track = getTrack(part.id, property);
      if (track) {
        for (const k of track.keys) {
          const x = timeToX(k.time);
          const d = document.createElement('div');
          d.className = 'tl-key';
          d.style.left = x + 'px';
          if (App.anim.selectedKey &&
              App.anim.selectedKey.partId === part.id &&
              App.anim.selectedKey.property === property &&
              Math.abs(App.anim.selectedKey.time - k.time) < 1e-6) {
            d.classList.add('selected');
          }
          d.addEventListener('mousedown', (e) => {
            e.stopPropagation(); e.preventDefault();
            App.anim.selectedKey = { partId: part.id, property, time: k.time };
            App.anim.focus = { partId: part.id, property };
            setTime(k.time);
            renderTimeline();
          });
          d.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const i = track.keys.findIndex(xx => Math.abs(xx.time - k.time) < 1e-6);
            if (i >= 0) track.keys.splice(i, 1);
            App.anim.selectedKey = null;
            applyAnimationAtTime(App.anim.time);
            renderScene();
            renderTimeline();
          });
          trackDiv.appendChild(d);
        }
      }
    }
    els.tlTracksInner.appendChild(trackDiv);
  }

  function walk(part) {
    addRow(part, false, null);
    if (App.anim.expanded.has(part.id)) {
      for (const pr of PROPS) addRow(part, true, pr.key);
    }
    for (const c of (childrenOf[part.id] || [])) walk(c);
  }
  for (const r of roots) walk(r);

  updatePlayhead();
  updateTimecode();
  updatePlaybackUI();
  updateDurationField();
  handleTimelineScroll();
}

function handleTimelineScroll() {
  const sl = els.tlTracks.scrollLeft;
  const st = els.tlTracks.scrollTop;
  els.tlRuler.style.transform = 'translateX(' + (-sl) + 'px)';
  els.tlNamesInner.style.transform = 'translateY(' + (-st) + 'px)';
}

function updatePlayhead() {
  const x = timeToX(App.anim.time);
  els.tlPlayheadLine.style.left = x + 'px';
  els.tlRulerPlayhead.style.left = x + 'px';
  if (App.anim.playing) scrollPlayheadIntoView();
}
function scrollPlayheadIntoView() {
  const tracks = els.tlTracks;
  const x = timeToX(App.anim.time);
  const left = tracks.scrollLeft;
  const right = left + tracks.clientWidth;
  const m = 60;
  if (x < left + m) tracks.scrollLeft = Math.max(0, x - m);
  else if (x > right - m) tracks.scrollLeft = x - tracks.clientWidth + m;
}
function updateTimecode() {
  els.tcLoopStart.textContent = fmtTime(App.anim.loopStart);
  els.tcCurrent.textContent   = fmtTime(App.anim.time);
  els.tcLoopEnd.textContent   = fmtTime(App.anim.loopEnd);
}
function updateDurationField() {
  const a = getCurrentAnimation(); if (!a) return;
  if (document.activeElement === els.pbDuration) return;
  els.pbDuration.value = (a.duration || 1).toFixed(2);
}

function setTime(t) {
  const a = getCurrentAnimation(); if (!a) return;
  const dur = a.duration || 1;
  if (t < 0) t = 0;
  if (t > dur) t = dur;
  App.anim.time = t;
  applyAnimationAtTime(t);
  renderScene();
  updatePlayhead();
  updateTimecode();
  Gizmo.render();
  syncPropertyInputs();
}

// -------- playback --------

function updatePlaybackUI() {
  els.pbPlay.querySelector('.material-icons').textContent =
    App.anim.playing ? 'pause' : 'play_arrow';
  els.pbLoop.classList.toggle('active', App.anim.loop);
  els.pbOnion.classList.toggle('active', App.anim.onion);
}
function startPlayback() {
  if (App.anim.playing) return;
  const a = getCurrentAnimation(); if (!a) return;
  App.anim.playing = true;
  App.anim.lastTs = performance.now();
  updatePlaybackUI();
  App.anim.raf = requestAnimationFrame(playbackTick);
}
function stopPlayback() {
  if (!App.anim.playing) return;
  App.anim.playing = false;
  if (App.anim.raf) cancelAnimationFrame(App.anim.raf);
  App.anim.raf = null;
  updatePlaybackUI();
}
function playbackTick(ts) {
  if (!App.anim.playing) return;
  const a = getCurrentAnimation(); if (!a) { stopPlayback(); return; }
  const dur = a.duration || 1;
  const dt = (ts - App.anim.lastTs) / 1000;
  App.anim.lastTs = ts;

  let t = App.anim.time + dt;
  const lo = App.anim.loopStart || 0;
  const hi = Math.max(lo + 0.001, App.anim.loopEnd || dur);
  if (App.anim.loop) {
    if (t > hi) t = lo + ((t - lo) % (hi - lo));
  } else if (t > dur) {
    t = dur; stopPlayback();
  }
  App.anim.time = t;
  applyAnimationAtTime(t);
  renderScene();
  updatePlayhead();
  updateTimecode();
  Gizmo.render();
  syncPropertyInputs();
  App.anim.raf = requestAnimationFrame(playbackTick);
}

function stepFrame(dir) {
  const fps = (App.settings && App.settings.fps) || 60;
  const a = getCurrentAnimation(); if (!a) return;
  const dt = 1 / fps;
  let t = snapTime(App.anim.time) + dir * dt;
  if (t < 0) t = 0;
  if (t > (a.duration || 1)) t = (a.duration || 1);
  setTime(t);
}

// -------- keys --------

function addTrackForFocus() {
  const part = App.settings.parts.find(p => p.id === App.selectedId);
  if (!part) { setHint('Выберите слой', 2000); return; }
  for (const prop of ['position', 'rotation', 'scale', 'skew']) ensureTrack(part.id, prop);
  App.anim.expanded.add(part.id);
  App.anim.focus = { partId: part.id, property: 'rotation' };
  renderTimeline();
  setHint('Дорожки для "' + part.id + '" созданы', 1500);
}
function removeTrackForFocus() {
  if (!App.anim.focus) { setHint('Выберите дорожку', 2000); return; }
  const { partId, property } = App.anim.focus;
  removeTrack(partId, property);
  App.anim.focus = null;
  App.anim.selectedKey = null;
  applyAnimationAtTime(App.anim.time);
  renderScene();
  renderTimeline();
}
function addKeyframeAtFocus() {
  if (!App.anim.focus) { setHint('Выберите дорожку', 2000); return; }
  const { partId, property } = App.anim.focus;
  const part = App.settings.parts.find(p => p.id === partId);
  if (!part) return;
  const tr = ensureTrack(partId, property);
  const time = snapTime(App.anim.time);
  let value;
  if (property === 'position') value = clone(part.transform.position);
  else if (property === 'rotation') value = part.transform.rotation;
  else if (property === 'scale') value = clone(part.transform.scale);
  else if (property === 'skew') value = clone(part.transform.skew);
  const existing = tr.keys.find(k => Math.abs(k.time - time) < 1e-6);
  if (existing) existing.value = value;
  else tr.keys.push({ time, value });
  tr.keys.sort((a, b) => a.time - b.time);
  App.anim.selectedKey = { partId, property, time };
  renderTimeline();
  setHint('Кадр: ' + property + ' @ ' + fmtTime(time), 1200);
}
function deleteSelectedKeyframe() {
  if (!App.anim.selectedKey) { setHint('Выберите кадр', 2000); return; }
  const { partId, property, time } = App.anim.selectedKey;
  const tr = getTrack(partId, property); if (!tr) return;
  const i = tr.keys.findIndex(k => Math.abs(k.time - time) < 1e-6);
  if (i >= 0) tr.keys.splice(i, 1);
  App.anim.selectedKey = null;
  applyAnimationAtTime(App.anim.time);
  renderScene();
  renderTimeline();
  setHint('Кадр удалён', 1200);
}

// -------- timeline input --------

function setupTimelineScroll() {
  els.tlTracks.addEventListener('scroll', handleTimelineScroll, { passive: true });
}

function setupTimelineInput() {
  let dragging = false;
  function scrubTo(clientX) {
    const a = getCurrentAnimation(); if (!a) return;
    const rect = els.tlTracks.getBoundingClientRect();
    const x = clientX - rect.left + els.tlTracks.scrollLeft;
    const t = xToTime(x);
    setTime(snapTime(clamp(t, 0, a.duration || 1)));
  }
  els.tlRuler.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    scrubTo(e.clientX);
  });
  window.addEventListener('mousemove', (e) => { if (dragging) scrubTo(e.clientX); });
  window.addEventListener('mouseup', () => { dragging = false; });

  els.tlTracks.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft')  { e.preventDefault(); stepFrame(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepFrame(+1); }
    else if (e.key === 'Home')  { e.preventDefault(); setTime(0); }
    else if (e.key === 'End')   {
      e.preventDefault();
      const a = getCurrentAnimation();
      if (a) setTime(a.duration || 1);
    }
  });
}

// -------- фон --------

function applyBackgroundToViewport() {
  const bg = (App.settings && App.settings.frame && App.settings.frame.background) || 'grid';
  els.viewport.classList.toggle('bg-checker', bg === 'checkerboard');
  if (bg === 'checkerboard') els.viewport.style.background = '';
  else els.viewport.style.background = bg;
}
const BG = { hue: 0, sat: 0, val: 0.08, hex: '#1a1c20', dragSV: false, dragHue: false };

function hsvToRgb(h, s, v) {
  h = h / 360;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r=v; g=t; b=p; break;
    case 1: r=q; g=v; b=p; break;
    case 2: r=p; g=v; b=t; break;
    case 3: r=p; g=q; b=v; break;
    case 4: r=t; g=p; b=v; break;
    case 5: r=v; g=p; b=q; break;
  }
  return { r: Math.round(r*255), g: Math.round(g*255), b: Math.round(b*255) };
}
function rgbToHsv(r, g, b) {
  r/=255; g/=255; b/=255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  const v = max, d = max - min;
  const s = max === 0 ? 0 : d / max;
  let h;
  if (d === 0) h = 0;
  else if (max === r) h = ((g-b)/d) % 6;
  else if (max === g) h = (b-r)/d + 2;
  else h = (r-g)/d + 4;
  h *= 60; if (h < 0) h += 360;
  return { h, s, v };
}
function rgbToHex(r, g, b) {
  return '#' + [r,g,b].map(x => {
    const s = Math.max(0, Math.min(255, Math.round(x))).toString(16);
    return s.length === 1 ? '0' + s : s;
  }).join('');
}
function hexToRgb(hex) {
  hex = (hex || '').trim().replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length !== 6) return null;
  const n = parseInt(hex, 16);
  if (!isFinite(n)) return null;
  return { r: (n>>16)&255, g: (n>>8)&255, b: n&255 };
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
  const rgb = hexToRgb(hex); if (!rgb) return false;
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  BG.hue = hsv.h; BG.sat = hsv.s; BG.val = hsv.v;
  BG.hex = rgbToHex(rgb.r, rgb.g, rgb.b);
  updateBgCursor(); updateBgInputs();
  return true;
}
function openBgModal() {
  if (!App.settings) { setHint('Откройте объект', 2000); return; }
  const cur = (App.settings.frame && App.settings.frame.background) || 'grid';
  if (cur === 'checkerboard' || cur === 'grid') setBgFromHex('#1a1c20');
  else setBgFromHex(cur) || setBgFromHex('#1a1c20');
  renderBgPresets();
  els.modalBg.hidden = false;
}
function closeBgModal() { els.modalBg.hidden = true; }
function renderBgPresets() {
  const cur = (App.settings.frame && App.settings.frame.background) || 'grid';
  const presets = [
    { id: 'black',   color: '#000000' },
    { id: 'white',   color: '#ffffff' },
    { id: 'gray',    color: '#1a1c20' },
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
    if (p.id === 'gray' && cur === 'grid') b.classList.add('selected');
    if (p.id === 'black' && cur === '#000000') b.classList.add('selected');
    if (p.id === 'white' && cur === '#ffffff') b.classList.add('selected');
    if (p.id === 'checker' && cur === 'checkerboard') b.classList.add('selected');
    b.onclick = () => {
      if (p.checker) {
        App.settings.frame.background = 'checkerboard';
        applyBackgroundToViewport(); closeBgModal();
      } else if (p.custom) {
        // остаёмся в пикере
      } else {
        App.settings.frame.background = p.color;
        applyBackgroundToViewport(); closeBgModal();
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
    updateBgCursor(); updateBgInputs();
  }
  function hueAt(clientY) {
    const r = els.bgHue.getBoundingClientRect();
    BG.hue = 360 * clamp((clientY - r.top) / r.height, 0, 1);
    const { r: rr, g: gg, b: bb } = hsvToRgb(BG.hue, BG.sat, BG.val);
    BG.hex = rgbToHex(rr, gg, bb);
    updateBgCursor(); updateBgInputs();
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
    if (!setBgFromHex(v)) { setBgFromHex('#000000'); updateBgInputs(); }
  });
  els.bgCopy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(BG.hex); setHint('Скопировано: ' + BG.hex, 1200); }
    catch (e) { setHint('Не удалось скопировать', 1500); }
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
    applyBackgroundToViewport(); closeBgModal();
  });
  els.bgCancel.addEventListener('click', closeBgModal);
  els.bgClose.addEventListener('click', closeBgModal);
  els.modalBg.addEventListener('mousedown', (e) => {
    if (e.target === els.modalBg) closeBgModal();
  });
}

// -------- модалки --------

function promptText(title, initial, cb) {
  els.renameTitle.textContent = title;
  els.renameInput.value = initial || '';
  els.modalRename.hidden = false;
  setTimeout(() => { els.renameInput.focus(); els.renameInput.select(); }, 0);
  function cleanup() {
    els.modalRename.hidden = true;
    els.renameOk.removeEventListener('click', onOk);
    els.renameCancel.removeEventListener('click', onCancel);
    els.renameInput.removeEventListener('keydown', onKey);
    els.modalRename.removeEventListener('mousedown', onBg);
  }
  function onOk() { const v = els.renameInput.value.trim(); cleanup(); if (v) cb(v); }
  function onCancel() { cleanup(); }
  function onKey(e) {
    if (e.key === 'Enter')  { e.preventDefault(); onOk(); }
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  }
  function onBg(e) { if (e.target === els.modalRename) onCancel(); }
  els.renameOk.addEventListener('click', onOk);
  els.renameCancel.addEventListener('click', onCancel);
  els.renameInput.addEventListener('keydown', onKey);
  els.modalRename.addEventListener('mousedown', onBg);
}

function openAnimsModal() {
  if (!App.settings) { setHint('Сначала откройте объект', 2000); return; }
  if (!App.settings.animations || !App.settings.animations.length) {
    App.settings.animations = [{ name: 'idle', duration: 1, loop: true, tracks: [] }];
  }
  App._animSelectedName = getCurrentAnimation().name;
  renderAnimsList();
  els.modalAnims.hidden = false;
}
function closeAnimsModal() { els.modalAnims.hidden = true; }
function renderAnimsList() {
  els.animsList.innerHTML = '';
  for (const a of (App.settings.animations || [])) {
    const li = document.createElement('li');
    li.textContent = a.name;
    if (a.name === App._animSelectedName) li.classList.add('selected');
    li.onclick = () => { App._animSelectedName = a.name; renderAnimsList(); };
    li.ondblclick = () => renameAnimation();
    els.animsList.appendChild(li);
  }
}
function selectAnimation(name) {
  App._animSelectedName = name;
  const a = getCurrentAnimation();
  App.anim.time = 0;
  App.anim.loopStart = 0;
  App.anim.loopEnd = a.duration || 1;
  App.anim.loop = a.loop !== false;
  App.anim.focus = null;
  App.anim.selectedKey = null;
  els.animName.value = name;
  applyAnimationAtTime(0);
  renderScene();
  renderTimeline();
  Gizmo.render();
}
function createAnimation() {
  promptText('Новая анимация', 'anim', (name) => {
    if (!name) return;
    if (App.settings.animations.some(a => a.name === name)) {
      setHint('Анимация с таким именем уже есть', 2000); return;
    }
    App.settings.animations.push({ name, duration: 1, loop: true, tracks: [] });
    App._animSelectedName = name;
    renderAnimsList();
  });
}
function deleteAnimation() {
  if (!App._animSelectedName) { setHint('Выберите анимацию', 2000); return; }
  if (App.settings.animations.length <= 1) {
    setHint('Нельзя удалить единственную анимацию', 2000); return;
  }
  const i = App.settings.animations.findIndex(a => a.name === App._animSelectedName);
  if (i < 0) return;
  App.settings.animations.splice(i, 1);
  App._animSelectedName = App.settings.animations[0].name;
  renderAnimsList();
}
function renameAnimation() {
  if (!App._animSelectedName) { setHint('Выберите анимацию', 2000); return; }
  const a = App.settings.animations.find(x => x.name === App._animSelectedName);
  if (!a) return;
  promptText('Переименовать анимацию', a.name, (name) => {
    if (!name || name === a.name) return;
    if (App.settings.animations.some(x => x.name === name)) {
      setHint('Анимация с таким именем уже есть', 2000); return;
    }
    a.name = name; App._animSelectedName = name;
    if (els.animName.value !== name) els.animName.value = name;
    renderAnimsList();
  });
}

// -------- ввод сцены --------

function setupInput() {
  const vp = els.viewport;
  vp.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const rect = vp.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const before = screenToWorld(sx, sy);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    App.camera.zoom = Math.max(0.05, Math.min(20, App.camera.zoom * factor));
    const after = screenToWorld(sx, sy);
    App.camera.x += before.x - after.x;
    App.camera.y += before.y - after.y;
    applyCamera();
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    const ae = document.activeElement;
    const inField = ae && /input|textarea/i.test(ae.tagName);
    if (e.code === 'Space' && !inField) {
      if (!App.spaceDown) { App.spaceDown = true; vp.classList.add('space'); }
      e.preventDefault();
    }
    if (e.key === 'Escape') {
      if (!els.modalObjects.hidden) closeObjectsModal();
      if (!els.modalAnims.hidden) closeAnimsModal();
      if (!els.modalBg.hidden) closeBgModal();
    }
    if (e.key === '0' && e.ctrlKey) { e.preventDefault(); fitView(); }
    if ((e.key === 's' || e.key === 'ы') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); saveObject();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      App.spaceDown = false; App.panning = false;
      vp.classList.remove('space'); vp.classList.remove('panning');
    }
  });

  vp.addEventListener('mousedown', (e) => {
    if (App.spaceDown || e.button === 1) {
      App.panning = true;
      App.panStart = { sx: e.clientX, sy: e.clientY, cx: App.camera.x, cy: App.camera.y };
      vp.classList.add('panning');
      e.preventDefault(); return;
    }
    if (e.button === 0) {
      if (e.target.closest && e.target.closest('#gizmo-svg')) return;
      const partEl = e.target.closest && e.target.closest('[data-part-id]');
      setSelected(partEl ? partEl.getAttribute('data-part-id') : null);
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
    if (App.panning) { App.panning = false; vp.classList.remove('panning'); }
  });
  window.addEventListener('resize', () => { applyCamera(); renderTimeline(); });
}

// -------- модалка объектов --------

async function openObjectsModal() {
  try {
    const list = await fetchObjects();
    els.objectsList.innerHTML = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'empty'; li.textContent = 'В папке anim/ пока нет объектов';
      els.objectsList.appendChild(li);
    } else {
      for (const name of list) {
        const li = document.createElement('li');
        li.textContent = name;
        li.onclick = () => { closeObjectsModal(); openObject(name); };
        els.objectsList.appendChild(li);
      }
    }
    els.modalObjects.hidden = false;
  } catch (e) { setHint('Не удалось получить список: ' + e.message, 4000); }
}
function closeObjectsModal() { els.modalObjects.hidden = true; }

// -------- старт --------

function updateModeButtons(mode) {
  $$('.mode-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.mode, 10) === mode);
  });
}

function init() {
  cacheEls();
  setupInput();
  setupTimelineScroll();
  setupTimelineInput();
  setupBgPicker();
  App.syncProperties = syncPropertyInputs;

  Gizmo.init(App);
  Gizmo.setOnModeChange(updateModeButtons);
  updateModeButtons(Gizmo.mode);

  renderProperties();
  renderTimeline();

  els.btnObjects.addEventListener('click', openObjectsModal);
  els.modalObjects.addEventListener('click', (e) => {
    if (e.target === els.modalObjects) closeObjectsModal();
  });
  $('#modal-objects-close').addEventListener('click', closeObjectsModal);

  els.btnGroup.addEventListener('click', groupSelected);
  els.btnUngroup.addEventListener('click', ungroupSelected);
  els.btnPropsCollapse.addEventListener('click', togglePropsCollapse);
  els.btnSave.addEventListener('click', saveObject);
  els.btnSettings.addEventListener('click', () => setHint('Настройки — на следующем шаге', 2000));
  els.btnAnim.addEventListener('click', openAnimsModal);
  els.btnBg.addEventListener('click', openBgModal);

  els.modalAnimsClose.addEventListener('click', closeAnimsModal);
  els.modalAnims.addEventListener('click', (e) => {
    if (e.target === els.modalAnims) closeAnimsModal();
  });
  els.animAdd.addEventListener('click', createAnimation);
  els.animRename.addEventListener('click', renameAnimation);
  els.animDelete.addEventListener('click', deleteAnimation);
  els.animOk.addEventListener('click', () => {
    const a = App.settings && App.settings.animations.find(x => x.name === App._animSelectedName);
    if (a) selectAnimation(a.name);
    closeAnimsModal();
  });

  els.pbFirst.addEventListener('click', () => { stopPlayback(); setTime(0); });
  els.pbLast .addEventListener('click', () => {
    stopPlayback();
    const a = getCurrentAnimation(); if (a) setTime(a.duration || 1);
  });
  els.pbPrev .addEventListener('click', () => { stopPlayback(); stepFrame(-1); });
  els.pbNext .addEventListener('click', () => { stopPlayback(); stepFrame(+1); });
  els.pbPlay .addEventListener('click', () => { App.anim.playing ? stopPlayback() : startPlayback(); });
  els.pbStop .addEventListener('click', () => { stopPlayback(); setTime(0); });

  els.pbKeyAdd.addEventListener('click', addKeyframeAtFocus);
  els.pbKeyDel.addEventListener('click', deleteSelectedKeyframe);
  els.pbLoop.addEventListener('click', () => {
    App.anim.loop = !App.anim.loop;
    const a = getCurrentAnimation(); if (a) a.loop = App.anim.loop;
    updatePlaybackUI();
  });
  els.pbOnion.addEventListener('click', () => {
    App.anim.onion = !App.anim.onion;
    updatePlaybackUI();
    setHint('Onion skin: ' + (App.anim.onion ? 'on' : 'off'), 1500);
  });
  els.pbLoopStart.addEventListener('click', () => {
    App.anim.loopStart = App.anim.time;
    if (App.anim.loopEnd < App.anim.loopStart) App.anim.loopEnd = App.anim.loopStart + 0.001;
    updateTimecode();
  });
  els.pbLoopEnd.addEventListener('click', () => {
    App.anim.loopEnd = App.anim.time;
    if (App.anim.loopStart > App.anim.loopEnd) App.anim.loopStart = Math.max(0, App.anim.loopEnd - 0.001);
    updateTimecode();
  });
  els.pbDuration.addEventListener('change', () => {
    const a = getCurrentAnimation(); if (!a) return;
    let v = parseFloat(els.pbDuration.value);
    if (!isFinite(v) || v <= 0) v = 1;
    a.duration = v;
    App.anim.time = Math.min(App.anim.time, v);
    App.anim.loopEnd = v;
    applyAnimationAtTime(App.anim.time);
    renderScene();
    renderTimeline();
  });

  $$('.tools-row [data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act === 'zoom-in')  zoomBy(1.2);
      if (act === 'zoom-out') zoomBy(1 / 1.2);
      if (act === 'zoom-fit') fitView();
    });
  });
  $$('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => Gizmo.setMode(parseInt(btn.dataset.mode, 10)));
  });

  requestAnimationFrame(() => { applyCamera(); renderTimeline(); });

  const m = location.search.match(/[?&]open=([^&]+)/);
  if (m) openObject(decodeURIComponent(m[1]));
}

document.addEventListener('DOMContentLoaded', init);