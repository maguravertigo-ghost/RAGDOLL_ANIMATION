'use strict';

// ============================================================
//  timeline.js — рендер таймлайна, ключи key/tween, перетаскивание
//                кадров, рамка выделения и диапазон цикла
// ============================================================

function totalFrames() {
  const a = getCurrentAnimation();
  if (!a) return 1;
  const fps = (App.settings && App.settings.fps) || 60;
  return Math.max(1, Math.round((a.duration || 1) * fps));
}

function totalWidth() {
  return (totalFrames() + 1) * TL.CELL_W;
}

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

function isKeySelected(partId, property, time) {
  return App.anim.selectedKeys.some(
    k => k.partId === partId && k.property === property && Math.abs(k.time - time) < 1e-6
  );
}

// -------- рендер таймлайна --------

function renderTimeline() {
  const a = getCurrentAnimation();
  if (!a || !App.settings) {
    els.tlRuler.innerHTML = '';
    els.tlRuler.appendChild(els.tlRulerPlayhead);
    els.tlNamesInner.innerHTML = '';
    els.tlTracksInner.innerHTML = '';
    els.tlTracksInner.appendChild(els.tlPlayheadLine);
    return;
  }

  const frames = totalFrames();
  const w = totalWidth();
  const dur = a.duration || 1;
  const lo = clamp(App.anim.loopStart || 0, 0, dur);
  const hi = clamp(Math.max(lo, App.anim.loopEnd || dur), lo, dur);

  // --- линейка кадров ---
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

  // Маркеры начала и конца цикла на линейке
  if (App.anim.loop || lo > 1e-6 || hi < dur - 1e-6) {
    const mStart = document.createElement('div');
    mStart.className = 'tl-ruler-loop';
    mStart.style.left = timeToX(lo) + 'px';
    els.tlRuler.appendChild(mStart);

    const mEnd = document.createElement('div');
    mEnd.className = 'tl-ruler-loop';
    mEnd.style.left = timeToX(hi) + 'px';
    els.tlRuler.appendChild(mEnd);
  }

  els.tlRuler.appendChild(els.tlRulerPlayhead);

  // --- список слоёв и дорожек ---
  const { childrenOf, roots } = buildChildrenIndex();
  const PROPS = [
    { key: 'position', label: 'position' },
    { key: 'rotation', label: 'rotation' },
    { key: 'scale',    label: 'scale'    },
    { key: 'skew',     label: 'skew'     },
    { key: 'visible',  label: 'visible'  },
  ];

  els.tlNamesInner.innerHTML = '';
  els.tlTracksInner.innerHTML = '';

  // Подсветка диапазона цикла в области дорожек
  if (App.anim.loop && hi > lo + 1e-6) {
    const rangeDiv = document.createElement('div');
    rangeDiv.className = 'tl-loop-range';
    const x0 = timeToX(lo);
    const x1 = timeToX(hi);
    rangeDiv.style.left = x0 + 'px';
    rangeDiv.style.width = Math.max(1, x1 - x0) + 'px';
    els.tlTracksInner.appendChild(rangeDiv);
  }

  els.tlTracksInner.appendChild(els.tlPlayheadLine);

  function addRow(part, depth, isSub, property) {
    const expanded = !isSub && App.anim.expanded.has(part.id);

    // Левая колонка (имя слоя или свойства)
    const nameDiv = document.createElement('div');
    nameDiv.className = 'tl-row-name' + (isSub ? ' sub' : '');

    if (!isSub) {
      nameDiv.style.paddingLeft = (6 + Math.min(depth, 5) * 8) + 'px';
      const visOff = (part.visible === false);
      nameDiv.innerHTML =
        '<button class="tl-row-expand" type="button" tabindex="-1">' +
          '<span class="material-icons">' + (expanded ? 'expand_more' : 'chevron_right') + '</span>' +
        '</button>' +
        '<span class="tl-row-label"></span>' +
        '<button class="tl-row-vis' + (visOff ? ' hidden-off' : '') + '" type="button" tabindex="-1" title="Видимость">' +
          '<span class="material-icons">' + (visOff ? 'visibility_off' : 'visibility') + '</span>' +
        '</button>';
      nameDiv.querySelector('.tl-row-label').textContent = part.id;
    } else {
      nameDiv.style.paddingLeft = (26 + Math.min(depth, 5) * 8) + 'px';
      nameDiv.textContent = property;
    }

    if (isSub && App.anim.focus &&
        App.anim.focus.partId === part.id &&
        App.anim.focus.property === property) {
      nameDiv.classList.add('focused');
    }
    if (!isSub && App.selectedIds.has(part.id)) {
      nameDiv.classList.add('focused');
    }

    nameDiv.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!isSub && e.target.closest('.tl-row-expand')) {
        if (App.anim.expanded.has(part.id)) App.anim.expanded.delete(part.id);
        else App.anim.expanded.add(part.id);
        renderTimeline();
        return;
      }
      if (!isSub && e.target.closest('.tl-row-vis')) {
        togglePartVisibility(part);
        return;
      }
      if (isSub) {
        App.anim.focus = { partId: part.id, property };
        if (App.selectedId !== part.id) {
          App.selectedIds = new Set([part.id]);
          App.selectedId = part.id;
          renderLayers();
          renderProperties();
          updateSelSize();
          Gizmo.render();
        }
        renderTimeline();
      } else {
        setSelection([part.id], part.id);
      }
    });
    els.tlNamesInner.appendChild(nameDiv);

    // Правая колонка (дорожка кадров)
    const trackDiv = document.createElement('div');
    trackDiv.className = 'tl-row-track' + (isSub ? ' sub' : '');
    trackDiv.dataset.partId = part.id;
    if (isSub) trackDiv.dataset.prop = property;

    if (isSub && App.anim.focus &&
        App.anim.focus.partId === part.id &&
        App.anim.focus.property === property) {
      trackDiv.classList.add('focused');
    }
    trackDiv.style.width = w + 'px';

    if (isSub) {
      const track = getTrack(part.id, property);
      if (track && track.keys) {
        for (const k of track.keys) {
          const x = timeToX(k.time);
          const d = document.createElement('div');
          const isKeyType = (k.type === 'key' || property === 'visible');
          d.className = 'tl-key' + (isKeyType ? ' type-key' : '');
          if (isKeySelected(part.id, property, k.time)) {
            d.classList.add('selected');
          }
          d.style.left = x + 'px';
          d.dataset.partId = part.id;
          d.dataset.prop = property;
          d.dataset.time = String(k.time);

          d.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
            els.tlTracks.focus();
            beginKeyDrag(e, part.id, property, k);
          });

          d.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const i = track.keys.findIndex(xx => Math.abs(xx.time - k.time) < 1e-6);
            if (i >= 0) track.keys.splice(i, 1);
            App.anim.selectedKeys = App.anim.selectedKeys.filter(
              sk => !(sk.partId === part.id && sk.property === property && Math.abs(sk.time - k.time) < 1e-6)
            );
            applyAnimationAtTime(App.anim.time);
            renderScene();
            renderOnionSkins();
            renderLayers();
            renderTimeline();
            Gizmo.render();
            syncPropertyInputs();
          });

          trackDiv.appendChild(d);
        }
      }
    }
    els.tlTracksInner.appendChild(trackDiv);
  }

  function walk(part, depth) {
    addRow(part, depth, false, null);
    if (App.anim.expanded.has(part.id)) {
      for (const pr of PROPS) addRow(part, depth, true, pr.key);
    }
    for (const c of (childrenOf[part.id] || [])) walk(c, depth + 1);
  }
  for (const r of roots) walk(r, 0);

  updatePlayhead();
  updateTimecode();
  updatePlaybackUI();
  updateDurationField();
  handleTimelineScroll();
}

// -------- синхронизация прокрутки и ползунка --------

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
  const a = getCurrentAnimation();
  if (!a) return;
  if (document.activeElement === els.pbDuration) return;
  els.pbDuration.value = (a.duration || 1).toFixed(2);
}

function toggleTimelineCollapse() {
  App._timelineCollapsed = !App._timelineCollapsed;
  els.timeline.classList.toggle('collapsed', App._timelineCollapsed);
  els.timelineToggleIcon.textContent = App._timelineCollapsed ? 'expand_less' : 'expand_more';
  requestAnimationFrame(() => {
    applyCamera();
    Gizmo.render();
  });
}

// -------- добавление и удаление кадров --------

function addFrameAtFocus(preferredType) {
  if (!App.settings) { setHint('Сначала откройте объект', 2000); return; }
  const a = getCurrentAnimation();
  if (!a) return;

  // Если зажат режим ключевого кадра и выделено несколько ключей рамкой — переводим их в key
  if (preferredType === 'key' && App.anim.selectedKeys.length > 1) {
    let converted = 0;
    for (const sk of App.anim.selectedKeys) {
      const tr = getTrack(sk.partId, sk.property, a);
      if (!tr) continue;
      const kObj = tr.keys.find(k => Math.abs(k.time - sk.time) < 1e-6);
      if (kObj && kObj.type !== 'key') { kObj.type = 'key'; converted++; }
    }
    if (converted > 0) {
      applyAnimationAtTime(App.anim.time);
      renderScene();
      renderOnionSkins();
      renderTimeline();
      setHint('Ключевыми стали кадры: ' + converted, 1400);
      return;
    }
  }

  const time = snapTime(App.anim.time);

  // 1) Есть конкретная выделенная под-дорожка свойства
  if (App.anim.focus) {
    const { partId, property } = App.anim.focus;
    const part = App.settings.parts.find(p => p.id === partId);
    if (!part) return;
    const val = getPartPropValue(part, property);
    writeKeyOnTrack(partId, property, time, val, preferredType || 'tween', a);
    App.anim.selectedKeys = [{ partId, property, time }];
    renderTimeline();
    setHint(
      (preferredType === 'key' ? 'Ключевой кадр: ' : 'Кадр: ') +
      property + ' @ ' + fmtTime(time),
      1300
    );
    return;
  }

  // 2) Под-дорожка не выбрана, но выбран слой — ставим кадр по его трансформациям
  if (App.selectedId) {
    const part = App.settings.parts.find(p => p.id === App.selectedId);
    if (!part) return;
    const propsToKey = ['position', 'rotation', 'scale', 'skew'];
    const newSel = [];
    for (const pr of propsToKey) {
      writeKeyOnTrack(part.id, pr, time, getPartPropValue(part, pr), preferredType || 'tween', a);
      newSel.push({ partId: part.id, property: pr, time });
    }
    App.anim.expanded.add(part.id);
    App.anim.selectedKeys = newSel;
    renderTimeline();
    setHint(
      (preferredType === 'key' ? 'Ключевые кадры слоя «' : 'Кадры слоя «') +
      part.id + '» @ ' + fmtTime(time),
      1400
    );
    return;
  }

  setHint('Выберите дорожку или слой', 2000);
}

function deleteSelectedKeyframes() {
  const a = getCurrentAnimation();
  if (!a || !App.anim.selectedKeys.length) {
    setHint('Выберите кадр на таймлайне', 2000);
    return;
  }
  let removed = 0;
  for (const sk of App.anim.selectedKeys) {
    const tr = getTrack(sk.partId, sk.property, a);
    if (!tr || !tr.keys) continue;
    const i = tr.keys.findIndex(k => Math.abs(k.time - sk.time) < 1e-6);
    if (i >= 0) {
      tr.keys.splice(i, 1);
      removed++;
    }
  }
  App.anim.selectedKeys = [];
  applyAnimationAtTime(App.anim.time);
  renderScene();
  renderOnionSkins();
  renderLayers();
  renderTimeline();
  Gizmo.render();
  syncPropertyInputs();
  if (removed) setHint('Удалено кадров: ' + removed, 1200);
}

// -------- перетаскивание ключей и выделение рамкой --------

let tlKeyDrag = null;

function beginKeyDrag(e, partId, property, keyObj) {
  const a = getCurrentAnimation();
  if (!a) return;
  const additive = e.ctrlKey || e.metaKey || e.shiftKey;
  const already = isKeySelected(partId, property, keyObj.time);

  if (additive) {
    if (already) {
      App.anim.selectedKeys = App.anim.selectedKeys.filter(
        k => !(k.partId === partId && k.property === property && Math.abs(k.time - keyObj.time) < 1e-6)
      );
      renderTimeline();
      return;
    } else {
      App.anim.selectedKeys.push({ partId, property, time: keyObj.time });
    }
  } else if (!already) {
    App.anim.selectedKeys = [{ partId, property, time: keyObj.time }];
  }

  App.anim.focus = { partId, property };
  setTime(keyObj.time);
  renderTimeline();

  // Собираем ссылки на реальные объекты ключей для перетаскивания
  const items = [];
  for (const sk of App.anim.selectedKeys) {
    const tr = getTrack(sk.partId, sk.property, a);
    if (!tr) continue;
    const ko = tr.keys.find(x => Math.abs(x.time - sk.time) < 1e-6);
    const domEl = els.tlTracksInner.querySelector(
      '.tl-key[data-part-id="' + CSS.escape(sk.partId) + '"][data-prop="' + sk.property + '"]'
    );
    if (ko) {
      items.push({
        partId: sk.partId,
        property: sk.property,
        track: tr,
        keyObj: ko,
        origTime: ko.time
      });
    }
  }

  tlKeyDrag = {
    startX: e.clientX,
    moved: false,
    anchorOrigTime: keyObj.time,
    dur: a.duration || 1,
    items: items
  };
}

function updateKeyDrag(e) {
  if (!tlKeyDrag) return;
  const dx = e.clientX - tlKeyDrag.startX;
  if (!tlKeyDrag.moved && Math.abs(dx) < 3) return;
  tlKeyDrag.moved = true;

  const rawDt = xToTime(dx);
  const dt = snapTime(rawDt);

  for (const it of tlKeyDrag.items) {
    it.keyObj.time = clamp(snapTime(it.origTime + dt), 0, tlKeyDrag.dur);
  }

  const newAnchorTime = clamp(snapTime(tlKeyDrag.anchorOrigTime + dt), 0, tlKeyDrag.dur);
  App.anim.selectedKeys = tlKeyDrag.items.map(it => ({
    partId: it.partId,
    property: it.property,
    time: it.keyObj.time
  }));

  // Сортируем во время драга для корректной интерполяции
  const touchedTracks = new Set(tlKeyDrag.items.map(it => it.track));
  for (const tr of touchedTracks) {
    tr.keys.sort((k1, k2) => k1.time - k2.time);
  }

  setTime(newAnchorTime);
  renderTimeline();
}

function finishKeyDrag() {
  if (!tlKeyDrag) return;
  if (tlKeyDrag.moved) {
    const movedSet = new Set(tlKeyDrag.items.map(it => it.keyObj));
    const touchedTracks = new Set(tlKeyDrag.items.map(it => it.track));
    for (const tr of touchedTracks) {
      tr.keys.sort((k1, k2) => k1.time - k2.time);
      // Если ключ перетащили поверх другого — оставляем перетащенный
      const dedup = [];
      for (const k of tr.keys) {
        const prev = dedup.length ? dedup[dedup.length - 1] : null;
        if (prev && Math.abs(prev.time - k.time) < 1e-6) {
          if (movedSet.has(k) && !movedSet.has(prev)) {
            dedup[dedup.length - 1] = k;
          }
        } else {
          dedup.push(k);
        }
      }
      tr.keys = dedup;
    }
    applyAnimationAtTime(App.anim.time);
    renderScene();
    renderOnionSkins();
    renderTimeline();
    Gizmo.render();
    syncPropertyInputs();
  }
  tlKeyDrag = null;
}

// -------- ввод линейки и области дорожек --------

function setupTimelineScroll() {
  els.tlTracks.addEventListener('scroll', handleTimelineScroll, { passive: true });
}

function setupTimelineInput() {
  let rulerScrubbing = false;
  let boxSelect = null;

  function scrubTo(clientX) {
    const a = getCurrentAnimation();
    if (!a) return;
    const rect = els.tlTracks.getBoundingClientRect();
    const x = clientX - rect.left + els.tlTracks.scrollLeft;
    const t = xToTime(x);
    setTime(snapTime(clamp(t, 0, a.duration || 1)));
  }

  els.tlRuler.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    stopPlayback();
    rulerScrubbing = true;
    scrubTo(e.clientX);
  });

  // Выделение рамкой или клик в поле дорожек
  els.tlTracks.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.tl-key')) return;

    els.tlTracks.focus();
    const subRow = e.target.closest('.tl-row-track.sub');
    if (subRow && subRow.dataset.partId && subRow.dataset.prop) {
      App.anim.focus = { partId: subRow.dataset.partId, property: subRow.dataset.prop };
    }

    const rect = els.tlTracks.getBoundingClientRect();
    const startX = e.clientX - rect.left + els.tlTracks.scrollLeft;
    const startY = e.clientY - rect.top  + els.tlTracks.scrollTop;

    boxSelect = {
      clientStartX: e.clientX,
      clientStartY: e.clientY,
      startX,
      startY,
      additive: e.ctrlKey || e.metaKey || e.shiftKey,
      active: false,
      rectEl: null
    };
  });

  window.addEventListener('mousemove', (e) => {
    if (rulerScrubbing) {
      scrubTo(e.clientX);
      return;
    }
    if (tlKeyDrag) {
      updateKeyDrag(e);
      return;
    }
    if (boxSelect) {
      const dx = e.clientX - boxSelect.clientStartX;
      const dy = e.clientY - boxSelect.clientStartY;
      if (!boxSelect.active && (dx * dx + dy * dy) > 16) {
        boxSelect.active = true;
        const rEl = document.createElement('div');
        rEl.className = 'tl-select-rect';
        els.tlTracksInner.appendChild(rEl);
        boxSelect.rectEl = rEl;
      }
      if (boxSelect.active && boxSelect.rectEl) {
        const rect = els.tlTracks.getBoundingClientRect();
        const curX = e.clientX - rect.left + els.tlTracks.scrollLeft;
        const curY = e.clientY - rect.top  + els.tlTracks.scrollTop;
        const x1 = Math.min(boxSelect.startX, curX);
        const y1 = Math.min(boxSelect.startY, curY);
        const x2 = Math.max(boxSelect.startX, curX);
        const y2 = Math.max(boxSelect.startY, curY);
        boxSelect.rectEl.style.left   = x1 + 'px';
        boxSelect.rectEl.style.top    = y1 + 'px';
        boxSelect.rectEl.style.width  = (x2 - x1) + 'px';
        boxSelect.rectEl.style.height = (y2 - y1) + 'px';

        // Проверяем пересечение со всеми .tl-key в системе координат экрана
        const selRect = boxSelect.rectEl.getBoundingClientRect();
        const picked = boxSelect.additive ? [...App.anim.selectedKeys] : [];
        els.tlTracksInner.querySelectorAll('.tl-key').forEach(kEl => {
          const kr = kEl.getBoundingClientRect();
          const hit = !(kr.right < selRect.left || kr.left > selRect.right ||
                        kr.bottom < selRect.top || kr.top > selRect.bottom);
          const pid = kEl.dataset.partId;
          const prp = kEl.dataset.prop;
          const tm  = parseFloat(kEl.dataset.time);
          if (hit) {
            if (!picked.some(x => x.partId === pid && x.property === prp && Math.abs(x.time - tm) < 1e-6)) {
              picked.push({ partId: pid, property: prp, time: tm });
            }
          }
          kEl.classList.toggle(
            'selected',
            picked.some(x => x.partId === pid && x.property === prp && Math.abs(x.time - tm) < 1e-6)
          );
        });
        boxSelect.picked = picked;
      }
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (rulerScrubbing) {
      rulerScrubbing = false;
    }
    if (tlKeyDrag) {
      finishKeyDrag();
    }
    if (boxSelect) {
      if (boxSelect.active) {
        if (boxSelect.rectEl && boxSelect.rectEl.parentNode) {
          boxSelect.rectEl.parentNode.removeChild(boxSelect.rectEl);
        }
        App.anim.selectedKeys = boxSelect.picked || [];
        renderTimeline();
      } else {
        // Обычный клик без перетаскивания — перемещаем ползунок в этот кадр
        if (!boxSelect.additive) App.anim.selectedKeys = [];
        stopPlayback();
        scrubTo(e.clientX);
        renderTimeline();
      }
      boxSelect = null;
    }
  });

  els.tlTracks.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft')  { e.preventDefault(); stopPlayback(); stepFrame(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stopPlayback(); stepFrame(+1); }
    else if (e.key === 'Home')  { e.preventDefault(); stopPlayback(); setTime(0); }
    else if (e.key === 'End')   {
      e.preventDefault();
      stopPlayback();
      const a = getCurrentAnimation();
      if (a) setTime(a.duration || 1);
    }
  });
}
