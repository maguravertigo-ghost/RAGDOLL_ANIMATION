'use strict';

// ============================================================
//  stage.js — Редактор сцены (v0.4.0):
//    • Переключатель режимов (Малиновый: Анимация / Зелёный: Сцена)
//    • Фон сцены (SVG + PNG/растр + сплошной прямоугольник 1366×768)
//    • Слои сцены, пользовательские папки и Z-порядок отрисовки
//    • Относительное резиновое позиционирование (anchor 0..1),
//      исходный верхнеуровневый Pivot Point, Ctrl+Drag, Stage Gizmo,
//      одиночный и групповой скейл
//    • Быстрый 60 FPS предпросмотр всей сцены без пересоздания DOM
// ============================================================

// -------- 2D аффинная математика для точного расчёта границ и пивота --------

function mat2dIdentity() {
  return [1, 0, 0, 1, 0, 0];
}

function mat2dMul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}

function mat2dTranslate(tx, ty) {
  return [1, 0, 0, 1, tx, ty];
}

function mat2dRotate(deg) {
  const r = (deg || 0) * Math.PI / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

function mat2dSkewX(deg) {
  const t = Math.tan((deg || 0) * Math.PI / 180);
  return [1, 0, t, 1, 0, 0];
}

function mat2dSkewY(deg) {
  const t = Math.tan((deg || 0) * Math.PI / 180);
  return [1, t, 0, 1, 0, 0];
}

function mat2dScale(sx, sy) {
  return [sx, 0, 0, sy, 0, 0];
}

function mat2dApply(m, x, y) {
  return {
    x: m[0] * x + m[2] * y + m[4],
    y: m[1] * x + m[3] * y + m[5]
  };
}

function mat2dFromRigPart(part, sz, tr) {
  const pivX = (part.pivot ? part.pivot.x : 0.5) * sz.w;
  const pivY = (part.pivot ? part.pivot.y : 0.5) * sz.h;
  let m = mat2dTranslate(tr.position.x, tr.position.y);
  if (tr.rotation) m = mat2dMul(m, mat2dRotate(tr.rotation));
  if (tr.skew && tr.skew.x) m = mat2dMul(m, mat2dSkewX(tr.skew.x));
  if (tr.skew && tr.skew.y) m = mat2dMul(m, mat2dSkewY(tr.skew.y));
  m = mat2dMul(m, mat2dScale(tr.scale.x, tr.scale.y));
  m = mat2dMul(m, mat2dTranslate(-pivX, -pivY));
  return m;
}

// -------- нормализация модели сцены и метрики опорного экрана --------

function nextStageItemId(prefix) {
  const items = (App.stage.data && App.stage.data.items) || [];
  const used = new Set(items.map(it => it.id));
  let idx = 1;
  while (used.has(prefix + '_' + idx)) idx++;
  return prefix + '_' + idx;
}

function ensureStageStructure(stageObj, fallbackName) {
  const s = stageObj && typeof stageObj === 'object' ? stageObj : {};
  s.version = 1;
  s.name = s.name || fallbackName || 'stage';
  if (!s.frame || typeof s.frame !== 'object') {
    s.frame = { width: 1366, height: 768 };
  }
  s.frame.width  = clamp(Math.round(Number(s.frame.width)  || 1366), 128, 7680);
  s.frame.height = clamp(Math.round(Number(s.frame.height) || 768),  128, 4320);

  if (!s.background || typeof s.background !== 'object') {
    s.background = { color: '#243447', file: '', fit: 'stretch', opacity: 1, visible: true };
  }
  if (!s.background.color) s.background.color = '#243447';
  if (typeof s.background.file !== 'string') s.background.file = '';
  if (!['stretch', 'cover', 'contain', 'center'].includes(s.background.fit)) {
    s.background.fit = 'stretch';
  }
  if (s.background.opacity === undefined) s.background.opacity = 1;
  if (s.background.visible === undefined) s.background.visible = true;

  if (!Array.isArray(s.items)) s.items = [];
  for (let i = 0; i < s.items.length; i++) {
    const it = s.items[i];
    if (!it.id) it.id = 'item_' + (i + 1);
    if (!it.label) it.label = it.objectName || it.file || it.id;
    it.parent = it.parent || null;
    if (it.visible === undefined) it.visible = true;
    if (it.opacity === undefined) it.opacity = 1;
    if (it.isGroup) continue;
    if (!it.type) it.type = it.objectName ? 'object' : 'asset';
    if (!it.anchor || typeof it.anchor !== 'object') {
      it.anchor = { x: 0.5, y: 0.5 };
    } else {
      it.anchor.x = isFinite(it.anchor.x) ? Number(it.anchor.x) : 0.5;
      it.anchor.y = isFinite(it.anchor.y) ? Number(it.anchor.y) : 0.5;
    }
    if (!['fit', 'stretch', 'width', 'height', 'fixed'].includes(it.scaleMode)) {
      it.scaleMode = 'fit';
    }
    if (!it.scale || typeof it.scale !== 'object') {
      it.scale = { x: 1, y: 1 };
    } else {
      it.scale.x = isFinite(it.scale.x) ? Number(it.scale.x) : 1;
      it.scale.y = isFinite(it.scale.y) ? Number(it.scale.y) : 1;
    }
    it.rotation = isFinite(it.rotation) ? Number(it.rotation) : 0;
    if (!it.pivotOffset || typeof it.pivotOffset !== 'object') {
      it.pivotOffset = { x: 0, y: 0 };
    } else {
      it.pivotOffset.x = isFinite(it.pivotOffset.x) ? Number(it.pivotOffset.x) : 0;
      it.pivotOffset.y = isFinite(it.pivotOffset.y) ? Number(it.pivotOffset.y) : 0;
    }
    if (it.type === 'object') {
      if (typeof it.animation !== 'string') it.animation = 'idle';
      if (it.loop === undefined) it.loop = true;
      it.speed = isFinite(it.speed) && it.speed > 0 ? Number(it.speed) : 1;
      it.phase = isFinite(it.phase) ? Number(it.phase) : 0;
    }
  }
  return s;
}

function getStageFrameMetrics() {
  const st = App.stage.data;
  const baseW = (st && st.frame && st.frame.width)  || 1366;
  const baseH = (st && st.frame && st.frame.height) || 768;
  const pctW = els.stageRubberW ? (parseFloat(els.stageRubberW.value) || 100) : 100;
  const pctH = els.stageRubberH ? (parseFloat(els.stageRubberH.value) || 100) : 100;
  const fw = Math.max(64, Math.round(baseW * (pctW / 100)));
  const fh = Math.max(64, Math.round(baseH * (pctH / 100)));
  return {
    baseW,
    baseH,
    fw,
    fh,
    pctW,
    pctH,
    sxFrame: fw / baseW,
    syFrame: fh / baseH
  };
}

function anchorToWorld(anchor, metrics) {
  const m = metrics || getStageFrameMetrics();
  return {
    x: ((anchor ? anchor.x : 0.5) - 0.5) * m.fw,
    y: ((anchor ? anchor.y : 0.5) - 0.5) * m.fh
  };
}

function worldToAnchor(wx, wy, metrics) {
  const m = metrics || getStageFrameMetrics();
  return {
    x: m.fw > 0 ? (wx / m.fw + 0.5) : 0.5,
    y: m.fh > 0 ? (wy / m.fh + 0.5) : 0.5
  };
}

function getResponsiveMultiplier(scaleMode, metrics) {
  const m = metrics || getStageFrameMetrics();
  if (scaleMode === 'stretch') return { x: m.sxFrame, y: m.syFrame };
  if (scaleMode === 'width')   return { x: m.sxFrame, y: m.sxFrame };
  if (scaleMode === 'height')  return { x: m.syFrame, y: m.syFrame };
  if (scaleMode === 'fixed')   return { x: 1, y: 1 };
  const u = Math.min(m.sxFrame, m.syFrame);
  return { x: u, y: u };
}

function getItemEffectiveScale(item, metrics) {
  const r = getResponsiveMultiplier(item.scaleMode, metrics);
  return {
    x: item.scale.x * r.x,
    y: item.scale.y * r.y
  };
}

function isStageItemVisible(item) {
  if (!item || item.visible === false) return false;
  if (!App.stage.data || !item.parent) return true;
  const byId = {};
  for (const it of App.stage.data.items) byId[it.id] = it;
  let cur = byId[item.parent];
  let guard = 0;
  while (cur && guard++ < 64) {
    if (cur.visible === false) return false;
    cur = cur.parent ? byId[cur.parent] : null;
  }
  return true;
}

// -------- компиляция шаблонов объектов и исходного верхнего Pivot Point --------

function getSvgSizeFromRoot(svgEl) {
  if (!svgEl) return { w: 100, h: 100 };
  if (typeof getSvgSize === 'function') return getSvgSize(svgEl);
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const n = vb.trim().split(/[\s,]+/).map(parseFloat);
    if (n.length === 4 && n[2] > 0 && n[3] > 0) return { w: n[2], h: n[3] };
  }
  return {
    w: parseFloat(svgEl.getAttribute('width')) || 100,
    h: parseFloat(svgEl.getAttribute('height')) || 100
  };
}

function compileStageTemplate(name, settings, svgMap) {
  const parts = (settings && settings.parts) ? settings.parts : [];
  const byId = {};
  const partSizes = {};
  let unitToPx = 1;
  let foundUnitRatio = false;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    byId[p.id] = p;
    if (p.isGroup) {
      partSizes[p.id] = p.size ? { w: p.size.w, h: p.size.h } : { w: 100, h: 100 };
    } else {
      const svgEl = svgMap[p.file];
      partSizes[p.id] = getSvgSizeFromRoot(svgEl);
      if (svgEl && !foundUnitRatio && svgEl._unitToPx && isFinite(svgEl._unitToPx)) {
        unitToPx = svgEl._unitToPx;
        foundUnitRatio = true;
      }
    }
  }

  // Вычисляем базовые трансформации каждой части и точные мировые границы в rig-координатах
  const baseTrMap = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const src = p._baseTransform || p.transform || {
      position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 }, skew: { x: 0, y: 0 }
    };
    baseTrMap[p.id] = {
      position: { x: src.position.x, y: src.position.y },
      rotation: src.rotation || 0,
      scale:    { x: src.scale ? src.scale.x : 1, y: src.scale ? src.scale.y : 1 },
      skew:     { x: src.skew ? src.skew.x : 0, y: src.skew ? src.skew.y : 0 },
      visible:  (p._baseVisible !== undefined) ? !!p._baseVisible : (p.visible !== false)
    };
  }

  const worldMatMemo = {};
  function getPartWorldMat(p, guard) {
    if (worldMatMemo[p.id]) return worldMatMemo[p.id];
    if ((guard || 0) > 64) return mat2dIdentity();
    const localM = mat2dFromRigPart(p, partSizes[p.id], baseTrMap[p.id]);
    if (p.parent && byId[p.parent]) {
      const pm = getPartWorldMat(byId[p.parent], (guard || 0) + 1);
      worldMatMemo[p.id] = mat2dMul(pm, localM);
    } else {
      worldMatMemo[p.id] = localM;
    }
    return worldMatMemo[p.id];
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.isGroup) continue;
    if (!baseTrMap[p.id].visible) continue;
    const sz = partSizes[p.id];
    const m = getPartWorldMat(p, 0);
    const corners = [
      mat2dApply(m, 0, 0),
      mat2dApply(m, sz.w, 0),
      mat2dApply(m, sz.w, sz.h),
      mat2dApply(m, 0, sz.h)
    ];
    for (let c = 0; c < 4; c++) {
      if (corners[c].x < minX) minX = corners[c].x;
      if (corners[c].y < minY) minY = corners[c].y;
      if (corners[c].x > maxX) maxX = corners[c].x;
      if (corners[c].y > maxY) maxY = corners[c].y;
    }
  }
  if (!isFinite(minX)) {
    minX = -50; minY = -50; maxX = 50; maxY = 50;
  }

  // Исходный верхнеуровневый Pivot Point объекта:
  // Если в объекте один корневой узел верхнего уровня (например all_character, all_object, Group_1),
  // его собственный пивот в rig-координатах находится строго в точке basePosition корня.
  // Если корней несколько — используем clip.pivot от общего прямоугольника границ объекта.
  const roots = parts.filter(p => !p.parent || !byId[p.parent]);
  let rigPivot;
  if (roots.length === 1) {
    const rootBase = baseTrMap[roots[0].id];
    rigPivot = {
      x: rootBase.position.x,
      y: rootBase.position.y
    };
  } else {
    const cp = (settings && settings.clip && settings.clip.pivot) || { x: 0.5, y: 0.5 };
    rigPivot = {
      x: minX + (maxX - minX) * cp.x,
      y: minY + (maxY - minY) * cp.y
    };
  }

  const rigBounds = { minX, minY, maxX, maxY };
  const localBox = {
    x: (minX - rigPivot.x) * unitToPx,
    y: (minY - rigPivot.y) * unitToPx,
    w: Math.max(4, (maxX - minX) * unitToPx),
    h: Math.max(4, (maxY - minY) * unitToPx)
  };

  // Предкомпилируем базовые параметры частей и дорожки всех анимаций для 60 FPS без аллокаций
  const compiledParts = parts.map(p => {
    const sz = partSizes[p.id];
    const bt = baseTrMap[p.id];
    const pivX = (p.pivot ? p.pivot.x : 0.5) * sz.w;
    const pivY = (p.pivot ? p.pivot.y : 0.5) * sz.h;
    return {
      id: p.id,
      parent: p.parent || null,
      isGroup: !!p.isGroup,
      file: p.file || null,
      opacity: (p.opacity !== undefined) ? p.opacity : 1,
      pivPxX: pivX,
      pivPxY: pivY,
      basePosX: bt.position.x,
      basePosY: bt.position.y,
      baseRot:  bt.rotation,
      baseSclX: bt.scale.x,
      baseSclY: bt.scale.y,
      baseSkwX: bt.skew.x,
      baseSkwY: bt.skew.y,
      baseVis:  bt.visible
    };
  });

  const compiledAnims = {};
  const animNames = [];
  const rawAnims = (settings && Array.isArray(settings.animations)) ? settings.animations : [];
  for (let aIdx = 0; aIdx < rawAnims.length; aIdx++) {
    const a = rawAnims[aIdx];
    if (!a || !a.name) continue;
    animNames.push(a.name);
    const trackLookup = {};
    for (const tr of (a.tracks || [])) {
      if (!tr || !tr.keys || !tr.keys.length) continue;
      if (!trackLookup[tr.partId]) trackLookup[tr.partId] = {};
      trackLookup[tr.partId][tr.property] = tr.keys;
    }
    const partTracks = [];
    const animatedIndices = [];
    for (let pIdx = 0; pIdx < compiledParts.length; pIdx++) {
      const pid = compiledParts[pIdx].id;
      const tl = trackLookup[pid] || null;
      if (tl) {
        animatedIndices.push(pIdx);
        partTracks.push({
          pos: tl.position || null,
          rot: tl.rotation || null,
          scl: tl.scale || null,
          skw: tl.skew || null,
          vis: tl.visible || null
        });
      } else {
        partTracks.push(null);
      }
    }
    compiledAnims[a.name] = {
      name: a.name,
      duration: Math.max(0.001, Number(a.duration) || 1),
      loop: a.loop !== false,
      partTracks,
      animatedIndices
    };
  }

  let defaultAnim = '';
  if (compiledAnims.idle) defaultAnim = 'idle';
  else {
    const nonReset = animNames.find(n => n !== 'reset');
    defaultAnim = nonReset || animNames[0] || '';
  }

  return {
    name,
    unitToPx,
    rigPivot,
    rigBounds,
    localBox,
    svgMap,
    compiledParts,
    compiledAnims,
    animNames,
    defaultAnim
  };
}

function syncLiveObjectToStageCache() {
  if (!App.current || !App.settings) return;
  const out = buildSerializedSettings();
  if (!out) return;
  const svgMap = Object.assign({}, App.svgCache);
  App.stage.templates[App.current] = compileStageTemplate(App.current, out, svgMap);
}

async function loadStageObjectTemplate(objectName) {
  if (App.stage.templates[objectName]) {
    return App.stage.templates[objectName];
  }
  if (App.current === objectName && App.settings && Object.keys(App.svgCache || {}).length) {
    syncLiveObjectToStageCache();
    if (App.stage.templates[objectName]) return App.stage.templates[objectName];
  }
  const data = await fetchObjectData(objectName);
  const settings = data.settings;
  const svgMap = {};
  const parts = (settings && settings.parts) || [];
  await Promise.all(parts.map(async (p) => {
    if (p.isGroup || !p.file) return;
    try {
      svgMap[p.file] = await fetchSvg(objectName, p.file);
    } catch (e) {
      console.warn('Stage: не загружен SVG', objectName, p.file, e);
    }
  }));
  const tpl = compileStageTemplate(objectName, settings, svgMap);
  App.stage.templates[objectName] = tpl;
  return tpl;
}

// -------- быстрый сэмплер дорожек без аллокаций (O(log K)) --------

const _vecScratch = { x: 0, y: 0 };

function findKeySegmentIndex(keys, time) {
  let lo = 0, hi = keys.length - 2;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (time < keys[mid].time) hi = mid - 1;
    else if (time >= keys[mid + 1].time) lo = mid + 1;
    else return mid;
  }
  return Math.max(0, Math.min(keys.length - 2, lo));
}

function sampleScalarFast(keys, time, isStepProp) {
  const n = keys.length;
  if (n === 1 || time <= keys[0].time + 1e-6) return keys[0].value;
  const last = keys[n - 1];
  if (time >= last.time - 1e-6) return last.value;
  const i = findKeySegmentIndex(keys, time);
  const k0 = keys[i], k1 = keys[i + 1];
  if (Math.abs(time - k0.time) < 1e-6) return k0.value;
  if (isStepProp || k1.type === 'key') return k0.value;
  const span = k1.time - k0.time;
  const r = span > 0 ? (time - k0.time) / span : 0;
  return k0.value + (k1.value - k0.value) * r;
}

function sampleVec2Fast(keys, time, out) {
  const n = keys.length;
  if (n === 1 || time <= keys[0].time + 1e-6) {
    out.x = keys[0].value.x; out.y = keys[0].value.y;
    return;
  }
  const last = keys[n - 1];
  if (time >= last.time - 1e-6) {
    out.x = last.value.x; out.y = last.value.y;
    return;
  }
  const i = findKeySegmentIndex(keys, time);
  const k0 = keys[i], k1 = keys[i + 1];
  if (Math.abs(time - k0.time) < 1e-6 || k1.type === 'key') {
    out.x = k0.value.x; out.y = k0.value.y;
    return;
  }
  const span = k1.time - k0.time;
  const r = span > 0 ? (time - k0.time) / span : 0;
  out.x = k0.value.x + (k1.value.x - k0.value.x) * r;
  out.y = k0.value.y + (k1.value.y - k0.value.y) * r;
}

function buildRigPartTransformStr(cp, px, py, rot, sx, sy, kx, ky) {
  let s = 'translate(' + px + ' ' + py + ')';
  if (rot) s += ' rotate(' + rot + ')';
  if (kx)  s += ' skewX(' + kx + ')';
  if (ky)  s += ' skewY(' + ky + ')';
  if (sx !== 1 || sy !== 1) s += ' scale(' + sx + ' ' + sy + ')';
  if (cp.pivPxX || cp.pivPxY) s += ' translate(' + (-cp.pivPxX) + ' ' + (-cp.pivPxY) + ')';
  return s;
}

// -------- построение и синхронизация SVG-сцены без пересборки --------

function ensureStageViewportSkeleton() {
  if (!els.stageRoot) return;
  if (App.stage.frameDom && App.stage.frameDom.root === els.stageRoot && els.stageRoot.children.length > 0) {
    return;
  }
  els.stageRoot.innerHTML = '';

  if (els.stageDefs) {
    els.stageDefs.innerHTML = '';
    const cp = document.createElementNS(SVG_NS, 'clipPath');
    cp.setAttribute('id', 'stage-frame-clip');
    const cpRect = document.createElementNS(SVG_NS, 'rect');
    cp.appendChild(cpRect);
    els.stageDefs.appendChild(cp);
    App.stage._clipRectEl = cpRect;
  }

  const shadowRect = document.createElementNS(SVG_NS, 'rect');
  shadowRect.setAttribute('class', 'stage-shadow-rect');

  const bgGroup = document.createElementNS(SVG_NS, 'g');
  bgGroup.setAttribute('id', 'stage-bg-group');

  const bgSolid = document.createElementNS(SVG_NS, 'rect');
  bgSolid.setAttribute('id', 'stage-bg-solid');
  bgGroup.appendChild(bgSolid);

  const bgMediaSlot = document.createElementNS(SVG_NS, 'g');
  bgMediaSlot.setAttribute('id', 'stage-bg-media');
  bgGroup.appendChild(bgMediaSlot);

  const contentClipWrap = document.createElementNS(SVG_NS, 'g');
  contentClipWrap.setAttribute('id', 'stage-content-clip');

  const itemsLayer = document.createElementNS(SVG_NS, 'g');
  itemsLayer.setAttribute('id', 'stage-items-layer');
  contentClipWrap.appendChild(itemsLayer);

  const borderRect = document.createElementNS(SVG_NS, 'rect');
  borderRect.setAttribute('class', 'stage-frame-border');

  els.stageRoot.appendChild(shadowRect);
  els.stageRoot.appendChild(bgGroup);
  els.stageRoot.appendChild(contentClipWrap);
  els.stageRoot.appendChild(borderRect);

  App.stage.frameDom = {
    root: els.stageRoot,
    shadowRect,
    bgGroup,
    bgSolid,
    bgMediaSlot,
    contentClipWrap,
    itemsLayer,
    borderRect,
    renderedBgKey: ''
  };
}

function getPreserveAspectRatioForFit(fit) {
  if (fit === 'contain') return 'xMidYMid meet';
  if (fit === 'cover')   return 'xMidYMid slice';
  return 'none';
}

async function renderStageBackground() {
  if (!App.stage.data) return;
  ensureStageViewportSkeleton();
  const fd = App.stage.frameDom;
  const bg = App.stage.data.background;
  const m = getStageFrameMetrics();
  const x = -m.fw / 2, y = -m.fh / 2;

  fd.shadowRect.setAttribute('x', String(x));
  fd.shadowRect.setAttribute('y', String(y));
  fd.shadowRect.setAttribute('width', String(m.fw));
  fd.shadowRect.setAttribute('height', String(m.fh));

  fd.borderRect.setAttribute('x', String(x));
  fd.borderRect.setAttribute('y', String(y));
  fd.borderRect.setAttribute('width', String(m.fw));
  fd.borderRect.setAttribute('height', String(m.fh));

  if (App.stage._clipRectEl) {
    App.stage._clipRectEl.setAttribute('x', String(x));
    App.stage._clipRectEl.setAttribute('y', String(y));
    App.stage._clipRectEl.setAttribute('width', String(m.fw));
    App.stage._clipRectEl.setAttribute('height', String(m.fh));
  }
  if (App.stage.clipFrame) {
    fd.contentClipWrap.setAttribute('clip-path', 'url(#stage-frame-clip)');
    fd.bgGroup.setAttribute('clip-path', 'url(#stage-frame-clip)');
  } else {
    fd.contentClipWrap.removeAttribute('clip-path');
    fd.bgGroup.removeAttribute('clip-path');
  }

  fd.bgGroup.style.display = (bg.visible === false) ? 'none' : '';
  fd.bgGroup.style.opacity = String(clamp(Number(bg.opacity ?? 1), 0, 1));
  fd.bgSolid.setAttribute('x', String(x));
  fd.bgSolid.setAttribute('y', String(y));
  fd.bgSolid.setAttribute('width', String(m.fw));
  fd.bgSolid.setAttribute('height', String(m.fh));
  fd.bgSolid.setAttribute('fill', bg.color || '#243447');

  if (els.stageResLabel) {
    els.stageResLabel.textContent = m.baseW + '×' + m.baseH;
  }
  if (els.stageRubberReadout) {
    els.stageRubberReadout.textContent = m.fw + '×' + m.fh +
      ' (' + Math.round(m.pctW) + '%×' + Math.round(m.pctH) + '%)';
  }

  if (!bg.file) {
    fd.bgMediaSlot.innerHTML = '';
    fd.renderedBgKey = '';
    fd.bgMediaEl = null;
    return;
  }

  const assetKey = (App.stage.current || '') + '/' + bg.file;
  try {
    const asset = await fetchStageAssetParsed(App.stage.current, bg.file);
    if (!App.stage.data || App.stage.data.background.file !== bg.file) return;

    if (fd.renderedBgKey !== assetKey || !fd.bgMediaEl) {
      fd.bgMediaSlot.innerHTML = '';
      if (asset.kind === 'svg') {
        const svgNode = (typeof cloneSvgForDom === 'function')
          ? cloneSvgForDom(asset.parsed.root)
          : asset.parsed.root.cloneNode(true);
        fd.bgMediaSlot.appendChild(svgNode);
        fd.bgMediaEl = svgNode;
      } else {
        const imgEl = document.createElementNS(SVG_NS, 'image');
        imgEl.setAttribute('href', asset.url);
        fd.bgMediaSlot.appendChild(imgEl);
        fd.bgMediaEl = imgEl;
      }
      fd.renderedBgKey = assetKey;
      fd.bgAssetInfo = asset;
    }

    const el = fd.bgMediaEl;
    const info = fd.bgAssetInfo || asset;
    if (bg.fit === 'center') {
      const natW = info.kind === 'svg'
        ? (info.parsed.width * (info.unitToPx || 1))
        : (info.width || m.fw);
      const natH = info.kind === 'svg'
        ? (info.parsed.height * (info.unitToPx || 1))
        : (info.height || m.fh);
      const dw = natW * m.sxFrame;
      const dh = natH * m.syFrame;
      el.setAttribute('x', String(-dw / 2));
      el.setAttribute('y', String(-dh / 2));
      el.setAttribute('width', String(dw));
      el.setAttribute('height', String(dh));
      el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    } else {
      el.setAttribute('x', String(x));
      el.setAttribute('y', String(y));
      el.setAttribute('width', String(m.fw));
      el.setAttribute('height', String(m.fh));
      el.setAttribute('preserveAspectRatio', getPreserveAspectRatioForFit(bg.fit));
    }
  } catch (e) {
    console.warn('Stage: не удалось загрузить фон', bg.file, e);
    fd.bgMediaSlot.innerHTML = '';
    fd.renderedBgKey = '';
    fd.bgMediaEl = null;
  }
}

function buildObjectInstanceDom(item, tpl) {
  const outerG = document.createElementNS(SVG_NS, 'g');
  outerG.setAttribute('class', 'stage-item stage-item-object');
  outerG.setAttribute('data-stage-item-id', item.id);

  const rigWrap = document.createElementNS(SVG_NS, 'g');
  rigWrap.setAttribute('class', 'stage-rig-wrap');
  outerG.appendChild(rigWrap);

  const partNodes = new Array(tpl.compiledParts.length);
  const byIdNode = {};

  for (let i = 0; i < tpl.compiledParts.length; i++) {
    const cp = tpl.compiledParts[i];
    const g = document.createElementNS(SVG_NS, 'g');
    const trStr = buildRigPartTransformStr(
      cp, cp.basePosX, cp.basePosY, cp.baseRot,
      cp.baseSclX, cp.baseSclY, cp.baseSkwX, cp.baseSkwY
    );
    g.setAttribute('transform', trStr);
    if (!cp.baseVis) g.style.display = 'none';
    if (cp.opacity !== 1) g.style.opacity = String(cp.opacity);

    if (!cp.isGroup && cp.file && tpl.svgMap[cp.file]) {
      const inner = (typeof cloneSvgForDom === 'function')
        ? cloneSvgForDom(tpl.svgMap[cp.file])
        : tpl.svgMap[cp.file].cloneNode(true);
      g.appendChild(inner);
    }

    partNodes[i] = {
      el: g,
      lastTr: trStr,
      lastVis: cp.baseVis
    };
    byIdNode[cp.id] = g;
  }

  for (let i = 0; i < tpl.compiledParts.length; i++) {
    const cp = tpl.compiledParts[i];
    const g = partNodes[i].el;
    const parentEl = (cp.parent && byIdNode[cp.parent]) ? byIdNode[cp.parent] : rigWrap;
    parentEl.appendChild(g);
  }

  return {
    id: item.id,
    kind: 'object',
    objectName: item.objectName,
    outerG,
    rigWrap,
    tpl,
    partNodes,
    activeAnimApplied: ''
  };
}

function buildAssetInstanceDom(item, asset) {
  const outerG = document.createElementNS(SVG_NS, 'g');
  outerG.setAttribute('class', 'stage-item stage-item-asset');
  outerG.setAttribute('data-stage-item-id', item.id);

  let natW = 100, natH = 100;
  if (asset.kind === 'svg') {
    const u = asset.unitToPx || 1;
    natW = asset.parsed.width * u;
    natH = asset.parsed.height * u;
    const inner = (typeof cloneSvgForDom === 'function')
      ? cloneSvgForDom(asset.parsed.root)
      : asset.parsed.root.cloneNode(true);
    inner.setAttribute('x', String(-natW / 2));
    inner.setAttribute('y', String(-natH / 2));
    inner.setAttribute('width', String(natW));
    inner.setAttribute('height', String(natH));
    outerG.appendChild(inner);
  } else {
    natW = asset.width || 256;
    natH = asset.height || 256;
    const imgEl = document.createElementNS(SVG_NS, 'image');
    imgEl.setAttribute('href', asset.url);
    imgEl.setAttribute('x', String(-natW / 2));
    imgEl.setAttribute('y', String(-natH / 2));
    imgEl.setAttribute('width', String(natW));
    imgEl.setAttribute('height', String(natH));
    outerG.appendChild(imgEl);
  }

  return {
    id: item.id,
    kind: 'asset',
    file: item.file,
    outerG,
    localBox: { x: -natW / 2, y: -natH / 2, w: natW, h: natH }
  };
}

function buildFolderDom(item) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'stage-folder');
  g.setAttribute('data-stage-folder-id', item.id);
  return {
    id: item.id,
    kind: 'folder',
    outerG: g
  };
}

function syncStageItemTransform(item, metrics) {
  const dom = App.stage.domItems[item.id];
  if (!dom || !dom.outerG) return;
  const hid = (item.visible === false);
  dom.outerG.style.display = hid ? 'none' : '';
  dom.outerG.style.opacity = String(clamp(Number(item.opacity ?? 1), 0, 1));
  if (item.isGroup) return;

  const m = metrics || getStageFrameMetrics();
  const wpos = anchorToWorld(item.anchor, m);
  const eff = getItemEffectiveScale(item, m);
  const pivOffX = (item.pivotOffset && item.pivotOffset.x) || 0;
  const pivOffY = (item.pivotOffset && item.pivotOffset.y) || 0;

  let outerTr = 'translate(' + wpos.x + ' ' + wpos.y + ')';
  if (item.rotation) outerTr += ' rotate(' + item.rotation + ')';
  if (eff.x !== 1 || eff.y !== 1) outerTr += ' scale(' + eff.x + ' ' + eff.y + ')';
  if (pivOffX || pivOffY) outerTr += ' translate(' + (-pivOffX) + ' ' + (-pivOffY) + ')';
  dom.outerG.setAttribute('transform', outerTr);

  if (dom.kind === 'object' && dom.rigWrap && dom.tpl) {
    const u = dom.tpl.unitToPx || 1;
    const rp = dom.tpl.rigPivot;
    const rigTr = 'scale(' + u + ' ' + u + ') translate(' + (-rp.x) + ' ' + (-rp.y) + ')';
    if (dom._lastRigTr !== rigTr) {
      dom.rigWrap.setAttribute('transform', rigTr);
      dom._lastRigTr = rigTr;
    }
  }
}

function syncAllStageTransforms() {
  if (!App.stage.data) return;
  const m = getStageFrameMetrics();
  const items = App.stage.data.items;
  for (let i = 0; i < items.length; i++) {
    syncStageItemTransform(items[i], m);
  }
}

function syncStageDomOrder() {
  if (!App.stage.data || !App.stage.frameDom) return;
  const items = App.stage.data.items;
  const byId = {};
  for (const it of items) byId[it.id] = it;

  const rootLayer = App.stage.frameDom.itemsLayer;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const dom = App.stage.domItems[it.id];
    if (!dom || !dom.outerG) continue;
    let parentEl = rootLayer;
    if (it.parent && byId[it.parent] && byId[it.parent].isGroup && App.stage.domItems[it.parent]) {
      parentEl = App.stage.domItems[it.parent].outerG;
    }
    parentEl.appendChild(dom.outerG);
  }
}

async function rebuildStageScene() {
  ensureStageViewportSkeleton();
  const fd = App.stage.frameDom;
  if (!fd) return;
  fd.itemsLayer.innerHTML = '';
  App.stage.domItems = {};

  await renderStageBackground();
  if (!App.stage.data) return;

  const items = App.stage.data.items;
  // Параллельная предзагрузка уникальных шаблонов и ассетов сцены
  const uniqueObjs = Array.from(new Set(
    items.filter(it => !it.isGroup && it.type === 'object' && it.objectName).map(it => it.objectName)
  ));
  const uniqueAssets = Array.from(new Set(
    items.filter(it => !it.isGroup && it.type === 'asset' && it.file).map(it => it.file)
  ));

  await Promise.all([
    ...uniqueObjs.map(n => loadStageObjectTemplate(n).catch(e => console.warn('Stage object err:', n, e))),
    ...uniqueAssets.map(f => fetchStageAssetParsed(App.stage.current, f).catch(e => console.warn('Stage asset err:', f, e)))
  ]);

  const m = getStageFrameMetrics();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.isGroup) {
      App.stage.domItems[it.id] = buildFolderDom(it);
    } else if (it.type === 'object' && it.objectName) {
      const tpl = App.stage.templates[it.objectName];
      if (tpl) {
        if (!it.animation || (!tpl.compiledAnims[it.animation] && it.animation !== '__static__')) {
          it.animation = tpl.defaultAnim || '__static__';
        }
        const dom = buildObjectInstanceDom(it, tpl);
        App.stage.domItems[it.id] = dom;
        applyInstanceAnimationPose(it, dom, App.stage.playing ? App.stage.time : 0);
      }
    } else if (it.type === 'asset' && it.file) {
      const key = App.stage.current + '/' + it.file;
      const asset = App.stage.assetCache[key];
      if (asset) {
        App.stage.domItems[it.id] = buildAssetInstanceDom(it, asset);
      }
    }
    syncStageItemTransform(it, m);
  }

  syncStageDomOrder();
  updateStageSelSize();
  StageGizmo.render();
}

// -------- оценка поз анимации экземпляров (0 аллокаций в кадр) --------

function resetInstanceToBasePose(dom) {
  if (!dom || dom.kind !== 'object') return;
  const parts = dom.tpl.compiledParts;
  const nodes = dom.partNodes;
  for (let i = 0; i < parts.length; i++) {
    const cp = parts[i];
    const pn = nodes[i];
    const tr = buildRigPartTransformStr(
      cp, cp.basePosX, cp.basePosY, cp.baseRot,
      cp.baseSclX, cp.baseSclY, cp.baseSkwX, cp.baseSkwY
    );
    if (pn.lastTr !== tr) {
      pn.el.setAttribute('transform', tr);
      pn.lastTr = tr;
    }
    if (pn.lastVis !== cp.baseVis) {
      pn.el.style.display = cp.baseVis ? '' : 'none';
      pn.lastVis = cp.baseVis;
    }
  }
}

function applyInstanceAnimationPose(item, dom, globalTimeSec) {
  if (!dom || dom.kind !== 'object' || !dom.tpl) return;
  const animName = item.animation;
  if (!animName || animName === '__static__' || !dom.tpl.compiledAnims[animName]) {
    if (dom.activeAnimApplied !== '__static__') {
      resetInstanceToBasePose(dom);
      dom.activeAnimApplied = '__static__';
    }
    return;
  }

  const clip = dom.tpl.compiledAnims[animName];
  if (dom.activeAnimApplied !== animName) {
    resetInstanceToBasePose(dom);
    dom.activeAnimApplied = animName;
  }

  const dur = clip.duration;
  const spd = isFinite(item.speed) ? item.speed : 1;
  const ph  = isFinite(item.phase) ? item.phase : 0;
  const rawT = globalTimeSec * spd + ph;
  const useLoop = (item.loop !== undefined) ? !!item.loop : clip.loop;
  const t = useLoop
    ? (((rawT % dur) + dur) % dur)
    : clamp(rawT, 0, dur);

  const parts = dom.tpl.compiledParts;
  const nodes = dom.partNodes;
  const indices = clip.animatedIndices;
  const tracksArr = clip.partTracks;

  for (let k = 0; k < indices.length; k++) {
    const idx = indices[k];
    const cp = parts[idx];
    const trk = tracksArr[idx];
    const pn = nodes[idx];

    let vis = cp.baseVis;
    if (trk.vis) {
      vis = Boolean(sampleScalarFast(trk.vis, t, true));
    }
    if (pn.lastVis !== vis) {
      pn.el.style.display = vis ? '' : 'none';
      pn.lastVis = vis;
    }
    if (!vis) continue;

    let px = cp.basePosX, py = cp.basePosY;
    if (trk.pos) {
      sampleVec2Fast(trk.pos, t, _vecScratch);
      px = _vecScratch.x;
      py = _vecScratch.y;
    }
    const rot = trk.rot ? sampleScalarFast(trk.rot, t, false) : cp.baseRot;
    let sx = cp.baseSclX, sy = cp.baseSclY;
    if (trk.scl) {
      sampleVec2Fast(trk.scl, t, _vecScratch);
      sx = _vecScratch.x;
      sy = _vecScratch.y;
    }
    let kx = cp.baseSkwX, ky = cp.baseSkwY;
    if (trk.skw) {
      sampleVec2Fast(trk.skw, t, _vecScratch);
      kx = _vecScratch.x;
      ky = _vecScratch.y;
    }

    const trStr = buildRigPartTransformStr(cp, px, py, rot, sx, sy, kx, ky);
    if (pn.lastTr !== trStr) {
      pn.el.setAttribute('transform', trStr);
      pn.lastTr = trStr;
    }
  }
}

function evaluateStageAnimationsAtTime(globalTimeSec) {
  if (!App.stage.data) return;
  const items = App.stage.data.items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.isGroup || it.type !== 'object' || !isStageItemVisible(it)) continue;
    const dom = App.stage.domItems[it.id];
    if (dom) applyInstanceAnimationPose(it, dom, globalTimeSec);
  }
}

// -------- Live-предпросмотр всей сцены (Play / Stop / FPS) --------

function updateStagePreviewUI() {
  if (!els.stagePlay) return;
  const on = !!App.stage.playing;
  els.stagePlay.classList.toggle('playing', on);
  if (els.stagePlayIcon)  els.stagePlayIcon.textContent = on ? 'pause' : 'play_arrow';
  if (els.stagePlayLabel) els.stagePlayLabel.textContent = on ? 'Пауза сцены' : 'Предпросмотр сцены';
  if (els.stageFpsBadge)  els.stageFpsBadge.hidden = !on;
}

function startStagePreview() {
  if (App.stage.playing) return;
  App.stage.playing = true;
  App.stage.lastTs = 0;
  App.stage.fpsSamples = [];
  updateStagePreviewUI();

  function tick(ts) {
    if (!App.stage.playing) return;
    if (App.stage.lastTs > 0) {
      const dtMs = ts - App.stage.lastTs;
      const dt = Math.min(0.1, Math.max(0, dtMs / 1000));
      App.stage.time += dt * (App.stage.speed || 1);
      if (dtMs > 0 && els.stageFpsBadge) {
        const samples = App.stage.fpsSamples;
        samples.push(1000 / dtMs);
        if (samples.length > 20) samples.shift();
        if ((samples.length & 3) === 0) {
          let sum = 0;
          for (let i = 0; i < samples.length; i++) sum += samples[i];
          els.stageFpsBadge.textContent = Math.min(60, Math.round(sum / samples.length)) + ' FPS';
        }
      }
    }
    App.stage.lastTs = ts;
    evaluateStageAnimationsAtTime(App.stage.time);
    App.stage.raf = requestAnimationFrame(tick);
  }

  App.stage.raf = requestAnimationFrame(tick);
}

function pauseStagePreview() {
  App.stage.playing = false;
  if (App.stage.raf) {
    cancelAnimationFrame(App.stage.raf);
    App.stage.raf = null;
  }
  updateStagePreviewUI();
}

function stopStagePreview() {
  pauseStagePreview();
  App.stage.time = 0;
  evaluateStageAnimationsAtTime(0);
}

// -------- геометрические границы элементов сцены и групп --------

function getStageItemLocalBox(item) {
  const dom = App.stage.domItems[item.id];
  if (dom && dom.kind === 'object' && dom.tpl) return dom.tpl.localBox;
  if (dom && dom.kind === 'asset' && dom.localBox) return dom.localBox;
  return { x: -50, y: -50, w: 100, h: 100 };
}

function getStageItemWorldPoint(item, lx, ly, metrics) {
  const m = metrics || getStageFrameMetrics();
  const wpos = anchorToWorld(item.anchor, m);
  const eff = getItemEffectiveScale(item, m);
  const pivOffX = (item.pivotOffset && item.pivotOffset.x) || 0;
  const pivOffY = (item.pivotOffset && item.pivotOffset.y) || 0;
  const sx = (lx - pivOffX) * eff.x;
  const sy = (ly - pivOffY) * eff.y;
  const rad = (item.rotation || 0) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return {
    x: wpos.x + sx * c - sy * s,
    y: wpos.y + sx * s + sy * c
  };
}

function getStageItemWorldAABB(item, metrics) {
  const box = getStageItemLocalBox(item);
  const corners = [
    getStageItemWorldPoint(item, box.x, box.y, metrics),
    getStageItemWorldPoint(item, box.x + box.w, box.y, metrics),
    getStageItemWorldPoint(item, box.x + box.w, box.y + box.h, metrics),
    getStageItemWorldPoint(item, box.x, box.y + box.h, metrics)
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < 4; i++) {
    if (corners[i].x < minX) minX = corners[i].x;
    if (corners[i].y < minY) minY = corners[i].y;
    if (corners[i].x > maxX) maxX = corners[i].x;
    if (corners[i].y > maxY) maxY = corners[i].y;
  }
  return { minX, minY, maxX, maxY, corners };
}

function hitTestStageItemAtWorld(item, wx, wy, metrics) {
  if (!item || item.isGroup || !isStageItemVisible(item)) return false;
  const m = metrics || getStageFrameMetrics();
  const wpos = anchorToWorld(item.anchor, m);
  const eff = getItemEffectiveScale(item, m);
  if (Math.abs(eff.x) < 1e-6 || Math.abs(eff.y) < 1e-6) return false;
  const dx = wx - wpos.x;
  const dy = wy - wpos.y;
  const rad = -(item.rotation || 0) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const rx = dx * c - dy * s;
  const ry = dx * s + dy * c;
  const pivOffX = (item.pivotOffset && item.pivotOffset.x) || 0;
  const pivOffY = (item.pivotOffset && item.pivotOffset.y) || 0;
  const lx = rx / eff.x + pivOffX;
  const ly = ry / eff.y + pivOffY;
  const box = getStageItemLocalBox(item);
  return lx >= box.x && lx <= box.x + box.w && ly >= box.y && ly <= box.y + box.h;
}

function findTopmostStageItemAtWorld(wx, wy) {
  if (!App.stage.data) return null;
  const metrics = getStageFrameMetrics();
  const ordered = getOrderedStageLeafItems();
  // Поиск сверху вниз по Z-порядку (последний отрисованный — самый верхний)
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (hitTestStageItemAtWorld(ordered[i], wx, wy, metrics)) {
      return ordered[i];
    }
  }
  return null;
}

// Возвращает все листовые элементы в точном порядке отрисовки дерева слоёв
function getOrderedStageLeafItems() {
  if (!App.stage.data) return [];
  const { childrenOf, roots } = buildStageTreeIndex();
  const out = [];
  function walk(it) {
    if (it.isGroup) {
      for (const ch of (childrenOf[it.id] || [])) walk(ch);
    } else {
      out.push(it);
    }
  }
  for (const r of roots) walk(r);
  return out;
}

// Возвращает активные листовые элементы для выделения (включая содержимое выделенных папок)
function getSelectedTransformLeafItems() {
  if (!App.stage.data) return [];
  const items = App.stage.data.items;
  const byId = {};
  const childrenOf = {};
  for (const it of items) {
    byId[it.id] = it;
    if (it.parent) (childrenOf[it.parent] = childrenOf[it.parent] || []).push(it);
  }
  const leafSet = new Set();
  function collect(id) {
    const it = byId[id];
    if (!it) return;
    if (it.isGroup) {
      for (const ch of (childrenOf[id] || [])) collect(ch.id);
    } else {
      leafSet.add(it);
    }
  }
  for (const id of App.stage.selectedIds) {
    if (id !== '__bg__') collect(id);
  }
  return Array.from(leafSet);
}

function worldToViewportScreen(wx, wy) {
  const vp = els.viewport;
  const cx = vp.clientWidth / 2;
  const cy = vp.clientHeight / 2;
  const z = App.camera.zoom || 1;
  return {
    x: (wx - App.camera.x) * z + cx,
    y: (wy - App.camera.y) * z + cy
  };
}

function clientToStageWorld(clientX, clientY, allowSnap) {
  let cx = clientX, cy = clientY;
  if (allowSnap && App.grid.snap) {
    const sp = App.snapClientToGrid(clientX, clientY);
    cx = sp.x; cy = sp.y;
  }
  const rect = els.viewport.getBoundingClientRect();
  return screenToWorld(cx - rect.left, cy - rect.top);
}

// -------- StageGizmo: одиночный и групповой скейл / поворот / пивот / перемещение --------

const StageGizmo = (function () {
  const HSIZE = 8;
  let drag = null;

  function makeSvg(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
    }
    return el;
  }

  function render() {
    const svg = els.stageGizmoSvg;
    if (!svg) return;
    svg.innerHTML = '';
    if (App.editorMode !== 'stage' || !App.stage.data) return;

    // Рамка выделения мышью (marquee)
    if (drag && drag.kind === 'marquee') {
      const x = Math.min(drag.sx0, drag.sx1);
      const y = Math.min(drag.sy0, drag.sy1);
      const w = Math.abs(drag.sx1 - drag.sx0);
      const h = Math.abs(drag.sy1 - drag.sy0);
      svg.appendChild(makeSvg('rect', {
        x, y, width: w, height: h, class: 'stage-marquee-rect'
      }));
      return;
    }

    const leaves = getSelectedTransformLeafItems();
    if (!leaves.length) return;

    const metrics = getStageFrameMetrics();

    // ОДИНОЧНЫЙ ЭЛЕМЕНТ: ориентированная рамка + исходный верхнеуровневый Pivot Point + ручки скейла и поворота
    if (leaves.length === 1 && !(App.stage.selectedId && isStageFolderId(App.stage.selectedId))) {
      const it = leaves[0];
      if (!isStageItemVisible(it)) return;
      const aabb = getStageItemWorldAABB(it, metrics);
      const pts = aabb.corners.map(p => worldToViewportScreen(p.x, p.y));
      const dPath = 'M' + pts[0].x + ' ' + pts[0].y +
                    'L' + pts[1].x + ' ' + pts[1].y +
                    'L' + pts[2].x + ' ' + pts[2].y +
                    'L' + pts[3].x + ' ' + pts[3].y + 'Z';

      const interior = makeSvg('path', { d: dPath, class: 'stage-gizmo-interior' });
      interior.dataset.gizmo = 'move';
      svg.appendChild(interior);

      const box = makeSvg('path', { d: dPath, class: 'stage-gizmo-box' });
      box.dataset.gizmo = 'move';
      svg.appendChild(box);

      // Точка поворота сверху над гранью 0-1
      const topMidX = (pts[0].x + pts[1].x) / 2;
      const topMidY = (pts[0].y + pts[1].y) / 2;
      const edgeDx = pts[1].x - pts[0].x;
      const edgeDy = pts[1].y - pts[0].y;
      const edgeLen = Math.hypot(edgeDx, edgeDy) || 1;
      const nx = edgeDy / edgeLen;
      const ny = -edgeDx / edgeLen;
      const rotHx = topMidX + nx * 22;
      const rotHy = topMidY + ny * 22;

      svg.appendChild(makeSvg('line', {
        x1: topMidX, y1: topMidY, x2: rotHx, y2: rotHy,
        stroke: '#51cf66', 'stroke-width': 1.2
      }));
      const rotHandle = makeSvg('circle', {
        cx: rotHx, cy: rotHy, r: 5.5, class: 'stage-gizmo-rot-handle'
      });
      rotHandle.dataset.gizmo = 'rotate';
      svg.appendChild(rotHandle);

      // 4 угловые ручки скейла (масштабируют вокруг верхнеуровневого Pivot Point)
      for (let i = 0; i < 4; i++) {
        const h = makeSvg('rect', {
          x: pts[i].x - HSIZE / 2,
          y: pts[i].y - HSIZE / 2,
          width: HSIZE,
          height: HSIZE,
          class: 'stage-gizmo-handle c-' + i
        });
        h.dataset.gizmo = 'scale-corner';
        h.dataset.corner = String(i);
        svg.appendChild(h);
      }

      // 4 боковые ручки скейла по осям X / Y
      const edges = [
        { name: 'top',    a: 0, b: 1 },
        { name: 'right',  a: 1, b: 2 },
        { name: 'bottom', a: 2, b: 3 },
        { name: 'left',   a: 3, b: 0 }
      ];
      for (const ed of edges) {
        const mx = (pts[ed.a].x + pts[ed.b].x) / 2;
        const my = (pts[ed.a].y + pts[ed.b].y) / 2;
        const eh = makeSvg('rect', {
          x: mx - (HSIZE - 2) / 2,
          y: my - (HSIZE - 2) / 2,
          width: HSIZE - 2,
          height: HSIZE - 2,
          class: 'stage-gizmo-handle e-' + ed.name
        });
        eh.dataset.gizmo = 'scale-edge';
        eh.dataset.edge = ed.name;
        svg.appendChild(eh);
      }

      // Прицел верхнеуровневого Pivot Point объекта
      const wpos = anchorToWorld(it.anchor, metrics);
      const pScr = worldToViewportScreen(wpos.x, wpos.y);
      const pivG = makeSvg('g', { class: 'stage-gizmo-pivot' });
      pivG.dataset.gizmo = 'pivot';
      pivG.appendChild(makeSvg('circle', {
        cx: pScr.x, cy: pScr.y, r: 6.5,
        fill: 'rgba(15, 20, 26, 0.78)', stroke: '#ffd43b', 'stroke-width': 1.6
      }));
      pivG.appendChild(makeSvg('line', {
        x1: pScr.x - 9, y1: pScr.y, x2: pScr.x + 9, y2: pScr.y,
        stroke: '#ffd43b', 'stroke-width': 1.3
      }));
      pivG.appendChild(makeSvg('line', {
        x1: pScr.x, y1: pScr.y - 9, x2: pScr.x, y2: pScr.y + 9,
        stroke: '#ffd43b', 'stroke-width': 1.3
      }));
      svg.appendChild(pivG);
      return;
    }

    // ГРУППОВОЕ ВЫДЕЛЕНИЕ (папка или несколько объектов): общая рамка и групповой скейл
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let visCount = 0;
    for (const it of leaves) {
      if (!isStageItemVisible(it)) continue;
      const b = getStageItemWorldAABB(it, metrics);
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
      visCount++;
    }
    if (!visCount || !isFinite(minX)) return;

    const p0 = worldToViewportScreen(minX, minY);
    const p1 = worldToViewportScreen(maxX, maxY);
    const gx = p0.x, gy = p0.y;
    const gw = Math.max(8, p1.x - p0.x);
    const gh = Math.max(8, p1.y - p0.y);

    const interior = makeSvg('rect', {
      x: gx, y: gy, width: gw, height: gh, class: 'stage-gizmo-interior'
    });
    interior.dataset.gizmo = 'group-move';
    svg.appendChild(interior);

    const gBox = makeSvg('rect', {
      x: gx, y: gy, width: gw, height: gh, class: 'stage-gizmo-box group-box'
    });
    gBox.dataset.gizmo = 'group-move';
    svg.appendChild(gBox);

    const gCorners = [
      { idx: 0, x: gx,      y: gy },
      { idx: 1, x: gx + gw, y: gy },
      { idx: 2, x: gx + gw, y: gy + gh },
      { idx: 3, x: gx,      y: gy + gh }
    ];
    for (const c of gCorners) {
      const h = makeSvg('rect', {
        x: c.x - HSIZE / 2, y: c.y - HSIZE / 2, width: HSIZE, height: HSIZE,
        class: 'stage-gizmo-handle group-handle c-' + c.idx
      });
      h.dataset.gizmo = 'group-scale';
      h.dataset.axis = 'both';
      svg.appendChild(h);
    }

    const gEdges = [
      { cls: 'e-top',    axis: 'y', x: gx + gw / 2, y: gy },
      { cls: 'e-right',  axis: 'x', x: gx + gw,     y: gy + gh / 2 },
      { cls: 'e-bottom', axis: 'y', x: gx + gw / 2, y: gy + gh },
      { cls: 'e-left',   axis: 'x', x: gx,          y: gy + gh / 2 }
    ];
    for (const ed of gEdges) {
      const h = makeSvg('rect', {
        x: ed.x - (HSIZE - 2) / 2, y: ed.y - (HSIZE - 2) / 2,
        width: HSIZE - 2, height: HSIZE - 2,
        class: 'stage-gizmo-handle group-handle ' + ed.cls
      });
      h.dataset.gizmo = 'group-scale';
      h.dataset.axis = ed.axis;
      svg.appendChild(h);
    }

    // Центр трансформации группы
    const cx = gx + gw / 2, cy = gy + gh / 2;
    svg.appendChild(makeSvg('circle', {
      cx, cy, r: 5.5, fill: 'rgba(15,20,26,0.8)', stroke: '#ffd43b', 'stroke-width': 1.5
    }));
  }

  function startMoveDrag(e, itemsToMove, ctrlToggleCandidateId) {
    const metrics = getStageFrameMetrics();
    const w0 = clientToStageWorld(e.clientX, e.clientY, false);
    drag = {
      kind: 'move',
      clientX0: e.clientX,
      clientY0: e.clientY,
      moved: false,
      ctrlToggleCandidateId: ctrlToggleCandidateId || null,
      w0,
      snapshots: itemsToMove.map(it => ({
        item: it,
        wpos0: anchorToWorld(it.anchor, metrics)
      }))
    };
  }

  function startMarqueeDrag(e) {
    const rect = els.viewport.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    drag = {
      kind: 'marquee',
      additive: !!(e.shiftKey || e.ctrlKey || e.metaKey),
      sx0: sx, sy0: sy,
      sx1: sx, sy1: sy,
      moved: false
    };
  }

  function onGizmoMouseDown(e) {
    if (App.editorMode !== 'stage' || e.button !== 0 || App.spaceDown) return;
    const target = e.target && e.target.closest ? e.target.closest('[data-gizmo]') : null;
    if (!target) return;

    // Если зажат Ctrl на интерьере Gizmo — проверяем, не кликнули ли по другому объекту под курсором
    const gizmoKind = target.dataset.gizmo;
    if ((e.ctrlKey || e.metaKey) && (gizmoKind === 'move' || gizmoKind === 'group-move')) {
      handleStageViewportMouseDown(e, true);
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const leaves = getSelectedTransformLeafItems();
    if (!leaves.length) return;
    const metrics = getStageFrameMetrics();
    const wStart = clientToStageWorld(e.clientX, e.clientY, false);

    if (gizmoKind === 'move' || gizmoKind === 'group-move') {
      startMoveDrag(e, leaves, null);
      return;
    }

    if (gizmoKind === 'rotate' && leaves.length === 1) {
      const it = leaves[0];
      const piv = anchorToWorld(it.anchor, metrics);
      const a0 = Math.atan2(wStart.y - piv.y, wStart.x - piv.x) * 180 / Math.PI;
      drag = {
        kind: 'rotate',
        item: it,
        piv,
        a0,
        rot0: it.rotation || 0,
        moved: false
      };
      return;
    }

    if (gizmoKind === 'pivot' && leaves.length === 1) {
      const it = leaves[0];
      drag = {
        kind: 'pivot',
        item: it,
        w0: wStart,
        anchor0: clone(it.anchor),
        pivOff0: clone(it.pivotOffset || { x: 0, y: 0 }),
        moved: false
      };
      return;
    }

    if ((gizmoKind === 'scale-corner' || gizmoKind === 'scale-edge') && leaves.length === 1) {
      const it = leaves[0];
      const piv = anchorToWorld(it.anchor, metrics);
      const rad = -(it.rotation || 0) * Math.PI / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const dx = wStart.x - piv.x, dy = wStart.y - piv.y;
      const lx0 = dx * cos - dy * sin;
      const ly0 = dx * sin + dy * cos;
      const dist0 = Math.max(4, Math.hypot(lx0, ly0));
      drag = {
        kind: gizmoKind,
        edge: target.dataset.edge || '',
        item: it,
        piv,
        cos,
        sin,
        lx0: Math.abs(lx0) < 2 ? (lx0 < 0 ? -2 : 2) : lx0,
        ly0: Math.abs(ly0) < 2 ? (ly0 < 0 ? -2 : 2) : ly0,
        dist0,
        scale0: clone(it.scale),
        moved: false
      };
      return;
    }

    if (gizmoKind === 'group-scale') {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const it of leaves) {
        if (!isStageItemVisible(it)) continue;
        const b = getStageItemWorldAABB(it, metrics);
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxY > maxY) maxY = b.maxY;
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      drag = {
        kind: 'group-scale',
        axis: target.dataset.axis || 'both',
        center: { x: cx, y: cy },
        dx0: Math.abs(wStart.x - cx) < 4 ? 4 : (wStart.x - cx),
        dy0: Math.abs(wStart.y - cy) < 4 ? 4 : (wStart.y - cy),
        dist0: Math.max(6, Math.hypot(wStart.x - cx, wStart.y - cy)),
        snapshots: leaves.map(it => ({
          item: it,
          wpos0: anchorToWorld(it.anchor, metrics),
          scale0: clone(it.scale)
        })),
        moved: false
      };
    }
  }

  function onWindowMouseMove(e) {
    if (!drag) return;
    if (App.editorMode !== 'stage' || !App.stage.data) {
      drag = null;
      return;
    }

    const metrics = getStageFrameMetrics();

    if (drag.kind === 'marquee') {
      const rect = els.viewport.getBoundingClientRect();
      drag.sx1 = e.clientX - rect.left;
      drag.sy1 = e.clientY - rect.top;
      if (Math.hypot(drag.sx1 - drag.sx0, drag.sy1 - drag.sy0) > 3) drag.moved = true;
      render();
      return;
    }

    if (drag.kind === 'move') {
      if (!drag.moved && Math.hypot(e.clientX - drag.clientX0, e.clientY - drag.clientY0) < 3) {
        return;
      }
      drag.moved = true;
      const wCur = clientToStageWorld(e.clientX, e.clientY, true);
      const dwx = wCur.x - drag.w0.x;
      const dwy = wCur.y - drag.w0.y;
      for (const snap of drag.snapshots) {
        let nx = snap.wpos0.x + dwx;
        let ny = snap.wpos0.y + dwy;
        if (App.grid.snap && drag.snapshots.length === 1) {
          const step = App.grid.step || 4;
          nx = Math.round(nx / step) * step;
          ny = Math.round(ny / step) * step;
        }
        snap.item.anchor = worldToAnchor(nx, ny, metrics);
        syncStageItemTransform(snap.item, metrics);
      }
      markStageDirty();
      updateStageSelSize();
      syncStageInspectorLive();
      render();
      return;
    }

    if (drag.kind === 'rotate') {
      drag.moved = true;
      const wCur = clientToStageWorld(e.clientX, e.clientY, false);
      const a1 = Math.atan2(wCur.y - drag.piv.y, wCur.x - drag.piv.x) * 180 / Math.PI;
      let rot = drag.rot0 + (a1 - drag.a0);
      if (e.shiftKey) rot = Math.round(rot / 15) * 15;
      drag.item.rotation = Math.round(rot * 100) / 100;
      syncStageItemTransform(drag.item, metrics);
      markStageDirty();
      syncStageInspectorLive();
      render();
      return;
    }

    if (drag.kind === 'pivot') {
      drag.moved = true;
      const wCur = clientToStageWorld(e.clientX, e.clientY, true);
      const eff = getItemEffectiveScale(drag.item, metrics);
      const rad = -(drag.item.rotation || 0) * Math.PI / 180;
      const c = Math.cos(rad), s = Math.sin(rad);
      const dwx = wCur.x - drag.w0.x;
      const dwy = wCur.y - drag.w0.y;
      const dlx = (dwx * c - dwy * s) / (eff.x || 1);
      const dly = (dwx * s + dwy * c) / (eff.y || 1);
      drag.item.pivotOffset = {
        x: drag.pivOff0.x + dlx,
        y: drag.pivOff0.y + dly
      };
      const newWorld = anchorToWorld(drag.anchor0, metrics);
      drag.item.anchor = worldToAnchor(newWorld.x + dwx, newWorld.y + dwy, metrics);
      syncStageItemTransform(drag.item, metrics);
      markStageDirty();
      syncStageInspectorLive();
      render();
      return;
    }

    if (drag.kind === 'scale-corner' || drag.kind === 'scale-edge') {
      drag.moved = true;
      const wCur = clientToStageWorld(e.clientX, e.clientY, false);
      const dx = wCur.x - drag.piv.x, dy = wCur.y - drag.piv.y;
      const lx = dx * drag.cos - dy * drag.sin;
      const ly = dx * drag.sin + dy * drag.cos;

      if (drag.kind === 'scale-corner') {
        if (e.shiftKey) {
          // С зажатым Shift на углу — свободный непропорциональный скейл X/Y
          const fx = clamp(lx / drag.lx0, -50, 50);
          const fy = clamp(ly / drag.ly0, -50, 50);
          drag.item.scale.x = roundScaleVal(drag.scale0.x * fx);
          drag.item.scale.y = roundScaleVal(drag.scale0.y * fy);
        } else {
          // По умолчанию угловая ручка масштабирует пропорционально вокруг пивота
          const dist = Math.hypot(lx, ly);
          const sign = (lx * drag.lx0 + ly * drag.ly0) < 0 ? -1 : 1;
          const f = clamp((dist / drag.dist0) * sign, -50, 50);
          drag.item.scale.x = roundScaleVal(drag.scale0.x * f);
          drag.item.scale.y = roundScaleVal(drag.scale0.y * Math.abs(f));
        }
      } else {
        if (drag.edge === 'left' || drag.edge === 'right') {
          const fx = clamp(lx / drag.lx0, -50, 50);
          drag.item.scale.x = roundScaleVal(drag.scale0.x * fx);
        } else {
          const fy = clamp(ly / drag.ly0, -50, 50);
          drag.item.scale.y = roundScaleVal(drag.scale0.y * fy);
        }
      }

      syncStageItemTransform(drag.item, metrics);
      markStageDirty();
      updateStageSelSize();
      syncStageInspectorLive();
      render();
      return;
    }

    if (drag.kind === 'group-scale') {
      drag.moved = true;
      const wCur = clientToStageWorld(e.clientX, e.clientY, false);
      const dx = wCur.x - drag.center.x;
      const dy = wCur.y - drag.center.y;
      let fx = 1, fy = 1;
      if (drag.axis === 'both') {
        if (e.shiftKey) {
          fx = clamp(dx / drag.dx0, 0.05, 30);
          fy = clamp(dy / drag.dy0, 0.05, 30);
        } else {
          const f = clamp(Math.hypot(dx, dy) / drag.dist0, 0.05, 30);
          fx = f; fy = f;
        }
      } else if (drag.axis === 'x') {
        fx = clamp(dx / drag.dx0, 0.05, 30);
      } else {
        fy = clamp(dy / drag.dy0, 0.05, 30);
      }

      for (const snap of drag.snapshots) {
        const wx = drag.center.x + (snap.wpos0.x - drag.center.x) * fx;
        const wy = drag.center.y + (snap.wpos0.y - drag.center.y) * fy;
        snap.item.anchor = worldToAnchor(wx, wy, metrics);
        snap.item.scale.x = roundScaleVal(snap.scale0.x * fx);
        snap.item.scale.y = roundScaleVal(snap.scale0.y * fy);
        syncStageItemTransform(snap.item, metrics);
      }
      markStageDirty();
      updateStageSelSize();
      syncStageInspectorLive();
      render();
    }
  }

  function onWindowMouseUp() {
    if (!drag) return;
    const d = drag;
    drag = null;

    if (d.kind === 'marquee') {
      if (d.moved && App.stage.data) {
        const w0 = screenToWorld(Math.min(d.sx0, d.sx1), Math.min(d.sy0, d.sy1));
        const w1 = screenToWorld(Math.max(d.sx0, d.sx1), Math.max(d.sy0, d.sy1));
        const metrics = getStageFrameMetrics();
        const hits = [];
        for (const it of getOrderedStageLeafItems()) {
          if (!isStageItemVisible(it)) continue;
          const b = getStageItemWorldAABB(it, metrics);
          if (b.maxX >= w0.x && b.minX <= w1.x && b.maxY >= w0.y && b.minY <= w1.y) {
            hits.push(it.id);
          }
        }
        if (d.additive) {
          const merged = new Set(Array.from(App.stage.selectedIds).filter(id => id !== '__bg__'));
          for (const id of hits) merged.add(id);
          setStageSelection(Array.from(merged), hits[hits.length - 1] || App.stage.selectedId);
        } else if (hits.length) {
          setStageSelection(hits, hits[hits.length - 1]);
        } else {
          setStageSelection(['__bg__'], '__bg__');
        }
      } else if (!d.additive) {
        setStageSelection(['__bg__'], '__bg__');
      }
      render();
      return;
    }

    if (d.kind === 'move' && !d.moved && d.ctrlToggleCandidateId) {
      toggleStageSelection(d.ctrlToggleCandidateId);
      return;
    }

    if (d.moved) {
      renderStageProperties();
      render();
    }
  }

  function init() {
    if (!els.stageGizmoSvg) return;
    els.stageGizmoSvg.addEventListener('mousedown', onGizmoMouseDown);
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
  }

  return {
    init,
    render,
    startMoveDrag,
    startMarqueeDrag
  };
})();

function roundScaleVal(v) {
  if (Math.abs(v) < 0.005) return v < 0 ? -0.005 : 0.005;
  return Math.round(v * 10000) / 10000;
}

function isStageFolderId(id) {
  if (!App.stage.data || !id) return false;
  const it = App.stage.data.items.find(x => x.id === id);
  return !!(it && it.isGroup);
}

// -------- обработка кликов и Ctrl+Drag на вьюпорте сцены --------

function handleStageViewportMouseDown(e, fromGizmoInterior) {
  if (App.editorMode !== 'stage' || !App.stage.data) return;
  if (!fromGizmoInterior && e.target && e.target.closest && e.target.closest('#stage-gizmo-svg')) {
    return;
  }

  const metrics = getStageFrameMetrics();
  const wClick = clientToStageWorld(e.clientX, e.clientY, false);
  const currentSelectedLeaves = getSelectedTransformLeafItems();
  const hitSelected = currentSelectedLeaves.find(it => hitTestStageItemAtWorld(it, wClick.x, wClick.y, metrics)) || null;
  const hitTop = findTopmostStageItemAtWorld(wClick.x, wClick.y);

  // Режим Ctrl + Drag & Drop: перетаскивание объекта(ов) зажатием Ctrl + ЛКМ.
  // Если курсор попадает по уже выделенному в списке слоёв объекту (даже если поверх него перекрывается другой),
  // двигаем именно выделенный объект(ы) — удобно при сборке многослойных сцен!
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    if (!e.shiftKey && hitSelected) {
      StageGizmo.startMoveDrag(e, currentSelectedLeaves, null);
      return;
    }
    if (hitTop) {
      let toggleCandidate = null;
      if (App.stage.selectedIds.has(hitTop.id)) {
        toggleCandidate = e.shiftKey ? hitTop.id : null;
      } else if (e.shiftKey) {
        const cur = Array.from(App.stage.selectedIds).filter(id => id !== '__bg__');
        cur.push(hitTop.id);
        setStageSelection(cur, hitTop.id);
      } else {
        setStageSelection([hitTop.id], hitTop.id);
      }
      const leaves = getSelectedTransformLeafItems();
      if (leaves.length) StageGizmo.startMoveDrag(e, leaves, toggleCandidate);
    } else if (currentSelectedLeaves.length) {
      StageGizmo.startMoveDrag(e, currentSelectedLeaves, null);
    }
    return;
  }

  // Обычный клик / Shift-выделение / рамка выделения группы
  if (hitTop) {
    e.preventDefault();
    if (e.shiftKey) {
      toggleStageSelection(hitTop.id);
    } else {
      if (!App.stage.selectedIds.has(hitTop.id)) {
        setStageSelection([hitTop.id], hitTop.id);
      }
      const leaves = getSelectedTransformLeafItems();
      if (leaves.length) StageGizmo.startMoveDrag(e, leaves, null);
    }
  } else {
    StageGizmo.startMarqueeDrag(e);
  }
}

// -------- дерево слоёв сцены, папки и Z-порядок (правая панель) --------

function buildStageTreeIndex() {
  const items = (App.stage.data && App.stage.data.items) || [];
  const byId = {};
  for (const it of items) byId[it.id] = it;
  const childrenOf = {};
  const roots = [];
  for (const it of items) {
    if (it.parent && byId[it.parent] && byId[it.parent].isGroup) {
      (childrenOf[it.parent] = childrenOf[it.parent] || []).push(it);
    } else {
      roots.push(it);
    }
  }
  return { byId, childrenOf, roots };
}

function isStageDescendantOf(candidateId, ancestorId) {
  if (!App.stage.data) return false;
  const byId = {};
  for (const it of App.stage.data.items) byId[it.id] = it;
  let cur = byId[candidateId];
  let guard = 0;
  while (cur && cur.parent && guard++ < 64) {
    if (cur.parent === ancestorId) return true;
    cur = byId[cur.parent];
  }
  return false;
}

function setStageSelection(ids, primaryId) {
  const clean = (ids && ids.length) ? ids : ['__bg__'];
  App.stage.selectedIds = new Set(clean);
  App.stage.selectedId  = primaryId || clean[0] || '__bg__';
  renderStageLayers();
  renderStageProperties();
  updateStageSelSize();
  StageGizmo.render();
}

function toggleStageSelection(id) {
  const s = new Set(Array.from(App.stage.selectedIds).filter(x => x !== '__bg__'));
  if (s.has(id)) s.delete(id);
  else s.add(id);
  const arr = Array.from(s);
  if (!arr.length) setStageSelection(['__bg__'], '__bg__');
  else setStageSelection(arr, s.has(id) ? id : arr[arr.length - 1]);
}

function rangeSelectStage(targetId) {
  const lis = Array.from(els.stageLayersList.querySelectorAll('li[data-stage-id]'))
    .map(li => li.dataset.stageId)
    .filter(id => id !== '__bg__');
  const a = lis.indexOf(App.stage.selectedId);
  const b = lis.indexOf(targetId);
  if (a < 0 || b < 0) {
    setStageSelection([targetId], targetId);
    return;
  }
  const slice = lis.slice(Math.min(a, b), Math.max(a, b) + 1);
  setStageSelection(slice, targetId);
}

function renderStageLayers() {
  if (!els.stageLayersList) return;
  els.stageLayersList.innerHTML = '';
  if (!App.stage.data) return;

  const bg = App.stage.data.background;

  // 1) Закреплённая строка «Бэкграунд» (самый дальний задний план)
  const bgLi = document.createElement('li');
  bgLi.dataset.stageId = '__bg__';
  bgLi.className = 'stage-bg-row' + (App.stage.selectedIds.has('__bg__') ? ' selected' : '');
  const bgVisIcon = (bg.visible === false) ? 'visibility_off' : 'visibility';
  const bgBadge = bg.file ? bg.file : (App.stage.data.frame.width + '×' + App.stage.data.frame.height);

  bgLi.innerHTML =
    '<button type="button" class="stage-layer-vis" title="Видимость фона">' +
      '<span class="material-icons">' + bgVisIcon + '</span>' +
    '</button>' +
    '<span class="stage-bg-swatch"></span>' +
    '<span class="stage-layer-name">Бэкграунд</span>' +
    '<span class="stage-layer-badge"></span>';

  bgLi.querySelector('.stage-bg-swatch').style.background = bg.color || '#243447';
  bgLi.querySelector('.stage-layer-badge').textContent = bgBadge;

  bgLi.querySelector('.stage-layer-vis').addEventListener('click', (e) => {
    e.stopPropagation();
    bg.visible = (bg.visible === false);
    markStageDirty();
    renderStageBackground();
    renderStageLayers();
    if (App.stage.selectedId === '__bg__') renderStageProperties();
  });

  bgLi.addEventListener('click', () => {
    setStageSelection(['__bg__'], '__bg__');
  });

  els.stageLayersList.appendChild(bgLi);

  // 2) Иерархия пользовательских папок и слоёв (сверху вниз: от дальних к ближним)
  const { childrenOf, roots } = buildStageTreeIndex();

  function renderNode(it, depth) {
    const li = document.createElement('li');
    li.dataset.stageId = it.id;
    li.className = 'layer depth-' + Math.min(depth, 6) + (it.isGroup ? ' group' : '');
    if (App.stage.selectedIds.has(it.id)) li.classList.add('selected');
    if (it.visible === false) li.style.opacity = '0.5';
    li.draggable = true;

    const visIcon = (it.visible === false) ? 'visibility_off' : 'visibility';
    const typeIcon = it.isGroup
      ? 'folder'
      : (it.type === 'object' ? 'smart_toy' : 'image');
    const badgeTxt = it.isGroup
      ? ((childrenOf[it.id] || []).length + ' сл.')
      : (it.type === 'object' ? (it.animation === '__static__' ? 'static' : (it.animation || 'idle')) : 'asset');

    li.innerHTML =
      '<button type="button" class="stage-layer-vis" title="Показать / скрыть">' +
        '<span class="material-icons">' + visIcon + '</span>' +
      '</button>' +
      '<span class="material-icons layer-icon">' + typeIcon + '</span>' +
      '<span class="stage-layer-name"></span>' +
      '<span class="stage-layer-badge"></span>';

    li.querySelector('.stage-layer-name').textContent = it.label || it.id;
    li.querySelector('.stage-layer-badge').textContent = badgeTxt;

    li.querySelector('.stage-layer-vis').addEventListener('click', (e) => {
      e.stopPropagation();
      it.visible = (it.visible === false);
      markStageDirty();
      syncStageItemTransform(it);
      if (App.stage.playing) evaluateStageAnimationsAtTime(App.stage.time);
      renderStageLayers();
      if (App.stage.selectedId === it.id) renderStageProperties();
      StageGizmo.render();
    });

    li.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) toggleStageSelection(it.id);
      else if (e.shiftKey && App.stage.selectedId && App.stage.selectedId !== '__bg__') rangeSelectStage(it.id);
      else setStageSelection([it.id], it.id);
    });

    li.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      e.preventDefault();
      startStageLayerInlineRename(li, it);
    });

    // Drag & Drop смены Z-порядка и вложенности в папки
    li.addEventListener('dragstart', (e) => {
      App.stage._dragLayerId = it.id;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', it.id); } catch (_) {}
    });

    li.addEventListener('dragend', () => {
      App.stage._dragLayerId = null;
      li.classList.remove('dragging');
      els.stageLayersList.querySelectorAll('li').forEach(x =>
        x.classList.remove('drop-before', 'drop-after', 'drop-into')
      );
    });

    li.addEventListener('dragover', (e) => {
      const draggedId = App.stage._dragLayerId;
      if (!draggedId || draggedId === it.id) return;
      if (isStageDescendantOf(it.id, draggedId)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      els.stageLayersList.querySelectorAll('li').forEach(x =>
        x.classList.remove('drop-before', 'drop-after', 'drop-into')
      );
      const rect = li.getBoundingClientRect();
      const y = e.clientY - rect.top, h = rect.height;
      if (it.isGroup && y >= h * 0.28 && y <= h * 0.72) {
        li.classList.add('drop-into');
      } else if (y < h * 0.5) {
        li.classList.add('drop-before');
      } else {
        li.classList.add('drop-after');
      }
    });

    li.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && li.contains(e.relatedTarget)) return;
      li.classList.remove('drop-before', 'drop-after', 'drop-into');
    });

    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const draggedId = App.stage._dragLayerId;
      App.stage._dragLayerId = null;
      const mode = li.classList.contains('drop-before') ? 'before'
                 : li.classList.contains('drop-after')  ? 'after'
                 : li.classList.contains('drop-into')  ? 'into' : null;
      els.stageLayersList.querySelectorAll('li').forEach(x =>
        x.classList.remove('drop-before', 'drop-after', 'drop-into', 'dragging')
      );
      if (!draggedId || !mode || draggedId === it.id) return;
      reorderStageItem(draggedId, it.id, mode);
    });

    els.stageLayersList.appendChild(li);
    if (it.isGroup) {
      for (const ch of (childrenOf[it.id] || [])) {
        renderNode(ch, depth + 1);
      }
    }
  }

  for (const r of roots) renderNode(r, 0);
}

function reorderStageItem(draggedId, targetId, mode) {
  if (!App.stage.data) return;
  if (isStageDescendantOf(targetId, draggedId)) return;
  const items = App.stage.data.items;
  const dragged = items.find(x => x.id === draggedId);
  const target  = items.find(x => x.id === targetId);
  if (!dragged || !target) return;

  const oldIdx = items.indexOf(dragged);
  if (oldIdx >= 0) items.splice(oldIdx, 1);

  if (mode === 'into' && target.isGroup) {
    dragged.parent = target.id;
    let insertIdx = items.indexOf(target) + 1;
    for (let i = 0; i < items.length; i++) {
      if (items[i].parent === target.id) insertIdx = i + 1;
    }
    items.splice(insertIdx, 0, dragged);
  } else {
    dragged.parent = target.parent || null;
    const tIdx = items.indexOf(target);
    items.splice(mode === 'before' ? tIdx : tIdx + 1, 0, dragged);
  }

  markStageDirty();
  syncStageDomOrder();
  renderStageLayers();
  StageGizmo.render();
}

function startStageLayerInlineRename(li, item) {
  const nameSpan = li.querySelector('.stage-layer-name');
  if (!nameSpan) return;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'list-row-input';
  inp.value = item.label || item.id;
  nameSpan.replaceWith(inp);
  li.draggable = false;
  inp.focus();
  inp.select();

  let done = false;
  function finish(commit) {
    if (done) return;
    done = true;
    if (commit) {
      const val = inp.value.trim();
      if (val && val !== item.label) {
        item.label = val;
        markStageDirty();
      }
    }
    renderStageLayers();
    renderStageProperties();
  }

  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter')  { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('click', (ev) => ev.stopPropagation());
}

function createStageFolder() {
  if (!App.stage.data) return;
  const id = nextStageItemId('folder');
  const existingLabels = App.stage.data.items.filter(x => x.isGroup).map(x => x.label);
  const label = resolveAutoName(existingLabels, 'Папка ');
  let parent = null;
  if (App.stage.selectedId && isStageFolderId(App.stage.selectedId)) {
    parent = App.stage.selectedId;
  }
  const folder = {
    id,
    label,
    isGroup: true,
    parent,
    visible: true,
    opacity: 1
  };
  App.stage.data.items.push(folder);
  App.stage.domItems[id] = buildFolderDom(folder);
  syncStageDomOrder();
  markStageDirty();
  setStageSelection([id], id);
  setHint('Создана папка слоёв «' + label + '»', 1800);
}

function deleteSelectedStageItems() {
  if (!App.stage.data) return;
  const sel = Array.from(App.stage.selectedIds).filter(id => id !== '__bg__');
  if (!sel.length) {
    setHint('Выберите слой или папку для удаления', 1800);
    return;
  }
  const toRemove = new Set(sel);
  let added = true;
  while (added) {
    added = false;
    for (const it of App.stage.data.items) {
      if (it.parent && toRemove.has(it.parent) && !toRemove.has(it.id)) {
        toRemove.add(it.id);
        added = true;
      }
    }
  }
  for (const id of toRemove) {
    const dom = App.stage.domItems[id];
    if (dom && dom.outerG && dom.outerG.parentNode) {
      dom.outerG.parentNode.removeChild(dom.outerG);
    }
    delete App.stage.domItems[id];
  }
  App.stage.data.items = App.stage.data.items.filter(it => !toRemove.has(it.id));
  markStageDirty();
  setStageSelection(['__bg__'], '__bg__');
  setHint('Удалено слоёв: ' + toRemove.size, 1600);
}

// -------- Модалка добавления объекта / ассета в центр сцены --------

async function openStagePickModal() {
  if (!App.stage.data) {
    setHint('Сначала откройте сцену', 1800);
    return;
  }
  let targetParent = null;
  if (App.stage.selectedId && isStageFolderId(App.stage.selectedId)) {
    targetParent = App.stage.selectedId;
  } else if (App.stage.selectedId && App.stage.selectedId !== '__bg__') {
    const cur = App.stage.data.items.find(x => x.id === App.stage.selectedId);
    if (cur && cur.parent) targetParent = cur.parent;
  }
  App.stage._pendingFolderId = targetParent;
  App.stage._pickSelected = null;
  els.modalStagePickObj.hidden = false;
  await renderStagePickList();
}

function closeStagePickModal() {
  if (els.modalStagePickObj) els.modalStagePickObj.hidden = true;
}

async function renderStagePickList() {
  const tab = App.stage._pickTab || 'object';
  if (els.stagePickTabObj)   els.stagePickTabObj.classList.toggle('active', tab === 'object');
  if (els.stagePickTabAsset) els.stagePickTabAsset.classList.toggle('active', tab === 'asset');
  if (els.stagePickUpload)   els.stagePickUpload.hidden = (tab !== 'asset');

  els.stagePickList.innerHTML = '<li class="empty">Загрузка…</li>';

  if (tab === 'object') {
    let names = [];
    try { names = await fetchObjects(); } catch (_) {}
    els.stagePickList.innerHTML = '';
    if (!names.length) {
      els.stagePickList.innerHTML = '<li class="empty">Нет доступных объектов в anim/</li>';
      return;
    }
    if (!App.stage._pickSelected || !names.includes(App.stage._pickSelected)) {
      App.stage._pickSelected = names[0];
    }
    for (const n of names) {
      const li = document.createElement('li');
      li.dataset.val = n;
      if (n === App.stage._pickSelected) li.classList.add('selected');
      li.innerHTML =
        '<span class="material-icons" style="font-size:16px;color:#69db7c;margin-right:6px">smart_toy</span>' +
        '<span class="list-row-label"></span>';
      li.querySelector('.list-row-label').textContent = n;
      li.addEventListener('click', () => {
        App.stage._pickSelected = n;
        els.stagePickList.querySelectorAll('li').forEach(x => x.classList.toggle('selected', x === li));
      });
      li.addEventListener('dblclick', () => {
        App.stage._pickSelected = n;
        confirmAddStageLayerFromModal();
      });
      els.stagePickList.appendChild(li);
    }
  } else {
    const assets = App.stage.assets || [];
    els.stagePickList.innerHTML = '';
    if (!assets.length) {
      els.stagePickList.innerHTML =
        '<li class="empty">В папке сцены пока нет SVG/PNG файлов. Нажмите «Загрузить SVG / PNG…».</li>';
      return;
    }
    if (!App.stage._pickSelected || !assets.includes(App.stage._pickSelected)) {
      App.stage._pickSelected = assets[0];
    }
    for (const f of assets) {
      const li = document.createElement('li');
      li.dataset.val = f;
      if (f === App.stage._pickSelected) li.classList.add('selected');
      li.innerHTML =
        '<span class="material-icons" style="font-size:16px;color:#74c0fc;margin-right:6px">image</span>' +
        '<span class="list-row-label"></span>';
      li.querySelector('.list-row-label').textContent = f;
      li.addEventListener('click', () => {
        App.stage._pickSelected = f;
        els.stagePickList.querySelectorAll('li').forEach(x => x.classList.toggle('selected', x === li));
      });
      li.addEventListener('dblclick', () => {
        App.stage._pickSelected = f;
        confirmAddStageLayerFromModal();
      });
      els.stagePickList.appendChild(li);
    }
  }
}

async function addObjectLayerToStageCenter(objectName, parentFolderId) {
  if (!App.stage.data || !objectName) return null;
  const tpl = await loadStageObjectTemplate(objectName);
  const id = nextStageItemId('obj');
  const existingLabels = App.stage.data.items.map(x => x.label);
  const label = existingLabels.includes(objectName)
    ? resolveAutoName(existingLabels, objectName + '_')
    : objectName;

  const item = {
    id,
    label,
    type: 'object',
    objectName,
    parent: parentFolderId || null,
    anchor: { x: 0.5, y: 0.5 }, // Строго в центр сцены (0, 0)
    scaleMode: 'fit',
    scale: { x: 1, y: 1 },
    rotation: 0,
    pivotOffset: { x: 0, y: 0 },
    animation: tpl.defaultAnim || '__static__',
    loop: true,
    speed: 1,
    phase: 0,
    visible: true,
    opacity: 1
  };

  App.stage.data.items.push(item);
  const dom = buildObjectInstanceDom(item, tpl);
  App.stage.domItems[id] = dom;
  applyInstanceAnimationPose(item, dom, App.stage.playing ? App.stage.time : 0);
  syncStageItemTransform(item);
  syncStageDomOrder();
  markStageDirty();
  setStageSelection([id], id);
  setHint('Объект «' + objectName + '» добавлен в центр сцены', 2000);
  return item;
}

async function addAssetLayerToStageCenter(fileName, parentFolderId) {
  if (!App.stage.data || !fileName) return null;
  const asset = await fetchStageAssetParsed(App.stage.current, fileName);
  const id = nextStageItemId('asset');
  const baseLabel = fileName.replace(/\.[^.]+$/, '');
  const existingLabels = App.stage.data.items.map(x => x.label);
  const label = existingLabels.includes(baseLabel)
    ? resolveAutoName(existingLabels, baseLabel + '_')
    : baseLabel;

  const item = {
    id,
    label,
    type: 'asset',
    file: fileName,
    parent: parentFolderId || null,
    anchor: { x: 0.5, y: 0.5 },
    scaleMode: 'fit',
    scale: { x: 1, y: 1 },
    rotation: 0,
    pivotOffset: { x: 0, y: 0 },
    visible: true,
    opacity: 1
  };

  App.stage.data.items.push(item);
  App.stage.domItems[id] = buildAssetInstanceDom(item, asset);
  syncStageItemTransform(item);
  syncStageDomOrder();
  markStageDirty();
  setStageSelection([id], id);
  setHint('Ассет «' + fileName + '» добавлен в центр сцены', 2000);
  return item;
}

async function confirmAddStageLayerFromModal() {
  const val = App.stage._pickSelected;
  if (!val) {
    setHint('Выберите элемент из списка', 1600);
    return;
  }
  const tab = App.stage._pickTab || 'object';
  const parentId = App.stage._pendingFolderId || null;
  closeStagePickModal();
  try {
    if (tab === 'object') await addObjectLayerToStageCenter(val, parentId);
    else await addAssetLayerToStageCenter(val, parentId);
  } catch (e) {
    setHint('Ошибка добавления на сцену: ' + e.message, 3200);
  }
}

// -------- загрузка файла SVG / PNG для фона или ассета сцены --------

function triggerStageFileUpload(targetKind) {
  if (!App.stage.current || !els.stageFileInput) return;
  App.stage._uploadTarget = targetKind; // 'bg' | 'asset'
  els.stageFileInput.value = '';
  els.stageFileInput.click();
}

async function handleStageFileInputChange() {
  const f = els.stageFileInput && els.stageFileInput.files && els.stageFileInput.files[0];
  if (!f || !App.stage.current) return;
  try {
    const savedName = await uploadStageAssetBackend(App.stage.current, f);
    if (!App.stage.assets.includes(savedName)) {
      App.stage.assets.push(savedName);
      App.stage.assets.sort((a, b) => a.localeCompare(b));
    }
    if (App.stage._uploadTarget === 'bg') {
      App.stage.data.background.file = savedName;
      markStageDirty();
      await renderStageBackground();
      renderStageLayers();
      renderStageProperties();
      setHint('Фон сцены установлен: ' + savedName, 2200);
    } else {
      App.stage._pickTab = 'asset';
      App.stage._pickSelected = savedName;
      if (!els.modalStagePickObj.hidden) {
        await renderStagePickList();
      } else {
        await addAssetLayerToStageCenter(savedName, App.stage._pendingFolderId || null);
      }
      setHint('Файл загружен в сцену: ' + savedName, 2000);
    }
  } catch (e) {
    setHint('Ошибка загрузки файла: ' + e.message, 3400);
  }
}

// -------- панель «Свойства» в Редакторе сцены --------

function updateStageSelSize() {
  if (!els.selSize || App.editorMode !== 'stage') return;
  const leaves = getSelectedTransformLeafItems();
  if (!leaves.length) {
    const m = getStageFrameMetrics();
    els.selSize.textContent = m.fw + ' × ' + m.fh;
    return;
  }
  const m = getStageFrameMetrics();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of leaves) {
    const b = getStageItemWorldAABB(it, m);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  if (!isFinite(minX)) {
    els.selSize.textContent = '---, ---';
    return;
  }
  els.selSize.textContent = (maxX - minX).toFixed(1) + ', ' + (maxY - minY).toFixed(1);
}

function stagePropRowHtml(label, key, value, step, digits) {
  const d = (digits !== undefined) ? digits : 2;
  return (
    '<div class="prow">' +
      '<span class="plabel">' + label + '</span>' +
      '<div class="pinput-wrap">' +
        '<input type="number" data-skey="' + key + '" step="' + (step || 0.01) +
          '" value="' + (+value).toFixed(d) + '">' +
        '<div class="pspin">' +
          '<button type="button" data-sspin="up" data-skey="' + key + '" tabindex="-1">' +
            '<span class="material-icons">expand_less</span></button>' +
          '<button type="button" data-sspin="down" data-skey="' + key + '" tabindex="-1">' +
            '<span class="material-icons">expand_more</span></button>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="preset" data-sreset="' + key + '" title="Сбросить">' +
        '<span class="material-icons">restart_alt</span></button>' +
    '</div>'
  );
}

function syncStageInspectorLive() {
  const props = els.props;
  if (!props || App.editorMode !== 'stage') return;
  const leaves = getSelectedTransformLeafItems();
  if (leaves.length !== 1) return;
  const it = leaves[0];
  const m = getStageFrameMetrics();
  const wpos = anchorToWorld(it.anchor, m);
  const map = {
    'anc.x': (it.anchor.x * 100).toFixed(2),
    'anc.y': (it.anchor.y * 100).toFixed(2),
    'px.x':  wpos.x.toFixed(1),
    'px.y':  wpos.y.toFixed(1),
    'scl.x': it.scale.x.toFixed(3),
    'scl.y': it.scale.y.toFixed(3),
    'rot':   it.rotation.toFixed(1),
    'piv.x': ((it.pivotOffset && it.pivotOffset.x) || 0).toFixed(1),
    'piv.y': ((it.pivotOffset && it.pivotOffset.y) || 0).toFixed(1)
  };
  for (const k of Object.keys(map)) {
    const inp = props.querySelector('input[data-skey="' + k + '"]');
    if (inp && document.activeElement !== inp) inp.value = map[k];
  }
}

function renderStageProperties() {
  if (App.editorMode !== 'stage' || !els.props) return;
  const props = els.props;
  if (!App.stage.data) {
    els.propsTitle.textContent = 'Свойства сцены';
    props.innerHTML = '<div class="h">Сцена не открыта</div>';
    return;
  }

  const selId = App.stage.selectedId || '__bg__';
  const leaves = getSelectedTransformLeafItems();

  // 1) Свойства Бэкграунда и опорного разрешения сцены (по умолчанию 1366×768)
  if (selId === '__bg__' || (!leaves.length && !isStageFolderId(selId))) {
    const bg = App.stage.data.background;
    const fr = App.stage.data.frame;
    els.propsTitle.textContent = 'Бэкграунд сцены';

    let fileOptions = '<option value="">— Без картинки (сплошной прямоугольник) —</option>';
    for (const f of (App.stage.assets || [])) {
      const sel = (bg.file === f) ? ' selected' : '';
      fileOptions += '<option value="' + escapeHtmlAttr(f) + '"' + sel + '>' + escapeHtmlAttr(f) + '</option>';
    }

    props.innerHTML =
      '<label class="pcheck">' +
        '<input type="checkbox" id="sprop-bg-vis"' + (bg.visible !== false ? ' checked' : '') + '>' +
        '<span>Показывать фон сцены</span>' +
      '</label>' +
      '<div class="pgroup">' +
        '<div class="pgroup-title">Опорный экран, px</div>' +
        stagePropRowHtml('W', 'frame.w', fr.width, 10, 0) +
        stagePropRowHtml('H', 'frame.h', fr.height, 10, 0) +
        '<div class="stage-btn-row">' +
          '<button type="button" class="stage-btn-sm" data-res="1366x768">1366×768</button>' +
          '<button type="button" class="stage-btn-sm" data-res="1920x1080">1920×1080</button>' +
          '<button type="button" class="stage-btn-sm" data-res="1280x720">1280×720</button>' +
        '</div>' +
      '</div>' +
      '<div class="pgroup">' +
        '<div class="pgroup-title">Цвет прямоугольника фона</div>' +
        '<div class="stage-color-row">' +
          '<input type="color" id="sprop-bg-color" value="' + escapeHtmlAttr(normalizeHex6(bg.color)) + '">' +
          '<input type="text" id="sprop-bg-hex" value="' + escapeHtmlAttr(bg.color || '#243447') + '">' +
        '</div>' +
      '</div>' +
      '<div class="pgroup">' +
        '<div class="pgroup-title">Картинка фона (SVG / PNG)</div>' +
        '<select id="sprop-bg-file" class="stage-prop-select">' + fileOptions + '</select>' +
        '<div class="stage-btn-row">' +
          '<button type="button" id="sprop-bg-upload" class="stage-btn-sm primary-green">Загрузить SVG / PNG…</button>' +
          (bg.file ? '<button type="button" id="sprop-bg-clear" class="stage-btn-sm">Убрать</button>' : '') +
        '</div>' +
        '<div class="pgroup-title" style="margin-top:6px">Режим заполнения</div>' +
        '<select id="sprop-bg-fit" class="stage-prop-select">' +
          '<option value="stretch"' + (bg.fit === 'stretch' ? ' selected' : '') + '>Растянуть по экрану (stretch)</option>' +
          '<option value="cover"'   + (bg.fit === 'cover'   ? ' selected' : '') + '>Заполнить с обрезкой (cover)</option>' +
          '<option value="contain"' + (bg.fit === 'contain' ? ' selected' : '') + '>Вписать целиком (contain)</option>' +
          '<option value="center"'  + (bg.fit === 'center'  ? ' selected' : '') + '>По центру 1:1 (center)</option>' +
        '</select>' +
        stagePropRowHtml('Alpha', 'bg.op', bg.opacity ?? 1, 0.05, 2) +
      '</div>';

    props.querySelector('#sprop-bg-vis').addEventListener('change', (e) => {
      bg.visible = e.target.checked;
      markStageDirty();
      renderStageBackground();
      renderStageLayers();
    });

    const colorInp = props.querySelector('#sprop-bg-color');
    const hexInp   = props.querySelector('#sprop-bg-hex');
    colorInp.addEventListener('input', () => {
      bg.color = colorInp.value;
      hexInp.value = bg.color;
      markStageDirty();
      renderStageBackground();
      renderStageLayers();
    });
    hexInp.addEventListener('change', () => {
      const v = normalizeHex6(hexInp.value);
      bg.color = v;
      colorInp.value = v;
      hexInp.value = v;
      markStageDirty();
      renderStageBackground();
      renderStageLayers();
    });

    props.querySelector('#sprop-bg-file').addEventListener('change', async (e) => {
      bg.file = e.target.value;
      markStageDirty();
      await renderStageBackground();
      renderStageLayers();
      renderStageProperties();
    });
    props.querySelector('#sprop-bg-upload').addEventListener('click', () => triggerStageFileUpload('bg'));
    const clearBtn = props.querySelector('#sprop-bg-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        bg.file = '';
        markStageDirty();
        await renderStageBackground();
        renderStageLayers();
        renderStageProperties();
      });
    }
    props.querySelector('#sprop-bg-fit').addEventListener('change', async (e) => {
      bg.fit = e.target.value;
      markStageDirty();
      await renderStageBackground();
    });

    props.querySelectorAll('button[data-res]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [w, h] = btn.dataset.res.split('x').map(Number);
        fr.width = w; fr.height = h;
        markStageDirty();
        renderStageBackground();
        syncAllStageTransforms();
        renderStageLayers();
        renderStageProperties();
        StageGizmo.render();
      });
    });

    bindStageNumericInputs(props, {
      get(k) {
        if (k === 'frame.w') return fr.width;
        if (k === 'frame.h') return fr.height;
        if (k === 'bg.op')   return bg.opacity ?? 1;
        return 0;
      },
      set(k, v) {
        if (k === 'frame.w') fr.width  = clamp(Math.round(v), 128, 7680);
        if (k === 'frame.h') fr.height = clamp(Math.round(v), 128, 4320);
        if (k === 'bg.op')   bg.opacity = clamp(v, 0, 1);
        markStageDirty();
        renderStageBackground();
        syncAllStageTransforms();
        renderStageLayers();
        StageGizmo.render();
      },
      reset: { 'frame.w': 1366, 'frame.h': 768, 'bg.op': 1 }
    });
    return;
  }

  // 2) Групповое выделение (выбрана папка ИЛИ несколько слоёв): Групповой скейл и центрирование
  if (leaves.length > 1 || isStageFolderId(selId)) {
    const folder = isStageFolderId(selId)
      ? App.stage.data.items.find(x => x.id === selId)
      : null;
    els.propsTitle.textContent = folder
      ? ('Папка: ' + folder.label + ' (' + leaves.length + ')')
      : ('Группа слоёв (' + leaves.length + ')');

    props.innerHTML =
      (folder
        ? '<label class="pcheck">' +
            '<input type="checkbox" id="sprop-folder-vis"' + (folder.visible !== false ? ' checked' : '') + '>' +
            '<span>Видимость папки</span>' +
          '</label>'
        : '') +
      '<div class="pgroup">' +
        '<div class="pgroup-title">Масштаб выделенной группы</div>' +
        stagePropRowHtml('K%', 'grp.pct', 100, 5, 1) +
        '<div class="stage-btn-row">' +
          '<button type="button" class="stage-btn-sm" data-gscale="0.5">×0.5</button>' +
          '<button type="button" class="stage-btn-sm" data-gscale="0.8">×0.8</button>' +
          '<button type="button" class="stage-btn-sm" data-gscale="1.25">×1.25</button>' +
          '<button type="button" class="stage-btn-sm" data-gscale="1.5">×1.5</button>' +
        '</div>' +
        '<div class="stage-btn-row">' +
          '<button type="button" id="sprop-grp-center" class="stage-btn-sm primary-green">Группу в центр сцены</button>' +
          '<button type="button" id="sprop-grp-add-here" class="stage-btn-sm"' + (folder ? '' : ' hidden') + '>+ Слой в папку</button>' +
        '</div>' +
      '</div>';

    if (folder) {
      props.querySelector('#sprop-folder-vis').addEventListener('change', (e) => {
        folder.visible = e.target.checked;
        markStageDirty();
        syncStageItemTransform(folder);
        renderStageLayers();
        StageGizmo.render();
      });
      const addInBtn = props.querySelector('#sprop-grp-add-here');
      if (addInBtn) addInBtn.addEventListener('click', openStagePickModal);
    }

    function scaleGroupByFactor(factor) {
      if (!leaves.length || !isFinite(factor) || factor <= 0) return;
      const m = getStageFrameMetrics();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const it of leaves) {
        const b = getStageItemWorldAABB(it, m);
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxY > maxY) maxY = b.maxY;
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      for (const it of leaves) {
        const wp = anchorToWorld(it.anchor, m);
        const nx = cx + (wp.x - cx) * factor;
        const ny = cy + (wp.y - cy) * factor;
        it.anchor = worldToAnchor(nx, ny, m);
        it.scale.x = roundScaleVal(it.scale.x * factor);
        it.scale.y = roundScaleVal(it.scale.y * factor);
        syncStageItemTransform(it, m);
      }
      markStageDirty();
      updateStageSelSize();
      StageGizmo.render();
    }

    props.querySelectorAll('button[data-gscale]').forEach(btn => {
      btn.addEventListener('click', () => scaleGroupByFactor(parseFloat(btn.dataset.gscale)));
    });

    props.querySelector('#sprop-grp-center').addEventListener('click', () => {
      if (!leaves.length) return;
      const m = getStageFrameMetrics();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const it of leaves) {
        const b = getStageItemWorldAABB(it, m);
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxY > maxY) maxY = b.maxY;
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      for (const it of leaves) {
        const wp = anchorToWorld(it.anchor, m);
        it.anchor = worldToAnchor(wp.x - cx, wp.y - cy, m);
        syncStageItemTransform(it, m);
      }
      markStageDirty();
      StageGizmo.render();
    });

    let lastPct = 100;
    bindStageNumericInputs(props, {
      get() { return lastPct; },
      set(k, v) {
        const nextPct = clamp(v, 10, 500);
        const ratio = nextPct / lastPct;
        lastPct = nextPct;
        scaleGroupByFactor(ratio);
      },
      reset: { 'grp.pct': 100 }
    });
    return;
  }

  // 3) Одиночный слой сцены (анимированный объект anim/ или ассет stage/)
  const it = leaves[0];
  const m = getStageFrameMetrics();
  const wpos = anchorToWorld(it.anchor, m);
  els.propsTitle.textContent = (it.type === 'object' ? 'Объект: ' : 'Слой: ') + (it.label || it.id);

  let animBlockHtml = '';
  if (it.type === 'object') {
    const tpl = App.stage.templates[it.objectName];
    const animNames = tpl ? tpl.animNames : [];
    let animOpts = '<option value="__static__"' + (it.animation === '__static__' ? ' selected' : '') + '>— Статика (базовая поза) —</option>';
    for (const an of animNames) {
      const sel = (it.animation === an) ? ' selected' : '';
      animOpts += '<option value="' + escapeHtmlAttr(an) + '"' + sel + '>' + escapeHtmlAttr(an) + '</option>';
    }
    animBlockHtml =
      '<div class="pgroup">' +
        '<div class="pgroup-title">Тестовая анимация (' + escapeHtmlAttr(it.objectName) + ')</div>' +
        '<select id="sprop-obj-anim" class="stage-prop-select">' + animOpts + '</select>' +
        '<label class="pcheck">' +
          '<input type="checkbox" id="sprop-obj-loop"' + (it.loop !== false ? ' checked' : '') + '>' +
          '<span>Зациклить анимацию</span>' +
        '</label>' +
        stagePropRowHtml('Spd', 'anim.spd', it.speed ?? 1, 0.1, 2) +
        stagePropRowHtml('Фаза', 'anim.ph', it.phase ?? 0, 0.05, 2) +
        '<div class="stage-btn-row">' +
          '<button type="button" id="sprop-edit-obj" class="stage-btn-sm">Открыть в Редакторе объектов</button>' +
        '</div>' +
      '</div>';
  }

  props.innerHTML =
    '<label class="pcheck">' +
      '<input type="checkbox" id="sprop-item-vis"' + (it.visible !== false ? ' checked' : '') + '>' +
      '<span>Видимость на сцене</span>' +
    '</label>' +
    animBlockHtml +
    '<div class="pgroup">' +
      '<div class="pgroup-title">Позиция (% от экрана — резиновая)</div>' +
      stagePropRowHtml('X%', 'anc.x', it.anchor.x * 100, 0.5, 2) +
      stagePropRowHtml('Y%', 'anc.y', it.anchor.y * 100, 0.5, 2) +
      '<div class="pgroup-title" style="margin-top:5px">Мировые координаты, px</div>' +
      stagePropRowHtml('X', 'px.x', wpos.x, 2, 1) +
      stagePropRowHtml('Y', 'px.y', wpos.y, 2, 1) +
      '<div class="stage-btn-row">' +
        '<button type="button" id="sprop-item-center" class="stage-btn-sm primary-green">В центр (50%, 50%)</button>' +
      '</div>' +
    '</div>' +
    '<div class="pgroup">' +
      '<div class="pgroup-title">Масштаб и адаптивность</div>' +
      '<select id="sprop-scale-mode" class="stage-prop-select">' +
        '<option value="fit"'     + (it.scaleMode === 'fit'     ? ' selected' : '') + '>Пропорционально экрану (fit)</option>' +
        '<option value="stretch"' + (it.scaleMode === 'stretch' ? ' selected' : '') + '>Растягивать с экраном (stretch)</option>' +
        '<option value="width"'   + (it.scaleMode === 'width'   ? ' selected' : '') + '>По ширине экрана (width)</option>' +
        '<option value="height"'  + (it.scaleMode === 'height'  ? ' selected' : '') + '>По высоте экрана (height)</option>' +
        '<option value="fixed"'   + (it.scaleMode === 'fixed'   ? ' selected' : '') + '>Фиксированный px (fixed)</option>' +
      '</select>' +
      stagePropRowHtml('SX', 'scl.x', it.scale.x, 0.05, 3) +
      stagePropRowHtml('SY', 'scl.y', it.scale.y, 0.05, 3) +
      '<div class="stage-btn-row">' +
        '<button type="button" class="stage-btn-sm" data-uscl="0.5">0.5×</button>' +
        '<button type="button" class="stage-btn-sm" data-uscl="1">1×</button>' +
        '<button type="button" class="stage-btn-sm" data-uscl="1.5">1.5×</button>' +
        '<button type="button" class="stage-btn-sm" data-uscl="2">2×</button>' +
        '<button type="button" class="stage-btn-sm" data-flipx="1" title="Отразить по X">Flip X</button>' +
      '</div>' +
    '</div>' +
    '<div class="pgroup">' +
      '<div class="pgroup-title">Поворот и прозрачность</div>' +
      stagePropRowHtml('R°', 'rot', it.rotation, 1, 1) +
      stagePropRowHtml('Op', 'op', it.opacity ?? 1, 0.05, 2) +
    '</div>' +
    '<div class="pgroup">' +
      '<div class="pgroup-title">Смещение пивота от исходного, px</div>' +
      stagePropRowHtml('PX', 'piv.x', (it.pivotOffset && it.pivotOffset.x) || 0, 1, 1) +
      stagePropRowHtml('PY', 'piv.y', (it.pivotOffset && it.pivotOffset.y) || 0, 1, 1) +
    '</div>';

  props.querySelector('#sprop-item-vis').addEventListener('change', (e) => {
    it.visible = e.target.checked;
    markStageDirty();
    syncStageItemTransform(it);
    renderStageLayers();
    StageGizmo.render();
  });

  if (it.type === 'object') {
    const animSel = props.querySelector('#sprop-obj-anim');
    if (animSel) {
      animSel.addEventListener('change', () => {
        it.animation = animSel.value;
        markStageDirty();
        const dom = App.stage.domItems[it.id];
        if (dom) applyInstanceAnimationPose(it, dom, App.stage.playing ? App.stage.time : 0);
        renderStageLayers();
      });
    }
    const loopChk = props.querySelector('#sprop-obj-loop');
    if (loopChk) {
      loopChk.addEventListener('change', () => {
        it.loop = loopChk.checked;
        markStageDirty();
      });
    }
    const editObjBtn = props.querySelector('#sprop-edit-obj');
    if (editObjBtn) {
      editObjBtn.addEventListener('click', () => {
        setEditorMode('object');
        requestOpenObject(it.objectName);
      });
    }
  }

  props.querySelector('#sprop-item-center').addEventListener('click', () => {
    it.anchor = { x: 0.5, y: 0.5 };
    markStageDirty();
    syncStageItemTransform(it);
    syncStageInspectorLive();
    StageGizmo.render();
  });

  props.querySelector('#sprop-scale-mode').addEventListener('change', (e) => {
    it.scaleMode = e.target.value;
    markStageDirty();
    syncStageItemTransform(it);
    updateStageSelSize();
    StageGizmo.render();
  });

  props.querySelectorAll('button[data-uscl]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = parseFloat(btn.dataset.uscl);
      const signX = it.scale.x < 0 ? -1 : 1;
      it.scale.x = signX * s;
      it.scale.y = s;
      markStageDirty();
      syncStageItemTransform(it);
      updateStageSelSize();
      syncStageInspectorLive();
      StageGizmo.render();
    });
  });

  const flipBtn = props.querySelector('button[data-flipx]');
  if (flipBtn) {
    flipBtn.addEventListener('click', () => {
      it.scale.x = -it.scale.x;
      markStageDirty();
      syncStageItemTransform(it);
      syncStageInspectorLive();
      StageGizmo.render();
    });
  }

  bindStageNumericInputs(props, {
    get(k) {
      const curM = getStageFrameMetrics();
      const wp = anchorToWorld(it.anchor, curM);
      if (k === 'anc.x') return it.anchor.x * 100;
      if (k === 'anc.y') return it.anchor.y * 100;
      if (k === 'px.x')  return wp.x;
      if (k === 'px.y')  return wp.y;
      if (k === 'scl.x') return it.scale.x;
      if (k === 'scl.y') return it.scale.y;
      if (k === 'rot')   return it.rotation;
      if (k === 'op')    return it.opacity ?? 1;
      if (k === 'piv.x') return (it.pivotOffset && it.pivotOffset.x) || 0;
      if (k === 'piv.y') return (it.pivotOffset && it.pivotOffset.y) || 0;
      if (k === 'anim.spd') return it.speed ?? 1;
      if (k === 'anim.ph')  return it.phase ?? 0;
      return 0;
    },
    set(k, v) {
      const curM = getStageFrameMetrics();
      const wp = anchorToWorld(it.anchor, curM);
      if (k === 'anc.x') it.anchor.x = v / 100;
      if (k === 'anc.y') it.anchor.y = v / 100;
      if (k === 'px.x')  it.anchor = worldToAnchor(v, wp.y, curM);
      if (k === 'px.y')  it.anchor = worldToAnchor(wp.x, v, curM);
      if (k === 'scl.x') it.scale.x = roundScaleVal(v);
      if (k === 'scl.y') it.scale.y = roundScaleVal(v);
      if (k === 'rot')   it.rotation = v;
      if (k === 'op')    it.opacity = clamp(v, 0, 1);
      if (k === 'piv.x') { it.pivotOffset = it.pivotOffset || { x: 0, y: 0 }; it.pivotOffset.x = v; }
      if (k === 'piv.y') { it.pivotOffset = it.pivotOffset || { x: 0, y: 0 }; it.pivotOffset.y = v; }
      if (k === 'anim.spd') it.speed = clamp(v, 0.05, 10);
      if (k === 'anim.ph')  {
        it.phase = v;
        const dom = App.stage.domItems[it.id];
        if (dom) applyInstanceAnimationPose(it, dom, App.stage.playing ? App.stage.time : 0);
      }
      markStageDirty();
      syncStageItemTransform(it, curM);
      updateStageSelSize();
      syncStageInspectorLive();
      StageGizmo.render();
    },
    reset: {
      'anc.x': 50, 'anc.y': 50,
      'px.x': 0,   'px.y': 0,
      'scl.x': 1,  'scl.y': 1,
      'rot': 0,    'op': 1,
      'piv.x': 0,  'piv.y': 0,
      'anim.spd': 1, 'anim.ph': 0
    }
  });
}

function bindStageNumericInputs(container, handlers) {
  container.querySelectorAll('input[data-skey]').forEach(inp => {
    const key = inp.dataset.skey;
    const apply = () => {
      const v = parseFloat(inp.value);
      if (!isFinite(v)) return;
      handlers.set(key, v);
    };
    inp.addEventListener('change', apply);
    inp.addEventListener('input', apply);
  });

  container.querySelectorAll('button[data-sspin]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.skey;
      const inp = container.querySelector('input[data-skey="' + key + '"]');
      const step = inp ? (parseFloat(inp.step) || 0.1) : 0.1;
      const dir = btn.dataset.sspin === 'up' ? 1 : -1;
      const next = handlers.get(key) + dir * step;
      handlers.set(key, next);
      if (inp) inp.value = String(Math.round(next * 1000) / 1000);
    });
  });

  container.querySelectorAll('button[data-sreset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sreset;
      if (handlers.reset && key in handlers.reset) {
        const rv = handlers.reset[key];
        handlers.set(key, rv);
        const inp = container.querySelector('input[data-skey="' + key + '"]');
        if (inp) inp.value = String(rv);
      }
    });
  });
}

function normalizeHex6(raw) {
  const s = String(raw || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  return '#243447';
}

function escapeHtmlAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// -------- открытие, сохранение и CRUD сцен --------

function fitStageView() {
  const m = getStageFrameMetrics();
  const vp = els.viewport;
  const W = vp.clientWidth || 1000;
  const H = vp.clientHeight || 640;
  const pad = 48;
  const z = Math.min(
    Math.max(40, W - pad * 2) / m.fw,
    Math.max(40, H - pad * 2) / m.fh
  );
  App.camera.x = 0;
  App.camera.y = 0;
  App.camera.zoom = clamp(z, 0.05, 20);
  App.stage.camera = clone(App.camera);
  applyCamera();
}

async function openStage(name) {
  if (!name) return;
  try {
    stopStagePreview();
    App.stage._suppressDirty = true;
    const res = await fetchStageData(name);
    App.stage.current = name;
    App.stage._selectedModalName = name;
    App.stage.assets = res.assets || [];
    App.stage.data = ensureStageStructure(res.stage, name);
    App.stage.selectedId = '__bg__';
    App.stage.selectedIds = new Set(['__bg__']);
    if (els.stageName) els.stageName.value = name;
    setPref(PREF_LAST_STAGE, name);

    await rebuildStageScene();
    renderStageLayers();
    renderStageProperties();
    fitStageView();

    App.stage._suppressDirty = false;
    clearStageDirty();
    setHint('Сцена «' + name + '» (' + App.stage.data.frame.width + '×' + App.stage.data.frame.height + ')', 2200);
  } catch (e) {
    App.stage._suppressDirty = false;
    setHint('Ошибка открытия сцены: ' + e.message, 3500);
  }
}

async function saveCurrentStage() {
  if (!App.stage.current || !App.stage.data) {
    setHint('Сначала откройте или создайте сцену', 2000);
    return false;
  }
  try {
    const out = clone(App.stage.data);
    out.name = App.stage.current;
    const res = await saveStageBackend(App.stage.current, out);
    clearStageDirty();
    if (res.mode === 'download') {
      setHint('Скачан файл сцены ' + App.stage.current + '.stage.json', 2200);
    } else {
      setHint('Сцена сохранена: stage/' + App.stage.current + '/stage.json', 2000);
    }
    return true;
  } catch (e) {
    setHint('Ошибка сохранения сцены: ' + e.message, 3400);
    return false;
  }
}

async function openInitialStageIfNeeded() {
  if (App.stage.current && App.stage.data) {
    await rebuildStageScene();
    renderStageLayers();
    renderStageProperties();
    applyCamera();
    return;
  }
  let list = [];
  try { list = await fetchStages(); } catch (_) {}
  const last = getPref(PREF_LAST_STAGE);
  if (last && list.includes(last)) {
    await openStage(last);
  } else if (list.length) {
    await openStage(list[0]);
  } else {
    const created = await createStageBackend('main_stage');
    await openStage(created);
  }
}

// -------- модалка управления сценами (#modal-stages) --------

async function populateStagesModalList() {
  if (!els.stagesList) return;
  els.stagesList.innerHTML = '<li class="empty">Загрузка…</li>';
  let list = [];
  try { list = await fetchStages(); } catch (_) {}

  els.stagesList.innerHTML = '';
  if (!list.length) {
    els.stagesList.innerHTML = '<li class="empty">Сцен пока нет — нажмите «Создать».</li>';
    return;
  }
  if (!App.stage._selectedModalName || !list.includes(App.stage._selectedModalName)) {
    App.stage._selectedModalName = App.stage.current || list[0];
  }

  for (const name of list) {
    const li = document.createElement('li');
    li.className = 'editable-list-row';
    li.dataset.name = name;
    if (name === App.stage._selectedModalName) li.classList.add('selected');
    li.innerHTML =
      '<span class="list-row-label"></span>' +
      (name === App.stage.current ? '<span class="stage-layer-badge">открыта</span>' : '');
    li.querySelector('.list-row-label').textContent = name;

    li.addEventListener('click', () => {
      App.stage._selectedModalName = name;
      els.stagesList.querySelectorAll('li').forEach(x => x.classList.toggle('selected', x === li));
    });
    li.addEventListener('dblclick', () => {
      requestOpenStageFromModal(name);
    });
    els.stagesList.appendChild(li);
  }
}

function openStagesModal() {
  App.stage._selectedModalName = App.stage.current;
  els.modalStages.hidden = false;
  populateStagesModalList();
}

function closeStagesModal() {
  els.modalStages.hidden = true;
}

function requestOpenStageFromModal(name) {
  const target = name || App.stage._selectedModalName;
  if (!target) {
    setHint('Выберите сцену в списке', 1600);
    return;
  }
  if (target === App.stage.current && !App.stage.dirty) {
    closeStagesModal();
    return;
  }
  guardStageUnsavedChanges(() => {
    closeStagesModal();
    openStage(target);
  });
}

async function createStageFromModal() {
  try {
    const newName = await createStageBackend('');
    App.stage._selectedModalName = newName;
    await populateStagesModalList();
    guardStageUnsavedChanges(async () => {
      closeStagesModal();
      await openStage(newName);
    });
  } catch (e) {
    setHint('Ошибка создания сцены: ' + e.message, 3200);
  }
}

async function cloneStageFromModal() {
  const src = App.stage._selectedModalName;
  if (!src) { setHint('Выберите сцену для клонирования', 1800); return; }
  try {
    const newName = await cloneStageBackend(src);
    App.stage._selectedModalName = newName;
    await populateStagesModalList();
    setHint('Создана копия сцены «' + newName + '»', 2000);
  } catch (e) {
    setHint('Ошибка клонирования сцены: ' + e.message, 3200);
  }
}

function startStageModalInlineRename() {
  const cur = App.stage._selectedModalName;
  if (!cur) { setHint('Выберите сцену для переименования', 1800); return; }
  const row = Array.from(els.stagesList.querySelectorAll('li.editable-list-row'))
    .find(li => li.dataset.name === cur);
  if (!row) return;
  const labelEl = row.querySelector('.list-row-label');
  if (!labelEl) return;

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'list-row-input';
  inp.value = cur;
  labelEl.replaceWith(inp);
  inp.focus();
  inp.select();

  let done = false;
  async function finish(commit) {
    if (done) return;
    done = true;
    if (commit) {
      try {
        const renamed = await renameStageBackend(cur, inp.value);
        App.stage._selectedModalName = renamed;
        setHint('Сцена переименована: ' + renamed, 1800);
      } catch (e) {
        setHint('Ошибка переименования: ' + e.message, 3000);
      }
    }
    await populateStagesModalList();
  }

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
}

function deleteStageFromModal() {
  const target = App.stage._selectedModalName;
  if (!target) { setHint('Выберите сцену для удаления', 1800); return; }
  confirmDialog(
    'Удалить сцену?',
    'Удалить сцену «' + target + '» без возможности отмены?',
    async () => {
      try {
        await deleteStageBackend(target);
        if (App.stage.current === target) {
          App.stage.current = null;
          App.stage.data = null;
          clearStageDirty();
          if (els.stageName) els.stageName.value = '';
          if (App.stage.frameDom) App.stage.frameDom.itemsLayer.innerHTML = '';
          await openInitialStageIfNeeded();
        }
        App.stage._selectedModalName = App.stage.current;
        await populateStagesModalList();
        setHint('Сцена «' + target + '» удалена', 1800);
      } catch (e) {
        setHint('Ошибка удаления сцены: ' + e.message, 3200);
      }
    }
  );
}

// -------- переключение режимов «Анимация объектов» (малиновый) / «Сцена» (зелёный) --------

async function setEditorMode(nextMode) {
  if (nextMode !== 'object' && nextMode !== 'stage') return;
  if (App.editorMode === nextMode) return;

  const toStage = (nextMode === 'stage');
  if (toStage) {
    if (App.anim.playing && typeof stopPlayback === 'function') stopPlayback();
    App.objectCamera = clone(App.camera);
    syncLiveObjectToStageCache();
  } else {
    stopStagePreview();
    App.stage.camera = clone(App.camera);
  }

  App.editorMode = nextMode;
  document.body.setAttribute('data-editor-mode', nextMode);

  // Кнопка-индикатор в шапке
  if (els.btnEditorMode) {
    els.btnEditorMode.classList.toggle('mode-object', !toStage);
    els.btnEditorMode.classList.toggle('mode-stage', toStage);
    els.btnEditorMode.title = toStage
      ? 'Текущий режим: Редактор сцены (зелёный). Нажмите для возврата в Анимацию объектов (малиновый)'
      : 'Текущий режим: Анимация объектов (малиновый). Нажмите для перехода в Редактор сцены (зелёный)';
  }
  if (els.editorModeIcon)  els.editorModeIcon.textContent  = toStage ? 'landscape' : 'animation';
  if (els.editorModeLabel) els.editorModeLabel.textContent = toStage ? 'СЦЕНА' : 'АНИМАЦИЯ';

  // Верхняя панель
  if (els.headerObjectControls) els.headerObjectControls.hidden = toStage;
  if (els.headerStageControls)  els.headerStageControls.hidden  = !toStage;

  // Вьюпорт и оверлеи Gizmo
  if (els.scene)         els.scene.style.display = toStage ? 'none' : '';
  if (els.onion)         els.onion.style.display = toStage ? 'none' : '';
  if (els.gizmoSvg)      els.gizmoSvg.hidden = toStage;
  if (els.stageRoot)     els.stageRoot.style.display = toStage ? '' : 'none';
  if (els.stageGizmoSvg) els.stageGizmoSvg.hidden = !toStage;

  // Панель инструментов, таймлайн и нижняя панель сцены
  $$('.obj-mode-only').forEach(el => { el.hidden = toStage; });
  $$('.stage-mode-only').forEach(el => { el.hidden = !toStage; });
  if (els.playbackBar) els.playbackBar.hidden = toStage;
  if (els.timeline)    els.timeline.hidden    = toStage;
  if (els.stageBar)    els.stageBar.hidden    = !toStage;

  // Правая панель слоёв
  if (els.layersHeaderTitle)   els.layersHeaderTitle.textContent = toStage ? 'Слои сцены' : 'Слои';
  if (els.layersActionsObject) els.layersActionsObject.hidden = toStage;
  if (els.layersActionsStage)  els.layersActionsStage.hidden  = !toStage;
  if (els.layersList)          els.layersList.hidden          = toStage;
  if (els.stageLayersList)     els.stageLayersList.hidden     = !toStage;

  updateSaveButtonUI();

  if (toStage) {
    els.viewport.classList.remove('bg-checker');
    els.viewport.style.background = '';
    App.camera = clone(App.stage.camera);
    await openInitialStageIfNeeded();
  } else {
    App.camera = clone(App.objectCamera);
    applyBackgroundToViewport();
    applyCamera();
    renderLayers();
    renderProperties();
    updateSelSize();
    renderTimeline();
    Gizmo.render();
  }
}

function toggleEditorMode() {
  setEditorMode(App.editorMode === 'stage' ? 'object' : 'stage');
}

// -------- инициализация всех привязок Редактора сцены --------

function setupStageEditor() {
  StageGizmo.init();

  if (els.btnEditorMode) {
    els.btnEditorMode.addEventListener('click', toggleEditorMode);
  }

  // Inline-переименование имени сцены в шапке
  if (typeof setupHeaderInlineRename === 'function') {
    setupHeaderInlineRename(
      els.stageNameGroup,
      els.stageName,
      els.btnStageInlineRename,
      () => App.stage.current || '',
      async (oldName, rawNewName) => {
        try {
          const name = await renameStageBackend(oldName, rawNewName);
          setHint('Сцена переименована: ' + name, 1800);
          return { ok: true, name };
        } catch (e) {
          setHint(e.message, 2800);
          return { ok: false };
        }
      }
    );
  }

  if (els.btnStageFit) {
    els.btnStageFit.addEventListener('click', () => {
      setStageSelection(['__bg__'], '__bg__');
      fitStageView();
    });
  }

  // Модалка «Сцены»
  if (els.btnStages) els.btnStages.addEventListener('click', openStagesModal);
  if (els.modalStagesX) els.modalStagesX.addEventListener('click', closeStagesModal);
  if (els.modalStagesClose) els.modalStagesClose.addEventListener('click', closeStagesModal);
  if (els.modalStages) {
    els.modalStages.addEventListener('click', (e) => {
      if (e.target === els.modalStages) closeStagesModal();
    });
  }
  if (els.stageAdd)    els.stageAdd.addEventListener('click', createStageFromModal);
  if (els.stageClone)  els.stageClone.addEventListener('click', cloneStageFromModal);
  if (els.stageRename) els.stageRename.addEventListener('click', startStageModalInlineRename);
  if (els.stageDelete) els.stageDelete.addEventListener('click', deleteStageFromModal);
  if (els.stageOpen)   els.stageOpen.addEventListener('click', () => requestOpenStageFromModal());

  // Инструменты во вьюпорте сцены
  if (els.btnStageClip) {
    els.btnStageClip.addEventListener('click', () => {
      App.stage.clipFrame = !App.stage.clipFrame;
      els.btnStageClip.classList.toggle('active', App.stage.clipFrame);
      renderStageBackground();
      setHint('Обрезка по рамке экрана: ' + (App.stage.clipFrame ? 'ВКЛ' : 'ВЫКЛ'), 1500);
    });
  }
  if (els.btnStageCenter) {
    els.btnStageCenter.addEventListener('click', () => {
      const leaves = getSelectedTransformLeafItems();
      if (!leaves.length) {
        setHint('Выберите объект или группу для центрирования', 1600);
        return;
      }
      if (leaves.length === 1) {
        leaves[0].anchor = { x: 0.5, y: 0.5 };
        syncStageItemTransform(leaves[0]);
      } else {
        const m = getStageFrameMetrics();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const it of leaves) {
          const b = getStageItemWorldAABB(it, m);
          if (b.minX < minX) minX = b.minX;
          if (b.minY < minY) minY = b.minY;
          if (b.maxX > maxX) maxX = b.maxX;
          if (b.maxY > maxY) maxY = b.maxY;
        }
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        for (const it of leaves) {
          const wp = anchorToWorld(it.anchor, m);
          it.anchor = worldToAnchor(wp.x - cx, wp.y - cy, m);
          syncStageItemTransform(it, m);
        }
      }
      markStageDirty();
      syncStageInspectorLive();
      StageGizmo.render();
    });
  }

  // Слои сцены и модалка добавления
  if (els.btnStageAddLayer)  els.btnStageAddLayer.addEventListener('click', openStagePickModal);
  if (els.btnStageAddFolder) els.btnStageAddFolder.addEventListener('click', createStageFolder);
  if (els.btnStageDelLayer)  els.btnStageDelLayer.addEventListener('click', deleteSelectedStageItems);

  if (els.stagePickCloseX) els.stagePickCloseX.addEventListener('click', closeStagePickModal);
  if (els.stagePickCancel) els.stagePickCancel.addEventListener('click', closeStagePickModal);
  if (els.modalStagePickObj) {
    els.modalStagePickObj.addEventListener('click', (e) => {
      if (e.target === els.modalStagePickObj) closeStagePickModal();
    });
  }
  if (els.stagePickTabObj) {
    els.stagePickTabObj.addEventListener('click', () => {
      App.stage._pickTab = 'object';
      App.stage._pickSelected = null;
      renderStagePickList();
    });
  }
  if (els.stagePickTabAsset) {
    els.stagePickTabAsset.addEventListener('click', () => {
      App.stage._pickTab = 'asset';
      App.stage._pickSelected = null;
      renderStagePickList();
    });
  }
  if (els.stagePickUpload) {
    els.stagePickUpload.addEventListener('click', () => triggerStageFileUpload('asset'));
  }
  if (els.stagePickAdd) {
    els.stagePickAdd.addEventListener('click', confirmAddStageLayerFromModal);
  }
  if (els.stageFileInput) {
    els.stageFileInput.addEventListener('change', handleStageFileInputChange);
  }

  // Нижняя панель предпросмотра сцены и резинового теста экрана
  if (els.stagePlay) {
    els.stagePlay.addEventListener('click', () => {
      if (App.stage.playing) pauseStagePreview();
      else startStagePreview();
    });
  }
  if (els.stageStop) {
    els.stageStop.addEventListener('click', stopStagePreview);
  }
  if (els.stageSpeed) {
    els.stageSpeed.addEventListener('change', () => {
      App.stage.speed = parseFloat(els.stageSpeed.value) || 1;
    });
  }

  function onRubberSliderInput() {
    renderStageBackground();
    syncAllStageTransforms();
    updateStageSelSize();
    syncStageInspectorLive();
    StageGizmo.render();
  }
  if (els.stageRubberW) els.stageRubberW.addEventListener('input', onRubberSliderInput);
  if (els.stageRubberH) els.stageRubberH.addEventListener('input', onRubberSliderInput);
  if (els.stageRubberReset) {
    els.stageRubberReset.addEventListener('click', () => {
      if (els.stageRubberW) els.stageRubberW.value = '100';
      if (els.stageRubberH) els.stageRubberH.value = '100';
      onRubberSliderInput();
    });
  }

  // Курсор Ctrl+Drag во вьюпорте сцены
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Control' || e.key === 'Meta') {
      App.ctrlDown = true;
      if (App.editorMode === 'stage' && els.viewport) {
        els.viewport.classList.add('ctrl-drag-ready');
      }
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Control' || e.key === 'Meta') {
      App.ctrlDown = false;
      if (els.viewport) els.viewport.classList.remove('ctrl-drag-ready');
    }
  });
  window.addEventListener('blur', () => {
    App.ctrlDown = false;
    if (els.viewport) els.viewport.classList.remove('ctrl-drag-ready');
  });
}
