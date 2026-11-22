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
  if (App.editorMode === 'stage') {
    if (typeof StageGizmo !== 'undefined') StageGizmo.render();
    if (typeof renderStageRulersAndGuides === 'function') renderStageRulersAndGuides();
  } else {
    Gizmo.render();
    if (!App.selectedId) renderProperties();
  }
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
  if (App.editorMode === 'stage') {
    if (typeof fitStageView === 'function') fitStageView();
    return;
  }
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
  App.camera.zoom = clamp(z, 0.05, 60);
  App.camera.x = bbox.x + bbox.width / 2 + App.clipOffset.x;
  App.camera.y = bbox.y + bbox.height / 2 + App.clipOffset.y;
  applyCamera();
}

function zoomBy(factor) {
  const vp = els.viewport;
  const cx = vp.clientWidth / 2, cy = vp.clientHeight / 2;
  const before = screenToWorld(cx, cy);
  App.camera.zoom = clamp(App.camera.zoom * factor, 0.05, 60);
  const after = screenToWorld(cx, cy);
  App.camera.x += before.x - after.x;
  App.camera.y += before.y - after.y;
  applyCamera();
}

function isViewportLightBg() {
  if (App.editorMode === 'stage') return false;
  const bg = (App.settings && App.settings.frame && App.settings.frame.background) || 'grid';
  if (bg === 'grid' || bg === 'checkerboard') return false;
  const rgb = hexToRgb(bg);
  if (!rgb) return false;
  const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return lum > 0.55;
}

function gridStrokeColor(hex, alpha, fallback) {
  const rgb = hexToRgb(hex || '#9fb0c8');
  if (!rgb) return fallback;
  const a = clamp(Number(alpha) || 0.14, 0.02, 0.95);
  return 'rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', ' + a.toFixed(3) + ')';
}

function rebuildGrid() {
  if (!els.grid) return;
  els.grid.innerHTML = '';
  const showGrid  = !!(App.grid && App.grid.showGrid);
  const showCross = !!(App.grid && App.grid.showCrosshair);
  if (!showGrid && !showCross) return;

  const vp = els.viewport;
  const W = vp.clientWidth, H = vp.clientHeight;
  if (!W || !H) return;

  const z = App.camera.zoom || 1;
  const p0 = screenToWorld(0, 0);
  const p1 = screenToWorld(W, H);
  const wl = p0.x, wt = p0.y;
  const wr = p1.x, wb = p1.y;
  const light = isViewportLightBg();
  const origin = App.getGridOrigin ? App.getGridOrigin() : { x: 0, y: 0 };

  // 1) Опорная волосяная сетка с настраиваемым шагом, крупной клеткой, цветом и началом координат
  if (showGrid) {
    const baseStep = Math.max(1, Number(App.grid && App.grid.step) || 4);
    let drawStep = baseStep;
    while (drawStep * z < 2.0 && drawStep < 4096) {
      drawStep *= 4;
    }
    const rawMajor = (App.grid && App.grid.majorEvery !== undefined) ? Number(App.grid.majorEvery) : 5;
    const majorEvery = rawMajor > 0 ? Math.max(2, Math.round(rawMajor)) : 0;

    const ix0 = Math.floor((wl - origin.x) / drawStep);
    const ix1 = Math.ceil((wr - origin.x) / drawStep);
    const iy0 = Math.floor((wt - origin.y) / drawStep);
    const iy1 = Math.ceil((wb - origin.y) / drawStep);

    const totalCols = ix1 - ix0;
    const totalRows = iy1 - iy0;
    if (totalCols <= 1600 && totalRows <= 1600) {
      const minorSegs = [];
      const majorSegs = [];

      for (let i = ix0; i <= ix1; i++) {
        const x = origin.x + i * drawStep;
        if (showCross && Math.abs(x) < 1e-6) continue;
        const cmd = 'M' + x + ' ' + wt + 'V' + wb;
        if (majorEvery > 0 && i % majorEvery === 0) majorSegs.push(cmd);
        else minorSegs.push(cmd);
      }

      for (let j = iy0; j <= iy1; j++) {
        const y = origin.y + j * drawStep;
        if (showCross && Math.abs(y) < 1e-6) continue;
        const cmd = 'M' + wl + ' ' + y + 'H' + wr;
        if (majorEvery > 0 && j % majorEvery === 0) majorSegs.push(cmd);
        else minorSegs.push(cmd);
      }

      const baseOp = clamp(Number(App.grid && App.grid.opacity) || 0.14, 0.03, 0.75);
      const minorStroke = light
        ? 'rgba(0, 0, 0, 0.08)'
        : gridStrokeColor(App.grid && App.grid.color, baseOp, 'rgba(255,255,255,0.08)');
      const majorStroke = light
        ? 'rgba(0, 0, 0, 0.17)'
        : gridStrokeColor(App.grid && App.grid.color, Math.min(0.9, baseOp * 1.95), 'rgba(255,255,255,0.16)');

      if (minorSegs.length) {
        const pathMinor = document.createElementNS(SVG_NS, 'path');
        pathMinor.setAttribute('d', minorSegs.join(''));
        pathMinor.setAttribute('class', 'grid-path-minor');
        pathMinor.setAttribute('vector-effect', 'non-scaling-stroke');
        pathMinor.style.stroke = minorStroke;
        els.grid.appendChild(pathMinor);
      }

      if (majorSegs.length) {
        const pathMajor = document.createElementNS(SVG_NS, 'path');
        pathMajor.setAttribute('d', majorSegs.join(''));
        pathMajor.setAttribute('class', 'grid-path-major');
        pathMajor.setAttribute('vector-effect', 'non-scaling-stroke');
        pathMajor.style.stroke = majorStroke;
        els.grid.appendChild(pathMajor);
      }
    }
  }

  // 2) Центральный крест сцены (оси X=0, Y=0 и точка центра (0, 0))
  if (showCross) {
    const crossD = [];
    if (wt <= 0 && wb >= 0) crossD.push('M' + wl + ' 0H' + wr);
    if (wl <= 0 && wr >= 0) crossD.push('M0 ' + wt + 'V' + wb);
    if (crossD.length) {
      const crossPath = document.createElementNS(SVG_NS, 'path');
      crossPath.setAttribute('d', crossD.join(''));
      crossPath.setAttribute('class', 'grid-crosshair-line');
      crossPath.setAttribute('vector-effect', 'non-scaling-stroke');
      if (light) crossPath.style.stroke = 'rgba(32, 108, 185, 0.82)';
      els.grid.appendChild(crossPath);
    }

    const r = 4.5 / z;
    if (wl <= r && wr >= -r && wt <= r && wb >= -r) {
      const originCircle = document.createElementNS(SVG_NS, 'circle');
      originCircle.setAttribute('cx', '0');
      originCircle.setAttribute('cy', '0');
      originCircle.setAttribute('r', String(r));
      originCircle.setAttribute('class', 'grid-crosshair-origin');
      originCircle.setAttribute('vector-effect', 'non-scaling-stroke');
      if (light) {
        originCircle.style.stroke = 'rgba(24, 96, 172, 0.92)';
        originCircle.style.fill = 'rgba(32, 108, 185, 0.15)';
      }
      els.grid.appendChild(originCircle);
    }
  }
}

const GRID_CFG_STORAGE_KEY = 'animEditor.gridConfig.v1';

function loadSavedGridConfig() {
  try {
    const raw = localStorage.getItem(GRID_CFG_STORAGE_KEY);
    if (!raw) return;
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== 'object') return;
    if (Number.isFinite(Number(cfg.step))) App.grid.step = clamp(Math.round(Number(cfg.step)), 1, 512);
    if (Number.isFinite(Number(cfg.majorEvery))) App.grid.majorEvery = clamp(Math.round(Number(cfg.majorEvery)), 0, 32);
    if (cfg.originMode === 'center' || cfg.originMode === 'frame-topleft') App.grid.originMode = cfg.originMode;
    if (typeof cfg.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(cfg.color)) App.grid.color = cfg.color;
    if (Number.isFinite(Number(cfg.opacity))) App.grid.opacity = clamp(Number(cfg.opacity), 0.03, 0.75);
  } catch (e) {}
}

function saveGridConfig() {
  try {
    localStorage.setItem(GRID_CFG_STORAGE_KEY, JSON.stringify({
      step: App.grid.step,
      majorEvery: App.grid.majorEvery,
      originMode: App.grid.originMode,
      color: App.grid.color,
      opacity: App.grid.opacity,
    }));
  } catch (e) {}
}

function closeGridSettingsPopover() {
  if (els.gridSettingsPopover) els.gridSettingsPopover.hidden = true;
  if (els.btnGridSettings) els.btnGridSettings.classList.remove('active');
}

function toggleGridSettingsPopover(anchorEl) {
  const pop = els.gridSettingsPopover;
  if (!pop) return;
  if (!pop.hidden) {
    closeGridSettingsPopover();
    return;
  }
  if (els.guidesSettingsPopover) els.guidesSettingsPopover.hidden = true;
  if (els.btnStageGuidesMenu) els.btnStageGuidesMenu.classList.remove('active');
  if (els.stageContextMenu) els.stageContextMenu.hidden = true;

  renderGridSettingsPopover();
  pop.hidden = false;
  if (els.btnGridSettings) els.btnGridSettings.classList.add('active');

  const btn = anchorEl || els.btnGridSettings;
  if (btn && btn.getBoundingClientRect) {
    const r = btn.getBoundingClientRect();
    const left = clamp(r.left, 8, Math.max(8, window.innerWidth - 300));
    const top = clamp(r.bottom + 6, 8, Math.max(8, window.innerHeight - 360));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
}

function renderGridSettingsPopover() {
  const pop = els.gridSettingsPopover;
  if (!pop) return;
  const stepPresets = [4, 8, 16, 32, 64, 100];
  const swatches = ['#9fb0c8', '#3bc9db', '#51cf66', '#ffd43b', '#ff8787', '#ffffff'];
  const opPct = Math.round((Number(App.grid.opacity) || 0.14) * 100);

  pop.innerHTML =
    '<div class="popover-head">' +
      '<span>Настройка сетки макета</span>' +
      '<button type="button" class="guide-del-x" data-grid-act="close" title="Закрыть"><span class="material-icons" style="font-size:15px">close</span></button>' +
    '</div>' +
    '<div class="popover-section" style="display:flex;gap:10px;align-items:center">' +
      '<label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" data-grid-chk="show" ' + (App.grid.showGrid ? 'checked' : '') + '> Сетка</label>' +
      '<label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" data-grid-chk="snap" ' + (App.grid.snap ? 'checked' : '') + '> Привязка</label>' +
      '<label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" data-grid-chk="cross" ' + (App.grid.showCrosshair ? 'checked' : '') + '> Оси 0,0</label>' +
    '</div>' +
    '<div class="popover-section">' +
      '<span class="popover-label">Шаг ячейки (px):</span>' +
      '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:5px">' +
        stepPresets.map(s => '<button type="button" class="btn small' + (App.grid.step === s ? ' primary' : '') + '" data-grid-step="' + s + '" style="padding:2px 7px;min-width:34px">' + s + '</button>').join('') +
      '</div>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<input type="number" min="1" max="512" step="1" value="' + App.grid.step + '" data-grid-input="step" style="width:74px">' +
        '<span style="color:var(--fg-dim);font-size:11px">Крупная клетка каждые:</span>' +
        '<select data-grid-input="major" style="flex:1">' +
          [0, 2, 4, 5, 8, 10].map(m => '<option value="' + m + '"' + (Number(App.grid.majorEvery) === m ? ' selected' : '') + '>' + (m === 0 ? 'Выкл' : (m + '× (' + (m * App.grid.step) + 'px)')) + '</option>').join('') +
        '</select>' +
      '</div>' +
    '</div>' +
    '<div class="popover-section">' +
      '<span class="popover-label">Отсчёт узлов сетки (в режиме Сцена):</span>' +
      '<select data-grid-input="origin" style="width:100%">' +
        '<option value="center"' + (App.grid.originMode === 'center' ? ' selected' : '') + '>От центра сцены (0, 0)</option>' +
        '<option value="frame-topleft"' + (App.grid.originMode === 'frame-topleft' ? ' selected' : '') + '>От левого верхнего угла фрэйма (1366×768)</option>' +
      '</select>' +
    '</div>' +
    '<div class="popover-section">' +
      '<span class="popover-label">Цвет и прозрачность линий (<span data-grid-op-lbl>' + opPct + '%</span>):</span>' +
      '<div class="swatch-row" style="margin-bottom:6px">' +
        swatches.map(c => '<button type="button" class="color-swatch' + (String(App.grid.color).toLowerCase() === c ? ' active' : '') + '" style="background:' + c + '" data-grid-color="' + c + '" title="' + c + '"></button>').join('') +
        '<input type="color" value="' + (App.grid.color || '#9fb0c8') + '" data-grid-input="color" style="width:26px;height:22px;padding:0;border:none;background:transparent;cursor:pointer">' +
      '</div>' +
      '<input type="range" min="4" max="65" step="1" value="' + opPct + '" data-grid-input="opacity" style="width:100%">' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;gap:6px">' +
      '<button type="button" class="btn small" data-grid-act="reset">Сбросить по умолч.</button>' +
      '<button type="button" class="btn small primary" data-grid-act="close">Готово</button>' +
    '</div>';

  pop.querySelectorAll('[data-grid-step]').forEach(btn => {
    btn.addEventListener('click', () => {
      App.grid.step = clamp(parseInt(btn.getAttribute('data-grid-step'), 10) || 4, 1, 512);
      saveGridConfig();
      rebuildGrid();
      renderGridSettingsPopover();
    });
  });

  pop.querySelectorAll('[data-grid-chk]').forEach(chk => {
    chk.addEventListener('change', () => {
      const k = chk.getAttribute('data-grid-chk');
      if (k === 'show') App.grid.showGrid = !!chk.checked;
      else if (k === 'snap') App.grid.snap = !!chk.checked;
      else if (k === 'cross') App.grid.showCrosshair = !!chk.checked;
      updateGridButtonsUI();
      rebuildGrid();
    });
  });

  const stepInp = pop.querySelector('[data-grid-input="step"]');
  if (stepInp) {
    stepInp.addEventListener('change', () => {
      App.grid.step = clamp(Math.round(Number(stepInp.value) || 4), 1, 512);
      saveGridConfig();
      rebuildGrid();
      renderGridSettingsPopover();
    });
  }

  const majorSel = pop.querySelector('[data-grid-input="major"]');
  if (majorSel) {
    majorSel.addEventListener('change', () => {
      App.grid.majorEvery = clamp(parseInt(majorSel.value, 10) || 0, 0, 32);
      saveGridConfig();
      rebuildGrid();
    });
  }

  const originSel = pop.querySelector('[data-grid-input="origin"]');
  if (originSel) {
    originSel.addEventListener('change', () => {
      App.grid.originMode = originSel.value === 'frame-topleft' ? 'frame-topleft' : 'center';
      saveGridConfig();
      rebuildGrid();
    });
  }

  pop.querySelectorAll('[data-grid-color]').forEach(sw => {
    sw.addEventListener('click', () => {
      App.grid.color = sw.getAttribute('data-grid-color');
      saveGridConfig();
      rebuildGrid();
      renderGridSettingsPopover();
    });
  });

  const colorInp = pop.querySelector('[data-grid-input="color"]');
  if (colorInp) {
    colorInp.addEventListener('input', () => {
      App.grid.color = colorInp.value;
      saveGridConfig();
      rebuildGrid();
    });
  }

  const opInp = pop.querySelector('[data-grid-input="opacity"]');
  const opLbl = pop.querySelector('[data-grid-op-lbl]');
  if (opInp) {
    opInp.addEventListener('input', () => {
      const pct = clamp(parseInt(opInp.value, 10) || 14, 4, 65);
      App.grid.opacity = pct / 100;
      if (opLbl) opLbl.textContent = pct + '%';
      saveGridConfig();
      rebuildGrid();
    });
  }

  pop.querySelectorAll('[data-grid-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.getAttribute('data-grid-act');
      if (act === 'reset') {
        App.grid.step = 4;
        App.grid.majorEvery = 5;
        App.grid.originMode = 'center';
        App.grid.color = '#9fb0c8';
        App.grid.opacity = 0.14;
        saveGridConfig();
        rebuildGrid();
        renderGridSettingsPopover();
      } else {
        closeGridSettingsPopover();
      }
    });
  });
}

function updateGridButtonsUI() {
  if (els.btnCrosshair) els.btnCrosshair.classList.toggle('active', !!App.grid.showCrosshair);
  if (els.btnGrid)      els.btnGrid.classList.toggle('active', !!App.grid.showGrid);
  if (els.btnSnap)      els.btnSnap.classList.toggle('active', !!App.grid.snap);
}

function toggleCrosshair() {
  App.grid.showCrosshair = !App.grid.showCrosshair;
  updateGridButtonsUI();
  rebuildGrid();
  setHint('Крест сцены: ' + (App.grid.showCrosshair ? 'ВКЛ' : 'ВЫКЛ'), 1300);
}

function toggleSceneGrid() {
  App.grid.showGrid = !App.grid.showGrid;
  updateGridButtonsUI();
  rebuildGrid();
  setHint('Сетка сцены: ' + (App.grid.showGrid ? 'ВКЛ' : 'ВЫКЛ'), 1300);
}

function toggleGridSnap() {
  App.grid.snap = !App.grid.snap;
  updateGridButtonsUI();
  setHint('Привязка к сетке (Pivot): ' + (App.grid.snap ? 'ВКЛ' : 'ВЫКЛ'), 1500);
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
        rebuildGrid();
        markDirty();
        closeBgModal();
      } else if (p.custom) {
        // остаёмся в палитре для выбора кастомного цвета
      } else {
        App.settings.frame.background = p.isGrid ? 'grid' : p.color;
        applyBackgroundToViewport();
        rebuildGrid();
        markDirty();
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
    rebuildGrid();
    markDirty();
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
  loadSavedGridConfig();

  if (els.btnGridSettings) {
    els.btnGridSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleGridSettingsPopover(els.btnGridSettings);
    });
  }

  // Закрытие всплывающих поповеров при клике вне них
  window.addEventListener('mousedown', (e) => {
    const t = e.target;
    if (els.gridSettingsPopover && !els.gridSettingsPopover.hidden) {
      const insideGrid = (t && t.closest && (t.closest('#grid-settings-popover') || t.closest('#btn-grid-settings')));
      if (!insideGrid) closeGridSettingsPopover();
    }
    if (els.guidesSettingsPopover && !els.guidesSettingsPopover.hidden) {
      const insideGuides = (t && t.closest && (t.closest('#guides-settings-popover') || t.closest('#btn-stage-guides-menu')));
      if (!insideGuides) {
        els.guidesSettingsPopover.hidden = true;
        if (els.btnStageGuidesMenu) els.btnStageGuidesMenu.classList.remove('active');
      }
    }
    if (els.stageContextMenu && !els.stageContextMenu.hidden) {
      const insideCtx = (t && t.closest && t.closest('#stage-context-menu'));
      if (!insideCtx) els.stageContextMenu.hidden = true;
    }
  });

  // Глобальное отключение системного браузерного меню по ПКМ в рабочей области редактора
  // (кроме текстовых/числовых полей ввода; панорамирование на ПКМ НЕ вешаем)
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    const t = e.target;
    if (t && t.closest && t.closest('input[type="text"], input[type="number"], input[type="search"], textarea, [contenteditable="true"]')) {
      return;
    }
    e.preventDefault();
    if (els.stageContextMenu) els.stageContextMenu.hidden = true;
  });

  const vp = els.viewport;
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = vp.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const before = screenToWorld(sx, sy);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    App.camera.zoom = clamp(App.camera.zoom * factor, 0.05, 60);
    const after = screenToWorld(sx, sy);
    App.camera.x += before.x - after.x;
    App.camera.y += before.y - after.y;
    applyCamera();
  }, { passive: false });

  vp.addEventListener('mousedown', (e) => {
    // Линейки и направляющие обрабатывают перетаскивание самостоятельно
    if (e.target && e.target.closest && e.target.closest('.stage-ruler, .stage-ruler-corner, .stage-guide-hit')) {
      return;
    }
    // Панорамирование только на Space + ЛКМ или СКМ (колесо), НЕ на ПКМ
    if (App.spaceDown || e.button === 1) {
      App.panning = true;
      App.panStart = { sx: e.clientX, sy: e.clientY, cx: App.camera.x, cy: App.camera.y };
      vp.classList.add('panning');
      e.preventDefault();
      return;
    }
    if (e.button === 0) {
      if (App.editorMode === 'stage') {
        if (typeof handleStageViewportMouseDown === 'function') {
          handleStageViewportMouseDown(e);
        }
        return;
      }
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
