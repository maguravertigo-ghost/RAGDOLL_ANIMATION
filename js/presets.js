'use strict';

// ============================================================
//  presets.js — пресеты поз персонажа (сохранение, выбор, перенос
//               между кадрами и между разными персонажами)
// ============================================================

const PRESETS_LS_KEY = 'ragdoll_pose_presets_v1';

function roundPresetNum(n) {
  return Math.round((+n || 0) * 10000) / 10000;
}

function normPartKey(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(/\.svg$/i, '')
    .replace(/[-\s]+/g, '_');
}

// Семантические слоты частей тела/объекта для переноса поз между разными персонажами
function getSemanticSlot(part) {
  const k = normPartKey(part && (part.id || part.file));
  if (!k) return '';

  // Сторона (левая / правая)
  let side = '';
  if (/(?:^|_)(l|left)(?:_|$)/.test(k)) side = '_l';
  else if (/(?:^|_)(r|right)(?:_|$)/.test(k)) side = '_r';

  if (k === 'all_character' || k === 'all_object' || k === 'root' || k === 'character') return 'root_group';
  if (k === 'person_gr' || k === 'char_gr') return 'person_group';
  if (k === 'all_body' || k === 'body_gr' || k === 'torso_gr') return 'body_group';
  if (k === 'head_gr' || k === 'head_group') return 'head_group';

  if (k.indexOf('shadow') >= 0) return 'shadow';
  if (k.indexOf('eye') >= 0) return 'eyes' + side;
  if (k.indexOf('hat_tail') >= 0) return 'hat_tail';
  if (k.indexOf('head') >= 0 || k.indexOf('face') >= 0) return 'head';
  if (k.indexOf('hat') >= 0 || k.indexOf('helmet') >= 0) return 'hat';

  if (k.indexOf('h_long') >= 0 || (k.indexOf('hair') >= 0 && side)) return 'hair' + side;
  if (k.indexOf('hair') >= 0) return 'hair_front';

  if (k.indexOf('sleeve') >= 0 || k.indexOf('shoulder') >= 0) return 'sleeve' + side;
  if (k.indexOf('finger') >= 0) return 'fingers' + side;
  if ((k.indexOf('arm') >= 0 || k.indexOf('forearm') >= 0) && k.indexOf('angled') >= 0) return 'arm_angled' + side;
  if (k.indexOf('arm') >= 0 || k.indexOf('hand') >= 0) return 'arm' + side;

  if (k.indexOf('leg') >= 0 || k.indexOf('foot') >= 0 || k.indexOf('thigh') >= 0) return 'leg' + side;
  if (k.indexOf('dress') >= 0 || k.indexOf('skirt') >= 0 || k.indexOf('coat') >= 0) return 'dress';
  if (k.indexOf('body') >= 0 || k.indexOf('torso') >= 0 || k.indexOf('chest') >= 0) return 'body';
  if (k.indexOf('tail') >= 0) return 'tail' + side;

  return k;
}

// -------- чтение / запись presets.json и localStorage --------

function readPresetsLocalCache() {
  try {
    const raw = localStorage.getItem(PRESETS_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.presets)) return parsed.presets;
  } catch (_) {}
  return [];
}

function writePresetsLocalCache(list) {
  try {
    localStorage.setItem(PRESETS_LS_KEY, JSON.stringify({ version: 1, presets: list }));
  } catch (_) {}
}

function mergePresetsLists(primary, secondary) {
  const map = new Map();
  for (const item of (secondary || [])) {
    if (item && item.id) map.set(item.id, item);
  }
  for (const item of (primary || [])) {
    if (!item || !item.id) continue;
    const prev = map.get(item.id);
    if (!prev || (item.updatedAt || 0) >= (prev.updatedAt || 0)) {
      map.set(item.id, item);
    }
  }
  return Array.from(map.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function getLocalPresetsDirHandle() {
  if (App.storage.mode !== 'local-fs') return null;
  return App.storage.rootHandle || App.storage.animHandle || App.storage.singleObjHandle || null;
}

async function loadPresetsFromStorage() {
  const localList = readPresetsLocalCache();
  let remoteList = [];

  try {
    const dirHandle = getLocalPresetsDirHandle();
    if (dirHandle) {
      try {
        const fh = await dirHandle.getFileHandle('presets.json');
        const file = await fh.getFile();
        const parsed = JSON.parse(await file.text());
        if (parsed && Array.isArray(parsed.presets)) remoteList = parsed.presets;
        else if (Array.isArray(parsed)) remoteList = parsed;
      } catch (_) {}
    } else if (App.storage.mode === 'server') {
      const r = await fetch('/api/presets');
      if (r.ok) {
        const parsed = await r.json();
        if (parsed && Array.isArray(parsed.presets)) remoteList = parsed.presets;
      }
    }
  } catch (_) {}

  App.presets = mergePresetsLists(remoteList, localList);
  writePresetsLocalCache(App.presets);
  if (els.modalPresets && !els.modalPresets.hidden) {
    renderPresetsModalList();
  }
}

async function persistPresets() {
  writePresetsLocalCache(App.presets);
  const payload = JSON.stringify({ version: 1, presets: App.presets }, null, 2);

  try {
    const dirHandle = getLocalPresetsDirHandle();
    if (dirHandle) {
      const fh = await dirHandle.getFileHandle('presets.json', { create: true });
      const wr = await fh.createWritable();
      await wr.write(payload);
      await wr.close();
      return 'disk';
    }
    if (App.storage.mode === 'server') {
      const r = await fetch('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });
      if (r.ok) return 'server';
    }
  } catch (e) {
    console.warn('Не удалось записать presets.json на диск, сохранено в браузере:', e);
  }
  return 'browser';
}

// -------- снимок текущей позы и применение пресета --------

function captureCurrentPoseEntries(onlySelected) {
  if (!App.settings || !App.settings.parts) return [];
  const parts = onlySelected
    ? App.settings.parts.filter(p => App.selectedIds.has(p.id))
    : App.settings.parts;

  const entries = [];
  for (const p of parts) {
    ensureBase(p);
    const base = p._baseTransform;
    const cur  = p.transform;
    const sx = Math.abs(base.scale.x) > 1e-6 ? (cur.scale.x / base.scale.x) : cur.scale.x;
    const sy = Math.abs(base.scale.y) > 1e-6 ? (cur.scale.y / base.scale.y) : cur.scale.y;
    const curVis  = (p.visible !== false);
    const baseVis = (p._baseVisible !== false);

    entries.push({
      id: p.id,
      normId: normPartKey(p.id),
      slot: getSemanticSlot(p),
      isGroup: !!p.isGroup,
      delta: {
        dPos: {
          x: roundPresetNum(cur.position.x - base.position.x),
          y: roundPresetNum(cur.position.y - base.position.y)
        },
        dRot: roundPresetNum(cur.rotation - base.rotation),
        rScale: {
          x: roundPresetNum(sx),
          y: roundPresetNum(sy)
        },
        dSkew: {
          x: roundPresetNum(cur.skew.x - base.skew.x),
          y: roundPresetNum(cur.skew.y - base.skew.y)
        }
      },
      abs: {
        position: { x: roundPresetNum(cur.position.x), y: roundPresetNum(cur.position.y) },
        rotation: roundPresetNum(cur.rotation),
        scale:    { x: roundPresetNum(cur.scale.x),    y: roundPresetNum(cur.scale.y) },
        skew:     { x: roundPresetNum(cur.skew.x),     y: roundPresetNum(cur.skew.y) }
      },
      visible: curVis,
      visChanged: curVis !== baseVis
    });
  }
  return entries;
}

function entryMagnitude(entry) {
  if (!entry || !entry.delta) return 0;
  const d = entry.delta;
  return (
    Math.abs(d.dRot || 0) * 2 +
    Math.abs((d.dPos && d.dPos.x) || 0) +
    Math.abs((d.dPos && d.dPos.y) || 0) +
    Math.abs(((d.rScale && d.rScale.x) || 1) - 1) * 50 +
    Math.abs(((d.rScale && d.rScale.y) || 1) - 1) * 50 +
    Math.abs((d.dSkew && d.dSkew.x) || 0) +
    Math.abs((d.dSkew && d.dSkew.y) || 0)
  );
}

function findMatchingPresetEntry(targetPart, preset, targetSlotCounts) {
  const entries = preset.parts || [];
  // 1) Точное совпадение по имени слоя
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].id === targetPart.id) return entries[i];
  }

  // 2) Нормализованное имя (без учёта регистра и дефисов)
  const nk = normPartKey(targetPart.id);
  for (let i = 0; i < entries.length; i++) {
    if ((entries[i].normId || normPartKey(entries[i].id)) === nk) return entries[i];
  }

  // 3) Семантический слот (для переноса на другого персонажа, например arm_L / head / body)
  const slot = getSemanticSlot(targetPart);
  if (!slot) return null;

  // Ищем кандидатов с таким же слотом (или head_group <-> head, если у целевого персонажа нет отдельной группы головы)
  const candidates = entries.filter(e => {
    const es = e.slot || getSemanticSlot(e);
    if (es === slot) return true;
    if (!targetPart.isGroup && slot === 'head' && es === 'head_group' && !targetSlotCounts['head_group']) return true;
    if (!targetPart.isGroup && slot === 'body' && es === 'body_group' && !targetSlotCounts['body_group']) return true;
    return false;
  });

  if (!candidates.length) return null;

  // Предпочитаем запись с реальным изменением позы (например, если в исходном персонаже
  // поворачивали группу head_gr, а у нового персонажа есть только спрайт head)
  candidates.sort((a, b) => {
    const ma = entryMagnitude(a), mb = entryMagnitude(b);
    const activeDiff = (mb > 1e-4 ? 1 : 0) - (ma > 1e-4 ? 1 : 0);
    if (activeDiff !== 0) return activeDiff;
    const kindDiff = (!!b.isGroup === !!targetPart.isGroup ? 1 : 0) - (!!a.isGroup === !!targetPart.isGroup ? 1 : 0);
    if (kindDiff !== 0) return kindDiff;
    return mb - ma;
  });
  return candidates[0];
}

function applyPosePreset(preset) {
  if (!App.settings || !preset || !Array.isArray(preset.parts)) {
    setHint('Сначала откройте объект и выберите пресет', 2000);
    return;
  }

  const sameCharacter = (preset.sourceObject === App.current);
  const useRelative = els.presetOptRelative ? els.presetOptRelative.checked : true;
  const applyPos    = els.presetOptPos ? els.presetOptPos.checked : true;
  const applyVis    = els.presetOptVis ? els.presetOptVis.checked : true;

  // Если у пользователя выделены конкретные части (и не все), применяем ко всем подходящим частям;
  // слоты считаем заранее для умного сопоставления между разными персонажами
  const targetSlotCounts = {};
  for (const p of App.settings.parts) {
    const s = getSemanticSlot(p);
    if (s) targetSlotCounts[s] = (targetSlotCounts[s] || 0) + 1;
  }

  const a = getCurrentAnimation();
  const isReset = !!(a && a.name === 'reset');
  const time = isReset ? 0 : snapTime(App.anim.time);
  let matchedCount = 0;

  for (const p of App.settings.parts) {
    const entry = findMatchingPresetEntry(p, preset, targetSlotCounts);
    if (!entry) continue;

    ensureBase(p);
    const base = p._baseTransform;
    const d = entry.delta || { dPos: { x: 0, y: 0 }, dRot: 0, rScale: { x: 1, y: 1 }, dSkew: { x: 0, y: 0 } };

    if (useRelative || !sameCharacter || !entry.abs) {
      if (applyPos && d.dPos) {
        p.transform.position = {
          x: base.position.x + (d.dPos.x || 0),
          y: base.position.y + (d.dPos.y || 0)
        };
      }
      p.transform.rotation = base.rotation + (d.dRot || 0);
      p.transform.scale = {
        x: base.scale.x * ((d.rScale && isFinite(d.rScale.x)) ? d.rScale.x : 1),
        y: base.scale.y * ((d.rScale && isFinite(d.rScale.y)) ? d.rScale.y : 1)
      };
      p.transform.skew = {
        x: base.skew.x + ((d.dSkew && d.dSkew.x) || 0),
        y: base.skew.y + ((d.dSkew && d.dSkew.y) || 0)
      };
    } else {
      if (applyPos) p.transform.position = clone(entry.abs.position);
      p.transform.rotation = entry.abs.rotation;
      p.transform.scale    = clone(entry.abs.scale);
      p.transform.skew     = clone(entry.abs.skew);
    }

    let visTouched = false;
    if (applyVis && entry.visible !== undefined) {
      if (sameCharacter || entry.visChanged) {
        p.visible = !!entry.visible;
        visTouched = true;
      }
    }

    if (isReset) {
      p._baseTransform = clone(p.transform);
      if (visTouched) p._baseVisible = (p.visible !== false);
    } else if (!hasResetAnimation() && time < 1e-6) {
      p._baseTransform = clone(p.transform);
      if (visTouched) p._baseVisible = (p.visible !== false);
    }

    // Записываем применённую позу в текущий кадр анимации
    if (a) {
      const keyType = isReset ? 'key' : null;
      if (applyPos) writeKeyOnTrack(p.id, 'position', time, getPartPropValue(p, 'position'), keyType, a);
      writeKeyOnTrack(p.id, 'rotation', time, getPartPropValue(p, 'rotation'), keyType, a);
      writeKeyOnTrack(p.id, 'scale',    time, getPartPropValue(p, 'scale'),    keyType, a);
      writeKeyOnTrack(p.id, 'skew',     time, getPartPropValue(p, 'skew'),     keyType, a);
      if (visTouched) {
        writeKeyOnTrack(p.id, 'visible', time, getPartPropValue(p, 'visible'), 'key', a);
      }
    }

    matchedCount++;
  }

  if (matchedCount === 0) {
    setHint('В текущем объекте не найдено подходящих слоёв для пресета «' + preset.name + '»', 2600);
    return;
  }

  markDirty();
  syncSceneTransforms();
  renderOnionSkins();
  syncVisibilityUI();
  renderTimeline();
  updateSelSize();
  Gizmo.render();
  syncPropertyInputs();

  setHint('Пресет «' + preset.name + '» применён (затронуто слоёв: ' + matchedCount + ')', 2200);
}

// -------- UI модального окна Пресеты поз --------

function getSelectedPreset() {
  if (!App._selectedPresetId) return null;
  return App.presets.find(p => p.id === App._selectedPresetId) || null;
}

function updatePresetScopeUI() {
  const selCount = App.selectedIds ? App.selectedIds.size : 0;
  if (els.presetScopeSelLabel) {
    els.presetScopeSelLabel.textContent = 'Только выделенные слои (' + selCount + ')';
  }
  if (els.presetScopeSel) {
    els.presetScopeSel.disabled = (selCount === 0);
    if (selCount === 0 && els.presetScopeSel.checked && els.presetScopeAll) {
      els.presetScopeAll.checked = true;
    }
  }
}

function renderPresetsModalList() {
  if (!els.presetsList) return;
  els.presetsList.innerHTML = '';

  if (!App.presets.length) {
    const empty = document.createElement('li');
    empty.className = 'preset-empty';
    empty.textContent = 'Нет сохранённых пресетов. Выставьте позу персонажа и нажмите «Сохранить».';
    els.presetsList.appendChild(empty);
    return;
  }

  if (!App._selectedPresetId || !App.presets.some(x => x.id === App._selectedPresetId)) {
    App._selectedPresetId = App.presets[0].id;
  }

  for (const pr of App.presets) {
    const li = document.createElement('li');
    if (pr.id === App._selectedPresetId) li.classList.add('selected');

    const title = document.createElement('span');
    title.className = 'preset-item-title';
    title.textContent = pr.name;

    const badges = document.createElement('span');
    badges.className = 'preset-item-badges';

    if (pr.sourceObject) {
      const bObj = document.createElement('span');
      bObj.className = 'preset-badge';
      bObj.textContent = pr.sourceObject;
      badges.appendChild(bObj);
    }

    const bCnt = document.createElement('span');
    bCnt.className = 'preset-badge';
    bCnt.textContent = ((pr.parts && pr.parts.length) || 0) + ' сл.';
    badges.appendChild(bCnt);

    li.appendChild(title);
    li.appendChild(badges);

    li.addEventListener('click', () => {
      App._selectedPresetId = pr.id;
      renderPresetsModalList();
    });

    li.addEventListener('dblclick', () => {
      App._selectedPresetId = pr.id;
      applyPosePreset(pr);
      closePresetsModal();
    });

    els.presetsList.appendChild(li);
  }
}

async function openPresetsModal() {
  if (!App.settings) {
    setHint('Сначала откройте объект', 2000);
    return;
  }
  updatePresetScopeUI();
  await loadPresetsFromStorage();
  renderPresetsModalList();
  els.modalPresets.hidden = false;
  if (els.presetNameInput) els.presetNameInput.focus();
}

function closePresetsModal() {
  if (els.modalPresets) els.modalPresets.hidden = true;
}

async function createPresetFromUI() {
  if (!App.settings) {
    setHint('Сначала откройте объект', 2000);
    return;
  }
  const name = (els.presetNameInput ? els.presetNameInput.value : '').trim();
  if (!name) {
    setHint('Введите имя пресета (например: Руки вверх)', 2000);
    if (els.presetNameInput) els.presetNameInput.focus();
    return;
  }

  const onlySelected = !!(els.presetScopeSel && els.presetScopeSel.checked && App.selectedIds.size > 0);
  const entries = captureCurrentPoseEntries(onlySelected);
  if (!entries.length) {
    setHint('Нет слоёв для сохранения в пресет', 2000);
    return;
  }

  const now = Date.now();
  const preset = {
    id: 'preset_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    name: name,
    sourceObject: App.current || '',
    scope: onlySelected ? 'selected' : 'all',
    createdAt: now,
    updatedAt: now,
    parts: entries
  };

  App.presets.push(preset);
  App._selectedPresetId = preset.id;
  if (els.presetNameInput) els.presetNameInput.value = '';
  renderPresetsModalList();

  const where = await persistPresets();
  setHint(
    'Пресет «' + name + '» сохранён (' + entries.length + ' сл.' +
    (where === 'disk' ? ', presets.json на диске' : '') + ')',
    2200
  );
}

async function updateSelectedPresetWithCurrentPose() {
  const pr = getSelectedPreset();
  if (!pr) {
    setHint('Выберите пресет для перезаписи', 2000);
    return;
  }
  const onlySelected = !!(els.presetScopeSel && els.presetScopeSel.checked && App.selectedIds.size > 0);
  const entries = captureCurrentPoseEntries(onlySelected);
  if (!entries.length) return;

  confirmDialog(
    'Обновить пресет?',
    'Перезаписать пресет «' + pr.name + '» текущей позой со сцены (' + entries.length + ' сл.)?',
    async () => {
      pr.parts = entries;
      pr.sourceObject = App.current || pr.sourceObject;
      pr.scope = onlySelected ? 'selected' : 'all';
      pr.updatedAt = Date.now();
      renderPresetsModalList();
      await persistPresets();
      setHint('Пресет «' + pr.name + '» обновлён', 1800);
    }
  );
}

function renameSelectedPreset() {
  const pr = getSelectedPreset();
  if (!pr) {
    setHint('Выберите пресет для переименования', 2000);
    return;
  }
  promptText('Переименовать пресет', pr.name, async (newName) => {
    if (!newName || newName === pr.name) return;
    pr.name = newName;
    pr.updatedAt = Date.now();
    renderPresetsModalList();
    await persistPresets();
  });
}

function deleteSelectedPreset() {
  const pr = getSelectedPreset();
  if (!pr) {
    setHint('Выберите пресет для удаления', 2000);
    return;
  }
  confirmDialog(
    'Удалить пресет?',
    'Удалить пресет позы «' + pr.name + '»?',
    async () => {
      const idx = App.presets.findIndex(x => x.id === pr.id);
      if (idx >= 0) App.presets.splice(idx, 1);
      App._selectedPresetId = App.presets.length ? App.presets[Math.min(idx, App.presets.length - 1)].id : null;
      renderPresetsModalList();
      await persistPresets();
      setHint('Пресет удалён', 1600);
    }
  );
}

function exportPresetsJson() {
  if (!App.presets.length) {
    setHint('Нет пресетов для экспорта', 1800);
    return;
  }
  const text = JSON.stringify({ version: 1, presets: App.presets }, null, 2);
  downloadJsonBlob('presets.json', text);
  setHint('Скачан файл presets.json (' + App.presets.length + ' шт.)', 2000);
}

async function importPresetsFromFile(file) {
  if (!file) return;
  try {
    const txt = await file.text();
    const parsed = JSON.parse(txt);
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.presets) ? parsed.presets : null);
    if (!list) throw new Error('Некорректный формат файла пресетов');
    App.presets = mergePresetsLists(list, App.presets);
    renderPresetsModalList();
    await persistPresets();
    setHint('Импортировано пресетов: ' + list.length, 2200);
  } catch (e) {
    setHint('Ошибка импорта пресетов: ' + e.message, 3200);
  }
}

function setupPresetsControls() {
  App.presets = readPresetsLocalCache();

  if (els.btnPresets) els.btnPresets.addEventListener('click', openPresetsModal);
  if (els.presetsClose) els.presetsClose.addEventListener('click', closePresetsModal);
  if (els.presetsCancel) els.presetsCancel.addEventListener('click', closePresetsModal);
  if (els.modalPresets) {
    els.modalPresets.addEventListener('click', (e) => {
      if (e.target === els.modalPresets) closePresetsModal();
    });
  }

  if (els.presetSaveBtn) els.presetSaveBtn.addEventListener('click', createPresetFromUI);
  if (els.presetNameInput) {
    els.presetNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        createPresetFromUI();
      }
    });
  }

  if (els.presetApplyBtn) {
    els.presetApplyBtn.addEventListener('click', () => {
      const pr = getSelectedPreset();
      if (!pr) {
        setHint('Выберите пресет в списке', 1800);
        return;
      }
      applyPosePreset(pr);
      closePresetsModal();
    });
  }

  if (els.presetUpdateBtn) els.presetUpdateBtn.addEventListener('click', updateSelectedPresetWithCurrentPose);
  if (els.presetRenameBtn) els.presetRenameBtn.addEventListener('click', renameSelectedPreset);
  if (els.presetDeleteBtn) els.presetDeleteBtn.addEventListener('click', deleteSelectedPreset);
  if (els.presetExportBtn) els.presetExportBtn.addEventListener('click', exportPresetsJson);
  if (els.presetImportBtn && els.presetImportInput) {
    els.presetImportBtn.addEventListener('click', () => {
      els.presetImportInput.value = '';
      els.presetImportInput.click();
    });
    els.presetImportInput.addEventListener('change', () => {
      const f = els.presetImportInput.files && els.presetImportInput.files[0];
      if (f) importPresetsFromFile(f);
    });
  }
}
