'use strict';

// ============================================================
//  main.js — инициализация приложения, привязка кнопок и хоткеев
// ============================================================

function updateModeButtons(mode) {
  $$('.mode-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.mode, 10) === mode);
  });
}

function setupOnionControls() {
  function syncFromInputs() {
    App.anim.onionBefore = clamp(parseInt(els.onionBefore.value, 10) || 0, 0, 3);
    App.anim.onionAfter  = clamp(parseInt(els.onionAfter.value, 10) || 0, 0, 3);
    els.onionBefore.value = String(App.anim.onionBefore);
    els.onionAfter.value  = String(App.anim.onionAfter);
    if ((App.anim.onionBefore > 0 || App.anim.onionAfter > 0) && !App.anim.onion) {
      App.anim.onion = true;
      updatePlaybackUI();
    }
    renderOnionSkins();
  }

  els.onionBefore.value = '0';
  els.onionAfter.value  = '0';
  App.anim.onionBefore  = 0;
  App.anim.onionAfter   = 0;

  els.onionBefore.addEventListener('change', syncFromInputs);
  els.onionAfter.addEventListener('change', syncFromInputs);
  els.onionBefore.addEventListener('input', syncFromInputs);
  els.onionAfter.addEventListener('input', syncFromInputs);

  $$('.onion-spin button[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const dir = parseInt(btn.dataset.dir, 10) || 0;
      const inp = document.getElementById(targetId);
      if (!inp) return;
      const next = clamp((parseInt(inp.value, 10) || 0) + dir, 0, 3);
      inp.value = String(next);
      syncFromInputs();
    });
  });

  els.pbOnion.addEventListener('click', () => {
    App.anim.onion = !App.anim.onion;
    if (App.anim.onion && App.anim.onionBefore === 0 && App.anim.onionAfter === 0) {
      App.anim.onionBefore = 1;
      App.anim.onionAfter  = 1;
      els.onionBefore.value = '1';
      els.onionAfter.value  = '1';
    }
    updatePlaybackUI();
    renderOnionSkins();
    setHint('Луковая кожура: ' + (App.anim.onion ? 'ВКЛ' : 'ВЫКЛ'), 1400);
  });
}

function setupHeaderInlineRename(groupEl, inputEl, btnEl, getCurrentVal, commitFn) {
  if (!groupEl || !inputEl || !btnEl) return;
  const iconEl = btnEl.querySelector('.material-icons');
  const defaultTitle = btnEl.title || 'Переименовать';
  let editing = false;
  let origVal = '';

  function exitEdit(finalValue) {
    if (!editing) return;
    editing = false;
    document.removeEventListener('mousedown', onOutsideMouseDown, true);
    groupEl.classList.remove('editing');
    inputEl.readOnly = true;
    inputEl.tabIndex = -1;
    if (finalValue !== undefined) inputEl.value = finalValue;
    inputEl.blur();
    if (iconEl) iconEl.textContent = 'edit';
    btnEl.title = defaultTitle;
  }

  async function applyEdit() {
    if (!editing) return;
    const raw = inputEl.value;
    const res = await commitFn(origVal, raw);
    if (!res || !res.ok) {
      inputEl.focus();
      inputEl.select();
      return;
    }
    exitEdit(res.name);
  }

  function cancelEdit() {
    exitEdit(origVal);
  }

  function onOutsideMouseDown(e) {
    if (!groupEl.contains(e.target)) {
      cancelEdit();
    }
  }

  function enterEdit() {
    const cur = getCurrentVal();
    if (!cur) {
      setHint('Сначала откройте объект', 1800);
      return;
    }
    origVal = cur;
    editing = true;
    groupEl.classList.add('editing');
    inputEl.readOnly = false;
    inputEl.tabIndex = 0;
    inputEl.value = cur;
    if (iconEl) iconEl.textContent = 'check';
    btnEl.title = 'Применить название (Enter)';
    inputEl.focus();
    inputEl.select();
    setTimeout(() => document.addEventListener('mousedown', onOutsideMouseDown, true), 0);
  }

  btnEl.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (editing) applyEdit();
    else enterEdit();
  });

  inputEl.addEventListener('keydown', (e) => {
    if (!editing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      applyEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEdit();
    }
  });
}

function setupGlobalShortcuts() {
  const vp = els.viewport;

  document.addEventListener('keydown', (e) => {
    const ae = document.activeElement;
    const inField = ae && /input|textarea|select/i.test(ae.tagName) && !ae.readOnly;

    if (e.key === 'Escape') {
      if (App.stage && App.stage.previewFullscreen && typeof exitStageFullscreenPreview === 'function') {
        e.preventDefault();
        exitStageFullscreenPreview();
        return;
      }
      if (els.stageContextMenu && !els.stageContextMenu.hidden) {
        els.stageContextMenu.hidden = true;
        return;
      }
      if (els.gridSettingsPopover && !els.gridSettingsPopover.hidden && typeof closeGridSettingsPopover === 'function') {
        closeGridSettingsPopover();
        return;
      }
      if (els.guidesSettingsPopover && !els.guidesSettingsPopover.hidden && typeof closeGuidesSettingsPopover === 'function') {
        closeGuidesSettingsPopover();
        return;
      }
      if (els.modalUnsaved && !els.modalUnsaved.hidden) {
        els.unsavedStay.click();
        return;
      }
      if (!els.modalObjects.hidden) closeObjectsModal();
      if (!els.modalAnims.hidden) closeAnimsModal();
      if (!els.modalBg.hidden) closeBgModal();
      if (!els.modalSettings.hidden) closeSettingsModal();
      if (els.modalPresets && !els.modalPresets.hidden) closePresetsModal();
      if (els.modalStages && !els.modalStages.hidden && typeof closeStagesModal === 'function') closeStagesModal();
      if (els.modalStagePickObj && !els.modalStagePickObj.hidden && typeof closeStagePickModal === 'function') closeStagePickModal();
      return;
    }

    if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (App.editorMode === 'stage' && typeof saveCurrentStage === 'function') saveCurrentStage();
      else saveObject();
      return;
    }

    if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      fitView();
      return;
    }

    if (inField) return;
    if (!els.modalRename.hidden || !els.modalConfirm.hidden ||
        (els.modalUnsaved && !els.modalUnsaved.hidden)) return;

    if (e.code === 'Space') {
      if (!App.spaceDown) {
        App.spaceDown = true;
        vp.classList.add('space');
      }
      e.preventDefault();
      return;
    }

    if (App.editorMode === 'stage') {
      if (e.key === 'F2' && typeof triggerRenameStageItemById === 'function') {
        if (App.stage.selectedId && App.stage.selectedId !== '__bg__') {
          e.preventDefault();
          triggerRenameStageItemById(App.stage.selectedId);
        }
        return;
      }
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
          typeof getSelectedTransformLeafItems === 'function') {
        const leaves = getSelectedTransformLeafItems();
        if (leaves.length) {
          e.preventDefault();
          const stepPx = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -stepPx : (e.key === 'ArrowRight' ? stepPx : 0);
          const dy = e.key === 'ArrowUp'   ? -stepPx : (e.key === 'ArrowDown'  ? stepPx : 0);
          const m = getStageFrameMetrics();
          for (const it of leaves) {
            const wp = anchorToWorld(it.anchor, m);
            it.anchor = worldToAnchor(wp.x + dx, wp.y + dy, m);
            syncStageItemTransform(it, m);
          }
          markStageDirty();
          updateStageSelSize();
          syncStageInspectorLive();
          StageGizmo.render();
        }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') &&
          typeof deleteSelectedStageItems === 'function') {
        const hasStageSel = Array.from(App.stage.selectedIds).some(id => id !== '__bg__');
        if (hasStageSel) {
          e.preventDefault();
          deleteSelectedStageItems();
        }
      }
      return;
    }

    // Горячая клавиша O — добавить ключевой кадр
    if (e.code === 'KeyO' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      addFrameAtFocus('key');
      return;
    }

    // Delete / Backspace — удалить выделенные на таймлайне кадры
    if ((e.key === 'Delete' || e.key === 'Backspace') && App.anim.selectedKeys.length > 0) {
      e.preventDefault();
      deleteSelectedKeyframes();
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      App.spaceDown = false;
      App.panning = false;
      vp.classList.remove('space');
      vp.classList.remove('panning');
    }
  });
}

function init() {
  cacheEls();
  if (els.appVersion) els.appVersion.textContent = APP_VERSION;

  setupSceneInput();
  setupGlobalShortcuts();
  setupTimelineScroll();
  setupTimelineInput();
  setupBgPicker();
  setupOnionControls();
  setupPresetsControls();
  if (typeof setupStageEditor === 'function') setupStageEditor();

  // Inline-переименование текущего объекта и анимации в верхнем баре
  setupHeaderInlineRename(
    els.objNameGroup,
    els.objName,
    els.btnObjInlineRename,
    () => App.current || '',
    async (oldName, rawNewName) => renameObjectBackend(oldName, rawNewName)
  );
  setupHeaderInlineRename(
    els.animNameGroup,
    els.animName,
    els.btnAnimInlineRename,
    () => {
      const a = getCurrentAnimation();
      return a ? a.name : '';
    },
    async (oldName, rawNewName) => renameSpecificAnimation(oldName, rawNewName)
  );

  // Связываем колбэки для Gizmo
  App.syncProperties = syncPropertyInputs;
  App.onPartChanged = (part, kind, isLive) => {
    updateSelSize();
    onPartEdited(part, kind, isLive);
    if (App.anim.onion && !isLive) renderOnionSkins();
  };
  App.onChange = () => {
    markDirty();
    if (App.anim.onion) renderOnionSkins();
    updateSelSize();
  };

  Gizmo.init(App);
  Gizmo.setOnModeChange(updateModeButtons);
  updateModeButtons(Gizmo.mode);

  updateGridButtonsUI();
  updateSaveButtonUI();
  updateRealtimeUI();
  updateSelSize();
  renderProperties();
  renderTimeline();

  // Верхняя панель и модалка управления объектами
  els.btnObjects.addEventListener('click', openObjectsModal);
  els.modalObjects.addEventListener('click', (e) => {
    if (e.target === els.modalObjects) closeObjectsModal();
  });
  els.modalObjectsClose.addEventListener('click', closeObjectsModal);
  if (els.modalObjectsX) els.modalObjectsX.addEventListener('click', closeObjectsModal);
  if (els.objectsBtnPick) els.objectsBtnPick.addEventListener('click', pickLocalFolder);
  if (els.objectsBtnReconnect) els.objectsBtnReconnect.addEventListener('click', reconnectSavedFolder);
  if (els.objAdd)    els.objAdd.addEventListener('click', createObjectFromModal);
  if (els.objClone)  els.objClone.addEventListener('click', cloneObjectFromModal);
  if (els.objRename) els.objRename.addEventListener('click', renameObjectFromModal);
  if (els.objDelete) els.objDelete.addEventListener('click', deleteObjectFromModal);
  if (els.objOpen)   els.objOpen.addEventListener('click', openSelectedObjectFromModal);

  // Чип статуса хранилища и модалка Настройки
  if (els.btnStorageStatus) {
    els.btnStorageStatus.addEventListener('click', () => {
      if (App.storage.pendingHandle) reconnectSavedFolder();
      else openSettingsModal();
    });
  }
  els.btnSave.addEventListener('click', () => {
    if (App.editorMode === 'stage' && typeof saveCurrentStage === 'function') saveCurrentStage();
    else saveObject();
  });
  els.btnSettings.addEventListener('click', openSettingsModal);

  els.settingsClose.addEventListener('click', closeSettingsModal);
  els.settingsCancel.addEventListener('click', closeSettingsModal);
  els.settingsOk.addEventListener('click', applySettingsModal);
  els.modalSettings.addEventListener('click', (e) => {
    if (e.target === els.modalSettings) closeSettingsModal();
  });
  els.stPickFolder.addEventListener('click', pickLocalFolder);
  els.stReconnectFolder.addEventListener('click', reconnectSavedFolder);
  els.stClearFolder.addEventListener('click', clearSavedFolder);
  els.stDownloadJson.addEventListener('click', downloadCurrentSettingsJson);
  els.stWebkitDirInput.addEventListener('change', () => {
    handleWebkitDirFiles(els.stWebkitDirInput.files);
  });

  // Слои и свойства
  els.btnGroup.addEventListener('click', groupSelected);
  els.btnUngroup.addEventListener('click', ungroupSelected);
  els.btnPropsCollapse.addEventListener('click', togglePropsCollapse);

  // Модалка анимаций (Создать / Клонировать / Переименовать / Удалить)
  els.btnAnim.addEventListener('click', openAnimsModal);
  els.modalAnimsClose.addEventListener('click', closeAnimsModal);
  els.modalAnims.addEventListener('click', (e) => {
    if (e.target === els.modalAnims) closeAnimsModal();
  });
  els.animAdd.addEventListener('click', createAnimation);
  if (els.animClone) els.animClone.addEventListener('click', cloneAnimation);
  els.animRename.addEventListener('click', renameAnimation);
  els.animDelete.addEventListener('click', deleteAnimation);
  els.animOk.addEventListener('click', () => {
    const a = App.settings && App.settings.animations.find(x => x.name === App._animSelectedName);
    if (a) selectAnimation(a.name);
    closeAnimsModal();
  });

  // Ряд инструментов сцены (зум + крест + сетка + привязка к сетке + режимы Gizmo)
  $$('.tools-row [data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act === 'zoom-in')  zoomBy(1.2);
      if (act === 'zoom-out') zoomBy(1 / 1.2);
      if (act === 'zoom-fit') fitView();
    });
  });

  if (els.btnCrosshair) els.btnCrosshair.addEventListener('click', toggleCrosshair);
  if (els.btnGrid)      els.btnGrid.addEventListener('click', toggleSceneGrid);
  if (els.btnSnap)      els.btnSnap.addEventListener('click', toggleGridSnap);

  $$('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => Gizmo.setMode(parseInt(btn.dataset.mode, 10)));
  });

  els.btnRealtime.addEventListener('click', toggleRealtime);
  els.btnResetAnim.addEventListener('click', requestCreateResetAnimation);
  els.btnBg.addEventListener('click', openBgModal);
  els.btnTimelineToggle.addEventListener('click', toggleTimelineCollapse);

  els.fpsSlider.addEventListener('input', () => {
    const v = clamp(parseInt(els.fpsSlider.value, 10) || 0, 0, 60);
    App.anim.playbackFps = v;
    els.fpsValue.textContent = String(v);
  });

  // Ряд управления воспроизведением и ключами
  els.pbFirst.addEventListener('click', () => { stopPlayback(); setTime(0); });
  els.pbLast.addEventListener('click', () => {
    stopPlayback();
    const a = getCurrentAnimation();
    if (a) setTime(a.duration || 1);
  });
  els.pbPrev.addEventListener('click', () => { stopPlayback(); stepFrame(-1); });
  els.pbNext.addEventListener('click', () => { stopPlayback(); stepFrame(+1); });
  els.pbPlay.addEventListener('click', () => {
    App.anim.playing ? stopPlayback() : startPlayback();
  });
  els.pbStop.addEventListener('click', () => { stopPlayback(); setTime(0); });

  els.pbKeyAdd.addEventListener('click', () => addFrameAtFocus('tween'));
  els.btnKeyFrame.addEventListener('click', () => addFrameAtFocus('key'));
  els.btnConvertKeys.addEventListener('click', convertAllToKeyframes);
  els.pbKeyDel.addEventListener('click', deleteSelectedKeyframes);

  els.pbLoop.addEventListener('click', () => {
    App.anim.loop = !App.anim.loop;
    const a = getCurrentAnimation();
    if (a) {
      a.loop = App.anim.loop;
      markDirty();
    }
    updatePlaybackUI();
    renderTimeline();
  });

  els.pbLoopStart.addEventListener('click', () => {
    App.anim.loopStart = snapTime(App.anim.time);
    if (App.anim.loopEnd <= App.anim.loopStart) {
      const a = getCurrentAnimation();
      App.anim.loopEnd = Math.min((a && a.duration) || 1, App.anim.loopStart + 0.05);
    }
    renderTimeline();
  });

  els.pbLoopEnd.addEventListener('click', () => {
    App.anim.loopEnd = snapTime(App.anim.time);
    if (App.anim.loopStart >= App.anim.loopEnd) {
      App.anim.loopStart = Math.max(0, App.anim.loopEnd - 0.05);
    }
    renderTimeline();
  });

  els.pbDuration.addEventListener('change', () => {
    const a = getCurrentAnimation();
    if (!a) return;
    let v = parseFloat(els.pbDuration.value);
    if (!isFinite(v) || v <= 0) v = 1;
    if (a.duration !== v) {
      a.duration = v;
      markDirty();
    }
    App.anim.time = Math.min(App.anim.time, v);
    App.anim.loopEnd = v;
    if (App.anim.loopStart >= v) App.anim.loopStart = 0;
    applyAnimationAtTime(App.anim.time);
    renderScene();
    renderOnionSkins();
    renderTimeline();
  });

  window.addEventListener('beforeunload', (e) => {
    if (App.dirty || (App.stage && App.stage.dirty)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.addEventListener('resize', () => {
    applyCamera();
    if (App.editorMode === 'object') renderTimeline();
  });

  requestAnimationFrame(() => {
    applyCamera();
    renderTimeline();
  });

  initStorage().then(async () => {
    const modeMatch = location.search.match(/[?&]mode=(stage|object)\b/i);
    if (modeMatch && modeMatch[1].toLowerCase() === 'stage' && typeof setEditorMode === 'function') {
      await setEditorMode('stage');
      return;
    }
    const m = location.search.match(/[?&]open=([^&]+)/);
    if (m) {
      openObject(decodeURIComponent(m[1]));
      return;
    }
    // Если включено автооткрытие и есть готовый источник (локальная папка или сервер) — открываем последний объект
    if (App.storage.autoOpenLast && (App.storage.mode === 'local-fs' || App.storage.mode === 'server')) {
      const lastObj = getPref(PREF_LAST_OBJ);
      if (lastObj) {
        try {
          const list = await fetchObjects();
          if (list.includes(lastObj)) openObject(lastObj);
        } catch (_) {}
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
