'use strict';

// ============================================================
//  api.js — работа с источниками данных:
//           1) Локальная папка на диске (File System Access API + cookie + IndexedDB)
//           2) Локальный сервер Node.js (/api/...)
//           3) Репозиторий GitHub Pages (anim/index.json)
// ============================================================

const IDB_NAME  = 'RagdollAnimEditorDB';
const IDB_STORE = 'handles';
const IDB_KEY   = 'workspace_dir';

const PREF_SOURCE     = 'ragdoll_source';
const PREF_FOLDER     = 'ragdoll_folder_name';
const PREF_LAST_OBJ   = 'ragdoll_last_object';
const PREF_AUTO_OPEN  = 'ragdoll_auto_open';

// -------- IndexedDB для хранения FileSystemDirectoryHandle --------

function openHandlesDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB недоступна'));
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbSaveHandle(handle) {
  try {
    const db = await openHandlesDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn('Не удалось сохранить дескриптор папки в IndexedDB:', e);
  }
}

async function idbLoadHandle() {
  try {
    const db = await openHandlesDb();
    const res = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const r = tx.objectStore(IDB_STORE).get(IDB_KEY);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror   = () => reject(r.error);
    });
    db.close();
    return res;
  } catch (e) {
    return null;
  }
}

async function idbClearHandle() {
  try {
    const db = await openHandlesDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
    db.close();
  } catch (_) {}
}

// -------- базовый settings.json для новых SVG-объектов --------

function buildDefaultSettingsClient(name, svgs) {
  const parts = svgs.map(file => {
    const id = file.replace(/\.svg$/i, '');
    return {
      id: id,
      file: file,
      parent: null,
      pivot: { x: 0.5, y: 0.5 },
      transform: {
        position: { x: 0, y: 0 },
        rotation: 0,
        scale: { x: 1, y: 1 },
        skew: { x: 0, y: 0 }
      },
      visible: true,
      opacity: 1
    };
  });
  return {
    version: 1,
    name: name,
    fps: 60,
    frame: { width: 512, height: 512, background: 'grid' },
    clip: { pivot: { x: 0.5, y: 0.5 } },
    parts: parts,
    animations: [
      { name: 'idle', duration: 1.0, loop: true, tracks: [] }
    ]
  };
}

let _svgDefUid = 0;

function sanitizeSvgRoot(root) {
  // 1) Удаляем служебные узлы Inkscape/Sodipodi (namedview, metadata, path-effect)
  const metaToRemove = [];
  const walkAll = root.getElementsByTagName('*');
  for (let i = 0; i < walkAll.length; i++) {
    const el = walkAll[i];
    const ln = (el.localName || el.tagName || '').toLowerCase();
    if (ln === 'namedview' || ln === 'metadata' || ln === 'path-effect' || ln === 'guide') {
      metaToRemove.push(el);
    }
  }
  for (const el of metaToRemove) {
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  // 2) Удаляем скрытые слои из общего файла Inkscape (display:none вне <defs>)
  function pruneHidden(parent, insideDefs) {
    let child = parent.firstElementChild;
    while (child) {
      const next = child.nextElementSibling;
      const ln = (child.localName || child.tagName || '').toLowerCase();
      const nowDefs = insideDefs || ln === 'defs';
      if (!nowDefs) {
        const dispAttr = child.getAttribute('display');
        const styleAttr = child.getAttribute('style') || '';
        if (
          dispAttr === 'none' ||
          /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i.test(styleAttr)
        ) {
          parent.removeChild(child);
          child = next;
          continue;
        }
      }
      pruneHidden(child, nowDefs);
      child = next;
    }
  }
  pruneHidden(root, false);
}

function uniquifySvgDefs(svgNode) {
  const defsList = svgNode.getElementsByTagName('defs');
  if (!defsList.length) return svgNode;

  const idMap = {};
  let count = 0;
  const pfx = 'sd' + (++_svgDefUid) + '_';

  for (let d = 0; d < defsList.length; d++) {
    const elsWithId = defsList[d].querySelectorAll('[id]');
    for (let i = 0; i < elsWithId.length; i++) {
      const oldId = elsWithId[i].getAttribute('id');
      if (oldId) {
        const newId = pfx + oldId;
        idMap[oldId] = newId;
        elsWithId[i].setAttribute('id', newId);
        count++;
      }
    }
  }
  if (!count) return svgNode;

  // Переписываем ссылки #oldId и url(#oldId) внутри этого SVG
  const all = svgNode.getElementsByTagName('*');
  const refAttrs = ['href', 'xlink:href', 'fill', 'stroke', 'filter', 'clip-path', 'mask', 'style'];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    for (const attr of refAttrs) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      if (val.charAt(0) === '#') {
        const key = val.slice(1);
        if (idMap[key]) el.setAttribute(attr, '#' + idMap[key]);
      } else if (val.indexOf('url(#') >= 0) {
        const replaced = val.replace(/url\(#([^)]+)\)/g, (m, key) =>
          idMap[key] ? 'url(#' + idMap[key] + ')' : m
        );
        if (replaced !== val) el.setAttribute(attr, replaced);
      }
    }
  }
  return svgNode;
}

function cloneSvgForDom(cachedSvgEl) {
  const cloned = document.importNode(cachedSvgEl, true);
  return uniquifySvgDefs(cloned);
}

function parseSvgDocument(text, file) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('SVG parse error: ' + file);
  const root = doc.documentElement;
  sanitizeSvgRoot(root);
  const vb = root.getAttribute('viewBox');
  if (vb) {
    const m = vb.trim().split(/[\s,]+/).map(parseFloat);
    if (m.length === 4 && m[2] > 0 && m[3] > 0) {
      root.setAttribute('width', m[2]);
      root.setAttribute('height', m[3]);
    }
  } else {
    const w = parseFloat(root.getAttribute('width'));
    const h = parseFloat(root.getAttribute('height'));
    if (!isFinite(w) || w <= 0) root.setAttribute('width', 100);
    if (!isFinite(h) || h <= 0) root.setAttribute('height', 100);
  }
  return root;
}

// -------- определение структуры выбранной локальной папки --------

async function resolveAnimDirectory(pickedHandle) {
  // 1) Проверяем, есть ли внутри подпапка anim/ (пользователь выбрал корень RAGDOLL_ANIMATION)
  try {
    const subAnim = await pickedHandle.getDirectoryHandle('anim');
    if (subAnim) {
      return {
        rootHandle: pickedHandle,
        animHandle: subAnim,
        singleObjHandle: null,
        label: pickedHandle.name + '/anim'
      };
    }
  } catch (_) {}

  // 2) Проверяем содержимое выбранной папки
  let hasSubDirs = false;
  let hasDirectSvgs = false;
  for await (const [entryName, entry] of pickedHandle.entries()) {
    if (entry.kind === 'directory' && !entryName.startsWith('.')) hasSubDirs = true;
    if (entry.kind === 'file' && entryName.toLowerCase().endsWith('.svg')) hasDirectSvgs = true;
  }

  // Пользователь выбрал папку конкретного объекта (например, anim/fairy)
  if (!hasSubDirs && hasDirectSvgs) {
    return {
      rootHandle: null,
      animHandle: null,
      singleObjHandle: pickedHandle,
      label: pickedHandle.name
    };
  }

  // Пользователь выбрал саму папку anim/ со списком объектов
  return {
    rootHandle: null,
    animHandle: pickedHandle,
    singleObjHandle: null,
    label: pickedHandle.name
  };
}

async function activateDirectoryHandle(handle, saveToPrefs) {
  const resolved = await resolveAnimDirectory(handle);
  App.storage.mode            = 'local-fs';
  App.storage.rootHandle      = resolved.rootHandle;
  App.storage.animHandle      = resolved.animHandle;
  App.storage.singleObjHandle = resolved.singleObjHandle;
  App.storage.pendingHandle   = null;
  App.storage.memoryObjects   = null;
  App.storage.folderLabel     = resolved.label;

  if (saveToPrefs) {
    setPref(PREF_SOURCE, 'local');
    setPref(PREF_FOLDER, resolved.label);
    await idbSaveHandle(handle);
  }

  updateStorageUI();
  refreshSettingsModalUI();
  if (typeof loadPresetsFromStorage === 'function') {
    loadPresetsFromStorage();
  }
}

async function pickLocalFolder() {
  // Современный браузер (Chrome / Edge / Opera / Яндекс / Brave на HTTPS или localhost)
  if (typeof window.showDirectoryPicker === 'function') {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await activateDirectoryHandle(handle, true);
      setHint('Подключена локальная папка: ' + App.storage.folderLabel, 2400);
      if (!els.modalObjects.hidden) await populateObjectsModalList();
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') return false;
      setHint('Ошибка выбора папки: ' + e.message, 3500);
      return false;
    }
  }

  // Фоллбэк для браузеров без showDirectoryPicker (например Firefox)
  if (els.stWebkitDirInput) {
    els.stWebkitDirInput.value = '';
    els.stWebkitDirInput.click();
    return true;
  }

  setHint('Ваш браузер не поддерживает выбор локальной папки', 3500);
  return false;
}

async function handleWebkitDirFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  // Группируем файлы по папкам объектов
  const mem = {};
  let rootName = '';
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    const segs = rel.split('/').filter(Boolean);
    if (!rootName && segs.length) rootName = segs[0];

    let objName = null;
    let fileName = segs[segs.length - 1];
    const animIdx = segs.indexOf('anim');
    if (animIdx >= 0 && segs.length >= animIdx + 3) {
      objName = segs[animIdx + 1];
    } else if (segs.length === 3) {
      objName = segs[1];
    } else if (segs.length === 2) {
      objName = segs[0];
    }
    if (!objName || objName.startsWith('.')) continue;

    if (!mem[objName]) mem[objName] = { svgs: {}, settings: null };
    if (fileName.toLowerCase().endsWith('.svg')) {
      mem[objName].svgs[fileName] = await f.text();
    } else if (fileName === 'settings.json') {
      try { mem[objName].settings = JSON.parse(await f.text()); } catch (_) {}
    }
  }

  const names = Object.keys(mem);
  if (!names.length) {
    setHint('В выбранной папке не найдено SVG-объектов', 3000);
    return;
  }

  App.storage.mode            = 'local-files';
  App.storage.memoryObjects   = mem;
  App.storage.folderLabel     = rootName || 'локальные файлы';
  App.storage.pendingHandle   = null;
  setPref(PREF_FOLDER, App.storage.folderLabel);
  updateStorageUI();
  refreshSettingsModalUI();
  if (!els.modalObjects.hidden) await populateObjectsModalList();
  setHint('Загружено объектов из папки: ' + names.length, 2400);
}

async function reconnectSavedFolder() {
  const h = App.storage.pendingHandle;
  if (!h) {
    return pickLocalFolder();
  }
  try {
    let perm = 'denied';
    if (typeof h.requestPermission === 'function') {
      perm = await h.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        perm = await h.requestPermission({ mode: 'read' });
      }
    }
    if (perm === 'granted') {
      await activateDirectoryHandle(h, true);
      setHint('Доступ к папке «' + App.storage.folderLabel + '» восстановлен', 2200);
      if (!els.modalObjects.hidden) await populateObjectsModalList();
      const lastObj = getPref(PREF_LAST_OBJ);
      if (!App.current && App.storage.autoOpenLast && lastObj) {
        openObject(lastObj);
      }
      return true;
    } else {
      setHint('Доступ к папке не предоставлен', 2500);
      return false;
    }
  } catch (e) {
    setHint('Не удалось подключить папку: ' + e.message, 3000);
    return false;
  }
}

async function clearSavedFolder() {
  await idbClearHandle();
  delPref(PREF_SOURCE);
  delPref(PREF_FOLDER);
  App.storage.rootHandle      = null;
  App.storage.animHandle      = null;
  App.storage.singleObjHandle = null;
  App.storage.pendingHandle   = null;
  App.storage.memoryObjects   = null;
  App.storage.folderLabel     = '';
  App.storage.mode            = App.storage.serverAvailable ? 'server' : 'repo';
  updateStorageUI();
  refreshSettingsModalUI();
  if (!els.modalObjects.hidden) await populateObjectsModalList();
  setHint('Привязка локальной папки сброшена', 2000);
}

// -------- инициализация хранилища при старте --------

async function probeLocalServer() {
  // На GitHub Pages серверного API нет — не делаем лишний 404-запрос
  if (/\.github\.io$/i.test(location.hostname)) return false;
  try {
    const r = await fetch('/api/objects', { method: 'GET' });
    if (!r.ok) return false;
    const ct = r.headers.get('content-type') || '';
    if (ct.indexOf('application/json') < 0) return false;
    const arr = await r.json();
    return Array.isArray(arr);
  } catch (_) {
    return false;
  }
}

async function initStorage() {
  const autoPref = getPref(PREF_AUTO_OPEN);
  App.storage.autoOpenLast = (autoPref === '' || autoPref === '1');
  const savedLabel = getPref(PREF_FOLDER);
  const savedSource = getPref(PREF_SOURCE);

  App.storage.serverAvailable = await probeLocalServer();

  // Проверяем сохранённый дескриптор локальной папки в IndexedDB
  const savedHandle = await idbLoadHandle();
  if (savedHandle && (savedSource === 'local' || !App.storage.serverAvailable)) {
    try {
      let perm = 'prompt';
      if (typeof savedHandle.queryPermission === 'function') {
        perm = await savedHandle.queryPermission({ mode: 'readwrite' });
      }
      if (perm === 'granted') {
        await activateDirectoryHandle(savedHandle, false);
        return;
      } else {
        App.storage.pendingHandle = savedHandle;
        App.storage.folderLabel = savedLabel || savedHandle.name || 'anim';
      }
    } catch (_) {}
  } else if (savedLabel) {
    App.storage.folderLabel = savedLabel;
  }

  App.storage.mode = App.storage.serverAvailable ? 'server' : 'repo';
  updateStorageUI();
  refreshSettingsModalUI();
  if (typeof loadPresetsFromStorage === 'function') {
    loadPresetsFromStorage();
  }
}

// -------- обновление индикаторов в шапке и модалках --------

function updateStorageUI() {
  if (!els.storageDot || !els.storageLabel) return;
  const st = App.storage;
  els.storageDot.className = 'storage-dot';

  if (st.mode === 'local-fs') {
    els.storageDot.classList.add('ok');
    els.storageLabel.textContent = 'Локально: ' + (st.folderLabel || 'папка');
    els.btnStorageStatus.title = 'Подключена локальная папка «' + st.folderLabel + '» (чтение и запись на диск). Нажмите для настроек.';
  } else if (st.mode === 'local-files') {
    els.storageDot.classList.add('ok');
    els.storageLabel.textContent = 'Папка (импорт): ' + st.folderLabel;
    els.btnStorageStatus.title = 'Файлы загружены в память браузера. Сохранение — через скачивание JSON.';
  } else if (st.pendingHandle) {
    els.storageDot.classList.add('warn');
    els.storageLabel.textContent = 'Подключить: ' + st.folderLabel;
    els.btnStorageStatus.title = 'Нажмите, чтобы в 1 клик разрешить доступ к сохранённой локальной папке «' + st.folderLabel + '»';
  } else if (st.mode === 'server') {
    els.storageDot.classList.add('server');
    els.storageLabel.textContent = 'Локальный сервер';
    els.btnStorageStatus.title = 'Работа через локальный server.js (чтение и сохранение на диск)';
  } else {
    els.storageLabel.textContent = 'GitHub (выберите папку)';
    els.btnStorageStatus.title = 'Режим просмотра из репозитория. Нажмите, чтобы подключить локальную папку на ПК.';
  }
}

// -------- операции чтения списка объектов, JSON и SVG --------

async function getLocalObjectDirHandle(name, createIfMissing) {
  const st = App.storage;
  if (st.singleObjHandle && st.singleObjHandle.name === name) {
    return st.singleObjHandle;
  }
  if (st.animHandle) {
    return st.animHandle.getDirectoryHandle(name, { create: !!createIfMissing });
  }
  throw new Error('Локальная папка не подключена');
}

async function fetchObjects() {
  const st = App.storage;

  // 1) Локальная папка через File System Access API
  if (st.mode === 'local-fs') {
    if (st.singleObjHandle) return [st.singleObjHandle.name];
    const items = [];
    for await (const [entryName, entry] of st.animHandle.entries()) {
      if (entry.kind === 'directory' && !entryName.startsWith('.')) {
        items.push(entryName);
      }
    }
    items.sort((a, b) => a.localeCompare(b));
    return items;
  }

  // 2) Локальные файлы через webkitdirectory
  if (st.mode === 'local-files' && st.memoryObjects) {
    return Object.keys(st.memoryObjects).sort((a, b) => a.localeCompare(b));
  }

  // 3) Локальный сервер Node.js
  if (st.mode === 'server') {
    const r = await fetch('/api/objects');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // 4) Статический манифест репозитория (GitHub Pages)
  const r = await fetch('anim/index.json');
  if (!r.ok) throw new Error('Не найден anim/index.json (выберите локальную папку в Настройках)');
  const j = await r.json();
  return Object.keys((j && j.objects) || {}).sort((a, b) => a.localeCompare(b));
}

async function fetchObjectData(name) {
  const st = App.storage;

  // 1) Локальная папка (чтение/создание settings.json прямо на диске)
  if (st.mode === 'local-fs') {
    const dir = await getLocalObjectDirHandle(name, false);
    const svgs = [];
    for await (const [fName, entry] of dir.entries()) {
      if (entry.kind === 'file' && fName.toLowerCase().endsWith('.svg')) {
        svgs.push(fName);
      }
    }
    svgs.sort((a, b) => a.localeCompare(b));

    let settings = null;
    try {
      const fh = await dir.getFileHandle('settings.json');
      const file = await fh.getFile();
      settings = JSON.parse(await file.text());
    } catch (_) {
      settings = null;
    }

    if (!settings) {
      settings = buildDefaultSettingsClient(name, svgs);
      try {
        const fh = await dir.getFileHandle('settings.json', { create: true });
        const wr = await fh.createWritable();
        await wr.write(JSON.stringify(settings, null, 2));
        await wr.close();
      } catch (e) {
        console.warn('Не удалось записать стартовый settings.json:', e);
      }
    }
    return { name, svgs, settings };
  }

  // 2) Память (webkitdirectory)
  if (st.mode === 'local-files' && st.memoryObjects && st.memoryObjects[name]) {
    const entry = st.memoryObjects[name];
    const svgs = Object.keys(entry.svgs).sort((a, b) => a.localeCompare(b));
    if (!entry.settings) entry.settings = buildDefaultSettingsClient(name, svgs);
    return { name, svgs, settings: clone(entry.settings) };
  }

  // 3) Локальный сервер Node.js
  if (st.mode === 'server') {
    const r = await fetch('/api/object/' + encodeURIComponent(name));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // 4) Статический репозиторий GitHub Pages
  const idxRes = await fetch('anim/index.json');
  const idxJson = idxRes.ok ? await idxRes.json() : { objects: {} };
  const svgs = (idxJson.objects && idxJson.objects[name]) || [];

  let settings = null;
  try {
    const sr = await fetch('anim/' + encodeURIComponent(name) + '/settings.json');
    if (sr.ok) settings = await sr.json();
  } catch (_) {}

  if (!settings) settings = buildDefaultSettingsClient(name, svgs);
  return { name, svgs, settings };
}

async function fetchSvg(name, file) {
  const st = App.storage;

  if (st.mode === 'local-fs') {
    const dir = await getLocalObjectDirHandle(name, false);
    const fh = await dir.getFileHandle(file);
    const f = await fh.getFile();
    return parseSvgDocument(await f.text(), file);
  }

  if (st.mode === 'local-files' && st.memoryObjects && st.memoryObjects[name]) {
    const txt = st.memoryObjects[name].svgs[file];
    if (!txt) throw new Error('SVG не найден в памяти: ' + file);
    return parseSvgDocument(txt, file);
  }

  const url = 'anim/' + encodeURIComponent(name) + '/' + encodeURIComponent(file);
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + file);
  return parseSvgDocument(await r.text(), file);
}

// -------- открытие и сохранение объекта --------

async function openObject(name) {
  try {
    setHint('Загрузка ' + name + '…');
    stopPlayback();
    const data = await fetchObjectData(name);
    App.current     = name;
    App.settings    = data.settings;
    App.svgCache    = {};
    App.selectedId  = null;
    App.selectedIds = new Set();
    Gizmo.setMode(1);

    setPref(PREF_LAST_OBJ, name);

    if (!App.settings.fps || App.settings.fps <= 0) App.settings.fps = 60;
    if (!App.settings.animations || !App.settings.animations.length) {
      App.settings.animations = [{ name: 'idle', duration: 1, loop: true, tracks: [] }];
    }
    if (!App.settings.frame) {
      App.settings.frame = { width: 512, height: 512, background: 'grid' };
    }
    if (!App.settings.clip) {
      App.settings.clip = { pivot: { x: 0.5, y: 0.5 } };
    }

    for (const p of App.settings.parts) {
      if (p.visible === undefined) p.visible = true;
      if (p.opacity === undefined) p.opacity = 1;
      p._baseTransform = clone(p.transform);
      p._baseVisible   = p.visible !== false;
    }

    for (const p of App.settings.parts) {
      if (p.isGroup || !p.file) continue;
      try {
        App.svgCache[p.file] = await fetchSvg(name, p.file);
      } catch (e) {
        console.warn('Не загрузился', p.file, e);
      }
    }

    els.objName.value = name;
    App._animSelectedName = App.settings.animations[0].name;
    els.animName.value = App._animSelectedName;

    const a = getCurrentAnimation();
    App.anim.time         = 0;
    App.anim.loopStart    = 0;
    App.anim.loopEnd      = a.duration || 1;
    App.anim.loop         = a.loop !== false;
    App.anim.focus        = null;
    App.anim.selectedKeys = [];
    App.anim.expanded     = new Set();

    renderScene();
    computeClipOffset();
    applyAnimationAtTime(0);
    syncSceneTransforms();
    renderOnionSkins();
    renderLayers();
    renderProperties();
    updateSelSize();
    renderTimeline();
    updatePlaybackUI();
    applyBackgroundToViewport();
    fitView();
    Gizmo.render();
    setHint('Объект "' + name + '": частей ' + App.settings.parts.length, 2500);
  } catch (e) {
    setHint('Ошибка: ' + e.message, 4000);
  }
}

function buildSerializedSettings() {
  if (!App.current || !App.settings) return null;
  const out = clone(App.settings);
  if (!out.clip) out.clip = { pivot: { x: 0.5, y: 0.5 } };
  out.clip.offset = clone(App.clipOffset);

  for (const p of out.parts) {
    if (p._baseTransform) {
      p.transform = p._baseTransform;
      delete p._baseTransform;
    }
    if (p._baseVisible !== undefined) {
      p.visible = !!p._baseVisible;
      delete p._baseVisible;
    }
  }
  return out;
}

function downloadJsonBlob(filename, jsonText) {
  const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadCurrentSettingsJson() {
  const out = buildSerializedSettings();
  if (!out) {
    setHint('Сначала откройте объект', 2000);
    return;
  }
  const text = JSON.stringify(out, null, 2);
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const fh = await window.showSaveFilePicker({
        suggestedName: 'settings.json',
        types: [{ description: 'JSON файл настроек', accept: { 'application/json': ['.json'] } }]
      });
      const wr = await fh.createWritable();
      await wr.write(text);
      await wr.close();
      setHint('Файл settings.json сохранён', 2000);
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  downloadJsonBlob('settings.json', text);
  setHint('Скачан файл settings.json', 2000);
}

async function saveObject() {
  const out = buildSerializedSettings();
  if (!out) {
    setHint('Нечего сохранять', 2000);
    return;
  }
  const jsonText = JSON.stringify(out, null, 2);
  const st = App.storage;

  try {
    // Если есть ожидающая разрешения сохранённая папка — запрашиваем доступ и пишем в неё
    if (st.mode !== 'local-fs' && st.pendingHandle) {
      const ok = await reconnectSavedFolder();
      if (!ok) return;
    }

    // 1) Прямая запись в локальную папку на диске (File System Access API)
    if (App.storage.mode === 'local-fs') {
      const dir = await getLocalObjectDirHandle(App.current, true);
      if (typeof dir.queryPermission === 'function') {
        const perm = await dir.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted' && typeof dir.requestPermission === 'function') {
          const req = await dir.requestPermission({ mode: 'readwrite' });
          if (req !== 'granted') throw new Error('Нет прав на запись в выбранную папку');
        }
      }
      const fh = await dir.getFileHandle('settings.json', { create: true });
      const wr = await fh.createWritable();
      await wr.write(jsonText);
      await wr.close();
      setHint('Сохранено на диск: ' + App.storage.folderLabel + '/' + App.current + '/settings.json', 2200);
      return;
    }

    // 2) Сохранение через локальный сервер Node.js
    if (App.storage.mode === 'server') {
      const r = await fetch('/api/object/' + encodeURIComponent(App.current) + '/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonText
      });
      if (!r.ok) {
        let msg = 'HTTP ' + r.status;
        try {
          const j = await r.json();
          if (j && j.error) msg = j.error;
        } catch (_) {}
        throw new Error(msg);
      }
      setHint('Сохранено: anim/' + App.current + '/settings.json', 1800);
      return;
    }

    // 3) Открыто из GitHub Pages без привязанной локальной папки (или в Firefox)
    if (App.storage.mode === 'local-files' && App.storage.memoryObjects && App.storage.memoryObjects[App.current]) {
      App.storage.memoryObjects[App.current].settings = clone(out);
    }

    if (typeof window.showDirectoryPicker === 'function') {
      confirmDialog(
        'Подключить локальную папку для сохранения?',
        'Сейчас объект открыт из GitHub (режим чтения). Выберите локальную папку проекта на ПК, чтобы редактор сразу сохранил «' +
          App.current + '/settings.json» на диск и запомнил расположение.',
        async () => {
          const picked = await pickLocalFolder();
          if (picked && App.storage.mode === 'local-fs') {
            await saveObject();
          } else {
            await downloadCurrentSettingsJson();
          }
        }
      );
      return;
    }

    await downloadCurrentSettingsJson();
  } catch (e) {
    setHint('Ошибка сохранения: ' + e.message, 3500);
  }
}

// -------- модалка «Открыть объект» --------

async function populateObjectsModalList() {
  const st = App.storage;
  if (els.objectsSourceText) {
    if (st.mode === 'local-fs') {
      els.objectsSourceText.textContent = 'Локальная папка: ' + st.folderLabel;
    } else if (st.pendingHandle) {
      els.objectsSourceText.textContent = 'Сохранённая папка «' + st.folderLabel + '» ждёт подтверждения';
    } else if (st.mode === 'server') {
      els.objectsSourceText.textContent = 'Источник: локальный сервер (anim/)';
    } else if (st.mode === 'local-files') {
      els.objectsSourceText.textContent = 'Импорт в память: ' + st.folderLabel;
    } else {
      els.objectsSourceText.textContent = 'Источник: GitHub Pages (выберите локальную папку для записи)';
    }
  }
  if (els.objectsBtnReconnect) {
    els.objectsBtnReconnect.hidden = !st.pendingHandle;
  }

  try {
    const list = await fetchObjects();
    els.objectsList.innerHTML = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'В выбранном источнике пока нет объектов';
      els.objectsList.appendChild(li);
    } else {
      for (const name of list) {
        const li = document.createElement('li');
        li.textContent = name;
        if (name === App.current) li.classList.add('selected');
        li.onclick = () => {
          closeObjectsModal();
          openObject(name);
        };
        els.objectsList.appendChild(li);
      }
    }
  } catch (e) {
    els.objectsList.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Ошибка чтения списка: ' + e.message;
    els.objectsList.appendChild(li);
  }
}

async function openObjectsModal() {
  els.modalObjects.hidden = false;
  await populateObjectsModalList();
}

function closeObjectsModal() {
  els.modalObjects.hidden = true;
}

// -------- модалка «Настройки» --------

function refreshSettingsModalUI() {
  if (!els.modalSettings) return;
  const st = App.storage;

  els.stStatusDot.className = 'storage-dot';
  if (st.mode === 'local-fs') {
    els.stStatusDot.classList.add('ok');
    els.stSourceDesc.textContent = 'Локальная папка подключена (чтение и запись на диск)';
    els.stFolderCookie.textContent = 'Активная папка (cookie): ' + st.folderLabel;
  } else if (st.mode === 'local-files') {
    els.stStatusDot.classList.add('ok');
    els.stSourceDesc.textContent = 'Папка загружена в память браузера';
    els.stFolderCookie.textContent = 'Папка: ' + st.folderLabel + ' (сохранение через скачивание JSON)';
  } else if (st.pendingHandle) {
    els.stStatusDot.classList.add('warn');
    els.stSourceDesc.textContent = 'Сохранённая локальная папка ожидает разрешения браузера';
    els.stFolderCookie.textContent = 'Запомненная папка (cookie): ' + st.folderLabel;
  } else if (st.mode === 'server') {
    els.stStatusDot.classList.add('server');
    els.stSourceDesc.textContent = 'Подключён локальный Node.js сервер (server.js)';
    els.stFolderCookie.textContent = st.folderLabel
      ? ('Запомненная папка в cookie: ' + st.folderLabel)
      : 'Локальная папка в браузере не выбрана (используется anim/ сервера)';
  } else {
    els.stSourceDesc.textContent = 'Режим просмотра из репозитория GitHub Pages';
    els.stFolderCookie.textContent = st.folderLabel
      ? ('Последняя папка в cookie: ' + st.folderLabel)
      : 'Локальная папка ещё не выбрана';
  }

  els.stReconnectFolder.hidden = !st.pendingHandle;
  els.stClearFolder.hidden = !(st.mode === 'local-fs' || st.mode === 'local-files' || st.pendingHandle || st.folderLabel);
  els.stAutoOpen.checked = !!st.autoOpenLast;

  if (App.settings) {
    els.stObjectSection.hidden = false;
    els.stFps.value = String(App.settings.fps || 60);
    els.stFrameW.value = String((App.settings.frame && App.settings.frame.width) || 512);
    els.stFrameH.value = String((App.settings.frame && App.settings.frame.height) || 512);
  } else {
    els.stObjectSection.hidden = true;
  }
}

function openSettingsModal() {
  refreshSettingsModalUI();
  els.modalSettings.hidden = false;
}

function closeSettingsModal() {
  els.modalSettings.hidden = true;
}

function applySettingsModal() {
  App.storage.autoOpenLast = !!els.stAutoOpen.checked;
  setPref(PREF_AUTO_OPEN, App.storage.autoOpenLast ? '1' : '0');

  if (App.settings) {
    const fps = clamp(Math.round(parseFloat(els.stFps.value) || 60), 10, 120);
    const fw  = clamp(Math.round(parseFloat(els.stFrameW.value) || 512), 64, 4096);
    const fh  = clamp(Math.round(parseFloat(els.stFrameH.value) || 512), 64, 4096);
    App.settings.fps = fps;
    if (!App.settings.frame) App.settings.frame = { width: fw, height: fh, background: 'grid' };
    else {
      App.settings.frame.width = fw;
      App.settings.frame.height = fh;
    }
    renderTimeline();
  }

  closeSettingsModal();
  setHint('Настройки сохранены', 1500);
}
