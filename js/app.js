'use strict';

// ============================================================
//  app.js — глобальное состояние App, кэш DOM, математика матриц и модалки
// ============================================================

const APP_VERSION = 'v0.6.2';
const SVG_NS = 'http://www.w3.org/2000/svg';
const $  = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const TL = {
  CELL_W: 12,     // px на один кадр
  ROW_H: 22,
  SUB_ROW_H: 20,
};

const ANIM_PROPS = ['position', 'rotation', 'scale', 'skew', 'visible'];

const App = {
  version:      APP_VERSION,
  editorMode:   'object', // 'object' | 'stage'
  objectCamera: { x: 0, y: 0, zoom: 1 },
  current:      null,
  settings:     null,
  svgCache:     {},
  selectedId:   null,
  selectedIds:  new Set(),
  camera:       { x: 0, y: 0, zoom: 1 },
  clipOffset:   { x: 0, y: 0 },
  grid: {
    showCrosshair: true,
    showGrid:      true,
    snap:          false,     // по умолчанию выключена
    step:          4,         // мировой размер ячейки сетки (px)
    majorEvery:    5,         // крупная клетка каждые N шагов (0 = выкл)
    originMode:    'center',  // 'center' | 'frame-topleft' (для сборки макета 1366×768)
    color:         '#9fb0c8', // цвет линий сетки
    opacity:       0.14,      // прозрачность мелкой сетки (0.04..0.65)
  },
  dirty:        false,
  _suppressDirty: false,
  spaceDown:    false,
  ctrlDown:     false,
  panning:      false,
  panStart:     null,
  realtime:     true,
  onChange:     null,
  onPartChanged: null,
  syncProperties: null,
  _dragLayerId: null,
  _objSelectedName: null,
  _animSelectedName: null,
  _propsCollapsed: false,
  _timelineCollapsed: false,
  _partDomMap:  {},
  _onionPool:   [],
  _onionPoolDirty: true,
  presets:      [],
  _selectedPresetId: null,
  stage: {
    current:      null,
    data:         null,
    assets:       [],
    selectedId:   '__bg__',
    selectedIds:  new Set(['__bg__']),
    dirty:        false,
    _suppressDirty: false,
    camera:       { x: 0, y: 0, zoom: 0.65 },
    playing:      false,
    previewFullscreen: false,
    showPreviewFps: true,
    savedCameraBeforePreview: null,
    raf:          null,
    lastTs:       0,
    time:         0,
    speed:        1,
    fpsSamples:   [],
    clipFrame:    false,
    showRulers:   true,
    guideSnap:    true,
    activeSnapGuides: [],
    activeGridSnapLines: [],
    activeSnapEdges: null,
    hoveredId:    null,
    hoveredGuideId: null,
    collapsedFolders: new Set(),
    barCollapsed: false,
    bgPropsExpanded: false,
    testWidth:    null,
    testHeight:   null,
    _selectedModalName: null,
    _pickTab:     'object',
    _pickSelected: null,
    _pendingFolderId: null,
    _uploadTarget: null, // 'bg' | 'asset'
    customStages: {},
    deletedStages: new Set(),
    templates:    {},    // { [objName]: { settings, svgs } }
    assetCache:   {},    // { ['stage/file']: { kind, svgText, viewBox, width, height, unitToPx, dataUrl } }
    domItems:     {},    // { [itemId]: runtimeInstance }
    bgDom:        null,
    frameDom:     null,
  },
  isPartVisible(part) {
    if (!part) return false;
    if (part.visible === false) return false;
    if (!this.settings || !this.settings.parts || !part.parent) return true;
    const byId = {};
    for (const p of this.settings.parts) byId[p.id] = p;
    let cur = byId[part.parent];
    let guard = 0;
    while (cur && guard++ < 64) {
      if (cur.visible === false) return false;
      cur = cur.parent ? byId[cur.parent] : null;
    }
    return true;
  },
  getGridOrigin() {
    if (this.editorMode === 'stage' && this.grid.originMode === 'frame-topleft' && this.stage && this.stage.data) {
      const w = Number(this.stage.testWidth || this.stage.data.width) || 1366;
      const h = Number(this.stage.testHeight || this.stage.data.height) || 768;
      return { x: -w / 2, y: -h / 2 };
    }
    return { x: 0, y: 0 };
  },
  snapWorldToGrid(wx, wy) {
    const step = Math.max(1, Number(this.grid.step) || 4);
    const orig = this.getGridOrigin();
    return {
      x: orig.x + Math.round((wx - orig.x) / step) * step,
      y: orig.y + Math.round((wy - orig.y) / step) * step,
    };
  },
  snapClientToGrid(clientX, clientY) {
    if (!this.grid.snap || !els.viewport) return { x: clientX, y: clientY };
    const rect = els.viewport.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const z = this.camera.zoom || 1;
    const wx = (sx - cx) / z + this.camera.x;
    const wy = (sy - cy) / z + this.camera.y;
    const snapped = this.snapWorldToGrid(wx, wy);
    const sxSnap = (snapped.x - this.camera.x) * z + cx;
    const sySnap = (snapped.y - this.camera.y) * z + cy;
    return { x: sxSnap + rect.left, y: sySnap + rect.top };
  },
  anim: {
    time: 0,
    playing: false,
    raf: null,
    lastTs: 0,
    playbackFps: 60,
    loop: true,
    loopStart: 0,
    loopEnd: 1,
    onion: false,
    onionBefore: 1,
    onionAfter: 1,
    focus: null,          // { partId, property }
    selectedKeys: [],     // [{ partId, property, time }]
    expanded: new Set(),
  },
  storage: {
    mode: 'repo',         // 'local-fs' | 'local-files' | 'server' | 'repo'
    serverAvailable: false,
    folderLabel: '',
    rootHandle: null,
    animHandle: null,
    singleObjHandle: null,
    pendingHandle: null,  // сохранённый дескриптор, ожидающий 1 клика на разрешение
    memoryObjects: null,  // фоллбэк для webkitdirectory: { [objName]: { svgs: {file: text}, settings: obj } }
    customObjects: {},    // объекты, созданные/клонированные в браузере в режиме repo
    deletedObjects: new Set(),
    autoOpenLast: true,
  },
};

const els = {};
function cacheEls() {
  // Header
  els.appVersion         = $('#app-version');
  els.btnEditorMode      = $('#btn-editor-mode');
  els.editorModeIcon     = $('#editor-mode-icon');
  els.editorModeLabel    = $('#editor-mode-label');
  els.headerObjectControls = $('#header-object-controls');
  els.headerStageControls  = $('#header-stage-controls');

  els.btnObjects         = $('#btn-objects');
  els.objNameGroup       = $('#obj-name-group');
  els.objName            = $('#obj-name');
  els.btnObjInlineRename = $('#btn-obj-inline-rename');
  els.btnAnim            = $('#btn-anim');
  els.animNameGroup      = $('#anim-name-group');
  els.animName           = $('#anim-name');
  els.btnAnimInlineRename = $('#btn-anim-inline-rename');

  els.btnStages            = $('#btn-stages');
  els.stageNameGroup       = $('#stage-name-group');
  els.stageName            = $('#stage-name');
  els.btnStageInlineRename = $('#btn-stage-inline-rename');
  els.btnStageFit          = $('#btn-stage-bg-quick');
  els.stageResLabel        = $('#stage-res-label');

  els.btnStorageStatus   = $('#btn-storage-status');
  els.storageDot         = $('#storage-dot');
  els.storageLabel       = $('#storage-label');
  els.btnSave            = $('#btn-save');
  els.btnSettings        = $('#btn-settings');

  // Viewport & SVG
  els.viewport          = $('#viewport');
  els.svg               = $('#scene-svg');
  els.stageDefs         = $('#stage-defs');
  els.world             = $('#world');
  els.grid              = $('#grid');
  els.stageRoot         = $('#stage-root');
  els.onion             = $('#onion');
  els.scene             = $('#scene');
  els.stageGuidesSvg    = $('#stage-guides-svg');
  els.gizmoSvg          = $('#gizmo-svg');
  els.stageGizmoSvg     = $('#stage-gizmo-svg');
  els.stageRulerCorner  = $('#stage-ruler-corner');
  els.stageRulerH       = $('#stage-ruler-h');
  els.stageRulerHCanvas = $('#stage-ruler-h-canvas');
  els.stageRulerHairX   = $('#stage-ruler-hair-x');
  els.stageRulerV       = $('#stage-ruler-v');
  els.stageRulerVCanvas = $('#stage-ruler-v-canvas');
  els.stageRulerHairY   = $('#stage-ruler-hair-y');
  els.stagePreviewFpsHud = $('#stage-preview-fps-hud');

  // Tools row
  els.zoomLabel         = $('#zoom-label');
  els.btnCrosshair      = $('#btn-crosshair');
  els.btnGrid           = $('#btn-grid');
  els.btnSnap           = $('#btn-snap');
  els.btnGridSettings   = $('#btn-grid-settings');
  els.btnRealtime       = $('#btn-realtime');
  els.btnResetAnim      = $('#btn-reset-anim');
  els.btnPresets        = $('#btn-presets');
  els.btnStageRulers    = $('#btn-stage-rulers');
  els.btnStageGuideSnap = $('#btn-stage-guide-snap');
  els.btnStageGuidesMenu = $('#btn-stage-guides-menu');
  els.btnStageAddObj    = $('#btn-stage-add-obj');
  els.btnStageClip      = $('#btn-stage-clip');
  els.btnStagePlayTop   = $('#btn-stage-play-top');
  els.stageHintDrag     = $('#stage-ctrl-hint');
  els.stageFpsBadge     = $('#stage-fps-badge');
  els.btnBg             = $('#btn-bg');
  els.fpsSlider         = $('#fps-slider');
  els.fpsValue          = $('#fps-value');
  els.selSize           = $('#sel-size');
  els.btnTimelineToggle = $('#btn-timeline-toggle');
  els.timelineToggleIcon = $('#timeline-toggle-icon');
  els.btnStageBarToggle = $('#btn-stage-bar-toggle');
  els.stageBarToggleIcon = $('#stage-bar-toggle-icon');

  // Playback row
  els.playbackBar       = $('#playback-bar');
  els.pbFirst           = $('#pb-first');
  els.pbPrev            = $('#pb-prev');
  els.pbPlay            = $('#pb-play');
  els.pbStop            = $('#pb-stop');
  els.pbNext            = $('#pb-next');
  els.pbLast            = $('#pb-last');
  els.pbLoopStart       = $('#pb-loop-set-start');
  els.pbLoopEnd         = $('#pb-loop-set-end');
  els.tcLoopStart       = $('#tc-loop-start');
  els.tcCurrent         = $('#tc-current');
  els.tcLoopEnd         = $('#tc-loop-end');
  els.pbKeyAdd          = $('#pb-key-add');
  els.btnKeyFrame       = $('#btn-key-frame');
  els.btnConvertKeys    = $('#btn-convert-keys');
  els.pbKeyDel          = $('#pb-key-del');
  els.pbLoop            = $('#pb-loop');
  els.pbOnion           = $('#pb-onion');
  els.onionBefore       = $('#onion-before');
  els.onionAfter        = $('#onion-after');
  els.pbDuration        = $('#pb-duration');

  // Stage preview & rubber screen bar
  els.stageBar          = $('#stage-bar');
  els.stagePlay         = $('#stage-play-btn');
  els.stagePlayIcon     = $('#stage-play-icon');
  els.stagePlayLabel    = $('#stage-play-label');
  els.stagePreviewFpsFlag = $('#stage-preview-fps-flag');
  els.stageSpeed        = $('#stage-speed-slider');
  els.stageSpeedValue   = $('#stage-speed-value');
  els.stageRubberW      = $('#stage-rubber-w');
  els.stageRubberH      = $('#stage-rubber-h');
  els.stageRubberReset  = $('#stage-rubber-reset');
  els.stageRubberReadout = $('#stage-rubber-readout');
  els.gridSettingsPopover   = $('#grid-settings-popover');
  els.guidesSettingsPopover = $('#guides-settings-popover');
  els.stageContextMenu      = $('#stage-context-menu');

  // Timeline
  els.timeline          = $('#timeline');
  els.tlRuler           = $('#tl-ruler');
  els.tlRulerPlayhead   = $('#tl-ruler-playhead');
  els.tlNamesInner      = $('#tl-names-inner');
  els.tlTracks          = $('#tl-tracks');
  els.tlTracksInner     = $('#tl-tracks-inner');
  els.tlPlayheadLine    = $('#tl-playhead-line');

  // Right panel (Layers & Properties)
  els.layersHeaderTitle    = $('#layers-panel-title');
  els.layersActionsObject  = $('#layers-actions-object');
  els.layersActionsStage   = $('#layers-actions-stage');
  els.btnGroup          = $('#btn-group');
  els.btnUngroup        = $('#btn-ungroup');
  els.btnStageAddLayer  = $('#btn-stage-layer-add');
  els.btnStageAddFolder = $('#btn-stage-folder-add');
  els.btnStageUngroup   = $('#btn-stage-folder-ungroup');
  els.btnStageCloneLayer = $('#btn-stage-layer-clone');
  els.btnStageDelLayer  = $('#btn-stage-layer-del');
  els.layersList        = $('#layers-list');
  els.stageLayersList   = $('#stage-layers-list');
  els.stageFileInput    = $('#stage-file-input');
  els.propsTitle        = $('#props-title');
  els.btnPropsCollapse  = $('#btn-props-collapse');
  els.propsCollapseIcon = $('#props-collapse-icon');
  els.props             = $('#props');

  // Modals
  els.modalStages        = $('#modal-stages');
  els.modalStagesX       = $('#modal-stages-x');
  els.stagesSourceText   = $('#stages-source-text');
  els.stagesBtnReconnect = $('#stages-btn-reconnect');
  els.stagesBtnPick      = $('#stages-btn-pick');
  els.stagesList         = $('#stages-list');
  els.stageAdd           = $('#stage-add');
  els.stageClone         = $('#stage-clone');
  els.stageRename        = $('#stage-rename');
  els.stageDelete        = $('#stage-delete');
  els.stageOpen          = $('#stage-open');
  els.modalStagesClose   = $('#modal-stages-close');

  els.modalStagePickObj  = $('#modal-stage-pick-obj');
  els.stagePickCloseX    = $('#stage-pick-close-x');
  els.stagePickTabObj    = $('#stage-pick-tab-obj');
  els.stagePickTabAsset  = $('#stage-pick-tab-asset');
  els.stagePickList      = $('#stage-pick-list');
  els.stagePickUpload    = $('#stage-pick-upload-btn');
  els.stagePickCancel    = $('#stage-pick-cancel');
  els.stagePickAdd       = $('#stage-pick-ok');
  els.modalObjects       = $('#modal-objects');
  els.modalObjectsX      = $('#modal-objects-x');
  els.objectsSourceBar   = $('#objects-source-bar');
  els.objectsSourceText  = $('#objects-source-text');
  els.objectsBtnReconnect = $('#objects-btn-reconnect');
  els.objectsBtnPick     = $('#objects-btn-pick');
  els.objectsList        = $('#objects-list');
  els.objAdd             = $('#obj-add');
  els.objClone           = $('#obj-clone');
  els.objRename          = $('#obj-rename');
  els.objDelete          = $('#obj-delete');
  els.objOpen            = $('#obj-open');
  els.modalObjectsClose  = $('#modal-objects-close');

  els.modalSettings      = $('#modal-settings');
  els.settingsClose      = $('#settings-close');
  els.stStatusDot        = $('#st-status-dot');
  els.stSourceDesc       = $('#st-source-desc');
  els.stFolderCookie     = $('#st-folder-cookie');
  els.stPickFolder       = $('#st-pick-folder');
  els.stReconnectFolder  = $('#st-reconnect-folder');
  els.stClearFolder      = $('#st-clear-folder');
  els.stAutoOpen         = $('#st-auto-open');
  els.stWebkitDirInput   = $('#st-webkitdir-input');
  els.stObjectSection    = $('#st-object-section');
  els.stFps              = $('#st-fps');
  els.stFrameW           = $('#st-frame-w');
  els.stFrameH           = $('#st-frame-h');
  els.stDownloadJson     = $('#st-download-json');
  els.settingsCancel     = $('#settings-cancel');
  els.settingsOk         = $('#settings-ok');

  els.modalRename       = $('#modal-rename');
  els.renameTitle       = $('#rename-title');
  els.renameInput       = $('#rename-input');
  els.renameOk          = $('#rename-ok');
  els.renameCancel      = $('#rename-cancel');

  els.modalAnims        = $('#modal-anims');
  els.animsList         = $('#anims-list');
  els.modalAnimsClose   = $('#modal-anims-close');
  els.animAdd           = $('#anim-add');
  els.animClone         = $('#anim-clone');
  els.animRename        = $('#anim-rename');
  els.animDelete        = $('#anim-delete');
  els.animOk            = $('#anim-ok');

  els.modalBg           = $('#modal-bg');
  els.bgPresets         = $('#bg-presets');
  els.bgPicker          = $('#bg-picker');
  els.bgSv              = $('#bg-sv');
  els.bgCursor          = $('#bg-cursor');
  els.bgHue             = $('#bg-picker') ? $('#bg-picker').querySelector('.bg-hue') : null;
  els.bgHueCursor       = $('#bg-hue-cursor');
  els.bgHex             = $('#bg-hex');
  els.bgCopy            = $('#bg-copy');
  els.bgPaste           = $('#bg-paste');
  els.bgOk              = $('#bg-ok');
  els.bgCancel          = $('#bg-cancel');
  els.bgClose           = $('#bg-close');

  els.modalConfirm      = $('#modal-confirm');
  els.confirmTitle      = $('#confirm-title');
  els.confirmText       = $('#confirm-text');
  els.confirmOk         = $('#confirm-ok');
  els.confirmCancel     = $('#confirm-cancel');

  els.modalPresets        = $('#modal-presets');
  els.presetsClose        = $('#presets-close');
  els.presetsCancel       = $('#presets-cancel');
  els.presetNameInput     = $('#preset-name-input');
  els.presetScopeAll      = $('#preset-scope-all');
  els.presetScopeSel      = $('#preset-scope-sel');
  els.presetScopeSelLabel = $('#preset-scope-sel-label');
  els.presetSaveBtn       = $('#preset-save-btn');
  els.presetsList         = $('#presets-list');
  els.presetOptRelative   = $('#preset-opt-relative');
  els.presetOptPos        = $('#preset-opt-pos');
  els.presetOptVis        = $('#preset-opt-vis');
  els.presetApplyBtn      = $('#preset-apply-btn');
  els.presetUpdateBtn     = $('#preset-update-btn');
  els.presetRenameBtn     = $('#preset-rename-btn');
  els.presetDeleteBtn     = $('#preset-delete-btn');
  els.presetExportBtn     = $('#preset-export-btn');
  els.presetImportBtn     = $('#preset-import-btn');
  els.presetImportInput   = $('#preset-import-input');

  els.modalUnsaved        = $('#modal-unsaved');
  els.unsavedText         = $('#unsaved-text');
  els.unsavedDiscard      = $('#unsaved-discard');
  els.unsavedStay         = $('#unsaved-stay');
  els.unsavedSave         = $('#unsaved-save');

  els.hint              = $('#hint');
  if (els.appVersion) els.appVersion.textContent = APP_VERSION;
}
App.els = els;

// -------- подсказки (toast) --------

let hintTimer = null;
function setHint(text, ms) {
  if (!els.hint) return;
  els.hint.textContent = text || '';
  els.hint.classList.toggle('visible', !!text);
  if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
  if (text && ms) hintTimer = setTimeout(() => setHint(''), ms);
}

// -------- общие утилиты --------

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
  return String(min).padStart(2, '0') + ':' +
         String(sec).padStart(2, '0') + ':' +
         String(ms).padStart(3, '0');
}

// -------- работа с cookie и localStorage --------

function setPref(name, value, days) {
  const maxAge = (days || 365) * 86400;
  const str = String(value == null ? '' : value);
  try {
    document.cookie = encodeURIComponent(name) + '=' + encodeURIComponent(str) +
                      '; max-age=' + maxAge + '; path=/; SameSite=Lax';
  } catch (_) {}
  try { localStorage.setItem(name, str); } catch (_) {}
}

function getPref(name) {
  try {
    const target = encodeURIComponent(name) + '=';
    const parts = (document.cookie || '').split(';');
    for (let p of parts) {
      p = p.trim();
      if (p.indexOf(target) === 0) {
        return decodeURIComponent(p.slice(target.length));
      }
    }
  } catch (_) {}
  try {
    const v = localStorage.getItem(name);
    if (v !== null) return v;
  } catch (_) {}
  return '';
}

function delPref(name) {
  try {
    document.cookie = encodeURIComponent(name) + '=; max-age=0; path=/; SameSite=Lax';
  } catch (_) {}
  try { localStorage.removeItem(name); } catch (_) {}
}

// -------- матрицы трансформаций --------

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
    return {
      position: { x: e, y: f },
      rotation: 0,
      scale: { x: 0, y: Math.sqrt(c * c + d * d) },
      skew: { x: 0, y: 0 }
    };
  }
  const sx = Math.sqrt(a2);
  const theta = Math.atan2(b, a);
  const sinT = Math.sin(theta), cosT = Math.cos(theta);
  const sy = cosT * d - sinT * c;
  const tK = (sinT * d + cosT * c) / sx;
  const kx = Math.atan(tK) * 180 / Math.PI;
  return {
    position: { x: e, y: f },
    rotation: theta * 180 / Math.PI,
    scale: { x: sx, y: sy },
    skew: { x: kx, y: 0 }
  };
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
  const pts = [
    { x: 0, y: 0 },
    { x: size.w, y: 0 },
    { x: size.w, y: size.h },
    { x: 0, y: size.h }
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    const q = new DOMPoint(p.x, p.y).matrixTransform(m);
    if (q.x < minX) minX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.x > maxX) maxX = q.x;
    if (q.y > maxY) maxY = q.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// -------- диалоговые модалки (ввод текста / подтверждение) --------

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
  function onOk() {
    const v = els.renameInput.value.trim();
    cleanup();
    if (v) cb(v);
  }
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

function confirmDialog(title, text, onConfirm) {
  els.confirmTitle.textContent = title || 'Подтверждение';
  els.confirmText.textContent = text || '';
  els.modalConfirm.hidden = false;
  setTimeout(() => els.confirmOk.focus(), 0);

  function cleanup() {
    els.modalConfirm.hidden = true;
    els.confirmOk.removeEventListener('click', onOk);
    els.confirmCancel.removeEventListener('click', onCancel);
    document.removeEventListener('keydown', onKey);
    els.modalConfirm.removeEventListener('mousedown', onBg);
  }
  function onOk() { cleanup(); if (onConfirm) onConfirm(); }
  function onCancel() { cleanup(); }
  function onKey(e) {
    if (els.modalConfirm.hidden) return;
    if (e.key === 'Enter')  { e.preventDefault(); onOk(); }
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  }
  function onBg(e) { if (e.target === els.modalConfirm) onCancel(); }

  els.confirmOk.addEventListener('click', onOk);
  els.confirmCancel.addEventListener('click', onCancel);
  document.addEventListener('keydown', onKey);
  els.modalConfirm.addEventListener('mousedown', onBg);
}

// -------- отслеживание несохранённых изменений и авто-именование --------

function updateSaveButtonUI() {
  if (!els.btnSave) return;
  const isDirty = App.editorMode === 'stage' ? !!App.stage.dirty : !!App.dirty;
  els.btnSave.classList.toggle('dirty', isDirty);
  if (App.editorMode === 'stage') {
    els.btnSave.title = isDirty
      ? 'Есть несохранённые изменения сцены! Сохранить сцену (Ctrl+S)'
      : 'Сохранить сцену (Ctrl+S)';
  } else {
    els.btnSave.title = isDirty
      ? 'Есть несохранённые изменения! Сохранить объект (Ctrl+S)'
      : 'Сохранить объект (Ctrl+S)';
  }
}

function markDirty() {
  if (!App.settings || App._suppressDirty) return;
  if (!App.dirty) {
    App.dirty = true;
    updateSaveButtonUI();
  }
}

function clearDirty() {
  App.dirty = false;
  updateSaveButtonUI();
}

function markStageDirty() {
  if (!App.stage.data || App.stage._suppressDirty) return;
  if (!App.stage.dirty) {
    App.stage.dirty = true;
    updateSaveButtonUI();
  }
}

function clearStageDirty() {
  App.stage.dirty = false;
  updateSaveButtonUI();
}

function guardStageUnsavedChanges(proceedFn) {
  if (!App.stage.dirty || !App.stage.current || !els.modalUnsaved) {
    proceedFn();
    return;
  }
  els.unsavedText.textContent =
    'В сцене «' + App.stage.current + '» есть несохранённые изменения. ' +
    'Сохранить их перед переключением?';
  els.modalUnsaved.hidden = false;
  setTimeout(() => { if (els.unsavedSave) els.unsavedSave.focus(); }, 0);

  function cleanup() {
    els.modalUnsaved.hidden = true;
    els.unsavedSave.removeEventListener('click', onSave);
    els.unsavedStay.removeEventListener('click', onStay);
    els.unsavedDiscard.removeEventListener('click', onDiscard);
    document.removeEventListener('keydown', onKey);
    els.modalUnsaved.removeEventListener('mousedown', onBg);
  }
  async function onSave() {
    cleanup();
    if (typeof saveCurrentStage === 'function') {
      const ok = await saveCurrentStage();
      if (ok && !App.stage.dirty) proceedFn();
    }
  }
  function onStay() {
    cleanup();
    if (els.modalStages && !els.modalStages.hidden && typeof closeStagesModal === 'function') {
      closeStagesModal();
    }
  }
  function onDiscard() {
    cleanup();
    clearStageDirty();
    proceedFn();
  }
  function onKey(e) {
    if (els.modalUnsaved.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); onStay(); }
  }
  function onBg(e) { if (e.target === els.modalUnsaved) onStay(); }

  els.unsavedSave.addEventListener('click', onSave);
  els.unsavedStay.addEventListener('click', onStay);
  els.unsavedDiscard.addEventListener('click', onDiscard);
  document.addEventListener('keydown', onKey);
  els.modalUnsaved.addEventListener('mousedown', onBg);
}

function guardUnsavedChanges(proceedFn) {
  if (!App.dirty || !App.current || !els.modalUnsaved) {
    proceedFn();
    return;
  }
  els.unsavedText.textContent =
    'В объекте «' + App.current + '» есть несохранённые изменения. ' +
    'Сохранить их перед переключением на другой объект?';
  els.modalUnsaved.hidden = false;
  setTimeout(() => { if (els.unsavedSave) els.unsavedSave.focus(); }, 0);

  function cleanup() {
    els.modalUnsaved.hidden = true;
    els.unsavedSave.removeEventListener('click', onSave);
    els.unsavedStay.removeEventListener('click', onStay);
    els.unsavedDiscard.removeEventListener('click', onDiscard);
    document.removeEventListener('keydown', onKey);
    els.modalUnsaved.removeEventListener('mousedown', onBg);
  }
  async function onSave() {
    cleanup();
    if (typeof saveObject === 'function') {
      const ok = await saveObject();
      if (ok && !App.dirty) proceedFn();
    }
  }
  function onStay() {
    cleanup();
    if (els.modalObjects && !els.modalObjects.hidden && typeof closeObjectsModal === 'function') {
      closeObjectsModal();
    }
  }
  function onDiscard() {
    cleanup();
    clearDirty();
    proceedFn();
  }
  function onKey(e) {
    if (els.modalUnsaved.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); onStay(); }
  }
  function onBg(e) { if (e.target === els.modalUnsaved) onStay(); }

  els.unsavedSave.addEventListener('click', onSave);
  els.unsavedStay.addEventListener('click', onStay);
  els.unsavedDiscard.addEventListener('click', onDiscard);
  document.addEventListener('keydown', onKey);
  els.modalUnsaved.addEventListener('mousedown', onBg);
}

function sanitizeEntityName(raw) {
  const s = String(raw || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, '');
  if (!s || s === '.' || s === '..') return '';
  return s;
}

function resolveAutoName(existingNames, prefix) {
  const used = new Set(existingNames || []);
  let idx = 0;
  while (used.has(prefix + idx)) idx++;
  return prefix + idx;
}

function resolveCloneName(existingNames, sourceName) {
  const used = new Set(existingNames || []);
  const stem = String(sourceName || 'item').replace(/_clone_\d+$/, '');
  let idx = 0;
  while (used.has(stem + '_clone_' + idx)) idx++;
  return stem + '_clone_' + idx;
}

