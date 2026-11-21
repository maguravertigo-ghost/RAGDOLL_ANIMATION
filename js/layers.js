'use strict';

// ============================================================
//  layers.js — дерево слоёв, вложенность/группы и панель свойств
// ============================================================

function buildChildrenIndex() {
  const parts = App.settings ? App.settings.parts : [];
  const byId = {};
  for (const p of parts) byId[p.id] = p;
  const childrenOf = {};
  const roots = [];
  for (const p of parts) {
    if (p.parent && byId[p.parent]) {
      (childrenOf[p.parent] = childrenOf[p.parent] || []).push(p);
    } else {
      roots.push(p);
    }
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
    if (p.visible === false) li.style.opacity = '0.5';
    li.draggable = true;
    const iconName = p.isGroup ? 'folder' : 'crop_square';
    li.innerHTML =
      '<span class="material-icons layer-icon">' + iconName + '</span>' +
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
    e.stopPropagation();
    e.preventDefault();
    promptText('Переименовать слой', p.id, (newName) => renamePart(p.id, newName));
  });
  li.addEventListener('dragstart', (e) => {
    App._dragLayerId = p.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', p.id); } catch (_) {}
  });
  li.addEventListener('dragend', () => {
    App._dragLayerId = null;
    li.classList.remove('dragging');
    els.layersList.querySelectorAll('li').forEach(x =>
      x.classList.remove('drop-before', 'drop-after', 'drop-into')
    );
  });
  li.addEventListener('dragover', (e) => {
    const dragged = App._dragLayerId;
    if (!dragged || dragged === p.id) return;
    if (isDescendantOf(p.id, dragged)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    els.layersList.querySelectorAll('li').forEach(x =>
      x.classList.remove('drop-before', 'drop-after', 'drop-into')
    );
    const rect = li.getBoundingClientRect();
    const y = e.clientY - rect.top, h = rect.height;
    if (y < h * 0.25) li.classList.add('drop-before');
    else if (y > h * 0.75) li.classList.add('drop-after');
    else li.classList.add('drop-into');
  });
  li.addEventListener('dragleave', () => {
    li.classList.remove('drop-before', 'drop-after', 'drop-into');
  });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    const dragged = App._dragLayerId;
    if (!dragged || dragged === p.id) return;
    let mode = 'into';
    if (li.classList.contains('drop-before')) mode = 'before';
    else if (li.classList.contains('drop-after')) mode = 'after';
    els.layersList.querySelectorAll('li').forEach(x =>
      x.classList.remove('drop-before', 'drop-after', 'drop-into')
    );
    movePartTo(dragged, p.id, mode);
  });
}

// -------- выделение слоёв --------

function setSelection(ids, primaryId) {
  App.selectedIds = new Set(ids);
  App.selectedId = primaryId || (ids.length ? ids[0] : null);
  els.layersList.querySelectorAll('li').forEach(li => {
    li.classList.toggle('selected', App.selectedIds.has(li.dataset.id));
  });
  if (!App.selectedId) Gizmo.setMode(1);
  updateSelSize();
  Gizmo.render();
  renderProperties();
  renderTimeline();
}

function toggleSelection(id) {
  const s = new Set(App.selectedIds);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  const arr = Array.from(s);
  setSelection(arr, s.has(id) ? id : (arr[0] || null));
}

function rangeSelect(id) {
  const all = Array.from(els.layersList.querySelectorAll('li')).map(x => x.dataset.id);
  const a = all.indexOf(App.selectedId), b = all.indexOf(id);
  if (a < 0 || b < 0) { setSelection([id], id); return; }
  setSelection(all.slice(Math.min(a, b), Math.max(a, b) + 1), id);
}

function setSelected(id) {
  setSelection(id ? [id] : [], id);
}

// -------- иерархия и группировка --------

function isDescendantOf(childId, ancestorId) {
  if (childId === ancestorId) return true;
  const byId = {};
  for (const p of App.settings.parts) byId[p.id] = p;
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
  const byId = {};
  for (const p of App.settings.parts) byId[p.id] = p;
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
  const newParentId = (mode === 'into') ? target.id : (target.parent || null);
  reparentPart(part, newParentId);
  const pi = parts.indexOf(part);
  parts.splice(pi, 1);
  const ti = parts.indexOf(target);
  if (mode === 'before') parts.splice(ti, 0, part);
  else if (mode === 'after') parts.splice(ti + 1, 0, part);
  else parts.push(part);
  refreshAfterStructureChange();
}

function groupSelected() {
  if (!App.settings) return;
  const ids = Array.from(App.selectedIds);
  if (!ids.length) { setHint('Выберите слои для группы', 2000); return; }
  const parts = App.settings.parts;
  const byId = {};
  for (const p of parts) byId[p.id] = p;
  const children = ids.map(id => byId[id]).filter(Boolean);
  if (!children.length) return;
  const parentId = children[0].parent || null;
  if (!children.every(c => (c.parent || null) === parentId)) {
    setHint('Группировать можно только слои с одним родителем', 2500);
    return;
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
    id: gid,
    isGroup: true,
    parent: parentId,
    size: { w: bbox.w, h: bbox.h },
    pivot: { x: 0.5, y: 0.5 },
    transform: {
      position: { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 },
      rotation: 0,
      scale: { x: 1, y: 1 },
      skew: { x: 0, y: 0 }
    },
    visible: true,
    opacity: 1
  };
  group._baseTransform = clone(group.transform);
  group._baseVisible = true;

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
  for (const c of children) {
    const i = parts.indexOf(c);
    if (i > maxIdx) maxIdx = i;
  }
  parts.splice(maxIdx, 0, group);
  setSelection([gid], gid);
  refreshAfterStructureChange();
  setHint('Создана группа ' + gid, 1800);
}

function ungroupSelected() {
  if (!App.settings) return;
  const id = App.selectedId;
  if (!id) { setHint('Выберите группу', 2000); return; }
  const parts = App.settings.parts;
  const byId = {};
  for (const p of parts) byId[p.id] = p;
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
  // Удаляем дорожки удалённой группы из анимаций
  for (const a of (App.settings.animations || [])) {
    a.tracks = (a.tracks || []).filter(t => t.partId !== g.id);
  }
  const i = parts.indexOf(g);
  if (i >= 0) parts.splice(i, 1);
  setSelection(children.map(c => c.id), children[0] ? children[0].id : null);
  refreshAfterStructureChange();
  setHint('Разгруппировано', 1500);
}

function renamePart(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  if (App.settings.parts.some(p => p.id === newId)) {
    setHint('Слой с таким именем уже есть', 2000);
    return;
  }
  for (const p of App.settings.parts) {
    if (p.id === oldId) p.id = newId;
    if (p.parent === oldId) p.parent = newId;
  }
  for (const a of (App.settings.animations || [])) {
    for (const t of (a.tracks || [])) {
      if (t.partId === oldId) t.partId = newId;
    }
  }
  if (App.selectedIds.has(oldId)) {
    App.selectedIds.delete(oldId);
    App.selectedIds.add(newId);
  }
  if (App.selectedId === oldId) App.selectedId = newId;
  if (App.anim.focus && App.anim.focus.partId === oldId) App.anim.focus.partId = newId;
  if (App.anim.expanded.has(oldId)) {
    App.anim.expanded.delete(oldId);
    App.anim.expanded.add(newId);
  }
  for (const sk of App.anim.selectedKeys) {
    if (sk.partId === oldId) sk.partId = newId;
  }
  refreshAfterStructureChange();
  setHint('Переименовано: ' + oldId + ' → ' + newId, 1500);
}

function refreshAfterStructureChange() {
  renderScene();
  renderOnionSkins();
  renderLayers();
  renderTimeline();
  updateSelSize();
  Gizmo.render();
  renderProperties();
}

// -------- панель Свойства (правый нижний блок) --------

function propCategoryFromKey(key) {
  if (key === 'pos.x' || key === 'pos.y') return 'position';
  if (key === 'rot') return 'rotation';
  if (key === 'scl.x' || key === 'scl.y') return 'scale';
  if (key === 'skw.x' || key === 'skw.y') return 'skew';
  if (key === 'piv.x' || key === 'piv.y') return 'pivot';
  return null;
}

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
    'pos.x': 0, 'pos.y': 0,
    'rot': 0,
    'scl.x': 1, 'scl.y': 1,
    'skw.x': 0, 'skw.y': 0,
    'piv.x': 0.5, 'piv.y': 0.5
  };

  function row(label, key, value, step) {
    return (
      '<div class="prow">' +
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
      '</div>'
    );
  }

  const checkedAttr = (part.visible !== false) ? ' checked' : '';
  props.innerHTML =
    '<label class="pcheck">' +
      '<input type="checkbox" id="prop-visible"' + checkedAttr + '>' +
      '<span>Видимость слоя</span>' +
    '</label>' +
    '<div class="pgroup"><div class="pgroup-title">Позиция</div>' +
      row('X', 'pos.x', t.position.x, 0.5) +
      row('Y', 'pos.y', t.position.y, 0.5) + '</div>' +
    '<div class="pgroup"><div class="pgroup-title">Поворот, °</div>' +
      row('R', 'rot', t.rotation, 1) + '</div>' +
    '<div class="pgroup"><div class="pgroup-title">Масштаб</div>' +
      row('X', 'scl.x', t.scale.x, 0.01) +
      row('Y', 'scl.y', t.scale.y, 0.01) + '</div>' +
    '<div class="pgroup"><div class="pgroup-title">Скос, °</div>' +
      row('X', 'skw.x', t.skew.x, 1) +
      row('Y', 'skw.y', t.skew.y, 1) + '</div>' +
    '<div class="pgroup"><div class="pgroup-title">Pivot (0..1)</div>' +
      row('X', 'piv.x', part.pivot.x, 0.01) +
      row('Y', 'piv.y', part.pivot.y, 0.01) + '</div>';

  const visCheck = props.querySelector('#prop-visible');
  if (visCheck) {
    visCheck.addEventListener('change', () => {
      setPartVisibility(part, visCheck.checked);
    });
  }

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

  function setValue(key, v, isLive) {
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
    const cat = propCategoryFromKey(key);
    if (cat) onPartEdited(part, cat, !!isLive);
  }

  props.querySelectorAll('input[type="number"]').forEach(inp => {
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      if (isFinite(v)) setValue(inp.dataset.key, v, true);
    });
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (isFinite(v)) setValue(inp.dataset.key, v, false);
    });
  });

  props.querySelectorAll('[data-spin]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      const dir = btn.dataset.spin === 'up' ? 1 : -1;
      const inp = props.querySelector('input[data-key="' + key + '"]');
      const step = parseFloat(inp.step) || 0.1;
      const v = getValue(key) + dir * step;
      setValue(key, v, false);
      inp.value = (+v).toFixed(3);
    });
  });

  props.querySelectorAll('[data-reset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.reset;
      const v = RESET[key];
      setValue(key, v, false);
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
  const visCheck = els.props.querySelector('#prop-visible');
  if (visCheck) visCheck.checked = (part.visible !== false);
  updateSelSize();
}

function togglePropsCollapse() {
  App._propsCollapsed = !App._propsCollapsed;
  els.props.classList.toggle('collapsed', App._propsCollapsed);
  els.propsCollapseIcon.textContent = App._propsCollapsed ? 'expand_less' : 'expand_more';
}
