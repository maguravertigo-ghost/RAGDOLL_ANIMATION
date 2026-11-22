'use strict';

// ============================================================
//  stage.js — Редактор сцены (v0.6.0):
//    • Два режима редактора (Малиновый: Анимация объектов / Зелёный: Сцена)
//    • Скрытие ключевого таймлайна в режиме Сцены + сворачивание нижней панели
//    • Встроенный слой «Бэкграунд» (свойства свёрнуты по умолчанию)
//    • Фрэйм игры 1366×768 и полноэкранный Предпросмотр (выход по ESC + опциональный FPS нагрузки)
//    • Тактильные направляющие с курсором-рукой, меню направляющих (цвет/прозрачность/список) и сетка макета
//    • Кастомное ПКМ-меню слоёв/объектов/направляющих, сворачивание папок, групповое выравнивание и свойства
// ============================================================

// -------- 2D аффинная математика для точного расчёта границ и единого пивота --------

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

// -------- нормализация модели сцены, направляющих и метаданных игры --------

function nextStageItemId(prefix) {
  const items = (App.stage.data && App.stage.data.items) || [];
  const used = new Set(items.map(it => it.id));
  let idx = 1;
  while (used.has(prefix + '_' + idx)) idx++;
  return prefix + '_' + idx;
}

function nextStageGuideId() {
  const guides = (App.stage.data && App.stage.data.guides) || [];
  const used = new Set(guides.map(g => g.id));
  let idx = 1;
  while (used.has('guide_' + idx)) idx++;
  return 'guide_' + idx;
}

function normalizeStageInteraction(raw, itemType) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const defaultRole = itemType === 'object' ? 'animated' : 'static';
  const role = ['static', 'animated', 'interactive', 'scripted'].includes(src.role)
    ? src.role
    : defaultRole;
  return {
    role,
    gameTag: typeof src.gameTag === 'string' ? src.gameTag : '',
    clickable: !!src.clickable,
    draggable: !!src.draggable,
    onClickAnim: typeof src.onClickAnim === 'string' ? src.onClickAnim : '',
    initialState: src.initialState === 'hidden' ? 'hidden' : 'visible'
  };
}

function ensureStageStructure(stageObj, fallbackName) {
  const s = stageObj && typeof stageObj === 'object' ? stageObj : {};
  s.version = 2;
  s.name = s.name || fallbackName || 'stage';
  s.sceneKind = s.sceneKind === 'cutscene' ? 'cutscene' : 'gameplay';
  if (!Array.isArray(s.cutscenes)) s.cutscenes = [];

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

  // Относительные направляющие сцены: axis ('v' | 'h'), pos (0..1 относительно ширины/высоты фрэйма)
  if (!Array.isArray(s.guides)) s.guides = [];
  s.guides = s.guides
    .filter(g => g && (g.axis === 'v' || g.axis === 'h') && isFinite(g.pos))
    .map((g, idx) => ({
      id: g.id || ('guide_' + (idx + 1)),
      axis: g.axis,
      pos: Number(g.pos)
    }));

  if (!s.guideStyle || typeof s.guideStyle !== 'object') {
    s.guideStyle = { color: '#3bc9db', opacity: 0.88 };
  } else {
    s.guideStyle.color = (typeof s.guideStyle.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.guideStyle.color))
      ? s.guideStyle.color
      : '#3bc9db';
    s.guideStyle.opacity = isFinite(Number(s.guideStyle.opacity))
      ? clamp(Number(s.guideStyle.opacity), 0.15, 1)
      : 0.88;
  }

  if (!Array.isArray(s.items)) s.items = [];
  for (let i = 0; i < s.items.length; i++) {
    const it = s.items[i];
    if (!it.id) it.id = 'item_' + (i + 1);
    if (!it.label) it.label = it.objectName || it.file || it.id;
    it.parent = it.parent || null;
    if (it.visible === undefined) it.visible = true;
    if (it.opacity === undefined) it.opacity = 1;
    if (it.isGroup) {
      it.editorOnly = !!it.editorOnly;
      continue;
    }

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

    // У каждого объекта на сцене строго ОДИН единый Pivot Point (исходный верхнеуровневый)
    delete it.pivotOffset;

    if (it.type === 'object') {
      if (typeof it.animation !== 'string') it.animation = 'idle';
      if (it.loop === undefined) it.loop = true;
      it.speed = isFinite(it.speed) && it.speed > 0 ? Number(it.speed) : 1;
      it.phase = isFinite(it.phase) ? Number(it.phase) : 0;
    }
    it.interaction = normalizeStageInteraction(it.interaction, it.type);
  }
  return s;
}

function syncStageRubberSlidersToBase() {
  const st = App.stage.data;
  const baseW = (st && st.frame && st.frame.width)  || 1366;
  const baseH = (st && st.frame && st.frame.height) || 768;
  App.stage.testWidth = null;
  App.stage.testHeight = null;
  if (els.stageRubberW) {
    els.stageRubberW.min = String(Math.min(360, Math.round(baseW * 0.35)));
    els.stageRubberW.max = String(Math.max(2560, Math.round(baseW * 2)));
    els.stageRubberW.value = String(baseW);
  }
  if (els.stageRubberH) {
    els.stageRubberH.min = String(Math.min(240, Math.round(baseH * 0.35)));
    els.stageRubberH.max = String(Math.max(1440, Math.round(baseH * 2)));
    els.stageRubberH.value = String(baseH);
  }
}

function getStageFrameMetrics() {
  const st = App.stage.data;
  const baseW = (st && st.frame && st.frame.width)  || 1366;
  const baseH = (st && st.frame && st.frame.height) || 768;
  let fw = baseW;
  let fh = baseH;
  if (!App.stage.previewFullscreen) {
    if (isFinite(App.stage.testWidth) && App.stage.testWidth > 0) {
      fw = Math.round(App.stage.testWidth);
    }
    if (isFinite(App.stage.testHeight) && App.stage.testHeight > 0) {
      fh = Math.round(App.stage.testHeight);
    }
  }
  fw = Math.max(64, fw);
  fh = Math.max(64, fh);
  return {
    baseW,
    baseH,
    fw,
    fh,
    pctW: (fw / baseW) * 100,
    pctH: (fh / baseH) * 100,
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

function guideToWorldCoord(guide, metrics) {
  const m = metrics || getStageFrameMetrics();
  if (guide.axis === 'v') return (guide.pos - 0.5) * m.fw;
  return (guide.pos - 0.5) * m.fh;
}

function worldCoordToGuidePos(axis, wCoord, metrics) {
  const m = metrics || getStageFrameMetrics();
  if (axis === 'v') return m.fw > 0 ? (wCoord / m.fw + 0.5) : 0.5;
  return m.fh > 0 ? (wCoord / m.fh + 0.5) : 0.5;
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

// -------- компиляция шаблонов объектов и их единого верхнеуровневого Pivot Point --------

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

  // Единый верхнеуровневый Pivot Point объекта
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

// -------- построение и синхронизация SVG-сцены --------

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
  borderRect.setAttribute('vector-effect', 'non-scaling-stroke');

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
  const clipNow = !!(App.stage.clipFrame || App.stage.previewFullscreen);
  if (clipNow) {
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
    const pctText = (Math.round(m.pctW) === 100 && Math.round(m.pctH) === 100)
      ? '100%'
      : (Math.round(m.pctW) + '%×' + Math.round(m.pctH) + '%');
    els.stageRubberReadout.textContent = m.fw + ' × ' + m.fh + ' (' + pctText + ')';
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
      el.setAttribute('x', String(-natW / 2));
      el.setAttribute('y', String(-natH / 2));
      el.setAttribute('width', String(natW));
      el.setAttribute('height', String(natH));
      el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    } else {
      el.setAttribute('x', String(x));
      el.setAttribute('y', String(y));
      el.setAttribute('width', String(m.fw));
      el.setAttribute('height', String(m.fh));
      el.setAttribute('preserveAspectRatio', getPreserveAspectRatioForFit(bg.fit));
    }
  } catch (e) {
    console.warn('Stage: ошибка загрузки фона', bg.file, e);
  }
}

function buildObjectInstanceDom(item, tpl) {
  const outerG = document.createElementNS(SVG_NS, 'g');
  outerG.setAttribute('class', 'stage-item stage-item-object');
  outerG.setAttribute('data-stage-item-id', item.id);

  const rigWrap = document.createElementNS(SVG_NS, 'g');
  rigWrap.setAttribute('class', 'stage-rig-wrap');
  outerG.appendChild(rigWrap);

  const partNodes = [];
  const byIdNode = {};
  for (let i = 0; i < tpl.compiledParts.length; i++) {
    const cp = tpl.compiledParts[i];
    const g = document.createElementNS(SVG_NS, 'g');
    if (cp.opacity !== 1) g.setAttribute('opacity', String(cp.opacity));
    if (!cp.isGroup && cp.file && tpl.svgMap[cp.file]) {
      const srcSvg = tpl.svgMap[cp.file];
      const svgClone = (typeof cloneSvgForDom === 'function')
        ? cloneSvgForDom(srcSvg)
        : srcSvg.cloneNode(true);
      g.appendChild(svgClone);
    }
    const baseTrStr = buildRigPartTransformStr(
      cp, cp.basePosX, cp.basePosY, cp.baseRot,
      cp.baseSclX, cp.baseSclY, cp.baseSkwX, cp.baseSkwY
    );
    g.setAttribute('transform', baseTrStr);
    g.style.display = cp.baseVis ? '' : 'none';
    byIdNode[cp.id] = g;
    partNodes.push({
      el: g,
      lastTr: baseTrStr,
      lastVis: cp.baseVis
    });
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
  const hiddenInPreview = App.stage.previewFullscreen &&
    item.interaction && item.interaction.initialState === 'hidden';
  const hid = (item.visible === false) || hiddenInPreview;
  dom.outerG.style.display = hid ? 'none' : '';
  dom.outerG.style.opacity = String(clamp(Number(item.opacity ?? 1), 0, 1));
  if (item.isGroup) return;

  const m = metrics || getStageFrameMetrics();
  const wpos = anchorToWorld(item.anchor, m);
  const eff = getItemEffectiveScale(item, m);

  let outerTr = 'translate(' + wpos.x + ' ' + wpos.y + ')';
  if (item.rotation) outerTr += ' rotate(' + item.rotation + ')';
  if (eff.x !== 1 || eff.y !== 1) outerTr += ' scale(' + eff.x + ' ' + eff.y + ')';
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
  renderStageRulersAndGuides();
  StageGizmo.render();
}

// -------- оценка поз анимации экземпляров (60 FPS, 0 аллокаций в кадр) --------

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

// -------- Полноэкранный Предпросмотр сцены 1366×768 без UI (выход по ESC) --------

const PREF_STAGE_PREVIEW_FPS = 'animEditor.stagePreviewFps';

function syncStagePreviewFpsHudVisibility() {
  if (!els.stagePreviewFpsHud) return;
  const showHud = !!(App.stage.playing && App.stage.previewFullscreen && App.stage.showPreviewFps);
  els.stagePreviewFpsHud.hidden = !showHud;
  if (showHud && !els.stagePreviewFpsHud.textContent) {
    els.stagePreviewFpsHud.textContent = '60 FPS · замер нагрузки…';
  }
}

function updateStagePreviewUI() {
  const on = !!App.stage.playing;
  if (els.stagePlay) els.stagePlay.classList.toggle('playing', on);
  if (els.stagePlayIcon) els.stagePlayIcon.textContent = on ? 'pause' : 'play_arrow';
  if (els.stagePlayLabel) {
    els.stagePlayLabel.textContent = on ? 'Идёт предпросмотр (ESC — выход)' : 'Предпросмотр (ESC — выход)';
  }
  if (els.stageFpsBadge) {
    els.stageFpsBadge.hidden = !(on && !App.stage.previewFullscreen);
  }
  syncStagePreviewFpsHudVisibility();
}

function countActiveAnimatedStageObjects() {
  if (!App.stage.data || !Array.isArray(App.stage.data.items)) return 0;
  let cnt = 0;
  for (const it of App.stage.data.items) {
    if (!it.isGroup && isStageItemVisible(it)) cnt++;
  }
  return cnt;
}

function startStageAnimationLoop() {
  if (App.stage.playing) return;
  App.stage.playing = true;
  App.stage.lastTs = 0;
  App.stage.time = 0;
  App.stage.fpsSamples = [];
  const dtSamples = [];
  const evalSamples = [];
  updateStagePreviewUI();

  function tick(ts) {
    if (!App.stage.playing) return;
    let dtMs = 0;
    if (App.stage.lastTs > 0) {
      dtMs = ts - App.stage.lastTs;
      const dt = Math.min(0.1, Math.max(0, dtMs / 1000));
      App.stage.time += dt * (App.stage.speed || 1);
    }
    App.stage.lastTs = ts;

    const tEval0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    evaluateStageAnimationsAtTime(App.stage.time);
    const evalMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tEval0;

    if (dtMs > 0.2) {
      const samples = App.stage.fpsSamples;
      samples.push(1000 / dtMs);
      dtSamples.push(dtMs);
      evalSamples.push(evalMs);
      if (samples.length > 24) samples.shift();
      if (dtSamples.length > 24) dtSamples.shift();
      if (evalSamples.length > 24) evalSamples.shift();

      if ((samples.length & 3) === 0) {
        let sumFps = 0, sumDt = 0, sumEv = 0;
        for (let i = 0; i < samples.length; i++) {
          sumFps += samples[i];
          sumDt  += dtSamples[i];
          sumEv  += evalSamples[i];
        }
        const avgFps = Math.round(sumFps / samples.length);
        const avgDt  = sumDt / samples.length;
        const avgEv  = sumEv / samples.length;

        if (els.stageFpsBadge && !App.stage.previewFullscreen) {
          els.stageFpsBadge.textContent = avgFps + ' FPS';
        }
        if (els.stagePreviewFpsHud && App.stage.previewFullscreen && App.stage.showPreviewFps) {
          const visLayers = countActiveAnimatedStageObjects();
          els.stagePreviewFpsHud.hidden = false;
          els.stagePreviewFpsHud.classList.toggle('fps-warn', avgFps < 50 && avgFps >= 30);
          els.stagePreviewFpsHud.classList.toggle('fps-low', avgFps < 30);
          els.stagePreviewFpsHud.textContent =
            avgFps + ' FPS · кадр ' + avgDt.toFixed(1) + ' мс · риг ' + avgEv.toFixed(2) + ' мс · ' + visLayers + ' сл.';
        }
      }
    }
    App.stage.raf = requestAnimationFrame(tick);
  }

  App.stage.raf = requestAnimationFrame(tick);
}

function stopStagePreview() {
  App.stage.playing = false;
  if (App.stage.raf) {
    cancelAnimationFrame(App.stage.raf);
    App.stage.raf = null;
  }
  App.stage.time = 0;
  evaluateStageAnimationsAtTime(0);
  updateStagePreviewUI();
}

function fitStagePreviewFullscreenCamera() {
  if (!els.viewport) return;
  const m = getStageFrameMetrics();
  const W = Math.max(64, els.viewport.clientWidth || window.innerWidth || m.fw);
  const H = Math.max(64, els.viewport.clientHeight || window.innerHeight || m.fh);
  const z = Math.min(W / m.fw, H / m.fh);
  App.camera.x = 0;
  App.camera.y = 0;
  App.camera.zoom = clamp(z, 0.05, 20);
  applyCamera();
}

function enterStageFullscreenPreview() {
  if (App.editorMode !== 'stage' || !App.stage.data) return;
  if (App.stage.previewFullscreen) return;

  App.stage.savedCameraBeforePreview = clone(App.camera);
  App.stage.previewFullscreen = true;
  document.body.classList.add('stage-preview-fullscreen');
  setHint('');

  renderStageBackground();
  syncAllStageTransforms();
  fitStagePreviewFullscreenCamera();
  startStageAnimationLoop();

  if (document.documentElement && typeof document.documentElement.requestFullscreen === 'function') {
    try {
      const p = document.documentElement.requestFullscreen();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {}
  }

  requestAnimationFrame(() => {
    if (App.stage.previewFullscreen) fitStagePreviewFullscreenCamera();
  });
}

function exitStageFullscreenPreview() {
  if (!App.stage.previewFullscreen) {
    stopStagePreview();
    return;
  }
  App.stage.previewFullscreen = false;
  document.body.classList.remove('stage-preview-fullscreen');
  stopStagePreview();

  if (typeof document !== 'undefined' && document.fullscreenElement &&
      typeof document.exitFullscreen === 'function') {
    try {
      const p = document.exitFullscreen();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {}
  }

  renderStageBackground();
  syncAllStageTransforms();
  if (App.stage.savedCameraBeforePreview) {
    App.camera = clone(App.stage.savedCameraBeforePreview);
    App.stage.savedCameraBeforePreview = null;
  }
  requestAnimationFrame(() => {
    applyCamera();
    renderStageRulersAndGuides();
    StageGizmo.render();
  });
}

// -------- геометрические границы элементов сцены и единого Pivot Point --------

function getStageItemLocalBox(item) {
  const dom = App.stage.domItems[item.id];
  if (dom && dom.kind === 'object' && dom.tpl) return dom.tpl.localBox;
  if (dom && dom.kind === 'asset' && dom.localBox) return dom.localBox;
  return { x: -50, y: -50, w: 100, h: 100 };
}

function getStageItemWorldPointWithCenter(item, wpos, lx, ly, metrics) {
  const eff = getItemEffectiveScale(item, metrics);
  const sx = lx * eff.x;
  const sy = ly * eff.y;
  const rad = (item.rotation || 0) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return {
    x: wpos.x + sx * c - sy * s,
    y: wpos.y + sx * s + sy * c
  };
}

function getStageItemWorldAABBAtPos(item, wpos, metrics) {
  const box = getStageItemLocalBox(item);
  const corners = [
    getStageItemWorldPointWithCenter(item, wpos, box.x, box.y, metrics),
    getStageItemWorldPointWithCenter(item, wpos, box.x + box.w, box.y, metrics),
    getStageItemWorldPointWithCenter(item, wpos, box.x + box.w, box.y + box.h, metrics),
    getStageItemWorldPointWithCenter(item, wpos, box.x, box.y + box.h, metrics)
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

function getStageItemWorldAABB(item, metrics) {
  const m = metrics || getStageFrameMetrics();
  const wpos = anchorToWorld(item.anchor, m);
  return getStageItemWorldAABBAtPos(item, wpos, m);
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
  const lx = rx / eff.x;
  const ly = ry / eff.y;
  const box = getStageItemLocalBox(item);
  return lx >= box.x && lx <= box.x + box.w && ly >= box.y && ly <= box.y + box.h;
}

function findTopmostStageItemAtWorld(wx, wy) {
  if (!App.stage.data) return null;
  const metrics = getStageFrameMetrics();
  const ordered = getOrderedStageLeafItems();
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (hitTestStageItemAtWorld(ordered[i], wx, wy, metrics)) {
      return ordered[i];
    }
  }
  return null;
}

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

function clientToStageWorld(clientX, clientY, allowGridSnap) {
  let cx = clientX, cy = clientY;
  if (allowGridSnap && App.grid.snap) {
    const sp = App.snapClientToGrid(clientX, clientY);
    cx = sp.x; cy = sp.y;
  }
  const rect = els.viewport.getBoundingClientRect();
  return screenToWorld(cx - rect.left, cy - rect.top);
}

// -------- Inkscape-Линейки, Вытягиваемые Направляющие и Привязка --------

const RULER_THICK = 20;
let _guideDrag = null;

function chooseRulerStep(zoom) {
  const targetPx = 65;
  const rawWorld = targetPx / Math.max(0.02, zoom || 1);
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i] >= rawWorld) return steps[i];
  }
  return 2000;
}

function renderStageRulersCanvas(metrics) {
  if (!els.viewport || !els.stageRulerH || !els.stageRulerV) return;
  const show = (App.editorMode === 'stage') && !!App.stage.showRulers && !App.stage.previewFullscreen;
  if (els.stageRulerCorner) els.stageRulerCorner.hidden = !show;
  els.stageRulerH.hidden = !show;
  els.stageRulerV.hidden = !show;
  if (!show) return;

  const vpW = els.viewport.clientWidth || 800;
  const vpH = els.viewport.clientHeight || 500;
  const z = App.camera.zoom || 1;
  const cx = vpW / 2;
  const cy = vpH / 2;
  const m = metrics || getStageFrameMetrics();
  const frameLeftWorld = -m.fw / 2;
  const frameTopWorld  = -m.fh / 2;

  const majorStep = chooseRulerStep(z);
  const minorStep = majorStep / 5;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;

  // Горизонтальная линейка (координаты 0..fw от левого края фрэйма сцены)
  const hCanvas = els.stageRulerHCanvas;
  if (hCanvas && typeof hCanvas.getContext === 'function') {
    const wPx = Math.max(1, vpW - RULER_THICK);
    const hPx = RULER_THICK;
    if (hCanvas.width !== Math.round(wPx * dpr) || hCanvas.height !== Math.round(hPx * dpr)) {
      hCanvas.width = Math.round(wPx * dpr);
      hCanvas.height = Math.round(hPx * dpr);
    }
    const ctx = hCanvas.getContext('2d');
    if (ctx) {
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, wPx, hPx);

      // Подсветка диапазона самого фрэйма 0..fw
      const xFrame0 = (frameLeftWorld - App.camera.x) * z + cx - RULER_THICK;
      const xFrame1 = (frameLeftWorld + m.fw - App.camera.x) * z + cx - RULER_THICK;
      ctx.fillStyle = 'rgba(81, 207, 102, 0.08)';
      ctx.fillRect(Math.max(0, xFrame0), 0, Math.max(0, Math.min(wPx, xFrame1) - Math.max(0, xFrame0)), hPx);

      const worldMin = (RULER_THICK - cx) / z + App.camera.x;
      const worldMax = (vpW - cx) / z + App.camera.x;
      const fMin = worldMin - frameLeftWorld;
      const fMax = worldMax - frameLeftWorld;
      const firstMinor = Math.floor(fMin / minorStep) * minorStep;

      ctx.strokeStyle = '#5c6470';
      ctx.fillStyle = '#adb5bd';
      ctx.font = '9px ui-monospace, Consolas, monospace';
      ctx.textBaseline = 'top';
      ctx.beginPath();
      for (let fv = firstMinor; fv <= fMax + minorStep * 0.5; fv += minorStep) {
        const wx = frameLeftWorld + fv;
        const sx = (wx - App.camera.x) * z + cx - RULER_THICK;
        if (sx < -2 || sx > wPx + 2) continue;
        const isMajor = Math.abs(fv / majorStep - Math.round(fv / majorStep)) < 1e-3;
        const tickLen = isMajor ? 11 : 5;
        const xSnap = Math.round(sx) + 0.5;
        ctx.moveTo(xSnap, hPx);
        ctx.lineTo(xSnap, hPx - tickLen);
        if (isMajor) {
          ctx.fillText(String(Math.round(fv)), xSnap + 2, 2);
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // Вертикальная линейка (координаты 0..fh от верхнего края фрэйма сцены)
  const vCanvas = els.stageRulerVCanvas;
  if (vCanvas && typeof vCanvas.getContext === 'function') {
    const wPx = RULER_THICK;
    const hPx = Math.max(1, vpH - RULER_THICK);
    if (vCanvas.width !== Math.round(wPx * dpr) || vCanvas.height !== Math.round(hPx * dpr)) {
      vCanvas.width = Math.round(wPx * dpr);
      vCanvas.height = Math.round(hPx * dpr);
    }
    const ctx = vCanvas.getContext('2d');
    if (ctx) {
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, wPx, hPx);

      const yFrame0 = (frameTopWorld - App.camera.y) * z + cy - RULER_THICK;
      const yFrame1 = (frameTopWorld + m.fh - App.camera.y) * z + cy - RULER_THICK;
      ctx.fillStyle = 'rgba(81, 207, 102, 0.08)';
      ctx.fillRect(0, Math.max(0, yFrame0), wPx, Math.max(0, Math.min(hPx, yFrame1) - Math.max(0, yFrame0)));

      const worldMin = (RULER_THICK - cy) / z + App.camera.y;
      const worldMax = (vpH - cy) / z + App.camera.y;
      const fMin = worldMin - frameTopWorld;
      const fMax = worldMax - frameTopWorld;
      const firstMinor = Math.floor(fMin / minorStep) * minorStep;

      ctx.strokeStyle = '#5c6470';
      ctx.fillStyle = '#adb5bd';
      ctx.font = '9px ui-monospace, Consolas, monospace';
      ctx.beginPath();
      for (let fv = firstMinor; fv <= fMax + minorStep * 0.5; fv += minorStep) {
        const wy = frameTopWorld + fv;
        const sy = (wy - App.camera.y) * z + cy - RULER_THICK;
        if (sy < -2 || sy > hPx + 2) continue;
        const isMajor = Math.abs(fv / majorStep - Math.round(fv / majorStep)) < 1e-3;
        const tickLen = isMajor ? 11 : 5;
        const ySnap = Math.round(sy) + 0.5;
        ctx.moveTo(wPx, ySnap);
        ctx.lineTo(wPx - tickLen, ySnap);
        if (isMajor) {
          ctx.save();
          ctx.translate(2, ySnap - 2);
          ctx.rotate(-Math.PI / 2);
          ctx.textBaseline = 'top';
          ctx.fillText(String(Math.round(fv)), 0, 0);
          ctx.restore();
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }
}

const GUIDE_HIT_BAND = 12;

function getStageGuideStyle() {
  const gs = (App.stage.data && App.stage.data.guideStyle) || {};
  return {
    color: (typeof gs.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(gs.color)) ? gs.color : '#3bc9db',
    opacity: isFinite(Number(gs.opacity)) ? clamp(Number(gs.opacity), 0.15, 1) : 0.88,
  };
}

function findStageGuideNearClient(clientX, clientY, pxTol) {
  if (App.editorMode !== 'stage' || !App.stage.showRulers || App.stage.previewFullscreen || !App.stage.data || !els.viewport) {
    return null;
  }
  const guides = App.stage.data.guides || [];
  if (!guides.length) return null;
  const rect = els.viewport.getBoundingClientRect();
  const lx = clientX - rect.left;
  const ly = clientY - rect.top;
  if (lx < RULER_THICK || ly < RULER_THICK || lx > rect.width || ly > rect.height) return null;

  const m = getStageFrameMetrics();
  const tol = pxTol || 6;
  let best = null;
  let bestDist = tol;
  for (let i = 0; i < guides.length; i++) {
    const g = guides[i];
    const wCoord = guideToWorldCoord(g, m);
    const scr = worldToViewportScreen(
      g.axis === 'v' ? wCoord : 0,
      g.axis === 'h' ? wCoord : 0
    );
    const d = g.axis === 'v' ? Math.abs(lx - scr.x) : Math.abs(ly - scr.y);
    if (d <= bestDist) {
      bestDist = d;
      best = g;
    }
  }
  return best;
}

function renderStageGuidesOverlay(metrics) {
  const svg = els.stageGuidesSvg;
  if (!svg) return;
  svg.innerHTML = '';
  const show = (App.editorMode === 'stage') && !!App.stage.showRulers &&
    !App.stage.previewFullscreen && !!App.stage.data;
  svg.hidden = !show;
  if (!show) return;

  const vpW = els.viewport.clientWidth || 800;
  const vpH = els.viewport.clientHeight || 500;
  const m = metrics || getStageFrameMetrics();
  const guides = App.stage.data.guides || [];
  const activeSnapSet = new Set(App.stage.activeSnapGuides || []);
  const style = getStageGuideStyle();

  for (let i = 0; i < guides.length; i++) {
    const g = guides[i];
    const wCoord = guideToWorldCoord(g, m);
    const scr = worldToViewportScreen(
      g.axis === 'v' ? wCoord : 0,
      g.axis === 'h' ? wCoord : 0
    );
    const isDragging   = _guideDrag && _guideDrag.guide && _guideDrag.guide.id === g.id;
    const willDelete   = !!(isDragging && _guideDrag.willDelete);
    const isSnapped    = activeSnapSet.has(g.id);
    const isHovered    = !isDragging && App.stage.hoveredGuideId === g.id;

    const line = document.createElementNS(SVG_NS, 'line');
    const hit  = document.createElementNS(SVG_NS, 'rect');
    const cls = 'stage-guide-line' +
      (isHovered ? ' hovered' : '') +
      (isDragging ? ' dragging' : '') +
      (willDelete ? ' will-delete' : '') +
      (isSnapped ? ' active-snap' : '');
    line.setAttribute('class', cls);
    if (!isDragging && !willDelete && !isSnapped) {
      line.style.stroke = style.color;
      line.style.strokeOpacity = String(isHovered ? 1 : style.opacity);
    }

    hit.setAttribute('class', 'stage-guide-hit ' + (g.axis === 'v' ? 'guide-v' : 'guide-h'));
    hit.dataset.guideId = g.id;

    if (g.axis === 'v') {
      const x = Math.round(scr.x) + 0.5;
      line.setAttribute('x1', String(x));
      line.setAttribute('y1', '0');
      line.setAttribute('x2', String(x));
      line.setAttribute('y2', String(vpH));

      hit.setAttribute('x', String(Math.round(scr.x - GUIDE_HIT_BAND / 2)));
      hit.setAttribute('y', String(RULER_THICK));
      hit.setAttribute('width', String(GUIDE_HIT_BAND));
      hit.setAttribute('height', String(Math.max(1, vpH - RULER_THICK)));
    } else {
      const y = Math.round(scr.y) + 0.5;
      line.setAttribute('x1', '0');
      line.setAttribute('y1', String(y));
      line.setAttribute('x2', String(vpW));
      line.setAttribute('y2', String(y));

      hit.setAttribute('x', String(RULER_THICK));
      hit.setAttribute('y', String(Math.round(scr.y - GUIDE_HIT_BAND / 2)));
      hit.setAttribute('width', String(Math.max(1, vpW - RULER_THICK)));
      hit.setAttribute('height', String(GUIDE_HIT_BAND));
    }

    svg.appendChild(line);
    svg.appendChild(hit);

    if (isDragging || isHovered) {
      const pxFromEdge = g.axis === 'v' ? (wCoord + m.fw / 2) : (wCoord + m.fh / 2);
      const label = willDelete
        ? 'Убрать обратно в линейку (удалить)'
        : ((g.axis === 'v' ? 'X: ' : 'Y: ') + Math.round(pxFromEdge) + ' px (' + (g.pos * 100).toFixed(1) + '%)');
      const bw = willDelete ? 220 : 148;
      const bx = g.axis === 'v' ? clamp(scr.x + 10, 28, Math.max(28, vpW - bw - 8)) : 28;
      const by = g.axis === 'h' ? clamp(scr.y - 24, 24, Math.max(24, vpH - 28)) : 26;
      const bgRect = document.createElementNS(SVG_NS, 'rect');
      bgRect.setAttribute('class', 'stage-guide-badge-bg' + (isDragging ? ' dragging' : '') + (willDelete ? ' will-delete' : ''));
      if (!isDragging && !willDelete) bgRect.style.stroke = style.color;
      bgRect.setAttribute('x', String(bx));
      bgRect.setAttribute('y', String(by));
      bgRect.setAttribute('width', String(bw));
      bgRect.setAttribute('height', '19');
      const txt = document.createElementNS(SVG_NS, 'text');
      txt.setAttribute('class', 'stage-guide-badge-text');
      txt.setAttribute('x', String(bx + 6));
      txt.setAttribute('y', String(by + 13));
      txt.textContent = label;
      svg.appendChild(bgRect);
      svg.appendChild(txt);
    }
  }
}

function renderStageRulersAndGuides() {
  const m = getStageFrameMetrics();
  renderStageRulersCanvas(m);
  renderStageGuidesOverlay(m);
}

// Вычисляет смещение привязки к направляющим (по границе Bounding Box ИЛИ по единому Pivot Point)
function computeGuideSnapAdjustment(snapshots, dwx, dwy, metrics) {
  App.stage.activeSnapGuides = [];
  if (!App.stage.guideSnap || !App.stage.showRulers || !App.stage.data) {
    return { dwx, dwy, snappedX: false, snappedY: false };
  }
  const guides = App.stage.data.guides || [];
  if (!guides.length || !snapshots.length) {
    return { dwx, dwy, snappedX: false, snappedY: false };
  }

  let candMinX = Infinity, candMinY = Infinity, candMaxX = -Infinity, candMaxY = -Infinity;
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const candPos = { x: snap.wpos0.x + dwx, y: snap.wpos0.y + dwy };
    const b = getStageItemWorldAABBAtPos(snap.item, candPos, metrics);
    if (b.minX < candMinX) candMinX = b.minX;
    if (b.minY < candMinY) candMinY = b.minY;
    if (b.maxX > candMaxX) candMaxX = b.maxX;
    if (b.maxY > candMaxY) candMaxY = b.maxY;
  }

  // Точки привязки по X и Y: границы Bounding Box (лево/право, верх/низ) И единый Pivot Point
  const xPoints = [candMinX, candMaxX];
  const yPoints = [candMinY, candMaxY];
  if (snapshots.length === 1) {
    xPoints.unshift(snapshots[0].wpos0.x + dwx);
    yPoints.unshift(snapshots[0].wpos0.y + dwy);
  } else {
    xPoints.unshift((candMinX + candMaxX) / 2);
    yPoints.unshift((candMinY + candMaxY) / 2);
  }

  const threshWorld = 9 / Math.max(0.05, App.camera.zoom || 1);
  let bestDx = null, bestAbsX = threshWorld, bestGuideX = null;
  let bestDy = null, bestAbsY = threshWorld, bestGuideY = null;

  for (let i = 0; i < guides.length; i++) {
    const g = guides[i];
    const gw = guideToWorldCoord(g, metrics);
    if (g.axis === 'v') {
      for (let k = 0; k < xPoints.length; k++) {
        const diff = gw - xPoints[k];
        const ad = Math.abs(diff);
        if (ad <= bestAbsX) {
          bestAbsX = ad;
          bestDx = diff;
          bestGuideX = g.id;
        }
      }
    } else {
      for (let k = 0; k < yPoints.length; k++) {
        const diff = gw - yPoints[k];
        const ad = Math.abs(diff);
        if (ad <= bestAbsY) {
          bestAbsY = ad;
          bestDy = diff;
          bestGuideY = g.id;
        }
      }
    }
  }

  let outDwx = dwx, outDwy = dwy;
  if (bestDx !== null) {
    outDwx += bestDx;
    App.stage.activeSnapGuides.push(bestGuideX);
  }
  if (bestDy !== null) {
    outDwy += bestDy;
    App.stage.activeSnapGuides.push(bestGuideY);
  }
  return {
    dwx: outDwx,
    dwy: outDwy,
    snappedX: bestDx !== null,
    snappedY: bestDy !== null
  };
}

function snapGuideWorldCoord(axis, wCoord) {
  if (!App.grid.snap) return wCoord;
  if (typeof App.snapWorldToGrid === 'function') {
    const snapped = App.snapWorldToGrid(axis === 'v' ? wCoord : 0, axis === 'h' ? wCoord : 0);
    return axis === 'v' ? snapped.x : snapped.y;
  }
  const step = App.grid.step || 4;
  return Math.round(wCoord / step) * step;
}

function deleteStageGuideById(guideId) {
  if (!App.stage.data || !guideId) return;
  const before = App.stage.data.guides.length;
  App.stage.data.guides = App.stage.data.guides.filter(x => x.id !== guideId);
  if (App.stage.hoveredGuideId === guideId) App.stage.hoveredGuideId = null;
  if (App.stage.data.guides.length !== before) {
    markStageDirty();
    renderStageGuidesOverlay();
    if (App.stage.selectedId === '__bg__') renderStageProperties();
    if (els.guidesSettingsPopover && !els.guidesSettingsPopover.hidden) renderGuidesSettingsPopover();
    setHint('Направляющая удалена', 1400);
  }
}

function clearAllStageGuides() {
  if (!App.stage.data || !App.stage.data.guides.length) return;
  App.stage.data.guides = [];
  App.stage.hoveredGuideId = null;
  markStageDirty();
  renderStageGuidesOverlay();
  if (App.stage.selectedId === '__bg__') renderStageProperties();
  if (els.guidesSettingsPopover && !els.guidesSettingsPopover.hidden) renderGuidesSettingsPopover();
  setHint('Все направляющие сцены очищены', 1600);
}

function closeGuidesSettingsPopover() {
  if (els.guidesSettingsPopover) els.guidesSettingsPopover.hidden = true;
  if (els.btnStageGuidesMenu) els.btnStageGuidesMenu.classList.remove('active');
}

function toggleGuidesSettingsPopover(anchorEl) {
  const pop = els.guidesSettingsPopover;
  if (!pop || !App.stage.data) return;
  if (!pop.hidden) {
    closeGuidesSettingsPopover();
    return;
  }
  if (typeof closeGridSettingsPopover === 'function') closeGridSettingsPopover();
  closeStageContextMenu();

  renderGuidesSettingsPopover();
  pop.hidden = false;
  if (els.btnStageGuidesMenu) els.btnStageGuidesMenu.classList.add('active');

  const btn = anchorEl || els.btnStageGuidesMenu;
  if (btn && btn.getBoundingClientRect) {
    const r = btn.getBoundingClientRect();
    const left = clamp(r.left, 8, Math.max(8, window.innerWidth - 300));
    const top  = clamp(r.bottom + 6, 8, Math.max(8, window.innerHeight - 400));
    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';
  }
}

function renderGuidesSettingsPopover() {
  const pop = els.guidesSettingsPopover;
  if (!pop || !App.stage.data) return;
  const st = App.stage.data;
  const style = getStageGuideStyle();
  const opPct = Math.round(style.opacity * 100);
  const swatches = ['#3bc9db', '#ffd43b', '#ff6b6b', '#51cf66', '#cc5de8', '#ffffff'];
  const m = getStageFrameMetrics();
  const guides = st.guides || [];

  let listHtml = '';
  if (!guides.length) {
    listHtml = '<li class="empty">Направляющих пока нет — потяните мышкой с верхней или левой линейки</li>';
  } else {
    for (const g of guides) {
      const wCoord = guideToWorldCoord(g, m);
      const px = Math.round(g.axis === 'v' ? (wCoord + m.fw / 2) : (wCoord + m.fh / 2));
      const axisBadge = g.axis === 'v' ? 'Верт. X' : 'Гориз. Y';
      listHtml +=
        '<li>' +
          '<span>' + axisBadge + ': ' + px + ' px (' + (g.pos * 100).toFixed(1) + '%)</span>' +
          '<button type="button" class="guide-del-x" data-del-guide="' + escapeHtmlAttr(g.id) + '" title="Удалить эту направляющую">' +
            '<span class="material-icons" style="font-size:14px">close</span>' +
          '</button>' +
        '</li>';
    }
  }

  pop.innerHTML =
    '<div class="popover-head">' +
      '<span>Меню направляющих (' + guides.length + ')</span>' +
      '<button type="button" class="guide-del-x" data-gmenu-act="close" title="Закрыть"><span class="material-icons" style="font-size:15px">close</span></button>' +
    '</div>' +
    '<div class="popover-section" style="display:flex;gap:10px;align-items:center">' +
      '<label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" data-gmenu-chk="rulers" ' + (App.stage.showRulers ? 'checked' : '') + '> Линейки</label>' +
      '<label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" data-gmenu-chk="snap" ' + (App.stage.guideSnap ? 'checked' : '') + '> Привязка BBox + Pivot</label>' +
    '</div>' +
    '<div class="popover-section">' +
      '<span class="popover-label">Цвет и прозрачность (<span data-gmenu-op-lbl>' + opPct + '%</span>):</span>' +
      '<div class="swatch-row" style="margin-bottom:6px">' +
        swatches.map(c => '<button type="button" class="color-swatch' + (style.color.toLowerCase() === c ? ' active' : '') + '" style="background:' + c + '" data-gmenu-color="' + c + '" title="' + c + '"></button>').join('') +
        '<input type="color" value="' + style.color + '" data-gmenu-input="color" style="width:26px;height:22px;padding:0;border:none;background:transparent;cursor:pointer">' +
      '</div>' +
      '<input type="range" min="15" max="100" step="1" value="' + opPct + '" data-gmenu-input="opacity" style="width:100%">' +
    '</div>' +
    '<div class="popover-section">' +
      '<span class="popover-label">Быстрая разметка макета:</span>' +
      '<div style="display:flex;gap:4px;flex-wrap:wrap">' +
        '<button type="button" class="btn small" data-gmenu-preset="center">+ Центр 50%</button>' +
        '<button type="button" class="btn small" data-gmenu-preset="thirds">+ Трети</button>' +
        '<button type="button" class="btn small" data-gmenu-preset="safe">+ Поля 5%</button>' +
      '</div>' +
    '</div>' +
    '<div class="popover-section">' +
      '<span class="popover-label">Список направляющих на сцене:</span>' +
      '<ul class="guide-list-mini">' + listHtml + '</ul>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;gap:6px">' +
      '<button type="button" class="btn small danger" data-gmenu-act="clear"' + (guides.length ? '' : ' disabled') + '>Очистить все</button>' +
      '<button type="button" class="btn small primary" data-gmenu-act="close">Готово</button>' +
    '</div>';

  pop.querySelectorAll('[data-gmenu-chk]').forEach(chk => {
    chk.addEventListener('change', () => {
      const k = chk.getAttribute('data-gmenu-chk');
      if (k === 'rulers') {
        App.stage.showRulers = !!chk.checked;
        if (els.btnStageRulers) els.btnStageRulers.classList.toggle('active', App.stage.showRulers);
        renderStageRulersAndGuides();
      } else if (k === 'snap') {
        App.stage.guideSnap = !!chk.checked;
        if (els.btnStageGuideSnap) els.btnStageGuideSnap.classList.toggle('active', App.stage.guideSnap);
      }
    });
  });

  pop.querySelectorAll('[data-gmenu-color]').forEach(sw => {
    sw.addEventListener('click', () => {
      st.guideStyle.color = sw.getAttribute('data-gmenu-color');
      markStageDirty();
      renderStageGuidesOverlay();
      renderGuidesSettingsPopover();
    });
  });

  const colorInp = pop.querySelector('[data-gmenu-input="color"]');
  if (colorInp) {
    colorInp.addEventListener('input', () => {
      st.guideStyle.color = colorInp.value;
      markStageDirty();
      renderStageGuidesOverlay();
    });
  }

  const opInp = pop.querySelector('[data-gmenu-input="opacity"]');
  const opLbl = pop.querySelector('[data-gmenu-op-lbl]');
  if (opInp) {
    opInp.addEventListener('input', () => {
      const pct = clamp(parseInt(opInp.value, 10) || 88, 15, 100);
      st.guideStyle.opacity = pct / 100;
      if (opLbl) opLbl.textContent = pct + '%';
      markStageDirty();
      renderStageGuidesOverlay();
    });
  }

  pop.querySelectorAll('[data-gmenu-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.getAttribute('data-gmenu-preset');
      const addG = (axis, pos) => {
        if (!st.guides.some(g => g.axis === axis && Math.abs(g.pos - pos) < 0.0005)) {
          st.guides.push({ id: nextStageGuideId(), axis, pos });
        }
      };
      if (p === 'center') {
        addG('v', 0.5); addG('h', 0.5);
      } else if (p === 'thirds') {
        addG('v', 1 / 3); addG('v', 2 / 3);
        addG('h', 1 / 3); addG('h', 2 / 3);
      } else if (p === 'safe') {
        addG('v', 0.05); addG('v', 0.95);
        addG('h', 0.05); addG('h', 0.95);
      }
      markStageDirty();
      renderStageGuidesOverlay();
      if (App.stage.selectedId === '__bg__') renderStageProperties();
      renderGuidesSettingsPopover();
    });
  });

  pop.querySelectorAll('[data-del-guide]').forEach(btn => {
    btn.addEventListener('click', () => {
      deleteStageGuideById(btn.getAttribute('data-del-guide'));
    });
  });

  pop.querySelectorAll('[data-gmenu-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.getAttribute('data-gmenu-act');
      if (act === 'clear') clearAllStageGuides();
      else closeGuidesSettingsPopover();
    });
  });
}

function startExistingGuideDrag(guide, e) {
  if (!guide) return;
  e.preventDefault();
  e.stopPropagation();
  closeStageContextMenu();
  App.stage.hoveredGuideId = guide.id;
  _guideDrag = {
    guide,
    isNew: false,
    leftRulerOnce: true,
    willDelete: false,
  };
  document.body.classList.add('guide-dragging');
  renderStageGuidesOverlay();
}

function startGuideDragFromRuler(axis, e) {
  if (App.editorMode !== 'stage' || !App.stage.data || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  closeStageContextMenu();
  const m = getStageFrameMetrics();
  const w = clientToStageWorld(e.clientX, e.clientY, false);
  const wCoord = snapGuideWorldCoord(axis, (axis === 'v') ? w.x : w.y);
  const guide = {
    id: nextStageGuideId(),
    axis,
    pos: worldCoordToGuidePos(axis, wCoord, m)
  };
  App.stage.data.guides.push(guide);
  App.stage.hoveredGuideId = guide.id;
  _guideDrag = {
    guide,
    isNew: true,
    leftRulerOnce: false,
    willDelete: false,
  };
  document.body.classList.add('guide-dragging');
  renderStageGuidesOverlay(m);
}

function setupStageRulersAndGuidesInteraction() {
  if (els.stageRulerH) {
    els.stageRulerH.addEventListener('mousedown', (e) => startGuideDragFromRuler('h', e));
    els.stageRulerH.addEventListener('contextmenu', (e) => {
      if (App.editorMode !== 'stage' || !App.stage.data) return;
      e.preventDefault();
      e.stopPropagation();
      openStageRulerOrGuideContextMenu(e.clientX, e.clientY, null, 'h');
    });
  }
  if (els.stageRulerV) {
    els.stageRulerV.addEventListener('mousedown', (e) => startGuideDragFromRuler('v', e));
    els.stageRulerV.addEventListener('contextmenu', (e) => {
      if (App.editorMode !== 'stage' || !App.stage.data) return;
      e.preventDefault();
      e.stopPropagation();
      openStageRulerOrGuideContextMenu(e.clientX, e.clientY, null, 'v');
    });
  }
  if (els.stageRulerCorner) {
    els.stageRulerCorner.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleGuidesSettingsPopover(els.stageRulerCorner);
    });
    els.stageRulerCorner.addEventListener('dblclick', () => {
      clearAllStageGuides();
    });
  }

  if (els.stageGuidesSvg) {
    els.stageGuidesSvg.addEventListener('mousedown', (e) => {
      if (App.editorMode !== 'stage' || !App.stage.data || e.button !== 0) return;
      const hit = e.target && e.target.closest ? e.target.closest('[data-guide-id]') : null;
      const g = hit
        ? App.stage.data.guides.find(x => x.id === hit.dataset.guideId)
        : findStageGuideNearClient(e.clientX, e.clientY, 6);
      if (!g) return;
      startExistingGuideDrag(g, e);
    });

    els.stageGuidesSvg.addEventListener('contextmenu', (e) => {
      if (App.editorMode !== 'stage' || !App.stage.data) return;
      const hit = e.target && e.target.closest ? e.target.closest('[data-guide-id]') : null;
      const g = hit
        ? App.stage.data.guides.find(x => x.id === hit.dataset.guideId)
        : findStageGuideNearClient(e.clientX, e.clientY, 7);
      if (!g) return;
      e.preventDefault();
      e.stopPropagation();
      openStageRulerOrGuideContextMenu(e.clientX, e.clientY, g, g.axis);
    });

    els.stageGuidesSvg.addEventListener('dblclick', (e) => {
      if (App.editorMode !== 'stage' || !App.stage.data) return;
      const hit = e.target && e.target.closest ? e.target.closest('[data-guide-id]') : null;
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      deleteStageGuideById(hit.dataset.guideId);
    });
  }

  window.addEventListener('mousemove', (e) => {
    if (App.editorMode === 'stage' && App.stage.showRulers && !App.stage.previewFullscreen && els.viewport) {
      const rect = els.viewport.getBoundingClientRect();
      const sx = e.clientX - rect.left - RULER_THICK;
      const sy = e.clientY - rect.top - RULER_THICK;
      if (els.stageRulerHairX) {
        els.stageRulerHairX.style.transform = (sx >= 0 && sx <= rect.width)
          ? ('translateX(' + Math.round(sx) + 'px)')
          : 'translateX(-100px)';
      }
      if (els.stageRulerHairY) {
        els.stageRulerHairY.style.transform = (sy >= 0 && sy <= rect.height)
          ? ('translateY(' + Math.round(sy) + 'px)')
          : 'translateY(-100px)';
      }

      if (!_guideDrag) {
        const nearG = findStageGuideNearClient(e.clientX, e.clientY, 6);
        const nextHoverId = nearG ? nearG.id : null;
        if (App.stage.hoveredGuideId !== nextHoverId) {
          App.stage.hoveredGuideId = nextHoverId;
          renderStageGuidesOverlay();
        }
      }
    }

    if (!_guideDrag || !App.stage.data || !els.viewport) return;
    const rect = els.viewport.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    const overRulerOrOutside =
      (_guideDrag.guide.axis === 'h' && localY <= RULER_THICK) ||
      (_guideDrag.guide.axis === 'v' && localX <= RULER_THICK) ||
      localX < 0 || localY < 0 || localX > rect.width || localY > rect.height;

    if (!overRulerOrOutside) {
      _guideDrag.leftRulerOnce = true;
    }
    _guideDrag.willDelete = overRulerOrOutside && (!_guideDrag.isNew || _guideDrag.leftRulerOnce);

    const m = getStageFrameMetrics();
    const w = clientToStageWorld(e.clientX, e.clientY, false);
    const wCoord = snapGuideWorldCoord(_guideDrag.guide.axis, (_guideDrag.guide.axis === 'v') ? w.x : w.y);
    _guideDrag.guide.pos = Math.round(worldCoordToGuidePos(_guideDrag.guide.axis, wCoord, m) * 100000) / 100000;
    renderStageGuidesOverlay(m);
  });

  window.addEventListener('mouseup', (e) => {
    if (!_guideDrag) return;
    const d = _guideDrag;
    _guideDrag = null;
    document.body.classList.remove('guide-dragging');
    if (!App.stage.data || !els.viewport) return;

    const rect = els.viewport.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    const droppedBackOnRuler =
      (d.guide.axis === 'h' && localY <= RULER_THICK) ||
      (d.guide.axis === 'v' && localX <= RULER_THICK) ||
      localX < 0 || localY < 0 || localX > rect.width || localY > rect.height;

    if (droppedBackOnRuler) {
      App.stage.data.guides = App.stage.data.guides.filter(x => x.id !== d.guide.id);
      App.stage.hoveredGuideId = null;
      if (!d.isNew || d.leftRulerOnce) {
        if (!d.isNew) markStageDirty();
        setHint('Направляющая убрана обратно в линейку', 1500);
      }
    } else {
      markStageDirty();
    }
    renderStageGuidesOverlay();
    if (App.stage.selectedId === '__bg__') renderStageProperties();
    if (els.guidesSettingsPopover && !els.guidesSettingsPopover.hidden) renderGuidesSettingsPopover();
  });
}

// -------- StageGizmo: одиночный и групповой скейл / поворот / перемещение --------

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
    if (App.editorMode !== 'stage' || !App.stage.data || App.stage.previewFullscreen) return;

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

    const metrics = getStageFrameMetrics();
    const leaves = getSelectedTransformLeafItems();
    const leafIdSet = new Set(leaves.map(it => it.id));

    // Контур при наведении мыши на невыделенный объект на сцене (видна рамка и единый Pivot до клика)
    if (!drag && App.stage.hoveredId && !leafIdSet.has(App.stage.hoveredId)) {
      const hovItem = App.stage.data.items.find(x => x.id === App.stage.hoveredId);
      if (hovItem && !hovItem.isGroup && isStageItemVisible(hovItem)) {
        const hb = getStageItemWorldAABB(hovItem, metrics);
        const hpts = hb.corners.map(p => worldToViewportScreen(p.x, p.y));
        const hd = 'M' + hpts[0].x + ' ' + hpts[0].y +
                   'L' + hpts[1].x + ' ' + hpts[1].y +
                   'L' + hpts[2].x + ' ' + hpts[2].y +
                   'L' + hpts[3].x + ' ' + hpts[3].y + 'Z';
        svg.appendChild(makeSvg('path', { d: hd, class: 'stage-gizmo-hover-box' }));
        const hw = anchorToWorld(hovItem.anchor, metrics);
        const hp = worldToViewportScreen(hw.x, hw.y);
        svg.appendChild(makeSvg('circle', {
          cx: hp.x, cy: hp.y, r: 4,
          fill: 'rgba(15, 20, 26, 0.78)', stroke: '#66d9e8', 'stroke-width': 1.3,
          style: 'pointer-events:none'
        }));
      }
    }

    if (!leaves.length) return;

    // ОДИНОЧНЫЙ ЭЛЕМЕНТ: высококонтрастная двойная рамка Bounding Box + единый Pivot Point + ручки
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

      // Тёмная подложка под рамку, чтобы рамка читалась на любом зелёном / светлом фоне
      svg.appendChild(makeSvg('path', { d: dPath, class: 'stage-gizmo-box-halo' }));

      const box = makeSvg('path', { d: dPath, class: 'stage-gizmo-box' });
      box.dataset.gizmo = 'move';
      svg.appendChild(box);

      const topMidX = (pts[0].x + pts[1].x) / 2;
      const topMidY = (pts[0].y + pts[1].y) / 2;
      const edgeDx = pts[1].x - pts[0].x;
      const edgeDy = pts[1].y - pts[0].y;
      const edgeLen = Math.hypot(edgeDx, edgeDy) || 1;
      const nx = edgeDy / edgeLen;
      const ny = -edgeDx / edgeLen;
      const rotHx = topMidX + nx * 24;
      const rotHy = topMidY + ny * 24;

      svg.appendChild(makeSvg('line', {
        x1: topMidX, y1: topMidY, x2: rotHx, y2: rotHy,
        stroke: 'rgba(8, 12, 18, 0.85)', 'stroke-width': 3, style: 'pointer-events:none'
      }));
      svg.appendChild(makeSvg('line', {
        x1: topMidX, y1: topMidY, x2: rotHx, y2: rotHy,
        stroke: '#38d9a9', 'stroke-width': 1.4, style: 'pointer-events:none'
      }));
      const rotHandle = makeSvg('circle', {
        cx: rotHx, cy: rotHy, r: 5.8, class: 'stage-gizmo-rot-handle'
      });
      rotHandle.dataset.gizmo = 'rotate';
      svg.appendChild(rotHandle);

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

      // Компактный шильдик габаритов BBox (Ш × В px) под рамкой
      const scrMinX = Math.min(pts[0].x, pts[1].x, pts[2].x, pts[3].x);
      const scrMaxX = Math.max(pts[0].x, pts[1].x, pts[2].x, pts[3].x);
      const scrMaxY = Math.max(pts[0].y, pts[1].y, pts[2].y, pts[3].y);
      const dimTxt = Math.round(aabb.maxX - aabb.minX) + ' × ' + Math.round(aabb.maxY - aabb.minY) + ' px';
      const dimW = Math.max(76, dimTxt.length * 6.3 + 12);
      const dimX = (scrMinX + scrMaxX) / 2 - dimW / 2;
      const dimY = scrMaxY + 8;
      svg.appendChild(makeSvg('rect', {
        x: dimX, y: dimY, width: dimW, height: 17, class: 'stage-gizmo-dim-bg'
      }));
      const dimEl = makeSvg('text', {
        x: dimX + 6, y: dimY + 12, class: 'stage-gizmo-dim-text'
      });
      dimEl.textContent = dimTxt;
      svg.appendChild(dimEl);

      // Маркер ЕДИНОГО Pivot Point объекта (высококонтрастная мишень с ореолом)
      const wpos = anchorToWorld(it.anchor, metrics);
      const pScr = worldToViewportScreen(wpos.x, wpos.y);
      const pivG = makeSvg('g', { class: 'stage-gizmo-pivot' });
      pivG.dataset.gizmo = 'move';
      pivG.appendChild(makeSvg('circle', {
        cx: pScr.x, cy: pScr.y, r: 8,
        fill: 'rgba(10, 14, 20, 0.86)', stroke: 'rgba(10, 14, 20, 0.95)', 'stroke-width': 2.2
      }));
      pivG.appendChild(makeSvg('line', {
        x1: pScr.x - 11, y1: pScr.y, x2: pScr.x + 11, y2: pScr.y,
        stroke: 'rgba(10, 14, 20, 0.95)', 'stroke-width': 3
      }));
      pivG.appendChild(makeSvg('line', {
        x1: pScr.x, y1: pScr.y - 11, x2: pScr.x, y2: pScr.y + 11,
        stroke: 'rgba(10, 14, 20, 0.95)', 'stroke-width': 3
      }));
      pivG.appendChild(makeSvg('circle', {
        cx: pScr.x, cy: pScr.y, r: 6.5,
        fill: 'rgba(255, 212, 59, 0.20)', stroke: '#ffd43b', 'stroke-width': 1.8
      }));
      pivG.appendChild(makeSvg('line', {
        x1: pScr.x - 10, y1: pScr.y, x2: pScr.x + 10, y2: pScr.y,
        stroke: '#ffd43b', 'stroke-width': 1.5
      }));
      pivG.appendChild(makeSvg('line', {
        x1: pScr.x, y1: pScr.y - 10, x2: pScr.x, y2: pScr.y + 10,
        stroke: '#ffd43b', 'stroke-width': 1.5
      }));
      pivG.appendChild(makeSvg('circle', {
        cx: pScr.x, cy: pScr.y, r: 2.1,
        fill: '#ffffff', stroke: 'none'
      }));
      svg.appendChild(pivG);
      return;
    }

    // ГРУППОВОЕ ВЫДЕЛЕНИЕ (папка или несколько объектов): суб-рамки участников + общая рамка группы
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let visCount = 0;
    const memberBoxes = [];
    for (const it of leaves) {
      if (!isStageItemVisible(it)) continue;
      const b = getStageItemWorldAABB(it, metrics);
      memberBoxes.push({ it, b });
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

    // Тонкие индивидуальные рамки и точки пивотов каждого объекта внутри группы
    for (const mb of memberBoxes) {
      const mpts = mb.b.corners.map(p => worldToViewportScreen(p.x, p.y));
      const md = 'M' + mpts[0].x + ' ' + mpts[0].y +
                 'L' + mpts[1].x + ' ' + mpts[1].y +
                 'L' + mpts[2].x + ' ' + mpts[2].y +
                 'L' + mpts[3].x + ' ' + mpts[3].y + 'Z';
      svg.appendChild(makeSvg('path', { d: md, class: 'stage-gizmo-subbox' }));
      const mw = anchorToWorld(mb.it.anchor, metrics);
      const mp = worldToViewportScreen(mw.x, mw.y);
      svg.appendChild(makeSvg('circle', {
        cx: mp.x, cy: mp.y, r: 3.2,
        fill: '#13171e', stroke: '#ffd43b', 'stroke-width': 1.3,
        style: 'pointer-events:none'
      }));
    }

    svg.appendChild(makeSvg('rect', {
      x: gx, y: gy, width: gw, height: gh, class: 'stage-gizmo-box-halo'
    }));

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

  function applyMoveDelta(dwxRaw, dwyRaw, metrics) {
    if (!drag || drag.kind !== 'move') return;
    let dwx = dwxRaw;
    let dwy = dwyRaw;

    // 1) Привязка к направляющим по границам Bounding Box ИЛИ единому Pivot Point
    const gSnap = computeGuideSnapAdjustment(drag.snapshots, dwx, dwy, metrics);
    dwx = gSnap.dwx;
    dwy = gSnap.dwy;

    // 2) Привязка к сетке по не привязанным к направляющим осям (с учётом шага и начала координат сетки)
    if (App.grid.snap && drag.snapshots.length > 0) {
      const ref0 = drag.snapshots[0].wpos0;
      const cand = { x: ref0.x + dwx, y: ref0.y + dwy };
      const snapped = (typeof App.snapWorldToGrid === 'function')
        ? App.snapWorldToGrid(cand.x, cand.y)
        : { x: Math.round(cand.x / (App.grid.step || 4)) * (App.grid.step || 4), y: Math.round(cand.y / (App.grid.step || 4)) * (App.grid.step || 4) };
      if (!gSnap.snappedX) dwx += (snapped.x - cand.x);
      if (!gSnap.snappedY) dwy += (snapped.y - cand.y);
    }

    for (const snap of drag.snapshots) {
      const nx = snap.wpos0.x + dwx;
      const ny = snap.wpos0.y + dwy;
      snap.item.anchor = worldToAnchor(nx, ny, metrics);
      syncStageItemTransform(snap.item, metrics);
    }
    renderStageGuidesOverlay(metrics);
  }

  function onGizmoMouseDown(e) {
    if (App.editorMode !== 'stage' || e.button !== 0 || App.spaceDown || App.stage.previewFullscreen) return;
    // Если клик попал прямо на направляющую — приоритет у перетаскивания направляющей
    const nearGuide = findStageGuideNearClient(e.clientX, e.clientY, 6);
    if (nearGuide) {
      startExistingGuideDrag(nearGuide, e);
      return;
    }
    const target = e.target && e.target.closest ? e.target.closest('[data-gizmo]') : null;
    if (!target) return;

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
      const wCur = clientToStageWorld(e.clientX, e.clientY, false);
      applyMoveDelta(wCur.x - drag.w0.x, wCur.y - drag.w0.y, metrics);
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

    if (drag.kind === 'scale-corner' || drag.kind === 'scale-edge') {
      drag.moved = true;
      const wCur = clientToStageWorld(e.clientX, e.clientY, false);
      const dx = wCur.x - drag.piv.x, dy = wCur.y - drag.piv.y;
      const lx = dx * drag.cos - dy * drag.sin;
      const ly = dx * drag.sin + dy * drag.cos;

      if (drag.kind === 'scale-corner') {
        if (e.shiftKey) {
          const fx = clamp(lx / drag.lx0, -50, 50);
          const fy = clamp(ly / drag.ly0, -50, 50);
          drag.item.scale.x = roundScaleVal(drag.scale0.x * fx);
          drag.item.scale.y = roundScaleVal(drag.scale0.y * fy);
        } else {
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

    if (App.stage.activeSnapGuides && App.stage.activeSnapGuides.length) {
      App.stage.activeSnapGuides = [];
      renderStageGuidesOverlay();
    }

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

  function onViewportHoverMove(e) {
    if (drag || _guideDrag || App.panning) return;
    if (App.editorMode !== 'stage' || !App.stage.data || App.stage.previewFullscreen || !els.viewport) return;
    const rect = els.viewport.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      if (App.stage.hoveredId) {
        App.stage.hoveredId = null;
        render();
      }
      return;
    }
    const w = clientToStageWorld(e.clientX, e.clientY, false);
    const hit = findTopmostStageItemAtWorld(w.x, w.y);
    const nextId = hit ? hit.id : null;
    if (App.stage.hoveredId !== nextId) {
      App.stage.hoveredId = nextId;
      render();
    }
  }

  function init() {
    if (!els.stageGizmoSvg) return;
    els.stageGizmoSvg.addEventListener('mousedown', onGizmoMouseDown);
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mousemove', onViewportHoverMove);
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
  if (App.editorMode !== 'stage' || !App.stage.data || App.stage.previewFullscreen) return;
  closeStageContextMenu();
  if (!fromGizmoInterior && e.target && e.target.closest) {
    if (e.target.closest('#stage-gizmo-svg') ||
        e.target.closest('#stage-guides-svg') ||
        e.target.closest('.stage-ruler') ||
        e.target.closest('.stage-ruler-corner')) {
      return;
    }
  }
  const nearGuide = findStageGuideNearClient(e.clientX, e.clientY, 6);
  if (nearGuide) {
    startExistingGuideDrag(nearGuide, e);
    return;
  }

  const metrics = getStageFrameMetrics();
  const wClick = clientToStageWorld(e.clientX, e.clientY, false);
  const currentSelectedLeaves = getSelectedTransformLeafItems();
  const hitSelected = currentSelectedLeaves.find(it => hitTestStageItemAtWorld(it, wClick.x, wClick.y, metrics)) || null;
  const hitTop = findTopmostStageItemAtWorld(wClick.x, wClick.y);

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

// -------- дерево слоёв сцены, папки, разгруппировка, дублирование и Z-порядок --------

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

  // 1) Встроенный закреплённый слой «Бэкграунд»
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

  bgLi.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setStageSelection(['__bg__'], '__bg__');
    openStageLayerContextMenu(e.clientX, e.clientY, '__bg__');
  });

  els.stageLayersList.appendChild(bgLi);

  // 2) Иерархия папок и слоёв (со сворачиванием папок и кнопкой «Выделить все объекты папки»)
  const { childrenOf, roots } = buildStageTreeIndex();

  function renderNode(it, depth) {
    const li = document.createElement('li');
    li.dataset.stageId = it.id;
    const isCollapsed = it.isGroup && App.stage.collapsedFolders && App.stage.collapsedFolders.has(it.id);
    li.className = 'layer depth-' + Math.min(depth, 6) + (it.isGroup ? ' group' : '');
    if (App.stage.selectedIds.has(it.id)) li.classList.add('selected');
    if (it.visible === false) li.style.opacity = '0.5';
    li.draggable = true;

    const visIcon = (it.visible === false) ? 'visibility_off' : 'visibility';
    const typeIcon = it.isGroup
      ? (isCollapsed ? 'folder' : 'folder_open')
      : (it.type === 'object' ? 'smart_toy' : 'image');

    let badgeTxt;
    const childList = it.isGroup ? (childrenOf[it.id] || []) : [];
    if (it.isGroup) {
      badgeTxt = childList.length + ' сл.' + (it.editorOnly ? ' · позиц.' : '');
    } else if (it.interaction && it.interaction.role === 'interactive') {
      badgeTxt = 'interactive';
    } else if (it.interaction && it.interaction.role === 'scripted') {
      badgeTxt = 'scripted';
    } else if (it.type === 'object') {
      badgeTxt = it.animation === '__static__' ? 'static' : (it.animation || 'idle');
    } else {
      badgeTxt = 'asset';
    }

    const twistHtml = it.isGroup
      ? '<button type="button" class="stage-folder-twist" title="' + (isCollapsed ? 'Развернуть папку' : 'Свернуть папку') + '">' +
          '<span class="material-icons">' + (isCollapsed ? 'chevron_right' : 'expand_more') + '</span>' +
        '</button>'
      : '';

    const selAllHtml = (it.isGroup && childList.length > 0)
      ? '<button type="button" class="stage-folder-selall" title="Выделить все объекты папки для группового редактирования свойств">' +
          '<span class="material-icons">select_all</span>' +
        '</button>'
      : '';

    li.innerHTML =
      twistHtml +
      '<button type="button" class="stage-layer-vis" title="Показать / скрыть">' +
        '<span class="material-icons">' + visIcon + '</span>' +
      '</button>' +
      '<span class="material-icons layer-icon">' + typeIcon + '</span>' +
      '<span class="stage-layer-name"></span>' +
      selAllHtml +
      '<span class="stage-layer-badge"></span>';

    li.querySelector('.stage-layer-name').textContent = it.label || it.id;
    li.querySelector('.stage-layer-badge').textContent = badgeTxt;

    const twistBtn = li.querySelector('.stage-folder-twist');
    if (twistBtn) {
      twistBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleStageFolderCollapsed(it.id);
      });
    }

    const selAllBtn = li.querySelector('.stage-folder-selall');
    if (selAllBtn) {
      selAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectAllInStageFolder(it.id);
      });
    }

    li.querySelector('.stage-layer-vis').addEventListener('click', (e) => {
      e.stopPropagation();
      it.visible = (it.visible === false);
      markStageDirty();
      if (it.isGroup) syncAllStageTransforms();
      else syncStageItemTransform(it);
      if (App.stage.playing) evaluateStageAnimationsAtTime(App.stage.time);
      renderStageLayers();
      renderStageProperties();
      StageGizmo.render();
    });

    li.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) toggleStageSelection(it.id);
      else if (e.shiftKey && App.stage.selectedId && App.stage.selectedId !== '__bg__') rangeSelectStage(it.id);
      else setStageSelection([it.id], it.id);
    });

    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!App.stage.selectedIds.has(it.id)) {
        setStageSelection([it.id], it.id);
      }
      openStageLayerContextMenu(e.clientX, e.clientY, it.id);
    });

    li.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      e.preventDefault();
      startStageLayerInlineRename(li, it);
    });

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
                 : li.classList.contains('drop-into')   ? 'into' : null;
      els.stageLayersList.querySelectorAll('li').forEach(x =>
        x.classList.remove('drop-before', 'drop-after', 'drop-into', 'dragging')
      );
      if (!draggedId || !mode || draggedId === it.id) return;
      reorderStageItem(draggedId, it.id, mode);
    });

    els.stageLayersList.appendChild(li);
    if (it.isGroup && !isCollapsed) {
      for (const ch of childList) {
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

function toggleStageFolderCollapsed(folderId) {
  if (!folderId) return;
  if (!App.stage.collapsedFolders) App.stage.collapsedFolders = new Set();
  if (App.stage.collapsedFolders.has(folderId)) App.stage.collapsedFolders.delete(folderId);
  else App.stage.collapsedFolders.add(folderId);
  renderStageLayers();
}

function getStageFolderLeafIds(folderId) {
  if (!App.stage.data || !folderId) return [];
  const { childrenOf } = buildStageTreeIndex();
  const ids = [];
  function walk(pid) {
    for (const ch of (childrenOf[pid] || [])) {
      if (ch.isGroup) walk(ch.id);
      else ids.push(ch.id);
    }
  }
  walk(folderId);
  return ids;
}

function selectAllInStageFolder(folderId) {
  const leafIds = getStageFolderLeafIds(folderId);
  if (!leafIds.length) {
    setHint('В папке пока нет объектов', 1600);
    return;
  }
  if (App.stage.collapsedFolders) App.stage.collapsedFolders.delete(folderId);
  setStageSelection(leafIds, leafIds[0]);
  setHint('Выделены все объекты папки (' + leafIds.length + ') — редактируйте свойства совместно', 1900);
}

function triggerRenameStageItemById(itemId) {
  if (!App.stage.data || !itemId || itemId === '__bg__') return;
  const item = App.stage.data.items.find(x => x.id === itemId);
  if (!item) return;
  // Если родительская папка была свёрнута — развернём её, чтобы строка появилась в DOM
  if (item.parent && App.stage.collapsedFolders && App.stage.collapsedFolders.has(item.parent)) {
    App.stage.collapsedFolders.delete(item.parent);
  }
  renderStageLayers();
  const li = els.stageLayersList
    ? els.stageLayersList.querySelector('li[data-stage-id="' + itemId + '"]')
    : null;
  if (li) {
    startStageLayerInlineRename(li, item);
  }
}

function moveSelectedStageZOrder(dir) {
  if (!App.stage.data) return;
  const sel = Array.from(App.stage.selectedIds).filter(id => id !== '__bg__');
  if (!sel.length) return;
  const items = App.stage.data.items;
  const selSet = new Set(sel);

  if (dir === 'front') {
    const rest = items.filter(it => !selSet.has(it.id));
    const moved = items.filter(it => selSet.has(it.id));
    App.stage.data.items = rest.concat(moved);
  } else if (dir === 'back') {
    const moved = items.filter(it => selSet.has(it.id));
    const rest = items.filter(it => !selSet.has(it.id));
    App.stage.data.items = moved.concat(rest);
  } else if (dir === 'up') {
    for (let i = items.length - 2; i >= 0; i--) {
      if (selSet.has(items[i].id) && !selSet.has(items[i + 1].id) && items[i].parent === items[i + 1].parent) {
        const tmp = items[i];
        items[i] = items[i + 1];
        items[i + 1] = tmp;
      }
    }
  } else if (dir === 'down') {
    for (let i = 1; i < items.length; i++) {
      if (selSet.has(items[i].id) && !selSet.has(items[i - 1].id) && items[i].parent === items[i - 1].parent) {
        const tmp = items[i];
        items[i] = items[i - 1];
        items[i - 1] = tmp;
      }
    }
  }
  markStageDirty();
  syncStageDomOrder();
  renderStageLayers();
  StageGizmo.render();
}

function alignSelectedStageItems(mode, forceFrame) {
  if (!App.stage.data) return;
  const leaves = getSelectedTransformLeafItems();
  if (!leaves.length) return;
  const m = getStageFrameMetrics();
  const useFrame = forceFrame || leaves.length === 1;

  const boxes = leaves.map(it => ({
    it,
    wpos: anchorToWorld(it.anchor, m),
    b: getStageItemWorldAABB(it, m)
  }));

  let refMinX = -m.fw / 2, refMaxX = m.fw / 2;
  let refMinY = -m.fh / 2, refMaxY = m.fh / 2;
  if (!useFrame) {
    refMinX = Infinity; refMinY = Infinity; refMaxX = -Infinity; refMaxY = -Infinity;
    for (const x of boxes) {
      if (x.b.minX < refMinX) refMinX = x.b.minX;
      if (x.b.minY < refMinY) refMinY = x.b.minY;
      if (x.b.maxX > refMaxX) refMaxX = x.b.maxX;
      if (x.b.maxY > refMaxY) refMaxY = x.b.maxY;
    }
  }
  const refCx = (refMinX + refMaxX) / 2;
  const refCy = (refMinY + refMaxY) / 2;

  if (mode === 'dist-x' && boxes.length >= 3) {
    const sorted = boxes.slice().sort((a, b) => ((a.b.minX + a.b.maxX) / 2) - ((b.b.minX + b.b.maxX) / 2));
    const firstCx = (sorted[0].b.minX + sorted[0].b.maxX) / 2;
    const lastCx  = (sorted[sorted.length - 1].b.minX + sorted[sorted.length - 1].b.maxX) / 2;
    const step = (lastCx - firstCx) / (sorted.length - 1);
    sorted.forEach((entry, idx) => {
      const curCx = (entry.b.minX + entry.b.maxX) / 2;
      const targetCx = firstCx + step * idx;
      const nx = entry.wpos.x + (targetCx - curCx);
      entry.it.anchor = worldToAnchor(nx, entry.wpos.y, m);
      syncStageItemTransform(entry.it, m);
    });
  } else if (mode === 'dist-y' && boxes.length >= 3) {
    const sorted = boxes.slice().sort((a, b) => ((a.b.minY + a.b.maxY) / 2) - ((b.b.minY + b.b.maxY) / 2));
    const firstCy = (sorted[0].b.minY + sorted[0].b.maxY) / 2;
    const lastCy  = (sorted[sorted.length - 1].b.minY + sorted[sorted.length - 1].b.maxY) / 2;
    const step = (lastCy - firstCy) / (sorted.length - 1);
    sorted.forEach((entry, idx) => {
      const curCy = (entry.b.minY + entry.b.maxY) / 2;
      const targetCy = firstCy + step * idx;
      const ny = entry.wpos.y + (targetCy - curCy);
      entry.it.anchor = worldToAnchor(entry.wpos.x, ny, m);
      syncStageItemTransform(entry.it, m);
    });
  } else {
    for (const entry of boxes) {
      let dx = 0, dy = 0;
      if (mode === 'left')        dx = refMinX - entry.b.minX;
      else if (mode === 'center-x') dx = refCx - (entry.b.minX + entry.b.maxX) / 2;
      else if (mode === 'right')  dx = refMaxX - entry.b.maxX;
      else if (mode === 'top')    dy = refMinY - entry.b.minY;
      else if (mode === 'center-y') dy = refCy - (entry.b.minY + entry.b.maxY) / 2;
      else if (mode === 'bottom') dy = refMaxY - entry.b.maxY;
      else if (mode === 'center-both') {
        dx = refCx - (entry.b.minX + entry.b.maxX) / 2;
        dy = refCy - (entry.b.minY + entry.b.maxY) / 2;
      }
      entry.it.anchor = worldToAnchor(entry.wpos.x + dx, entry.wpos.y + dy, m);
      syncStageItemTransform(entry.it, m);
    }
  }

  markStageDirty();
  updateStageSelSize();
  syncStageInspectorLive();
  renderStageProperties();
  StageGizmo.render();
}

// -------- Кастомное контекстное ПКМ-меню Редактора сцены --------

function closeStageContextMenu() {
  if (els.stageContextMenu) els.stageContextMenu.hidden = true;
}

function openStageContextMenu(clientX, clientY, headerText, entries) {
  const menu = els.stageContextMenu;
  if (!menu) return;
  if (typeof closeGridSettingsPopover === 'function') closeGridSettingsPopover();
  closeGuidesSettingsPopover();

  menu.innerHTML = '';
  if (headerText) {
    const hd = document.createElement('div');
    hd.className = 'ctx-menu-header';
    hd.textContent = headerText;
    menu.appendChild(hd);
  }

  for (const ent of entries) {
    if (!ent) continue;
    if (ent.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-menu-item' + (ent.danger ? ' danger' : '');
    if (ent.disabled) btn.disabled = true;
    btn.innerHTML =
      '<span class="material-icons">' + (ent.icon || 'chevron_right') + '</span>' +
      '<span></span>';
    btn.querySelectorAll('span')[1].textContent = ent.label;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeStageContextMenu();
      if (typeof ent.action === 'function') ent.action();
    });
    menu.appendChild(btn);
  }

  menu.hidden = false;
  const w = 240, h = Math.min(380, entries.length * 30 + 36);
  const left = clamp(clientX, 6, Math.max(6, (window.innerWidth || 1280) - w - 8));
  const top  = clamp(clientY, 6, Math.max(6, (window.innerHeight || 720) - h - 8));
  menu.style.left = left + 'px';
  menu.style.top  = top + 'px';
}

function openStageLayerContextMenu(clientX, clientY, stageId) {
  if (!App.stage.data) return;
  if (stageId === '__bg__') {
    const bg = App.stage.data.background;
    openStageContextMenu(clientX, clientY, 'Слой: Бэкграунд', [
      {
        icon: App.stage.bgPropsExpanded ? 'expand_less' : 'expand_more',
        label: App.stage.bgPropsExpanded ? 'Свернуть свойства Бэкграунда' : 'Развернуть свойства Бэкграунда',
        action: () => { App.stage.bgPropsExpanded = !App.stage.bgPropsExpanded; renderStageProperties(); }
      },
      {
        icon: bg.visible === false ? 'visibility' : 'visibility_off',
        label: bg.visible === false ? 'Показать фон сцены' : 'Скрыть фон сцены',
        action: () => { bg.visible = (bg.visible === false); markStageDirty(); renderStageBackground(); renderStageLayers(); renderStageProperties(); }
      },
      {
        icon: 'upload_file',
        label: 'Загрузить SVG / PNG фона…',
        action: () => triggerStageFileUpload('bg')
      },
      { sep: true },
      {
        icon: 'fit_screen',
        label: 'Вписать сцену во вьюпорт',
        action: () => fitStageView()
      }
    ]);
    return;
  }

  const item = App.stage.data.items.find(x => x.id === stageId);
  if (!item) return;
  const multiCount = Array.from(App.stage.selectedIds).filter(id => id !== '__bg__').length;

  if (item.isGroup) {
    const isCollapsed = App.stage.collapsedFolders && App.stage.collapsedFolders.has(item.id);
    const leafCount = getStageFolderLeafIds(item.id).length;
    openStageContextMenu(clientX, clientY, 'Папка: ' + (item.label || item.id), [
      {
        icon: 'select_all',
        label: 'Выделить все объекты папки (' + leafCount + ')',
        disabled: leafCount === 0,
        action: () => selectAllInStageFolder(item.id)
      },
      {
        icon: 'edit',
        label: 'Переименовать папку',
        action: () => triggerRenameStageItemById(item.id)
      },
      {
        icon: isCollapsed ? 'unfold_more' : 'unfold_less',
        label: isCollapsed ? 'Развернуть список папки' : 'Свернуть список папки',
        action: () => toggleStageFolderCollapsed(item.id)
      },
      {
        icon: item.visible === false ? 'visibility' : 'visibility_off',
        label: item.visible === false ? 'Показать папку' : 'Скрыть папку',
        action: () => { item.visible = (item.visible === false); markStageDirty(); syncAllStageTransforms(); renderStageLayers(); renderStageProperties(); StageGizmo.render(); }
      },
      { sep: true },
      {
        icon: 'add_circle_outline',
        label: 'Добавить объект в папку…',
        action: () => { setStageSelection([item.id], item.id); openStagePickModal(); }
      },
      {
        icon: item.editorOnly ? 'check_box' : 'check_box_outline_blank',
        label: 'Группа только для позиционирования',
        action: () => { item.editorOnly = !item.editorOnly; markStageDirty(); renderStageLayers(); renderStageProperties(); }
      },
      {
        icon: 'folder_off',
        label: 'Разгруппировать (сохранив позиции)',
        action: () => { setStageSelection([item.id], item.id); ungroupSelectedStageFolder(); }
      },
      { sep: true },
      {
        icon: 'vertical_align_top',
        label: 'На передний план',
        action: () => moveSelectedStageZOrder('front')
      },
      {
        icon: 'vertical_align_bottom',
        label: 'На задний план',
        action: () => moveSelectedStageZOrder('back')
      },
      { sep: true },
      {
        icon: 'delete_outline',
        label: 'Удалить папку со слоями',
        danger: true,
        action: () => deleteSelectedStageItems()
      }
    ]);
    return;
  }

  const entries = [
    {
      icon: 'edit',
      label: 'Переименовать слой',
      action: () => triggerRenameStageItemById(item.id)
    },
    {
      icon: item.visible === false ? 'visibility' : 'visibility_off',
      label: item.visible === false ? 'Показать слой' : 'Скрыть слой',
      action: () => { item.visible = (item.visible === false); markStageDirty(); syncStageItemTransform(item); renderStageLayers(); renderStageProperties(); StageGizmo.render(); }
    },
    {
      icon: 'content_copy',
      label: multiCount > 1 ? ('Дублировать выделенные (' + multiCount + ')') : 'Дублировать слой',
      action: () => duplicateSelectedStageItems()
    },
    {
      icon: 'filter_center_focus',
      label: 'В центр сцены (50%, 50%)',
      action: () => alignSelectedStageItems('center-both', true)
    },
    { sep: true },
    {
      icon: 'create_new_folder',
      label: multiCount > 1 ? ('Сгруппировать для позиционирования (' + multiCount + ')') : 'Упаковать в папку',
      action: () => createStageFolder(multiCount > 1)
    }
  ];

  if (item.parent) {
    entries.push({
      icon: 'folder_off',
      label: 'Вынуть из папки / разгруппировать папку',
      action: () => ungroupSelectedStageFolder()
    });
  }

  entries.push(
    { sep: true },
    { icon: 'vertical_align_top',    label: 'На передний план', action: () => moveSelectedStageZOrder('front') },
    { icon: 'arrow_upward',          label: 'Поднять выше',     action: () => moveSelectedStageZOrder('up') },
    { icon: 'arrow_downward',        label: 'Опустить ниже',    action: () => moveSelectedStageZOrder('down') },
    { icon: 'vertical_align_bottom', label: 'На задний план',   action: () => moveSelectedStageZOrder('back') }
  );

  if (item.type === 'object' && item.objectName) {
    entries.push(
      { sep: true },
      {
        icon: 'animation',
        label: 'Открыть «' + item.objectName + '» в Редакторе объектов',
        action: () => { setEditorMode('object'); requestOpenObject(item.objectName); }
      }
    );
  }

  entries.push(
    { sep: true },
    {
      icon: 'delete_outline',
      label: multiCount > 1 ? ('Удалить выделенные (' + multiCount + ')') : 'Удалить слой',
      danger: true,
      action: () => deleteSelectedStageItems()
    }
  );

  openStageContextMenu(clientX, clientY, (item.type === 'object' ? 'Объект: ' : 'Слой: ') + (item.label || item.id), entries);
}

function openStageRulerOrGuideContextMenu(clientX, clientY, guide, defaultAxis) {
  if (!App.stage.data) return;
  const st = App.stage.data;
  const entries = [];
  if (guide) {
    entries.push(
      {
        icon: 'delete_outline',
        label: 'Удалить эту направляющую',
        danger: true,
        action: () => deleteStageGuideById(guide.id)
      },
      {
        icon: 'vertical_align_center',
        label: 'Поставить ровно по центру (50%)',
        action: () => { guide.pos = 0.5; markStageDirty(); renderStageGuidesOverlay(); }
      },
      { sep: true }
    );
  } else if (defaultAxis) {
    entries.push({
      icon: 'add',
      label: defaultAxis === 'h' ? '+ Горизонтальная по центру (50%)' : '+ Вертикальная по центру (50%)',
      action: () => {
        st.guides.push({ id: nextStageGuideId(), axis: defaultAxis, pos: 0.5 });
        markStageDirty();
        renderStageGuidesOverlay();
      }
    });
  }
  entries.push(
    {
      icon: 'grid_goldenratio',
      label: '+ Крест направляющих по центру (50%)',
      action: () => {
        st.guides.push({ id: nextStageGuideId(), axis: 'v', pos: 0.5 });
        st.guides.push({ id: nextStageGuideId(), axis: 'h', pos: 0.5 });
        markStageDirty();
        renderStageGuidesOverlay();
      }
    },
    {
      icon: 'tune',
      label: 'Меню направляющих (цвет, прозрачность)…',
      action: () => toggleGuidesSettingsPopover(els.btnStageGuidesMenu)
    },
    { sep: true },
    {
      icon: 'clear_all',
      label: 'Очистить все направляющие (' + st.guides.length + ')',
      danger: true,
      disabled: st.guides.length === 0,
      action: () => clearAllStageGuides()
    }
  );
  openStageContextMenu(clientX, clientY, guide ? 'Направляющая' : 'Линейка сцены', entries);
}

function createStageFolder(asPositioningGroup) {
  if (!App.stage.data) return;
  const id = nextStageItemId('folder');
  const existingLabels = App.stage.data.items.filter(x => x.isGroup).map(x => x.label);
  const label = resolveAutoName(existingLabels, asPositioningGroup ? 'Группа ' : 'Папка ');
  let parent = null;
  const sel = Array.from(App.stage.selectedIds).filter(x => x !== '__bg__');

  if (sel.length === 1 && isStageFolderId(sel[0])) {
    parent = sel[0];
  }
  const folder = {
    id,
    label,
    isGroup: true,
    editorOnly: !!asPositioningGroup,
    parent,
    visible: true,
    opacity: 1
  };
  App.stage.data.items.push(folder);
  App.stage.domItems[id] = buildFolderDom(folder);

  // Если при создании папки выделены слои — сразу упаковываем их в новую папку
  if (sel.length > 0 && !(sel.length === 1 && isStageFolderId(sel[0]))) {
    for (const sid of sel) {
      const item = App.stage.data.items.find(x => x.id === sid);
      if (item && item.id !== id && !isStageDescendantOf(id, item.id)) {
        item.parent = id;
      }
    }
  }

  syncStageDomOrder();
  markStageDirty();
  setStageSelection([id], id);
  setHint('Создана папка слоёв «' + label + '»', 1800);
}

function ungroupSelectedStageFolder() {
  if (!App.stage.data) return;
  let folderId = null;
  if (App.stage.selectedId && isStageFolderId(App.stage.selectedId)) {
    folderId = App.stage.selectedId;
  } else {
    const cur = App.stage.data.items.find(x => x.id === App.stage.selectedId);
    if (cur && cur.parent) folderId = cur.parent;
  }
  if (!folderId) {
    setHint('Выберите папку (или слой внутри папки) для разгруппировки', 1800);
    return;
  }
  const folder = App.stage.data.items.find(x => x.id === folderId);
  if (!folder) return;

  const releasedIds = [];
  for (const it of App.stage.data.items) {
    if (it.parent === folderId) {
      it.parent = folder.parent || null;
      releasedIds.push(it.id);
    }
  }

  const dom = App.stage.domItems[folderId];
  if (dom && dom.outerG && dom.outerG.parentNode) {
    dom.outerG.parentNode.removeChild(dom.outerG);
  }
  delete App.stage.domItems[folderId];
  App.stage.data.items = App.stage.data.items.filter(x => x.id !== folderId);

  syncStageDomOrder();
  markStageDirty();
  setStageSelection(releasedIds.length ? releasedIds : ['__bg__'], releasedIds[0] || '__bg__');
  setHint('Папка «' + folder.label + '» разгруппирована', 1600);
}

async function duplicateSelectedStageItems() {
  if (!App.stage.data) return;
  const sel = Array.from(App.stage.selectedIds).filter(id => id !== '__bg__');
  if (!sel.length) {
    setHint('Выберите слой для дублирования', 1600);
    return;
  }
  const existingLabels = App.stage.data.items.map(x => x.label);
  const newIds = [];
  for (const sid of sel) {
    const src = App.stage.data.items.find(x => x.id === sid);
    if (!src || src.isGroup) continue;
    const copy = clone(src);
    copy.id = nextStageItemId(copy.type === 'object' ? 'obj' : 'asset');
    copy.label = resolveAutoName(existingLabels, (src.label || src.id) + '_');
    existingLabels.push(copy.label);
    copy.anchor = {
      x: Math.min(0.98, (copy.anchor.x || 0.5) + 0.02),
      y: Math.min(0.98, (copy.anchor.y || 0.5) + 0.02)
    };
    App.stage.data.items.push(copy);
    if (copy.type === 'object' && copy.objectName) {
      const tpl = await loadStageObjectTemplate(copy.objectName);
      const dom = buildObjectInstanceDom(copy, tpl);
      App.stage.domItems[copy.id] = dom;
      applyInstanceAnimationPose(copy, dom, App.stage.playing ? App.stage.time : 0);
    } else if (copy.type === 'asset' && copy.file) {
      const asset = await fetchStageAssetParsed(App.stage.current, copy.file);
      App.stage.domItems[copy.id] = buildAssetInstanceDom(copy, asset);
    }
    syncStageItemTransform(copy);
    newIds.push(copy.id);
  }
  if (newIds.length) {
    syncStageDomOrder();
    markStageDirty();
    setStageSelection(newIds, newIds[newIds.length - 1]);
    setHint('Дублировано слоёв: ' + newIds.length, 1600);
  }
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
  if (els.modalStagePickObj) els.modalStagePickObj.hidden = false;
  await renderStagePickList();
}

function closeStagePickModal() {
  if (els.modalStagePickObj) els.modalStagePickObj.hidden = true;
}

async function renderStagePickList() {
  if (!els.stagePickList) return;
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
        '<li class="empty">В папке сцены пока нет SVG/PNG файлов. Нажмите «Загрузить файл…».</li>';
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
  ensureStageViewportSkeleton();
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
    animation: tpl.defaultAnim || '__static__',
    loop: true,
    speed: 1,
    phase: 0,
    visible: true,
    opacity: 1,
    interaction: normalizeStageInteraction(null, 'object')
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
  ensureStageViewportSkeleton();
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
    visible: true,
    opacity: 1,
    interaction: normalizeStageInteraction(null, 'asset')
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
  if (!App.stage.current) return;
  App.stage._uploadTarget = targetKind; // 'bg' | 'asset'
  const inputEl = (targetKind === 'asset' && els.stagePickAssetInput)
    ? els.stagePickAssetInput
    : els.stageFileInput;
  if (!inputEl) return;
  inputEl.value = '';
  inputEl.click();
}

async function handleStageUploadedFiles(fileList, targetKind) {
  if (!fileList || !fileList.length || !App.stage.current) return;
  try {
    let lastSaved = '';
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      const savedName = await uploadStageAssetBackend(App.stage.current, f);
      if (!App.stage.assets.includes(savedName)) {
        App.stage.assets.push(savedName);
      }
      lastSaved = savedName;
    }
    App.stage.assets.sort((a, b) => a.localeCompare(b));

    if (targetKind === 'bg' && lastSaved) {
      App.stage.data.background.file = lastSaved;
      markStageDirty();
      await renderStageBackground();
      renderStageLayers();
      renderStageProperties();
      setHint('Фон сцены установлен: ' + lastSaved, 2200);
    } else if (lastSaved) {
      App.stage._pickTab = 'asset';
      App.stage._pickSelected = lastSaved;
      if (els.modalStagePickObj && !els.modalStagePickObj.hidden) {
        await renderStagePickList();
      } else {
        await addAssetLayerToStageCenter(lastSaved, App.stage._pendingFolderId || null);
      }
      setHint('Файл загружен в сцену: ' + lastSaved, 2000);
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

function getGroupBoundsAndCenter(leaves, metrics) {
  const m = metrics || getStageFrameMetrics();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of leaves) {
    const b = getStageItemWorldAABB(it, m);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, cx: 0, cy: 0, anchor: { x: 0.5, y: 0.5 } };
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { minX, minY, maxX, maxY, cx, cy, anchor: worldToAnchor(cx, cy, m) };
}

function stageAlignButtonsHtml(includeDistribute) {
  return (
    '<div class="stage-align-grid">' +
      '<button type="button" class="stage-align-btn" data-salign="left" title="Выровнять по левому краю"><span class="material-icons">align_horizontal_left</span></button>' +
      '<button type="button" class="stage-align-btn" data-salign="center-x" title="Выровнять по центру X"><span class="material-icons">align_horizontal_center</span></button>' +
      '<button type="button" class="stage-align-btn" data-salign="right" title="Выровнять по правому краю"><span class="material-icons">align_horizontal_right</span></button>' +
      '<button type="button" class="stage-align-btn" data-salign="top" title="Выровнять по верхнему краю"><span class="material-icons">align_vertical_top</span></button>' +
      '<button type="button" class="stage-align-btn" data-salign="center-y" title="Выровнять по центру Y"><span class="material-icons">align_vertical_center</span></button>' +
      '<button type="button" class="stage-align-btn" data-salign="bottom" title="Выровнять по нижнему краю"><span class="material-icons">align_vertical_bottom</span></button>' +
    '</div>' +
    (includeDistribute
      ? '<div class="stage-btn-row">' +
          '<button type="button" class="stage-btn-sm" data-salign="dist-x" title="Равномерно распределить по горизонтали (от 3 объектов)">Распред. X</button>' +
          '<button type="button" class="stage-btn-sm" data-salign="dist-y" title="Равномерно распределить по вертикали (от 3 объектов)">Распред. Y</button>' +
        '</div>'
      : '')
  );
}

function syncStageInspectorLive() {
  const props = els.props;
  if (!props || App.editorMode !== 'stage') return;
  const leaves = getSelectedTransformLeafItems();
  const m = getStageFrameMetrics();
  if (leaves.length > 1 || (App.stage.selectedId && isStageFolderId(App.stage.selectedId) && leaves.length >= 1)) {
    const gc = getGroupBoundsAndCenter(leaves, m);
    const gMap = {
      'grp.ancX': (gc.anchor.x * 100).toFixed(2),
      'grp.ancY': (gc.anchor.y * 100).toFixed(2),
      'grp.pxX':  gc.cx.toFixed(1),
      'grp.pxY':  gc.cy.toFixed(1),
    };
    for (const k of Object.keys(gMap)) {
      const inp = props.querySelector('input[data-skey="' + k + '"]');
      if (inp && document.activeElement !== inp) inp.value = gMap[k];
    }
    return;
  }
  if (leaves.length !== 1) return;
  const it = leaves[0];
  const wpos = anchorToWorld(it.anchor, m);
  const map = {
    'anc.x': (it.anchor.x * 100).toFixed(2),
    'anc.y': (it.anchor.y * 100).toFixed(2),
    'px.x':  wpos.x.toFixed(1),
    'px.y':  wpos.y.toFixed(1),
    'scl.x': it.scale.x.toFixed(3),
    'scl.y': it.scale.y.toFixed(3),
    'rot':   it.rotation.toFixed(1)
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

  // 1) Выбран встроенный слой «Бэкграунд» (свойства самого фона СВЁРНУТЫ по умолчанию)
  if (selId === '__bg__' || (!leaves.length && !isStageFolderId(selId))) {
    const st = App.stage.data;
    const bg = st.background;
    const fr = st.frame;
    const guides = st.guides || [];
    const bgExpanded = !!App.stage.bgPropsExpanded;
    els.propsTitle.textContent = 'Сцена и Бэкграунд';

    let fileOptions = '<option value="">— Без картинки (сплошной прямоугольник) —</option>';
    for (const f of (App.stage.assets || [])) {
      const sel = (bg.file === f) ? ' selected' : '';
      fileOptions += '<option value="' + escapeHtmlAttr(f) + '"' + sel + '>' + escapeHtmlAttr(f) + '</option>';
    }

    const bgSummary = bg.file ? bg.file : (bg.color || '#243447');
    const toggleIcon = bgExpanded ? 'expand_less' : 'expand_more';

    props.innerHTML =
      // Сворачиваемая карточка Бэкграунда — СВЁРНУТА по умолчанию
      '<div class="stage-collapse-card">' +
        '<button type="button" class="stage-collapse-head" id="sprop-bg-collapse-btn">' +
          '<span class="material-icons">' + toggleIcon + '</span>' +
          '<span>Свойства Бэкграунда</span>' +
          '<span class="stage-collapse-summary">' + escapeHtmlAttr(bgSummary) + '</span>' +
        '</button>' +
        '<div class="stage-collapse-body" id="sprop-bg-collapse-body"' + (bgExpanded ? '' : ' hidden') + '>' +
          '<label class="pcheck">' +
            '<input type="checkbox" id="sprop-bg-vis"' + (bg.visible !== false ? ' checked' : '') + '>' +
            '<span>Показывать фон сцены</span>' +
          '</label>' +
          '<div class="pgroup-title" style="margin-top:4px">Цвет прямоугольника фона</div>' +
          '<div class="stage-color-row">' +
            '<input type="color" id="sprop-bg-color" value="' + escapeHtmlAttr(normalizeHex6(bg.color)) + '">' +
            '<input type="text" id="sprop-bg-hex" value="' + escapeHtmlAttr(bg.color || '#243447') + '">' +
          '</div>' +
          '<div class="pgroup-title" style="margin-top:6px">Картинка фона (SVG / PNG)</div>' +
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
        '</div>' +
      '</div>' +

      // Карточка целевого фрэйма игры и типа сцены (Игровая / Катсцена)
      '<div class="pgroup">' +
        '<div class="pgroup-title">Фрэйм игры и назначение сцены</div>' +
        '<select id="sprop-scene-kind" class="stage-prop-select">' +
          '<option value="gameplay"' + (st.sceneKind !== 'cutscene' ? ' selected' : '') + '>Игровая интерактивная сцена</option>' +
          '<option value="cutscene"' + (st.sceneKind === 'cutscene' ? ' selected' : '') + '>Сцена для катсцены / анимации</option>' +
        '</select>' +
        stagePropRowHtml('W', 'frame.w', fr.width, 10, 0) +
        stagePropRowHtml('H', 'frame.h', fr.height, 10, 0) +
        '<div class="stage-btn-row">' +
          '<button type="button" class="stage-btn-sm" data-res="1366x768">1366×768</button>' +
          '<button type="button" class="stage-btn-sm" data-res="1920x1080">1920×1080</button>' +
          '<button type="button" class="stage-btn-sm" data-res="1280x720">1280×720</button>' +
        '</div>' +
      '</div>' +

      // Быстрое управление направляющими и сеткой макета
      '<div class="pgroup">' +
        '<div class="pgroup-title">Направляющие (' + guides.length + ') и сетка макета</div>' +
        '<div class="stage-btn-row">' +
          '<button type="button" id="sprop-guide-menu" class="stage-btn-sm primary-green">Меню направляющих…</button>' +
          '<button type="button" id="sprop-grid-menu" class="stage-btn-sm">Настройка сетки…</button>' +
        '</div>' +
        '<div class="stage-btn-row">' +
          '<button type="button" id="sprop-guide-center" class="stage-btn-sm">+ Крест 50%</button>' +
          (guides.length ? '<button type="button" id="sprop-guide-clear" class="stage-btn-sm">Очистить</button>' : '') +
        '</div>' +
      '</div>';

    props.querySelector('#sprop-bg-collapse-btn').addEventListener('click', () => {
      App.stage.bgPropsExpanded = !App.stage.bgPropsExpanded;
      renderStageProperties();
    });

    props.querySelector('#sprop-guide-menu').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleGuidesSettingsPopover(els.btnStageGuidesMenu || e.currentTarget);
    });

    props.querySelector('#sprop-grid-menu').addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof toggleGridSettingsPopover === 'function') {
        toggleGridSettingsPopover(els.btnGridSettings || e.currentTarget);
      }
    });

    props.querySelector('#sprop-scene-kind').addEventListener('change', (e) => {
      st.sceneKind = e.target.value === 'cutscene' ? 'cutscene' : 'gameplay';
      markStageDirty();
    });

    props.querySelector('#sprop-guide-center').addEventListener('click', () => {
      st.guides.push(
        { id: nextStageGuideId(), axis: 'v', pos: 0.5 }
      );
      st.guides.push(
        { id: nextStageGuideId(), axis: 'h', pos: 0.5 }
      );
      markStageDirty();
      renderStageGuidesOverlay();
      renderStageProperties();
    });

    const clearGuidesBtn = props.querySelector('#sprop-guide-clear');
    if (clearGuidesBtn) {
      clearGuidesBtn.addEventListener('click', () => {
        st.guides = [];
        markStageDirty();
        renderStageGuidesOverlay();
        renderStageProperties();
      });
    }

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
        syncStageRubberSlidersToBase();
        markStageDirty();
        renderStageBackground();
        syncAllStageTransforms();
        renderStageLayers();
        renderStageProperties();
        renderStageRulersAndGuides();
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
        if (k === 'frame.w') { fr.width  = clamp(Math.round(v), 128, 7680); syncStageRubberSlidersToBase(); }
        if (k === 'frame.h') { fr.height = clamp(Math.round(v), 128, 4320); syncStageRubberSlidersToBase(); }
        if (k === 'bg.op')   bg.opacity = clamp(v, 0, 1);
        markStageDirty();
        renderStageBackground();
        syncAllStageTransforms();
        renderStageLayers();
        renderStageRulersAndGuides();
        StageGizmo.render();
      },
      reset: { 'frame.w': 1366, 'frame.h': 768, 'bg.op': 1 }
    });
    return;
  }

  // 2) Групповое выделение (папка ИЛИ несколько слоёв) — совместное редактирование свойств и позиционирование
  if (leaves.length > 1 || isStageFolderId(selId)) {
    const folder = isStageFolderId(selId)
      ? App.stage.data.items.find(x => x.id === selId)
      : null;
    const m = getStageFrameMetrics();
    const gc = getGroupBoundsAndCenter(leaves, m);
    const avgOpacity = leaves.length
      ? (leaves.reduce((acc, x) => acc + (x.opacity ?? 1), 0) / leaves.length)
      : 1;
    const alignToFrame = !!App.stage._groupAlignFrame;

    els.propsTitle.textContent = folder
      ? ('Папка: ' + folder.label + ' (' + leaves.length + ')')
      : ('Выделено слоёв: ' + leaves.length);

    props.innerHTML =
      (folder
        ? '<div class="pgroup">' +
            '<label class="pcheck">' +
              '<input type="checkbox" id="sprop-folder-vis"' + (folder.visible !== false ? ' checked' : '') + '>' +
              '<span>Видимость папки</span>' +
            '</label>' +
            '<label class="pcheck" title="Папка используется как удобная группа для совместного позиционирования в редакторе — можно разгруппировать в любой момент без потери позиций">' +
              '<input type="checkbox" id="sprop-folder-editor-only"' + (folder.editorOnly ? ' checked' : '') + '>' +
              '<span>Группа только для позиционирования</span>' +
            '</label>' +
            '<div class="stage-btn-row">' +
              '<button type="button" id="sprop-folder-selall" class="stage-btn-sm primary-green"' + (leaves.length ? '' : ' disabled') + '>Выделить все объекты (' + leaves.length + ')</button>' +
              '<button type="button" id="sprop-folder-ungroup" class="stage-btn-sm">Разгруппировать</button>' +
            '</div>' +
            '<div class="stage-btn-row">' +
              '<button type="button" id="sprop-grp-add-here" class="stage-btn-sm">+ Добавить слой в папку…</button>' +
            '</div>' +
          '</div>'
        : '<div class="pgroup">' +
            '<div class="pgroup-title">Группировка для позиционирования</div>' +
            '<div class="stage-btn-row">' +
              '<button type="button" id="sprop-pack-temp-grp" class="stage-btn-sm primary-green">Во врем. группу позиц.</button>' +
              '<button type="button" id="sprop-pack-folder" class="stage-btn-sm">В папку</button>' +
            '</div>' +
          '</div>') +

      '<div class="pgroup">' +
        '<div class="pgroup-title">Позиция центра группы и выравнивание</div>' +
        stagePropRowHtml('X%', 'grp.ancX', gc.anchor.x * 100, 0.5, 2) +
        stagePropRowHtml('Y%', 'grp.ancY', gc.anchor.y * 100, 0.5, 2) +
        stagePropRowHtml('X', 'grp.pxX', gc.cx, 2, 1) +
        stagePropRowHtml('Y', 'grp.pxY', gc.cy, 2, 1) +
        '<label class="pcheck" style="margin-top:4px">' +
          '<input type="checkbox" id="sprop-align-ref"' + (alignToFrame ? ' checked' : '') + '>' +
          '<span>Выравнивать относительно фрэйма 1366×768</span>' +
        '</label>' +
        stageAlignButtonsHtml(leaves.length >= 3) +
        '<div class="stage-btn-row">' +
          '<button type="button" id="sprop-grp-center" class="stage-btn-sm primary-green">Группу в центр сцены (50%, 50%)</button>' +
        '</div>' +
      '</div>' +

      '<div class="pgroup">' +
        '<div class="pgroup-title">Масштаб, поворот и прозрачность группы</div>' +
        stagePropRowHtml('K%', 'grp.pct', 100, 5, 1) +
        '<div class="stage-btn-row">' +
          '<button type="button" class="stage-btn-sm" data-gscale="0.5">×0.5</button>' +
          '<button type="button" class="stage-btn-sm" data-gscale="0.8">×0.8</button>' +
          '<button type="button" class="stage-btn-sm" data-gscale="1.25">×1.25</button>' +
          '<button type="button" class="stage-btn-sm" data-gscale="1.5">×1.5</button>' +
          '<button type="button" id="sprop-grp-flipx" class="stage-btn-sm" title="Зеркально отразить группу по X">Flip X</button>' +
        '</div>' +
        '<div class="stage-btn-row">' +
          '<button type="button" class="stage-btn-sm" data-grot="-15">↺ -15°</button>' +
          '<button type="button" class="stage-btn-sm" data-grot="15">↻ +15°</button>' +
          '<button type="button" class="stage-btn-sm" data-grot="reset">Сброс R=0°</button>' +
        '</div>' +
        stagePropRowHtml('Op', 'grp.op', avgOpacity, 0.05, 2) +
      '</div>' +

      '<div class="pgroup">' +
        '<div class="pgroup-title">Пакетные свойства выбранных объектов</div>' +
        '<select id="sprop-batch-scalemode" class="stage-prop-select">' +
          '<option value="">— Задать адаптивность всем (' + leaves.length + ') —</option>' +
          '<option value="fit">Пропорционально экрану (fit)</option>' +
          '<option value="stretch">Растягивать с экраном (stretch)</option>' +
          '<option value="width">По ширине экрана (width)</option>' +
          '<option value="height">По высоте экрана (height)</option>' +
          '<option value="fixed">Фиксированный px (fixed)</option>' +
        '</select>' +
        '<select id="sprop-batch-role" class="stage-prop-select">' +
          '<option value="">— Задать роль в игре всем (' + leaves.length + ') —</option>' +
          '<option value="static">Статичный декор</option>' +
          '<option value="animated">Фоновая анимация</option>' +
          '<option value="interactive">Интерактивный объект</option>' +
          '<option value="scripted">Управляется игрой / катсценой</option>' +
        '</select>' +
        '<div class="stage-btn-row">' +
          '<button type="button" class="stage-btn-sm" data-gz="front" title="На передний план">На передний</button>' +
          '<button type="button" class="stage-btn-sm" data-gz="back" title="На задний план">На задний</button>' +
          '<button type="button" id="sprop-grp-vis-on" class="stage-btn-sm">Показать все</button>' +
          '<button type="button" id="sprop-grp-vis-off" class="stage-btn-sm">Скрыть все</button>' +
        '</div>' +
      '</div>';

    if (folder) {
      props.querySelector('#sprop-folder-vis').addEventListener('change', (e) => {
        folder.visible = e.target.checked;
        markStageDirty();
        syncAllStageTransforms();
        renderStageLayers();
        StageGizmo.render();
      });
      props.querySelector('#sprop-folder-editor-only').addEventListener('change', (e) => {
        folder.editorOnly = e.target.checked;
        markStageDirty();
        renderStageLayers();
      });
      props.querySelector('#sprop-folder-selall').addEventListener('click', () => selectAllInStageFolder(folder.id));
      props.querySelector('#sprop-folder-ungroup').addEventListener('click', ungroupSelectedStageFolder);
      props.querySelector('#sprop-grp-add-here').addEventListener('click', openStagePickModal);
    } else {
      props.querySelector('#sprop-pack-temp-grp').addEventListener('click', () => createStageFolder(true));
      props.querySelector('#sprop-pack-folder').addEventListener('click', () => createStageFolder(false));
    }

    const alignRefChk = props.querySelector('#sprop-align-ref');
    if (alignRefChk) {
      alignRefChk.addEventListener('change', () => {
        App.stage._groupAlignFrame = alignRefChk.checked;
      });
    }

    props.querySelectorAll('[data-salign]').forEach(btn => {
      btn.addEventListener('click', () => {
        alignSelectedStageItems(btn.getAttribute('data-salign'), !!App.stage._groupAlignFrame);
      });
    });

    function moveGroupCenterToWorld(targetCx, targetCy) {
      if (!leaves.length) return;
      const curM = getStageFrameMetrics();
      const curG = getGroupBoundsAndCenter(leaves, curM);
      const dx = targetCx - curG.cx;
      const dy = targetCy - curG.cy;
      for (const it of leaves) {
        const wp = anchorToWorld(it.anchor, curM);
        it.anchor = worldToAnchor(wp.x + dx, wp.y + dy, curM);
        syncStageItemTransform(it, curM);
      }
      markStageDirty();
      syncStageInspectorLive();
      StageGizmo.render();
    }

    function scaleGroupByFactor(factor) {
      if (!leaves.length || !isFinite(factor) || factor <= 0) return;
      const curM = getStageFrameMetrics();
      const curG = getGroupBoundsAndCenter(leaves, curM);
      for (const it of leaves) {
        const wp = anchorToWorld(it.anchor, curM);
        const nx = curG.cx + (wp.x - curG.cx) * factor;
        const ny = curG.cy + (wp.y - curG.cy) * factor;
        it.anchor = worldToAnchor(nx, ny, curM);
        it.scale.x = roundScaleVal(it.scale.x * factor);
        it.scale.y = roundScaleVal(it.scale.y * factor);
        syncStageItemTransform(it, curM);
      }
      markStageDirty();
      updateStageSelSize();
      syncStageInspectorLive();
      StageGizmo.render();
    }

    props.querySelectorAll('button[data-gscale]').forEach(btn => {
      btn.addEventListener('click', () => scaleGroupByFactor(parseFloat(btn.dataset.gscale)));
    });

    props.querySelector('#sprop-grp-flipx').addEventListener('click', () => {
      if (!leaves.length) return;
      const curM = getStageFrameMetrics();
      const curG = getGroupBoundsAndCenter(leaves, curM);
      for (const it of leaves) {
        const wp = anchorToWorld(it.anchor, curM);
        const nx = curG.cx - (wp.x - curG.cx);
        it.anchor = worldToAnchor(nx, wp.y, curM);
        it.scale.x = -it.scale.x;
        it.rotation = -(it.rotation || 0);
        syncStageItemTransform(it, curM);
      }
      markStageDirty();
      syncStageInspectorLive();
      StageGizmo.render();
    });

    props.querySelectorAll('button[data-grot]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!leaves.length) return;
        const curM = getStageFrameMetrics();
        const raw = btn.getAttribute('data-grot');
        if (raw === 'reset') {
          for (const it of leaves) {
            it.rotation = 0;
            syncStageItemTransform(it, curM);
          }
        } else {
          const deg = parseFloat(raw) || 0;
          const rad = deg * Math.PI / 180;
          const c = Math.cos(rad), s = Math.sin(rad);
          const curG = getGroupBoundsAndCenter(leaves, curM);
          for (const it of leaves) {
            const wp = anchorToWorld(it.anchor, curM);
            const dx = wp.x - curG.cx, dy = wp.y - curG.cy;
            it.anchor = worldToAnchor(curG.cx + dx * c - dy * s, curG.cy + dx * s + dy * c, curM);
            it.rotation = Math.round(((it.rotation || 0) + deg) * 100) / 100;
            syncStageItemTransform(it, curM);
          }
        }
        markStageDirty();
        updateStageSelSize();
        syncStageInspectorLive();
        StageGizmo.render();
      });
    });

    props.querySelector('#sprop-grp-center').addEventListener('click', () => {
      moveGroupCenterToWorld(0, 0);
    });

    props.querySelector('#sprop-batch-scalemode').addEventListener('change', (e) => {
      const val = e.target.value;
      if (!val) return;
      for (const it of leaves) {
        it.scaleMode = val;
        syncStageItemTransform(it);
      }
      markStageDirty();
      updateStageSelSize();
      StageGizmo.render();
      e.target.value = '';
    });

    props.querySelector('#sprop-batch-role').addEventListener('change', (e) => {
      const val = e.target.value;
      if (!val) return;
      for (const it of leaves) {
        it.interaction = normalizeStageInteraction(it.interaction, it.type);
        it.interaction.role = val;
        if (val === 'interactive' && !it.interaction.clickable && !it.interaction.draggable) {
          it.interaction.clickable = true;
        }
      }
      markStageDirty();
      renderStageLayers();
      e.target.value = '';
    });

    props.querySelectorAll('[data-gz]').forEach(btn => {
      btn.addEventListener('click', () => moveSelectedStageZOrder(btn.getAttribute('data-gz')));
    });

    props.querySelector('#sprop-grp-vis-on').addEventListener('click', () => {
      for (const it of leaves) { it.visible = true; syncStageItemTransform(it); }
      markStageDirty(); renderStageLayers(); StageGizmo.render();
    });
    props.querySelector('#sprop-grp-vis-off').addEventListener('click', () => {
      for (const it of leaves) { it.visible = false; syncStageItemTransform(it); }
      markStageDirty(); renderStageLayers(); StageGizmo.render();
    });

    let lastPct = 100;
    bindStageNumericInputs(props, {
      get(k) {
        const curM = getStageFrameMetrics();
        const curG = getGroupBoundsAndCenter(leaves, curM);
        if (k === 'grp.ancX') return curG.anchor.x * 100;
        if (k === 'grp.ancY') return curG.anchor.y * 100;
        if (k === 'grp.pxX')  return curG.cx;
        if (k === 'grp.pxY')  return curG.cy;
        if (k === 'grp.op')   return leaves.length ? (leaves[0].opacity ?? 1) : 1;
        return lastPct;
      },
      set(k, v) {
        const curM = getStageFrameMetrics();
        const curG = getGroupBoundsAndCenter(leaves, curM);
        if (k === 'grp.ancX') {
          const w = anchorToWorld({ x: v / 100, y: curG.anchor.y }, curM);
          moveGroupCenterToWorld(w.x, curG.cy);
          return;
        }
        if (k === 'grp.ancY') {
          const w = anchorToWorld({ x: curG.anchor.x, y: v / 100 }, curM);
          moveGroupCenterToWorld(curG.cx, w.y);
          return;
        }
        if (k === 'grp.pxX') { moveGroupCenterToWorld(v, curG.cy); return; }
        if (k === 'grp.pxY') { moveGroupCenterToWorld(curG.cx, v); return; }
        if (k === 'grp.op') {
          const op = clamp(v, 0, 1);
          for (const it of leaves) { it.opacity = op; syncStageItemTransform(it, curM); }
          markStageDirty();
          return;
        }
        if (k === 'grp.pct') {
          const nextPct = clamp(v, 10, 500);
          const ratio = nextPct / lastPct;
          lastPct = nextPct;
          scaleGroupByFactor(ratio);
        }
      },
      reset: {
        'grp.ancX': 50, 'grp.ancY': 50,
        'grp.pxX': 0,   'grp.pxY': 0,
        'grp.pct': 100, 'grp.op': 1
      }
    });
    return;
  }

  // 3) Одиночный слой сцены (анимированный объект anim/ или декор stage/)
  const it = leaves[0];
  it.interaction = normalizeStageInteraction(it.interaction, it.type);
  const inter = it.interaction;
  const m = getStageFrameMetrics();
  const wpos = anchorToWorld(it.anchor, m);
  els.propsTitle.textContent = (it.type === 'object' ? 'Объект: ' : 'Слой: ') + (it.label || it.id);

  let animBlockHtml = '';
  let animNames = [];
  if (it.type === 'object') {
    const tpl = App.stage.templates[it.objectName];
    animNames = tpl ? tpl.animNames : [];
    let animOpts = '<option value="__static__"' + (it.animation === '__static__' ? ' selected' : '') + '>— Статика (базовая поза) —</option>';
    for (const an of animNames) {
      const sel = (it.animation === an) ? ' selected' : '';
      animOpts += '<option value="' + escapeHtmlAttr(an) + '"' + sel + '>' + escapeHtmlAttr(an) + '</option>';
    }
    animBlockHtml =
      '<div class="pgroup">' +
        '<div class="pgroup-title">Анимация по умолчанию (' + escapeHtmlAttr(it.objectName) + ')</div>' +
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

  let clickAnimOpts = '<option value="">— Без смены анимации —</option>';
  for (const an of animNames) {
    const sel = (inter.onClickAnim === an) ? ' selected' : '';
    clickAnimOpts += '<option value="' + escapeHtmlAttr(an) + '"' + sel + '>' + escapeHtmlAttr(an) + '</option>';
  }

  props.innerHTML =
    '<label class="pcheck">' +
      '<input type="checkbox" id="sprop-item-vis"' + (it.visible !== false ? ' checked' : '') + '>' +
      '<span>Видимость в редакторе</span>' +
    '</label>' +
    animBlockHtml +
    '<div class="pgroup">' +
      '<div class="pgroup-title">Поведение в игре / катсцене</div>' +
      '<select id="sprop-inter-role" class="stage-prop-select">' +
        '<option value="static"'      + (inter.role === 'static'      ? ' selected' : '') + '>Статичный декор</option>' +
        '<option value="animated"'    + (inter.role === 'animated'    ? ' selected' : '') + '>Фоновая анимация</option>' +
        '<option value="interactive"' + (inter.role === 'interactive' ? ' selected' : '') + '>Интерактивный объект (клик / drag)</option>' +
        '<option value="scripted"'    + (inter.role === 'scripted'    ? ' selected' : '') + '>Управляется игрой / катсценой</option>' +
      '</select>' +
      '<select id="sprop-inter-init" class="stage-prop-select" title="Начальное состояние при старте сцены">' +
        '<option value="visible"' + (inter.initialState !== 'hidden' ? ' selected' : '') + '>На старте игры: Показан</option>' +
        '<option value="hidden"'  + (inter.initialState === 'hidden' ? ' selected' : '') + '>На старте игры: Скрыт (ждёт триггер)</option>' +
      '</select>' +
      '<label class="pcheck">' +
        '<input type="checkbox" id="sprop-inter-click"' + (inter.clickable ? ' checked' : '') + '>' +
        '<span>Реагирует на клик / тап</span>' +
      '</label>' +
      '<label class="pcheck">' +
        '<input type="checkbox" id="sprop-inter-drag"' + (inter.draggable ? ' checked' : '') + '>' +
        '<span>Перетаскиваемый игроком (Drag & Drop)</span>' +
      '</label>' +
      (it.type === 'object'
        ? '<div class="pgroup-title" style="margin-top:4px">Анимация по клику / событию</div>' +
          '<select id="sprop-inter-click-anim" class="stage-prop-select">' + clickAnimOpts + '</select>'
        : '') +
      '<div class="prow" style="margin-top:4px">' +
        '<span class="plabel">ID</span>' +
        '<input type="text" id="sprop-inter-tag" class="stage-prop-select" style="margin:0" placeholder="game_id (напр. fairy_npc)" value="' + escapeHtmlAttr(inter.gameTag) + '">' +
      '</div>' +
    '</div>' +
    '<div class="pgroup">' +
      '<div class="pgroup-title">Позиция пивота (% от фрэйма — резиновая)</div>' +
      stagePropRowHtml('X%', 'anc.x', it.anchor.x * 100, 0.5, 2) +
      stagePropRowHtml('Y%', 'anc.y', it.anchor.y * 100, 0.5, 2) +
      '<div class="pgroup-title" style="margin-top:5px">Мировые координаты пивота, px</div>' +
      stagePropRowHtml('X', 'px.x', wpos.x, 2, 1) +
      stagePropRowHtml('Y', 'px.y', wpos.y, 2, 1) +
      '<div class="pgroup-title" style="margin-top:5px">Выравнивание по фрэйму 1366×768</div>' +
      stageAlignButtonsHtml(false) +
      '<div class="stage-btn-row">' +
        '<button type="button" id="sprop-item-center" class="stage-btn-sm primary-green">Пивот в (50%, 50%)</button>' +
      '</div>' +
      '<div class="stage-btn-row">' +
        '<button type="button" class="stage-btn-sm" data-sz="front" title="На передний план">На передний</button>' +
        '<button type="button" class="stage-btn-sm" data-sz="up" title="Поднять выше">Выше</button>' +
        '<button type="button" class="stage-btn-sm" data-sz="down" title="Опустить ниже">Ниже</button>' +
        '<button type="button" class="stage-btn-sm" data-sz="back" title="На задний план">На задний</button>' +
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
    '</div>';

  props.querySelector('#sprop-item-vis').addEventListener('change', (e) => {
    it.visible = e.target.checked;
    markStageDirty();
    syncStageItemTransform(it);
    renderStageLayers();
    StageGizmo.render();
  });

  props.querySelector('#sprop-inter-role').addEventListener('change', (e) => {
    inter.role = e.target.value;
    if (inter.role === 'interactive' && !inter.clickable && !inter.draggable) {
      inter.clickable = true;
      const chk = props.querySelector('#sprop-inter-click');
      if (chk) chk.checked = true;
    }
    markStageDirty();
    renderStageLayers();
  });
  props.querySelector('#sprop-inter-init').addEventListener('change', (e) => {
    inter.initialState = e.target.value === 'hidden' ? 'hidden' : 'visible';
    markStageDirty();
  });
  props.querySelector('#sprop-inter-click').addEventListener('change', (e) => {
    inter.clickable = e.target.checked;
    if (inter.clickable && inter.role === 'static') inter.role = 'interactive';
    markStageDirty();
    renderStageLayers();
  });
  props.querySelector('#sprop-inter-drag').addEventListener('change', (e) => {
    inter.draggable = e.target.checked;
    if (inter.draggable && inter.role === 'static') inter.role = 'interactive';
    markStageDirty();
    renderStageLayers();
  });
  const clickAnimSel = props.querySelector('#sprop-inter-click-anim');
  if (clickAnimSel) {
    clickAnimSel.addEventListener('change', (e) => {
      inter.onClickAnim = e.target.value;
      markStageDirty();
    });
  }
  props.querySelector('#sprop-inter-tag').addEventListener('change', (e) => {
    inter.gameTag = e.target.value.trim();
    markStageDirty();
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

  props.querySelectorAll('[data-salign]').forEach(btn => {
    btn.addEventListener('click', () => alignSelectedStageItems(btn.getAttribute('data-salign'), true));
  });

  props.querySelectorAll('[data-sz]').forEach(btn => {
    btn.addEventListener('click', () => moveSelectedStageZOrder(btn.getAttribute('data-sz')));
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

// -------- сворачивание нижней панели сцены по кнопке-стрелочке --------

function toggleStageBarCollapse() {
  App.stage.barCollapsed = !App.stage.barCollapsed;
  if (els.stageBar) {
    els.stageBar.classList.toggle('collapsed', App.stage.barCollapsed);
  }
  if (els.stageBarToggleIcon) {
    els.stageBarToggleIcon.textContent = App.stage.barCollapsed ? 'expand_less' : 'expand_more';
  }
  requestAnimationFrame(() => {
    applyCamera();
    renderStageRulersAndGuides();
  });
}

// -------- открытие, сохранение и CRUD сцен --------

function fitStageView() {
  const m = getStageFrameMetrics();
  const vp = els.viewport;
  const W = vp.clientWidth || 1000;
  const H = vp.clientHeight || 640;
  const rulerOffset = App.stage.showRulers ? RULER_THICK : 0;
  const pad = 42;
  const z = Math.min(
    Math.max(40, W - rulerOffset - pad * 2) / m.fw,
    Math.max(40, H - rulerOffset - pad * 2) / m.fh
  );
  App.camera.x = -rulerOffset / (2 * Math.max(0.1, z));
  App.camera.y = -rulerOffset / (2 * Math.max(0.1, z));
  App.camera.zoom = clamp(z, 0.05, 20);
  App.stage.camera = clone(App.camera);
  applyCamera();
}

async function openStage(name) {
  if (!name) return;
  try {
    if (App.stage.previewFullscreen) exitStageFullscreenPreview();
    else stopStagePreview();

    App.stage._suppressDirty = true;
    const res = await fetchStageData(name);
    App.stage.current = name;
    App.stage._selectedModalName = name;
    App.stage.assets = res.assets || [];
    App.stage.data = ensureStageStructure(res.stage, name);
    App.stage.selectedId = '__bg__';
    App.stage.selectedIds = new Set(['__bg__']);
    App.stage.bgPropsExpanded = false; // Бэкграунд свёрнут по умолчанию
    syncStageRubberSlidersToBase();
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
  if (els.stagesSourceText && els.storageLabel) {
    els.stagesSourceText.textContent = 'Источник: ' + (els.storageLabel.textContent || 'репозиторий');
  }
  if (els.stagesBtnReconnect) {
    els.stagesBtnReconnect.hidden = !App.storage.pendingHandle;
  }
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
    if (App.stage.previewFullscreen) exitStageFullscreenPreview();
    else stopStagePreview();
    App.stage.camera = clone(App.camera);
  }

  App.editorMode = nextMode;
  document.body.setAttribute('data-editor-mode', nextMode);

  if (els.btnEditorMode) {
    els.btnEditorMode.classList.toggle('mode-object', !toStage);
    els.btnEditorMode.classList.toggle('mode-stage', toStage);
    els.btnEditorMode.title = toStage
      ? 'Текущий режим: Редактор сцены (зелёный). Нажмите для возврата в Анимацию объектов (малиновый)'
      : 'Текущий режим: Анимация объектов (малиновый). Нажмите для перехода в Редактор сцены (зелёный)';
  }
  if (els.editorModeIcon)  els.editorModeIcon.textContent  = toStage ? 'landscape' : 'animation';
  if (els.editorModeLabel) els.editorModeLabel.textContent = toStage ? 'СЦЕНА' : 'АНИМАЦИЯ';

  if (els.headerObjectControls) els.headerObjectControls.hidden = toStage;
  if (els.headerStageControls)  els.headerStageControls.hidden  = !toStage;

  // Вьюпорт, линейки, направляющие и оверлеи Gizmo
  if (els.scene)         els.scene.style.display = toStage ? 'none' : '';
  if (els.onion)         els.onion.style.display = toStage ? 'none' : '';
  if (els.gizmoSvg)      els.gizmoSvg.hidden = toStage;
  if (els.stageRoot) {
    els.stageRoot.removeAttribute('hidden');
    els.stageRoot.style.display = toStage ? '' : 'none';
  }
  if (els.stageGizmoSvg) els.stageGizmoSvg.hidden = !toStage;

  // В режиме Сцены полностью скрываем ключевой таймлайн и полосу воспроизведения объекта
  $$('.obj-mode-only').forEach(el => { el.hidden = toStage; });
  $$('.stage-mode-only').forEach(el => { el.hidden = !toStage; });
  if (els.playbackBar) els.playbackBar.hidden = toStage;
  if (els.timeline)    els.timeline.hidden    = toStage;
  if (els.stageBar) {
    els.stageBar.hidden = !toStage;
    els.stageBar.classList.toggle('collapsed', toStage && !!App.stage.barCollapsed);
  }

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
    renderStageRulersAndGuides();
  } else {
    closeStageContextMenu();
    closeGuidesSettingsPopover();
    renderStageRulersAndGuides();
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
  setupStageRulersAndGuidesInteraction();

  if (els.btnEditorMode) {
    els.btnEditorMode.addEventListener('click', toggleEditorMode);
  }

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
  if (els.stagesBtnPick && typeof pickLocalFolder === 'function') {
    els.stagesBtnPick.addEventListener('click', pickLocalFolder);
  }
  if (els.stagesBtnReconnect && typeof reconnectSavedFolder === 'function') {
    els.stagesBtnReconnect.addEventListener('click', reconnectSavedFolder);
  }
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

  // Инструменты во вьюпорте сцены (линейки, привязка к направляющим, добавление, обрезка, сворачивание нижней панели)
  if (els.btnStageRulers) {
    els.btnStageRulers.classList.toggle('active', !!App.stage.showRulers);
    els.btnStageRulers.addEventListener('click', () => {
      App.stage.showRulers = !App.stage.showRulers;
      els.btnStageRulers.classList.toggle('active', App.stage.showRulers);
      renderStageRulersAndGuides();
      setHint('Линейки и направляющие: ' + (App.stage.showRulers ? 'ВКЛ' : 'ВЫКЛ'), 1500);
    });
  }

  if (els.btnStageGuideSnap) {
    els.btnStageGuideSnap.classList.toggle('active', !!App.stage.guideSnap);
    els.btnStageGuideSnap.addEventListener('click', () => {
      App.stage.guideSnap = !App.stage.guideSnap;
      els.btnStageGuideSnap.classList.toggle('active', App.stage.guideSnap);
      setHint('Привязка объектов к направляющим (BBox + Pivot): ' + (App.stage.guideSnap ? 'ВКЛ' : 'ВЫКЛ'), 1600);
    });
  }

  if (els.btnStageGuidesMenu) {
    els.btnStageGuidesMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleGuidesSettingsPopover(els.btnStageGuidesMenu);
    });
  }

  if (els.btnStageAddObj) {
    els.btnStageAddObj.addEventListener('click', openStagePickModal);
  }

  if (els.btnStageClip) {
    els.btnStageClip.addEventListener('click', () => {
      App.stage.clipFrame = !App.stage.clipFrame;
      els.btnStageClip.classList.toggle('active', App.stage.clipFrame);
      renderStageBackground();
      setHint('Обрезка по фрэйму 1366×768: ' + (App.stage.clipFrame ? 'ВКЛ' : 'ВЫКЛ'), 1500);
    });
  }

  if (els.btnStagePlayTop) {
    els.btnStagePlayTop.addEventListener('click', enterStageFullscreenPreview);
  }

  if (els.btnStageBarToggle) {
    els.btnStageBarToggle.addEventListener('click', toggleStageBarCollapse);
  }

  // Слои сцены и модалка добавления
  if (els.btnStageAddLayer)   els.btnStageAddLayer.addEventListener('click', openStagePickModal);
  if (els.btnStageAddFolder)  els.btnStageAddFolder.addEventListener('click', () => createStageFolder(false));
  if (els.btnStageUngroup)    els.btnStageUngroup.addEventListener('click', ungroupSelectedStageFolder);
  if (els.btnStageCloneLayer) els.btnStageCloneLayer.addEventListener('click', duplicateSelectedStageItems);
  if (els.btnStageDelLayer)   els.btnStageDelLayer.addEventListener('click', deleteSelectedStageItems);

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
    els.stageFileInput.addEventListener('change', () => {
      handleStageUploadedFiles(els.stageFileInput.files, App.stage._uploadTarget || 'bg');
    });
  }
  if (els.stagePickAssetInput) {
    els.stagePickAssetInput.addEventListener('change', () => {
      handleStageUploadedFiles(els.stagePickAssetInput.files, 'asset');
    });
  }

  // Полноэкранный чистый Предпросмотр по кнопке #stage-play-btn (выход — ESC) + флаг FPS справа от кнопки
  const savedFpsPref = getPref(PREF_STAGE_PREVIEW_FPS);
  if (savedFpsPref === '0' || savedFpsPref === 'false') App.stage.showPreviewFps = false;
  else if (savedFpsPref === '1' || savedFpsPref === 'true') App.stage.showPreviewFps = true;
  if (els.stagePreviewFpsFlag) {
    els.stagePreviewFpsFlag.checked = !!App.stage.showPreviewFps;
    els.stagePreviewFpsFlag.addEventListener('change', () => {
      App.stage.showPreviewFps = !!els.stagePreviewFpsFlag.checked;
      setPref(PREF_STAGE_PREVIEW_FPS, App.stage.showPreviewFps ? '1' : '0');
      syncStagePreviewFpsHudVisibility();
    });
  }

  if (els.stagePlay) {
    els.stagePlay.addEventListener('click', () => {
      if (App.stage.previewFullscreen) exitStageFullscreenPreview();
      else enterStageFullscreenPreview();
    });
  }

  // Кастомное ПКМ-меню на вьюпорте сцены (по направляющим и объектам сцены; без панорамирования ПКМ)
  if (els.viewport) {
    els.viewport.addEventListener('contextmenu', (e) => {
      if (App.editorMode !== 'stage' || !App.stage.data || App.stage.previewFullscreen) return;
      e.preventDefault();
      const nearGuide = findStageGuideNearClient(e.clientX, e.clientY, 7);
      if (nearGuide) {
        openStageRulerOrGuideContextMenu(e.clientX, e.clientY, nearGuide, nearGuide.axis);
        return;
      }
      const wClick = clientToStageWorld(e.clientX, e.clientY, false);
      const hitTop = findTopmostStageItemAtWorld(wClick.x, wClick.y);
      if (hitTop) {
        if (!App.stage.selectedIds.has(hitTop.id)) {
          setStageSelection([hitTop.id], hitTop.id);
        }
        openStageLayerContextMenu(e.clientX, e.clientY, hitTop.id);
        return;
      }
      closeStageContextMenu();
    });
  }

  if (els.stageSpeed) {
    els.stageSpeed.addEventListener('input', () => {
      const pct = parseFloat(els.stageSpeed.value) || 100;
      App.stage.speed = clamp(pct / 100, 0.1, 4);
      if (els.stageSpeedValue) {
        els.stageSpeedValue.textContent = App.stage.speed.toFixed(1) + '×';
      }
    });
  }

  // Ползунки адаптивного растягивания экрана (в пикселях, относительно базового 1366×768)
  function onRubberSliderInput() {
    if (els.stageRubberW) App.stage.testWidth  = parseFloat(els.stageRubberW.value) || null;
    if (els.stageRubberH) App.stage.testHeight = parseFloat(els.stageRubberH.value) || null;
    renderStageBackground();
    syncAllStageTransforms();
    updateStageSelSize();
    syncStageInspectorLive();
    renderStageRulersAndGuides();
    StageGizmo.render();
  }
  if (els.stageRubberW) els.stageRubberW.addEventListener('input', onRubberSliderInput);
  if (els.stageRubberH) els.stageRubberH.addEventListener('input', onRubberSliderInput);
  if (els.stageRubberReset) {
    els.stageRubberReset.addEventListener('click', () => {
      syncStageRubberSlidersToBase();
      renderStageBackground();
      syncAllStageTransforms();
      updateStageSelSize();
      syncStageInspectorLive();
      renderStageRulersAndGuides();
      StageGizmo.render();
    });
  }

  // Если пользователь вышел из системного Fullscreen клавишей ESC браузера — синхронизируем выход
  if (typeof document !== 'undefined') {
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && App.stage.previewFullscreen) {
        exitStageFullscreenPreview();
      }
    });
  }

  window.addEventListener('resize', () => {
    if (App.stage.previewFullscreen) {
      fitStagePreviewFullscreenCamera();
    } else if (App.editorMode === 'stage') {
      renderStageRulersAndGuides();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Control' || e.key === 'Meta') {
      App.ctrlDown = true;
      if (App.editorMode === 'stage' && els.viewport && !App.stage.previewFullscreen) {
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

App.Stage = {
  renderStageRulersAndGuides,
  enterStageFullscreenPreview,
  exitStageFullscreenPreview
};
