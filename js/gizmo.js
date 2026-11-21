'use strict';

// ============================================================
//  Gizmo — интерактивное управление выделенной частью в сцене
// ============================================================

const Gizmo = (function () {

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HSIZE  = 9;
  const EHSIZE = 7;
  const PSIZE  = 7;
  const SCALE_MIN = 1e-3;
  const SCALE_MAX = 1e4;

  const state = {
    mode: 1,     // 1 = transform / move, 2 = rotate / skew
    drag: null
  };

  let app = null;
  let svgEl = null;

  // -----------------------------------------------------------
  // математика
  // -----------------------------------------------------------

  function rotateVec(v, deg) {
    if (!deg) return { x: v.x, y: v.y };
    const a = deg * Math.PI / 180;
    const c = Math.cos(a), s = Math.sin(a);
    return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
  }
  function applySkew(v, skx, sky) {
    let x = v.x, y = v.y;
    if (sky) { const a = sky * Math.PI / 180; y = y + x * Math.tan(a); }
    if (skx) { const a = skx * Math.PI / 180; x = x + y * Math.tan(a); }
    return { x, y };
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // -----------------------------------------------------------
  // доступ к выделенной части
  // -----------------------------------------------------------

  function getPart() {
    if (!app || !app.settings || !app.selectedId) return null;
    return app.settings.parts.find(p => p.id === app.selectedId) || null;
  }
  function getG(part) {
    if (!part) return null;
    return app.els.scene.querySelector('[data-part-id="' + part.id + '"]');
  }
	function getSize(part) {
	  if (part.isGroup) return part.size || { w: 100, h: 100 };
	  const root = app.svgCache[part.file];
	  if (!root) return { w: 100, h: 100 };
	  return app.getSvgSize(root);
	}
	function partLocalEl(part) {
	  const g = getG(part);
	  if (!g) return null;
	  if (part.isGroup) return g;
	  return g.querySelector('.part-inner');
	}
	function localToScreen(part, lx, ly) {
	  const el = partLocalEl(part);
	  if (!el) return { x: 0, y: 0 };
	  const ctm = el.getScreenCTM();
	  if (!ctm) return { x: 0, y: 0 };
	  const p = new DOMPoint(lx, ly).matrixTransform(ctm);
	  return { x: p.x, y: p.y };
	}
	function screenToLocal(part, sx, sy) {
	  const el = partLocalEl(part);
	  if (!el) return null;
	  const ctm = el.getScreenCTM();
	  if (!ctm) return null;
	  const p = new DOMPoint(sx, sy).matrixTransform(ctm.inverse());
	  return { x: p.x, y: p.y };
	}
	function screenToParent(part, sx, sy) {
	  const g = getG(part); if (!g || !g.parentNode) return null;
	  const ctm = g.parentNode.getScreenCTM();
	  if (!ctm) return null;
	  const p = new DOMPoint(sx, sy).matrixTransform(ctm.inverse());
	  return { x: p.x, y: p.y };
	}
	let onModeChange = null;
	function setMode(m) {
	  state.mode = m;
	  render();
	  if (onModeChange) onModeChange(m);
	}
  // -----------------------------------------------------------
  // трансформ
  // -----------------------------------------------------------

  function buildTransformString(part) {
    const t = part.transform;
    const { w, h } = getSize(part);
    const px = part.pivot.x * w, py = part.pivot.y * h;
    const a = [];
    a.push('translate(' + t.position.x + ' ' + t.position.y + ')');
    if (t.rotation) a.push('rotate(' + t.rotation + ')');
    if (t.scale.x !== 1 || t.scale.y !== 1) a.push('scale(' + t.scale.x + ' ' + t.scale.y + ')');
    if (t.skew.x) a.push('skewX(' + t.skew.x + ')');
    if (t.skew.y) a.push('skewY(' + t.skew.y + ')');
    a.push('translate(' + (-px) + ' ' + (-py) + ')');
    return a.join(' ');
  }
  function applyTransformAttr(part) {
    const g = getG(part);
    if (g) g.setAttribute('transform', buildTransformString(part));
  }

  // -----------------------------------------------------------
  // рендер
  // -----------------------------------------------------------

  function el(tag, attrs, cls) {
    const e = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (cls) e.setAttribute('class', cls);
    return e;
  }
  function clear() { while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild); }

  function render() {
    if (!svgEl) return;
    clear();
    const part = getPart(); if (!part) return;
    const g = getG(part);   if (!g) return;
    const { w, h } = getSize(part);

    const rect = svgEl.getBoundingClientRect();
    const L = rect.left, T = rect.top;
    const adj = p => ({ x: p.x - L, y: p.y - T });

    const corners = [
      localToScreen(part, 0, 0),
      localToScreen(part, w, 0),
      localToScreen(part, w, h),
      localToScreen(part, 0, h)
    ].map(adj);

    const edges = [
      { e: 'top',    pos: adj(localToScreen(part, w / 2, 0)) },
      { e: 'right',  pos: adj(localToScreen(part, w,     h / 2)) },
      { e: 'bottom', pos: adj(localToScreen(part, w / 2, h)) },
      { e: 'left',   pos: adj(localToScreen(part, 0,     h / 2)) }
    ];

    const pivS = adj(localToScreen(part, part.pivot.x * w, part.pivot.y * h));
    const pts = corners.map(p => p.x + ',' + p.y).join(' ');

    const interior = el('polygon', { points: pts }, 'gizmo-interior');
    interior.setAttribute('data-gizmo', 'interior');
    svgEl.appendChild(interior);

    const frame = el('polygon', { points: pts }, 'gizmo-frame mode-' + state.mode);
    frame.setAttribute('data-gizmo', 'frame');
    svgEl.appendChild(frame);

    corners.forEach((p, i) => {
      const r = el('rect', {
        x: p.x - HSIZE / 2, y: p.y - HSIZE / 2,
        width: HSIZE, height: HSIZE
      }, 'gizmo-handle gizmo-corner mode-' + state.mode + ' corner-' + i);
      r.setAttribute('data-gizmo', 'corner');
      r.setAttribute('data-idx', i);
      svgEl.appendChild(r);
    });

    edges.forEach(ed => {
      const r = el('rect', {
        x: ed.pos.x - EHSIZE / 2, y: ed.pos.y - EHSIZE / 2,
        width: EHSIZE, height: EHSIZE
      }, 'gizmo-handle gizmo-edge mode-' + state.mode + ' edge-' + ed.e);
      r.setAttribute('data-gizmo', 'edge');
      r.setAttribute('data-edge', ed.e);
      svgEl.appendChild(r);
    });

    const piv = el('g', null, 'gizmo-pivot');
    piv.setAttribute('data-gizmo', 'pivot');
    piv.appendChild(el('circle', { cx: pivS.x, cy: pivS.y, r: PSIZE + 6,
                                   fill: 'transparent', stroke: 'none' }));
    piv.appendChild(el('circle', { cx: pivS.x, cy: pivS.y, r: PSIZE,
                                   fill: 'none', stroke: 'rgba(111,168,212,0.35)',
                                   'stroke-width': 5 }));
    piv.appendChild(el('circle', { cx: pivS.x, cy: pivS.y, r: PSIZE,
                                   fill: 'var(--bg-2)', stroke: 'var(--select)',
                                   'stroke-width': 1.5 }));
    piv.appendChild(el('line', { x1: pivS.x - PSIZE - 4, y1: pivS.y,
                                 x2: pivS.x + PSIZE + 4, y2: pivS.y,
                                 stroke: 'var(--select)', 'stroke-width': 1 }));
    piv.appendChild(el('line', { x1: pivS.x, y1: pivS.y - PSIZE - 4,
                                 x2: pivS.x, y2: pivS.y + PSIZE + 4,
                                 stroke: 'var(--select)', 'stroke-width': 1 }));
    svgEl.appendChild(piv);
  }

  // -----------------------------------------------------------
  // mousedown
  // -----------------------------------------------------------

  function onMouseDown(e) {
    if (e.button !== 0) return;
    const part = getPart(); if (!part) return;

    const tgt = e.target;
    const hit = tgt.closest && tgt.closest('[data-gizmo]');
    const kind = hit ? hit.getAttribute('data-gizmo') : null;
    if (!kind) return;

    e.stopPropagation();
    e.preventDefault();

    const mx = e.clientX, my = e.clientY;

    if (kind === 'frame') {
      state.drag = { kind: 'maybe-cycle', startX: mx, startY: my };
      return;
    }
    if (kind === 'pivot')    { beginPivotDrag(part, mx, my); return; }
    if (kind === 'interior') { beginMove(part, mx, my);      return; }

    if (kind === 'corner' || kind === 'edge') {
      if (state.mode === 1) {
        if (kind === 'corner') beginResizeCorner(part, parseInt(hit.getAttribute('data-idx'), 10));
        else                   beginResizeEdge(part, hit.getAttribute('data-edge'));
      } else {
        if (kind === 'corner') beginRotate(part, mx, my);
        else                   beginSkew(part, hit.getAttribute('data-edge'), mx, my);
      }
    }
  }

  // -----------------------------------------------------------
  // MOVE (со "клик без движения = переключение режима")
  // -----------------------------------------------------------

function topLevelSelected() {
  const ids = app.selectedIds;
  if (!ids || !ids.size) return [];
  const parts = app.settings.parts;
  const byId = {};
  for (const p of parts) byId[p.id] = p;
  return parts.filter(p => ids.has(p.id) && (function () {
    let cur = p.parent ? byId[p.parent] : null;
    while (cur) {
      if (ids.has(cur.id)) return false;
      cur = cur.parent ? byId[cur.parent] : null;
    }
    return true;
  })());
}

function beginMove(part, mx, my) {
  const tops = topLevelSelected();
  const targets = tops.length ? tops : [part];
  const items = targets.map(p => ({
    part: p,
    startMp: screenToParent(p, mx, my),
    basePos: { x: p.transform.position.x, y: p.transform.position.y }
  }));
  state.drag = {
    kind: 'move', part,
    items: items,
    startX: mx, startY: my,
    moved: false,
    lockAxis: null
  };
}
function updateMove(d, mx, my) {
  if (!d.moved) {
    const dx = mx - d.startX, dy = my - d.startY;
    if (dx * dx + dy * dy < 9) return;
    d.moved = true;
  }
  for (const it of d.items) {
    const mp = screenToParent(it.part, mx, my);
    let nx = it.basePos.x + (mp.x - it.startMp.x);
    let ny = it.basePos.y + (mp.y - it.startMp.y);
    if (d.shift && !d.lockAxis) {
      const dx = Math.abs(mp.x - it.startMp.x);
      const dy = Math.abs(mp.y - it.startMp.y);
      d.lockAxis = (dx >= dy) ? 'x' : 'y';
    }
    if (d.shift && d.lockAxis === 'x') ny = it.basePos.y;
    if (d.shift && d.lockAxis === 'y') nx = it.basePos.x;
    it.part.transform.position.x = nx;
    it.part.transform.position.y = ny;
    applyTransformAttr(it.part);
  }
}

  // -----------------------------------------------------------
  // PIVOT
  // -----------------------------------------------------------

  function beginPivotDrag(part, mx, my) {
    const local = screenToLocal(part, mx, my);
    state.drag = { kind: 'pivot', part, startLocal: local };
  }
  function updatePivot(d, mx, my) {
    const part = d.part;
    const { w, h } = getSize(part);
    const local = screenToLocal(part, mx, my);
    if (!local) return;
    const t = part.transform;
    const oldPivot = { x: part.pivot.x * w, y: part.pivot.y * h };
    const newPivot = { x: local.x, y: local.y };
    const delta = { x: newPivot.x - oldPivot.x, y: newPivot.y - oldPivot.y };
    const Kd = applySkew(delta, t.skew.x, t.skew.y);
    const Sd = { x: Kd.x * t.scale.x, y: Kd.y * t.scale.y };
    const Rd = rotateVec(Sd, t.rotation);
    t.position.x += Rd.x;
    t.position.y += Rd.y;
    part.pivot.x = newPivot.x / w;
    part.pivot.y = newPivot.y / h;
    applyTransformAttr(part);
  }

  // -----------------------------------------------------------
  // RESIZE
  // -----------------------------------------------------------

  function beginResizeCorner(part, cornerIdx) {
    const { w, h } = getSize(part);
    const lc = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
    beginResize(part, lc[(cornerIdx + 2) % 4], lc[cornerIdx], { x: true, y: true });
  }
  function beginResizeEdge(part, edgeName) {
    const { w, h } = getSize(part);
    let fixedLocal, draggedLocal, axis;
    if      (edgeName === 'right')  { fixedLocal = { x: 0,   y: h/2 }; draggedLocal = { x: w,   y: h/2 }; axis = { x: true,  y: false }; }
    else if (edgeName === 'left')   { fixedLocal = { x: w,   y: h/2 }; draggedLocal = { x: 0,   y: h/2 }; axis = { x: true,  y: false }; }
    else if (edgeName === 'bottom') { fixedLocal = { x: w/2, y: 0   }; draggedLocal = { x: w/2, y: h   }; axis = { x: false, y: true  }; }
    else                            { fixedLocal = { x: w/2, y: h   }; draggedLocal = { x: w/2, y: 0   }; axis = { x: false, y: true  }; }
    beginResize(part, fixedLocal, draggedLocal, axis);
  }
  function beginResize(part, fixedLocal, draggedLocal, axis) {
    const { w, h } = getSize(part);
    const t = part.transform;
    const Fs = localToScreen(part, fixedLocal.x, fixedLocal.y);
    const Fp = screenToParent(part, Fs.x, Fs.y);
    const refX = localToScreen(part, fixedLocal.x + 1, fixedLocal.y);
    const refY = localToScreen(part, fixedLocal.x, fixedLocal.y + 1);
    const Xv = { x: refX.x - Fs.x, y: refX.y - Fs.y };
    const Yv = { x: refY.x - Fs.x, y: refY.y - Fs.y };
    const dLocal = { x: draggedLocal.x - fixedLocal.x, y: draggedLocal.y - fixedLocal.y };
    const pivotLocal = { x: part.pivot.x * w, y: part.pivot.y * h };
    const aLocal = { x: fixedLocal.x - pivotLocal.x, y: fixedLocal.y - pivotLocal.y };
    state.drag = {
      kind: 'resize', part, w, h, axis,
      Fs, Fp, Xv, Yv, dLocal, aLocal,
      startSx: t.scale.x, startSy: t.scale.y
    };
  }
  function updateResize(d, mx, my, e) {
    const part = d.part;
    const t = part.transform;
    const shift = e.shiftKey, ctrl = e.ctrlKey;

    if (shift) {
      const bLocal = { x: d.aLocal.x + d.dLocal.x, y: d.aLocal.y + d.dLocal.y };
      const Kb = applySkew(bLocal, t.skew.x, t.skew.y);
      const Mp = screenToParent(part, mx, my);
      const Dp = { x: Mp.x - t.position.x, y: Mp.y - t.position.y };
      const Dr = rotateVec(Dp, -t.rotation);

      let sx = (Math.abs(Kb.x) > 1e-3) ? Dr.x / Kb.x : d.startSx;
      let sy = (Math.abs(Kb.y) > 1e-3) ? Dr.y / Kb.y : d.startSy;

      if (ctrl) {
        const a = clamp(Math.abs(sx), SCALE_MIN, SCALE_MAX);
        const b = clamp(Math.abs(sy), SCALE_MIN, SCALE_MAX);
        const avg = (a + b) / 2;
        sx = (sx < 0 ? -1 : 1) * avg;
        sy = (sy < 0 ? -1 : 1) * avg;
      }
      sx = clamp(sx, -SCALE_MAX, SCALE_MAX);
      sy = clamp(sy, -SCALE_MAX, SCALE_MAX);
      if (Math.abs(sx) < SCALE_MIN) sx = (sx < 0 ? -1 : 1) * SCALE_MIN;
      if (Math.abs(sy) < SCALE_MIN) sy = (sy < 0 ? -1 : 1) * SCALE_MIN;

      t.scale.x = sx;
      t.scale.y = sy;
      applyTransformAttr(part);
      return;
    }

    const DsNew = { x: mx - d.Fs.x, y: my - d.Fs.y };
    const det = d.Xv.x * d.Yv.y - d.Xv.y * d.Yv.x;
    if (Math.abs(det) < 1e-9) return;

    const kx = (DsNew.x * d.Yv.y - DsNew.y * d.Yv.x) / det;
    const ky = (d.Xv.x * DsNew.y - d.Xv.y * DsNew.x) / det;

    let newSx = t.scale.x, newSy = t.scale.y;
    if (d.axis.x && Math.abs(d.dLocal.x) > 1e-6) newSx = (kx / d.dLocal.x) * d.startSx;
    if (d.axis.y && Math.abs(d.dLocal.y) > 1e-6) newSy = (ky / d.dLocal.y) * d.startSy;

    newSx = clamp(newSx, -SCALE_MAX, SCALE_MAX);
    newSy = clamp(newSy, -SCALE_MAX, SCALE_MAX);
    if (Math.abs(newSx) < SCALE_MIN) newSx = (newSx < 0 ? -1 : 1) * SCALE_MIN;
    if (Math.abs(newSy) < SCALE_MIN) newSy = (newSy < 0 ? -1 : 1) * SCALE_MIN;

    t.scale.x = newSx;
    t.scale.y = newSy;

    const Ka = applySkew(d.aLocal, t.skew.x, t.skew.y);
    const Sa = { x: Ka.x * newSx, y: Ka.y * newSy };
    const Ra = rotateVec(Sa, t.rotation);
    t.position.x = d.Fp.x - Ra.x;
    t.position.y = d.Fp.y - Ra.y;

    applyTransformAttr(part);
  }

  // -----------------------------------------------------------
  // ROTATE / SKEW
  // -----------------------------------------------------------

function beginRotate(part, mx, my) {
  const { w, h } = getSize(part);
  const piv = localToScreen(part, part.pivot.x * w, part.pivot.y * h);
  const a0 = Math.atan2(my - piv.y, mx - piv.x);
  state.drag = {
    kind: 'rotate', part, pivScreen: piv,
    lastAngle: a0,
    accumulated: 0,
    baseRot: part.transform.rotation
  };
}
function updateRotate(d, mx, my) {
  const part = d.part;
  const cur = Math.atan2(my - d.pivScreen.y, mx - d.pivScreen.x);
  let diff = cur - d.lastAngle;
  while (diff >  Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  d.accumulated += diff;
  d.lastAngle = cur;
  part.transform.rotation = d.baseRot + d.accumulated * 180 / Math.PI;
  applyTransformAttr(part);
}
  function beginSkew(part, edgeName, mx, my) {
    const { w, h } = getSize(part);
    const mp = screenToParent(part, mx, my);
    state.drag = {
      kind: 'skew', part, edgeName, w, h, startMp: mp,
      baseSkewX: part.transform.skew.x,
      baseSkewY: part.transform.skew.y
    };
  }
function updateSkew(d, mx, my) {
  const t = d.part.transform;
  const mp = screenToParent(d.part, mx, my);
  const deltaP = { x: mp.x - d.startMp.x, y: mp.y - d.startMp.y };
  const unrot = rotateVec(deltaP, -t.rotation);
  const unscaled = {
    x: Math.abs(t.scale.x) > 1e-6 ? unrot.x / t.scale.x : unrot.x,
    y: Math.abs(t.scale.y) > 1e-6 ? unrot.y / t.scale.y : unrot.y
  };
  if (d.edgeName === 'top' || d.edgeName === 'bottom') {
    // Верхнее ребро: двигаем мышью вправо → верх уходит вправо → skewX отрицательный.
    // Нижнее: вправо → skewX положительный.
    const sign = (d.edgeName === 'top') ? -1 : 1;
    t.skew.x = d.baseSkewX + sign * Math.atan2(unscaled.x, d.h) * 180 / Math.PI;
  } else {
    // Левое ребро: вверх → skewY положительный. Правое: вверх → skewY отрицательный.
    const sign = (d.edgeName === 'left') ? -1 : 1;
    t.skew.y = d.baseSkewY + sign * Math.atan2(unscaled.y, d.w) * 180 / Math.PI;
  }
  applyTransformAttr(d.part);
}

  // -----------------------------------------------------------
  // события
  // -----------------------------------------------------------

function onMouseMove(e) {
  if (!state.drag) return;
  const d = state.drag;
  const mx = e.clientX, my = e.clientY;

  if (d.kind === 'maybe-cycle') {
    const dx = mx - d.startX, dy = my - d.startY;
    if (dx * dx + dy * dy > 25) state.drag = null;
    return;
  }
  if (d.kind === 'move')   { d.shift = e.shiftKey; updateMove(d, mx, my); }
  else if (d.kind === 'pivot')  updatePivot(d, mx, my);
  else if (d.kind === 'resize') updateResize(d, mx, my, e);
  else if (d.kind === 'rotate') updateRotate(d, mx, my);
  else if (d.kind === 'skew')   updateSkew(d, mx, my);

  render();
  if (app && app.syncProperties) app.syncProperties();
  if (app && app.onPartChanged) {
    if (d.items && d.moved) {
      for (const it of d.items) app.onPartChanged(it.part, d.kind, true);
    } else if (d.kind !== 'move' || d.moved) {
      app.onPartChanged(d.part, d.kind, true);
    }
  }
}

  function onMouseUp() {
    if (!state.drag) return;
    const d = state.drag;

    // клик без движения по рамке или по интерьеру — переключение режима
	if (d.kind === 'maybe-cycle' || (d.kind === 'move' && !d.moved)) {
	  setMode(state.mode === 1 ? 2 : 1);
	  state.drag = null;
	  return;
	}

    if (d.items && app && app.onPartChanged) {
      for (const it of d.items) app.onPartChanged(it.part, d.kind, false);
    } else if (d.part && app && app.onPartChanged) {
      app.onPartChanged(d.part, d.kind, false);
    }
    state.drag = null;
    render();
    if (app && app.onChange) app.onChange();
  }

  // -----------------------------------------------------------
  // init
  // -----------------------------------------------------------

  function init(appInstance) {
    app = appInstance;
    svgEl = document.getElementById('gizmo-svg');
    svgEl.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    render();
  }

  return {
    init,
    render,
    get mode() { return state.mode; },
    setMode,
    setOnModeChange(fn) { onModeChange = fn; }
  };
})();