'use strict';

// ============================================================
//  animation.js — модель анимаций, интерполяция key/tween,
//                 Realtime-запись, поза reset и воспроизведение
// ============================================================

function getCurrentAnimation() {
  if (!App.settings || !App.settings.animations) return null;
  return App.settings.animations.find(a => a.name === App._animSelectedName)
      || App.settings.animations[0] || null;
}

function hasResetAnimation() {
  return !!(App.settings && App.settings.animations &&
            App.settings.animations.some(a => a.name === 'reset'));
}

function getTrack(partId, property, animObj) {
  const a = animObj || getCurrentAnimation();
  if (!a || !a.tracks) return null;
  return a.tracks.find(t => t.partId === partId && t.property === property) || null;
}

function ensureTrack(partId, property, animObj) {
  const a = animObj || getCurrentAnimation();
  if (!a) return null;
  if (!a.tracks) a.tracks = [];
  let t = getTrack(partId, property, a);
  if (!t) {
    t = { partId, property, keys: [] };
    a.tracks.push(t);
  }
  return t;
}

function removeTrack(partId, property) {
  const a = getCurrentAnimation();
  if (!a || !a.tracks) return;
  const i = a.tracks.findIndex(t => t.partId === partId && t.property === property);
  if (i >= 0) a.tracks.splice(i, 1);
}

function interpolateValue(a, b, k) {
  if (typeof a === 'number') return a + (b - a) * k;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

function sampleTrack(track, time) {
  const keys = track.keys;
  if (!keys || !keys.length) return null;
  if (time <= keys[0].time + 1e-6) return clone(keys[0].value);
  if (time >= keys[keys.length - 1].time - 1e-6) return clone(keys[keys.length - 1].value);

  for (let i = 0; i < keys.length; i++) {
    if (Math.abs(keys[i].time - time) < 1e-6) return clone(keys[i].value);
  }

  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i];
    const k1 = keys[i + 1];
    if (k0.time <= time && time < k1.time) {
      // Дорожка видимости или целевой ключевой кадр type === 'key' — ступенчатое удержание без интерполяции
      if (track.property === 'visible' || k1.type === 'key') {
        return clone(k0.value);
      }
      const span = k1.time - k0.time;
      const ratio = span > 0 ? (time - k0.time) / span : 0;
      return interpolateValue(k0.value, k1.value, ratio);
    }
  }
  return clone(keys[0].value);
}

function ensureBase(part) {
  if (!part._baseTransform) part._baseTransform = clone(part.transform);
  if (part._baseVisible === undefined) part._baseVisible = (part.visible !== false);
}

function evaluatePoseAtTime(time) {
  const a = getCurrentAnimation();
  if (!a || !App.settings) return null;
  const out = {};
  for (const p of App.settings.parts) {
    ensureBase(p);
    const base = p._baseTransform;
    const tr = {
      position: clone(base.position),
      rotation: base.rotation,
      scale: clone(base.scale),
      skew: clone(base.skew)
    };
    let vis = p._baseVisible !== false;

    for (const prop of ['position', 'rotation', 'scale', 'skew']) {
      const t = a.tracks.find(x => x.partId === p.id && x.property === prop);
      if (!t || !t.keys || !t.keys.length) continue;
      const v = sampleTrack(t, time);
      if (v != null) tr[prop] = v;
    }

    const vt = a.tracks.find(x => x.partId === p.id && x.property === 'visible');
    if (vt && vt.keys && vt.keys.length) {
      const vv = sampleTrack(vt, time);
      if (vv != null) vis = Boolean(vv);
    }

    out[p.id] = { transform: tr, visible: vis };
  }
  return out;
}

function applyAnimationAtTime(time) {
  const pose = evaluatePoseAtTime(time);
  if (!pose) return;
  for (const p of App.settings.parts) {
    const st = pose[p.id];
    if (!st) continue;
    p.transform = st.transform;
    p.visible = st.visible;
  }
}

// -------- чтение/запись значений свойств части --------

function getPartPropValue(part, property) {
  if (property === 'position') return clone(part.transform.position);
  if (property === 'rotation') return part.transform.rotation;
  if (property === 'scale')    return clone(part.transform.scale);
  if (property === 'skew')     return clone(part.transform.skew);
  if (property === 'visible')  return part.visible === false ? 0 : 1;
  return null;
}

function writeKeyOnTrack(partId, property, time, value, explicitType, animObj) {
  const tr = ensureTrack(partId, property, animObj);
  if (!tr) return { created: false, key: null };
  const t = snapTime(time);
  const existing = tr.keys.find(k => Math.abs(k.time - t) < 1e-6);
  if (existing) {
    existing.value = clone(value);
    if (property === 'visible') existing.type = 'key';
    else if (explicitType) existing.type = explicitType;
    else if (!existing.type) existing.type = 'tween';
    return { created: false, key: existing };
  }
  const keyType = (property === 'visible') ? 'key' : (explicitType || 'tween');
  const key = { time: t, value: clone(value), type: keyType };
  tr.keys.push(key);
  tr.keys.sort((a, b) => a.time - b.time);
  return { created: true, key };
}

// Вызывается при изменении части из Gizmo или панели Свойств
function onPartEdited(part, kindOrProp, isLiveDrag) {
  if (!App.settings || !part) return;
  const a = getCurrentAnimation();

  // Настройка точки вращения (pivot) меняет базовую позу скелета, а не создаёт ключи анимации
  if (kindOrProp === 'pivot') {
    part._baseTransform = clone(part.transform);
    const resetAnim = App.settings.animations.find(x => x.name === 'reset');
    if (resetAnim) {
      writeKeyOnTrack(part.id, 'position', 0, part.transform.position, 'key', resetAnim);
    }
    return;
  }

  let props = [];
  if (kindOrProp === 'move' || kindOrProp === 'position') props = ['position'];
  else if (kindOrProp === 'rotate' || kindOrProp === 'rotation') props = ['rotation'];
  else if (kindOrProp === 'resize') props = ['scale', 'position'];
  else if (kindOrProp === 'scale') props = ['scale'];
  else if (kindOrProp === 'skew') props = ['skew'];
  else if (kindOrProp === 'visible') props = ['visible'];
  else props = ['position', 'rotation', 'scale', 'skew'];

  // Если редактируем саму анимацию reset — обновляем базовую позу и ключи reset в t=0
  if (a && a.name === 'reset') {
    part._baseTransform = clone(part.transform);
    part._baseVisible = (part.visible !== false);
    let createdAny = false;
    for (const pr of props) {
      const res = writeKeyOnTrack(part.id, pr, 0, getPartPropValue(part, pr), 'key', a);
      if (res.created) createdAny = true;
    }
    if (createdAny || !isLiveDrag) renderTimeline();
    return;
  }

  // Если ещё нет reset-анимации и мы стоим в 00:00 — синхронизируем базовую позу для сохранения сборки
  if (!hasResetAnimation() && snapTime(App.anim.time) < 1e-6) {
    part._baseTransform = clone(part.transform);
    part._baseVisible = (part.visible !== false);
  }

  // В режиме Realtime сразу пишем изменённые свойства в текущий кадр таймлайна
  if (App.realtime && a) {
    let createdAny = false;
    for (const pr of props) {
      // При resize проверяем, сдвинулась ли позиция относительно сэмпла трека/базы
      if (kindOrProp === 'resize' && pr === 'position') {
        const posTrack = getTrack(part.id, 'position', a);
        const refPos = (posTrack && posTrack.keys.length)
          ? sampleTrack(posTrack, App.anim.time)
          : part._baseTransform.position;
        const dx = Math.abs(part.transform.position.x - refPos.x);
        const dy = Math.abs(part.transform.position.y - refPos.y);
        if (dx < 1e-4 && dy < 1e-4 && !(posTrack && posTrack.keys.length)) continue;
      }
      const res = writeKeyOnTrack(part.id, pr, App.anim.time, getPartPropValue(part, pr), null, a);
      if (res.created) createdAny = true;
    }
    App.anim.expanded.add(part.id);
    if (createdAny || !isLiveDrag) renderTimeline();
  }
}

function setPartVisibility(part, vis) {
  if (!part) return;
  part.visible = !!vis;
  updatePartTransform(part);
  renderLayers();
  syncPropertyInputs();
  onPartEdited(part, 'visible', false);
  renderTimeline();
}

function togglePartVisibility(part) {
  if (!part) return;
  setPartVisibility(part, part.visible === false);
}

// -------- Realtime и генерация позы reset --------

function updateRealtimeUI() {
  if (!els.btnRealtime) return;
  els.btnRealtime.classList.toggle('active', App.realtime);
  els.btnRealtime.classList.toggle('realtime-off', !App.realtime);
}

function toggleRealtime() {
  App.realtime = !App.realtime;
  updateRealtimeUI();
  setHint('Realtime: ' + (App.realtime ? 'ВКЛ (правки пишутся в кадр)' : 'ВЫКЛ'), 1600);
}

function buildResetFromCurrentPose() {
  if (!App.settings) return;
  const fps = App.settings.fps || 60;
  const tracks = [];

  for (const p of App.settings.parts) {
    p._baseTransform = clone(p.transform);
    p._baseVisible = (p.visible !== false);
    for (const prop of ANIM_PROPS) {
      tracks.push({
        partId: p.id,
        property: prop,
        keys: [{ time: 0, value: getPartPropValue(p, prop), type: 'key' }]
      });
    }
  }

  const resetObj = {
    name: 'reset',
    duration: 1 / fps,
    loop: false,
    tracks: tracks
  };

  const idx = App.settings.animations.findIndex(a => a.name === 'reset');
  if (idx >= 0) {
    App.settings.animations[idx] = resetObj;
  } else {
    App.settings.animations.unshift(resetObj);
  }

  selectAnimation('reset');
  setHint('Поза «reset» сохранена (' + App.settings.parts.length + ' слоёв)', 2000);
}

function requestCreateResetAnimation() {
  if (!App.settings) {
    setHint('Сначала откройте объект', 2000);
    return;
  }
  if (hasResetAnimation()) {
    confirmDialog(
      'Обновить позу reset?',
      'Анимация «reset» уже существует. Перезаписать базовую позу объекта текущим состоянием сцены?',
      buildResetFromCurrentPose
    );
  } else {
    buildResetFromCurrentPose();
  }
}

function convertAllToKeyframes() {
  const a = getCurrentAnimation();
  if (!a || !a.tracks || !a.tracks.length) {
    setHint('Нет кадров для конвертации', 1800);
    return;
  }
  let tweenCount = 0;
  for (const t of a.tracks) {
    for (const k of (t.keys || [])) {
      if (k.type !== 'key') tweenCount++;
    }
  }
  if (tweenCount === 0) {
    setHint('Все кадры в этой анимации уже ключевые', 1800);
    return;
  }
  confirmDialog(
    'Конвертировать в ключевые?',
    'Перевести все обычные кадры (' + tweenCount + ' шт.) анимации «' + a.name + '» в ключевые (без интерполяции)?',
    () => {
      for (const t of a.tracks) {
        for (const k of (t.keys || [])) k.type = 'key';
      }
      applyAnimationAtTime(App.anim.time);
      renderScene();
      renderOnionSkins();
      renderTimeline();
      Gizmo.render();
      syncPropertyInputs();
      setHint('Конвертировано кадров в ключевые: ' + tweenCount, 1800);
    }
  );
}

// -------- модалка управления анимациями --------

function openAnimsModal() {
  if (!App.settings) { setHint('Сначала откройте объект', 2000); return; }
  if (!App.settings.animations || !App.settings.animations.length) {
    App.settings.animations = [{ name: 'idle', duration: 1, loop: true, tracks: [] }];
  }
  App._animSelectedName = getCurrentAnimation().name;
  renderAnimsList();
  els.modalAnims.hidden = false;
}

function closeAnimsModal() {
  els.modalAnims.hidden = true;
}

function renderAnimsList() {
  els.animsList.innerHTML = '';
  for (const a of (App.settings.animations || [])) {
    const li = document.createElement('li');
    li.textContent = a.name;
    if (a.name === App._animSelectedName) li.classList.add('selected');
    li.onclick = () => {
      App._animSelectedName = a.name;
      renderAnimsList();
    };
    li.ondblclick = () => {
      App._animSelectedName = a.name;
      selectAnimation(a.name);
      closeAnimsModal();
    };
    els.animsList.appendChild(li);
  }
}

function selectAnimation(name) {
  stopPlayback();
  App._animSelectedName = name;
  const a = getCurrentAnimation();
  if (!a) return;
  App.anim.time         = 0;
  App.anim.loopStart    = 0;
  App.anim.loopEnd      = a.duration || 1;
  App.anim.loop         = a.loop !== false;
  App.anim.focus        = null;
  App.anim.selectedKeys = [];
  els.animName.value    = a.name;
  applyAnimationAtTime(0);
  renderScene();
  renderOnionSkins();
  renderLayers();
  renderTimeline();
  Gizmo.render();
  syncPropertyInputs();
}

function createAnimation() {
  promptText('Новая анимация', 'anim', (name) => {
    if (!name) return;
    if (App.settings.animations.some(a => a.name === name)) {
      setHint('Анимация с таким именем уже есть', 2000);
      return;
    }
    App.settings.animations.push({ name, duration: 1, loop: true, tracks: [] });
    App._animSelectedName = name;
    selectAnimation(name);
    renderAnimsList();
  });
}

function deleteAnimation() {
  if (!App._animSelectedName) { setHint('Выберите анимацию', 2000); return; }
  if (App.settings.animations.length <= 1) {
    setHint('Нельзя удалить единственную анимацию', 2000);
    return;
  }
  const targetName = App._animSelectedName;
  confirmDialog(
    'Удалить анимацию?',
    'Удалить анимацию «' + targetName + '» без возможности отмены?',
    () => {
      const i = App.settings.animations.findIndex(a => a.name === targetName);
      if (i < 0) return;
      App.settings.animations.splice(i, 1);
      const next = App.settings.animations[0].name;
      selectAnimation(next);
      renderAnimsList();
    }
  );
}

function renameAnimation() {
  if (!App._animSelectedName) { setHint('Выберите анимацию', 2000); return; }
  const a = App.settings.animations.find(x => x.name === App._animSelectedName);
  if (!a) return;
  promptText('Переименовать анимацию', a.name, (name) => {
    if (!name || name === a.name) return;
    if (App.settings.animations.some(x => x.name === name)) {
      setHint('Анимация с таким именем уже есть', 2000);
      return;
    }
    a.name = name;
    App._animSelectedName = name;
    els.animName.value = name;
    renderAnimsList();
  });
}

// -------- воспроизведение --------

function updatePlaybackUI() {
  els.pbPlay.querySelector('.material-icons').textContent =
    App.anim.playing ? 'pause' : 'play_arrow';
  els.pbLoop.classList.toggle('active', App.anim.loop);
  els.pbOnion.classList.toggle('active', App.anim.onion);
  updateRealtimeUI();
}

function startPlayback() {
  if (App.anim.playing) return;
  const a = getCurrentAnimation();
  if (!a) return;
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
  if (App.anim.onion) renderOnionSkins();
}

function playbackTick(ts) {
  if (!App.anim.playing) return;
  const a = getCurrentAnimation();
  if (!a) { stopPlayback(); return; }
  const dur = a.duration || 1;
  const rawDt = (ts - App.anim.lastTs) / 1000;
  App.anim.lastTs = ts;

  const baseFps = (App.settings && App.settings.fps) || 60;
  const speedRatio = clamp(App.anim.playbackFps, 0, 60) / baseFps;
  let t = App.anim.time + rawDt * speedRatio;

  const lo = clamp(App.anim.loopStart || 0, 0, dur);
  const hi = clamp(Math.max(lo + 0.001, App.anim.loopEnd || dur), lo + 0.001, dur);

  if (App.anim.loop) {
    if (t > hi) t = lo + ((t - lo) % (hi - lo));
    else if (t < lo) t = lo;
  } else if (t >= dur) {
    t = dur;
    App.anim.time = t;
    applyAnimationAtTime(t);
    renderScene();
    renderLayers();
    updatePlayhead();
    updateTimecode();
    Gizmo.render();
    syncPropertyInputs();
    stopPlayback();
    return;
  }

  App.anim.time = t;
  applyAnimationAtTime(t);
  renderScene();
  if (App.anim.onion) renderOnionSkins();
  updatePlayhead();
  updateTimecode();
  Gizmo.render();
  syncPropertyInputs();
  App.anim.raf = requestAnimationFrame(playbackTick);
}

function setTime(t) {
  const a = getCurrentAnimation();
  if (!a) return;
  const dur = a.duration || 1;
  t = clamp(t, 0, dur);
  App.anim.time = t;
  applyAnimationAtTime(t);
  renderScene();
  renderOnionSkins();
  renderLayers();
  updatePlayhead();
  updateTimecode();
  Gizmo.render();
  syncPropertyInputs();
}

function stepFrame(dir) {
  const fps = (App.settings && App.settings.fps) || 60;
  const a = getCurrentAnimation();
  if (!a) return;
  const dt = 1 / fps;
  const t = clamp(snapTime(App.anim.time) + dir * dt, 0, a.duration || 1);
  setTime(t);
}
