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
  const origW = parseFloat(root.getAttribute('width'));
  const vb = root.getAttribute('viewBox');
  let unitToPx = 1;
  if (vb) {
    const m = vb.trim().split(/[\s,]+/).map(parseFloat);
    if (m.length === 4 && m[2] > 0 && m[3] > 0) {
      if (isFinite(origW) && origW > 0 && Math.abs(origW - m[2]) > 1e-3) {
        unitToPx = origW / m[2];
      }
      root.setAttribute('width', m[2]);
      root.setAttribute('height', m[3]);
    }
  } else {
    const w = parseFloat(root.getAttribute('width'));
    const h = parseFloat(root.getAttribute('height'));
    if (!isFinite(w) || w <= 0) root.setAttribute('width', 100);
    if (!isFinite(h) || h <= 0) root.setAttribute('height', 100);
  }
  root._unitToPx = unitToPx;
  return root;
}

// -------- определение структуры выбранной локальной папки --------

async function resolveAnimDirectory(pickedHandle) {
  // 1) Проверяем, есть ли внутри подпапка anim/ (пользователь выбрал корень RAGDOLL_ANIMATION)
  try {
    const subAnim = await pickedHandle.getDirectoryHandle('anim');
    if (subAnim) {
      let subStage = null;
      try { subStage = await pickedHandle.getDirectoryHandle('stage', { create: true }); }
      catch (_) {
        try { subStage = await pickedHandle.getDirectoryHandle('stage'); } catch (_2) {}
      }
      return {
        rootHandle: pickedHandle,
        animHandle: subAnim,
        stageHandle: subStage,
        singleObjHandle: null,
        label: pickedHandle.name
      };
    }
  } catch (_) {}

  // 1b) Пользователь выбрал непосредственно папку stage/
  if (String(pickedHandle.name || '').toLowerCase() === 'stage') {
    return {
      rootHandle: null,
      animHandle: null,
      stageHandle: pickedHandle,
      singleObjHandle: null,
      label: pickedHandle.name
    };
  }

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
      stageHandle: null,
      singleObjHandle: pickedHandle,
      label: pickedHandle.name
    };
  }

  // Пользователь выбрал саму папку anim/ со списком объектов
  return {
    rootHandle: null,
    animHandle: pickedHandle,
    stageHandle: null,
    singleObjHandle: null,
    label: pickedHandle.name
  };
}

async function activateDirectoryHandle(handle, saveToPrefs) {
  const resolved = await resolveAnimDirectory(handle);
  App.storage.mode            = 'local-fs';
  App.storage.rootHandle      = resolved.rootHandle;
  App.storage.animHandle      = resolved.animHandle;
  App.storage.stageHandle     = resolved.stageHandle;
  App.storage.singleObjHandle = resolved.singleObjHandle;
  App.storage.pendingHandle   = null;
  App.storage.memoryObjects   = null;
  App.storage.memoryStages    = null;
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

  // Группируем файлы по папкам объектов и сцен
  const mem = {};
  const memStages = {};
  let rootName = '';
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    const segs = rel.split('/').filter(Boolean);
    if (!rootName && segs.length) rootName = segs[0];

    const stageIdx = segs.indexOf('stage');
    if (stageIdx >= 0 && segs.length >= stageIdx + 3) {
      const stName = segs[stageIdx + 1];
      const fName = segs[segs.length - 1];
      if (stName && !stName.startsWith('.')) {
        if (!memStages[stName]) memStages[stName] = { files: {}, stage: null };
        if (fName === 'stage.json') {
          try { memStages[stName].stage = JSON.parse(await f.text()); } catch (_) {}
        } else if (/\.(svg)$/i.test(fName)) {
          memStages[stName].files[fName] = { kind: 'svg', text: await f.text() };
        } else if (/\.(png|jpe?g|webp|gif)$/i.test(fName)) {
          const dataUrl = await new Promise((res) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result || ''));
            fr.onerror = () => res('');
            fr.readAsDataURL(f);
          });
          memStages[stName].files[fName] = { kind: 'raster', dataUrl };
        }
      }
      continue;
    }

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
  if (!names.length && !Object.keys(memStages).length) {
    setHint('В выбранной папке не найдено SVG-объектов', 3000);
    return;
  }

  App.storage.mode            = 'local-files';
  App.storage.memoryObjects   = mem;
  App.storage.memoryStages    = memStages;
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
  App.storage.stageHandle     = null;
  App.storage.singleObjHandle = null;
  App.storage.pendingHandle   = null;
  App.storage.memoryObjects   = null;
  App.storage.memoryStages    = null;
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

  // 4) Статический манифест репозитория (GitHub Pages) + локальные объекты сессии
  let baseNames = [];
  try {
    const r = await fetch('anim/index.json');
    if (r.ok) {
      const j = await r.json();
      baseNames = Object.keys((j && j.objects) || {});
    }
  } catch (_) {}

  const merged = new Set();
  for (const n of baseNames) {
    if (!st.deletedObjects.has(n)) merged.add(n);
  }
  for (const n of Object.keys(st.customObjects || {})) {
    merged.add(n);
  }
  return Array.from(merged).sort((a, b) => a.localeCompare(b));
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

  // 4) Кастомный объект в памяти браузера (созданный/клонированный в режиме repo)
  if (st.customObjects && st.customObjects[name]) {
    const entry = st.customObjects[name];
    const svgs = Object.keys(entry.svgs || {}).sort((a, b) => a.localeCompare(b));
    const settings = entry.settings ? clone(entry.settings) : buildDefaultSettingsClient(name, svgs);
    return { name, svgs, settings };
  }

  // 5) Статический репозиторий GitHub Pages
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

async function fetchSvgTextRaw(name, file) {
  const st = App.storage;

  if (st.mode === 'local-fs') {
    const dir = await getLocalObjectDirHandle(name, false);
    const fh = await dir.getFileHandle(file);
    const f = await fh.getFile();
    return f.text();
  }

  if (st.mode === 'local-files' && st.memoryObjects && st.memoryObjects[name]) {
    const txt = st.memoryObjects[name].svgs[file];
    if (!txt) throw new Error('SVG не найден в памяти: ' + file);
    return txt;
  }

  if (st.customObjects && st.customObjects[name] && st.customObjects[name].svgs[file]) {
    return st.customObjects[name].svgs[file];
  }

  const url = 'anim/' + encodeURIComponent(name) + '/' + encodeURIComponent(file);
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + file);
  return r.text();
}

async function fetchSvg(name, file) {
  const txt = await fetchSvgTextRaw(name, file);
  return parseSvgDocument(txt, file);
}

// -------- открытие и сохранение объекта --------

async function openObject(name) {
  try {
    setHint('Загрузка ' + name + '…');
    stopPlayback();
    App._suppressDirty = true;
    const data = await fetchObjectData(name);
    App.current          = name;
    App._objSelectedName = name;
    App.settings         = data.settings;
    App.svgCache         = {};
    App.selectedId       = null;
    App.selectedIds      = new Set();
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
    App._suppressDirty = false;
    clearDirty();
    setHint('Объект "' + name + '": частей ' + App.settings.parts.length, 2500);
  } catch (e) {
    App._suppressDirty = false;
    setHint('Ошибка: ' + e.message, 4000);
  }
}

function requestOpenObject(name) {
  if (!name) return;
  if (name === App.current && !App.dirty) {
    closeObjectsModal();
    return;
  }
  guardUnsavedChanges(() => {
    closeObjectsModal();
    openObject(name);
  });
}

function clearCurrentObjectScene() {
  stopPlayback();
  App.current     = null;
  App.settings    = null;
  App.svgCache    = {};
  App.selectedId  = null;
  App.selectedIds = new Set();
  clearDirty();
  if (els.objName) els.objName.value = '';
  if (els.animName) els.animName.value = '';
  if (els.scene) els.scene.innerHTML = '';
  if (els.onion) els.onion.innerHTML = '';
  App._partDomMap = {};
  App._onionPool = [];
  renderLayers();
  renderProperties();
  updateSelSize();
  renderTimeline();
  Gizmo.render();
}

function buildSerializedSettings() {
  if (!App.current || !App.settings) return null;
  const out = clone(App.settings);
  out.name = App.current;
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
    return false;
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
      clearDirty();
      setHint('Файл settings.json сохранён', 2000);
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') return false;
    }
  }
  downloadJsonBlob('settings.json', text);
  clearDirty();
  setHint('Скачан файл settings.json', 2000);
  return true;
}

async function saveObject() {
  const out = buildSerializedSettings();
  if (!out) {
    setHint('Нечего сохранять', 2000);
    return false;
  }
  const jsonText = JSON.stringify(out, null, 2);
  if (App.stage && App.stage.templates && App.current) {
    delete App.stage.templates[App.current];
  }
  const st = App.storage;

  try {
    // Если есть ожидающая разрешения сохранённая папка — запрашиваем доступ и пишем в неё
    if (st.mode !== 'local-fs' && st.pendingHandle) {
      const ok = await reconnectSavedFolder();
      if (!ok) return false;
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
      clearDirty();
      setHint('Сохранено на диск: ' + App.storage.folderLabel + '/' + App.current + '/settings.json', 2200);
      return true;
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
      clearDirty();
      setHint('Сохранено: anim/' + App.current + '/settings.json', 1800);
      return true;
    }

    // 3) Открыто из GitHub Pages без привязанной локальной папки (или в Firefox)
    if (App.storage.mode === 'local-files' && App.storage.memoryObjects && App.storage.memoryObjects[App.current]) {
      App.storage.memoryObjects[App.current].settings = clone(out);
    }
    if (App.storage.customObjects && App.storage.customObjects[App.current]) {
      App.storage.customObjects[App.current].settings = clone(out);
    }

    if (typeof window.showDirectoryPicker === 'function') {
      return await new Promise((resolve) => {
        confirmDialog(
          'Подключить локальную папку для сохранения?',
          'Сейчас объект открыт из GitHub (режим чтения). Выберите локальную папку проекта на ПК, чтобы редактор сразу сохранил «' +
            App.current + '/settings.json» на диск и запомнил расположение.',
          async () => {
            const picked = await pickLocalFolder();
            if (picked && App.storage.mode === 'local-fs') {
              resolve(await saveObject());
            } else {
              resolve(await downloadCurrentSettingsJson());
            }
          }
        );
      });
    }

    return await downloadCurrentSettingsJson();
  } catch (e) {
    setHint('Ошибка сохранения: ' + e.message, 3500);
    return false;
  }
}

// -------- создание / клонирование / переименование / удаление объектов --------

async function ensureWritableFolderIfPending() {
  if (App.storage.mode !== 'local-fs' && App.storage.pendingHandle) {
    await reconnectSavedFolder();
  }
  if (App.storage.mode === 'local-fs' && !App.storage.animHandle) {
    throw new Error('Подключена папка одного объекта. Для управления списком объектов выберите общую папку anim/');
  }
}

async function createObjectBackend() {
  await ensureWritableFolderIfPending();
  const list = await fetchObjects();
  const newName = resolveAutoName(list, 'untitled_');
  const defaultSettings = buildDefaultSettingsClient(newName, []);
  const st = App.storage;

  if (st.mode === 'local-fs' && st.animHandle) {
    const dir = await st.animHandle.getDirectoryHandle(newName, { create: true });
    const fh = await dir.getFileHandle('settings.json', { create: true });
    const wr = await fh.createWritable();
    await wr.write(JSON.stringify(defaultSettings, null, 2));
    await wr.close();
  } else if (st.mode === 'server') {
    const r = await fetch('/api/objects/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName })
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ('HTTP ' + r.status));
    }
  } else if (st.mode === 'local-files' && st.memoryObjects) {
    st.memoryObjects[newName] = { svgs: {}, settings: defaultSettings };
  } else {
    st.deletedObjects.delete(newName);
    st.customObjects[newName] = { svgs: {}, settings: defaultSettings };
  }

  return newName;
}

async function cloneObjectBackend(sourceName) {
  await ensureWritableFolderIfPending();
  const list = await fetchObjects();
  if (!sourceName || !list.includes(sourceName)) {
    throw new Error('Выберите объект для клонирования');
  }
  const newName = resolveCloneName(list, sourceName);
  const st = App.storage;

  // Если клонируем текущий открытый объект — берём актуальное состояние со сцены
  const srcData = await fetchObjectData(sourceName);
  const clonedSettings = (sourceName === App.current && App.settings)
    ? buildSerializedSettings()
    : clone(srcData.settings);
  clonedSettings.name = newName;

  if (st.mode === 'local-fs' && st.animHandle) {
    const srcDir = await getLocalObjectDirHandle(sourceName, false);
    const dstDir = await st.animHandle.getDirectoryHandle(newName, { create: true });
    for await (const [fName, entry] of srcDir.entries()) {
      if (entry.kind !== 'file' || fName === 'settings.json') continue;
      const srcFile = await entry.getFile();
      const dstFh = await dstDir.getFileHandle(fName, { create: true });
      const wr = await dstFh.createWritable();
      await wr.write(await srcFile.arrayBuffer());
      await wr.close();
    }
    const stFh = await dstDir.getFileHandle('settings.json', { create: true });
    const stWr = await stFh.createWritable();
    await stWr.write(JSON.stringify(clonedSettings, null, 2));
    await stWr.close();
  } else if (st.mode === 'server') {
    const r = await fetch('/api/object/' + encodeURIComponent(sourceName) + '/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName })
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ('HTTP ' + r.status));
    }
    if (sourceName === App.current && App.dirty) {
      await fetch('/api/object/' + encodeURIComponent(newName) + '/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clonedSettings, null, 2)
      });
    }
  } else {
    const svgsMap = {};
    for (const svgFile of (srcData.svgs || [])) {
      try { svgsMap[svgFile] = await fetchSvgTextRaw(sourceName, svgFile); } catch (_) {}
    }
    if (st.mode === 'local-files' && st.memoryObjects) {
      st.memoryObjects[newName] = { svgs: svgsMap, settings: clonedSettings };
    } else {
      st.deletedObjects.delete(newName);
      st.customObjects[newName] = { svgs: svgsMap, settings: clonedSettings };
    }
  }

  return newName;
}

async function renameObjectBackend(oldName, rawNewName) {
  const newName = sanitizeEntityName(rawNewName);
  if (!newName) {
    setHint('Имя объекта не может быть пустым', 2000);
    return { ok: false };
  }
  if (newName === oldName) {
    return { ok: true, name: oldName, unchanged: true };
  }

  try {
    await ensureWritableFolderIfPending();
    const list = await fetchObjects();
    if (list.includes(newName)) {
      setHint('Объект с именем «' + newName + '» уже существует', 2400);
      return { ok: false };
    }

    const st = App.storage;
    if (st.mode === 'local-fs' && st.animHandle) {
      const oldDir = await st.animHandle.getDirectoryHandle(oldName, { create: false });
      const newDir = await st.animHandle.getDirectoryHandle(newName, { create: true });
      for await (const [fName, entry] of oldDir.entries()) {
        if (entry.kind !== 'file') continue;
        const srcFile = await entry.getFile();
        const dstFh = await newDir.getFileHandle(fName, { create: true });
        const wr = await dstFh.createWritable();
        if (fName === 'settings.json') {
          let stObj = null;
          try { stObj = JSON.parse(await srcFile.text()); } catch (_) {}
          if (stObj) {
            stObj.name = newName;
            await wr.write(JSON.stringify(stObj, null, 2));
          } else {
            await wr.write(await srcFile.arrayBuffer());
          }
        } else {
          await wr.write(await srcFile.arrayBuffer());
        }
        await wr.close();
      }
      await st.animHandle.removeEntry(oldName, { recursive: true });
    } else if (st.mode === 'server') {
      const r = await fetch('/api/object/' + encodeURIComponent(oldName) + '/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + r.status));
      }
    } else if (st.mode === 'local-files' && st.memoryObjects && st.memoryObjects[oldName]) {
      st.memoryObjects[newName] = st.memoryObjects[oldName];
      if (st.memoryObjects[newName].settings) st.memoryObjects[newName].settings.name = newName;
      delete st.memoryObjects[oldName];
    } else {
      const srcData = await fetchObjectData(oldName);
      const svgsMap = {};
      for (const svgFile of (srcData.svgs || [])) {
        try { svgsMap[svgFile] = await fetchSvgTextRaw(oldName, svgFile); } catch (_) {}
      }
      const settingsCopy = clone(srcData.settings);
      settingsCopy.name = newName;
      st.customObjects[newName] = { svgs: svgsMap, settings: settingsCopy };
      delete st.customObjects[oldName];
      st.deletedObjects.add(oldName);
    }

    if (App.current === oldName) {
      App.current = newName;
      if (App.settings) App.settings.name = newName;
      if (els.objName) els.objName.value = newName;
      setPref(PREF_LAST_OBJ, newName);
    }
    if (App._objSelectedName === oldName) {
      App._objSelectedName = newName;
    }

    setHint('Объект переименован: «' + newName + '»', 1800);
    return { ok: true, name: newName };
  } catch (e) {
    setHint('Ошибка переименования: ' + e.message, 3200);
    return { ok: false };
  }
}

async function deleteObjectBackend(targetName) {
  await ensureWritableFolderIfPending();
  const st = App.storage;

  if (st.mode === 'local-fs' && st.animHandle) {
    await st.animHandle.removeEntry(targetName, { recursive: true });
  } else if (st.mode === 'server') {
    const r = await fetch('/api/object/' + encodeURIComponent(targetName) + '/delete', {
      method: 'POST'
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ('HTTP ' + r.status));
    }
  } else if (st.mode === 'local-files' && st.memoryObjects) {
    delete st.memoryObjects[targetName];
  } else {
    delete st.customObjects[targetName];
    st.deletedObjects.add(targetName);
  }

  if (App.current === targetName) {
    clearCurrentObjectScene();
  }
}

// -------- модалка «Открыть объект» с inline-переименованием --------

let _activeObjectRowCancel = null;

function cancelActiveObjectRowEdit() {
  if (typeof _activeObjectRowCancel === 'function') {
    const fn = _activeObjectRowCancel;
    _activeObjectRowCancel = null;
    fn();
  }
}

function startObjectRowInlineRename(li, oldName) {
  if (!li || li.classList.contains('editing')) return;
  cancelActiveObjectRowEdit();

  const labelEl = li.querySelector('.list-row-label');
  const editBtn = li.querySelector('.list-row-edit-btn');
  const iconEl  = editBtn ? editBtn.querySelector('.material-icons') : null;
  if (!labelEl || !editBtn || !iconEl) return;

  li.classList.add('editing');
  iconEl.textContent = 'check';
  editBtn.title = 'Подтвердить переименование (Enter)';

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'list-row-input';
  inp.value = oldName;
  inp.autocomplete = 'off';
  inp.spellcheck = false;

  labelEl.replaceWith(inp);
  inp.focus();
  inp.select();

  let finished = false;

  function restoreView(displayText) {
    if (finished) return;
    finished = true;
    _activeObjectRowCancel = null;
    document.removeEventListener('mousedown', onDocDown, true);
    li.classList.remove('editing');
    iconEl.textContent = 'edit';
    editBtn.title = 'Переименовать';
    const span = document.createElement('span');
    span.className = 'list-row-label';
    span.textContent = displayText;
    if (inp.parentNode === li) inp.replaceWith(span);
  }

  async function commit() {
    if (finished) return;
    const raw = inp.value;
    const res = await renameObjectBackend(oldName, raw);
    if (!res.ok) {
      inp.focus();
      inp.select();
      return;
    }
    restoreView(res.name);
    await populateObjectsModalList();
  }

  function cancel() {
    restoreView(oldName);
  }

  function onDocDown(e) {
    if (!li.contains(e.target)) {
      cancel();
    }
  }

  inp.addEventListener('click', (e) => e.stopPropagation());
  inp.addEventListener('dblclick', (e) => e.stopPropagation());
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  });

  editBtn.onclick = (e) => {
    e.stopPropagation();
    commit();
  };

  setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
  _activeObjectRowCancel = () => {
    restoreView(oldName);
    editBtn.onclick = (ev) => {
      ev.stopPropagation();
      startObjectRowInlineRename(li, oldName);
    };
  };
}

async function populateObjectsModalList() {
  cancelActiveObjectRowEdit();
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
      els.objectsSourceText.textContent = 'Источник: GitHub Pages (выберите локальную папку для записи на диск)';
    }
  }
  if (els.objectsBtnReconnect) {
    els.objectsBtnReconnect.hidden = !st.pendingHandle;
  }

  try {
    const list = await fetchObjects();
    els.objectsList.innerHTML = '';
    if (!list.length) {
      App._objSelectedName = null;
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'В выбранном источнике пока нет объектов. Нажмите «+» внизу слева.';
      els.objectsList.appendChild(li);
      return;
    }

    if (!App._objSelectedName || !list.includes(App._objSelectedName)) {
      App._objSelectedName = (App.current && list.includes(App.current)) ? App.current : list[0];
    }

    for (const name of list) {
      const li = document.createElement('li');
      li.className = 'editable-list-row';
      li.dataset.name = name;
      if (name === App._objSelectedName) li.classList.add('selected');

      const span = document.createElement('span');
      span.className = 'list-row-label';
      span.textContent = name;

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'icon-btn icon-btn-sm list-row-edit-btn';
      editBtn.title = 'Переименовать объект';
      editBtn.innerHTML = '<span class="material-icons">edit</span>';
      editBtn.onclick = (e) => {
        e.stopPropagation();
        startObjectRowInlineRename(li, name);
      };

      li.appendChild(span);
      li.appendChild(editBtn);

      li.addEventListener('click', () => {
        if (li.classList.contains('editing')) return;
        App._objSelectedName = name;
        els.objectsList.querySelectorAll('li.editable-list-row').forEach(row => {
          row.classList.toggle('selected', row.dataset.name === name);
        });
      });

      li.addEventListener('dblclick', () => {
        if (li.classList.contains('editing')) return;
        App._objSelectedName = name;
        requestOpenObject(name);
      });

      els.objectsList.appendChild(li);
    }
  } catch (e) {
    els.objectsList.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Ошибка чтения списка: ' + e.message;
    els.objectsList.appendChild(li);
  }
}

async function createObjectFromModal() {
  try {
    const newName = await createObjectBackend();
    App._objSelectedName = newName;
    await populateObjectsModalList();
    const row = Array.from(els.objectsList.querySelectorAll('li[data-name]')).find(x => x.dataset.name === newName);
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    setHint('Создан объект «' + newName + '»', 2000);
  } catch (e) {
    setHint('Ошибка создания объекта: ' + e.message, 3200);
  }
}

async function cloneObjectFromModal() {
  if (!App._objSelectedName) {
    setHint('Выберите объект в списке для клонирования', 2000);
    return;
  }
  try {
    const newName = await cloneObjectBackend(App._objSelectedName);
    App._objSelectedName = newName;
    await populateObjectsModalList();
    const row = Array.from(els.objectsList.querySelectorAll('li[data-name]')).find(x => x.dataset.name === newName);
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    setHint('Создан клон «' + newName + '»', 2000);
  } catch (e) {
    setHint('Ошибка клонирования: ' + e.message, 3200);
  }
}

function renameObjectFromModal() {
  if (!App._objSelectedName) {
    setHint('Выберите объект для переименования', 2000);
    return;
  }
  const rows = els.objectsList.querySelectorAll('li.editable-list-row');
  for (const row of rows) {
    if (row.dataset.name === App._objSelectedName) {
      startObjectRowInlineRename(row, App._objSelectedName);
      return;
    }
  }
}

function deleteObjectFromModal() {
  if (!App._objSelectedName) {
    setHint('Выберите объект для удаления', 2000);
    return;
  }
  const target = App._objSelectedName;
  confirmDialog(
    'Удалить объект?',
    'Удалить объект «' + target + '» со всеми его анимациями без возможности отмены?',
    async () => {
      try {
        await deleteObjectBackend(target);
        App._objSelectedName = null;
        await populateObjectsModalList();
        setHint('Объект «' + target + '» удалён', 1800);
      } catch (e) {
        setHint('Ошибка удаления: ' + e.message, 3200);
      }
    }
  );
}

function openSelectedObjectFromModal() {
  if (!App._objSelectedName) {
    setHint('Выберите объект в списке', 1800);
    return;
  }
  requestOpenObject(App._objSelectedName);
}

async function openObjectsModal() {
  App._objSelectedName = App.current;
  els.modalObjects.hidden = false;
  await populateObjectsModalList();
}

function closeObjectsModal() {
  cancelActiveObjectRowEdit();
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
    const prevFps = App.settings.fps;
    const prevFw  = App.settings.frame && App.settings.frame.width;
    const prevFh  = App.settings.frame && App.settings.frame.height;
    App.settings.fps = fps;
    if (!App.settings.frame) App.settings.frame = { width: fw, height: fh, background: 'grid' };
    else {
      App.settings.frame.width = fw;
      App.settings.frame.height = fh;
    }
    if (fps !== prevFps || fw !== prevFw || fh !== prevFh) {
      markDirty();
    }
    renderTimeline();
  }

  closeSettingsModal();
  setHint('Настройки сохранены', 1500);
}

// ============================================================
//  v0.4.0 — Хранилище и API сцен (stage/<name>/stage.json и ассеты)
// ============================================================

const PREF_LAST_STAGE = 'anim_editor_last_stage';

function buildDefaultStageClient(name) {
  return {
    version: 1,
    name,
    frame: { width: 1366, height: 768 },
    background: {
      color: '#243447',
      file: '',
      fit: 'stretch',
      opacity: 1,
      visible: true
    },
    items: []
  };
}

async function ensureLocalStageRootHandle(createIfMissing) {
  const st = App.storage;
  if (st.stageHandle) return st.stageHandle;
  if (st.rootHandle && st.rootHandle !== st.animHandle && typeof st.rootHandle.getDirectoryHandle === 'function') {
    try {
      st.stageHandle = await st.rootHandle.getDirectoryHandle('stage', { create: !!createIfMissing });
      return st.stageHandle;
    } catch (_) {}
  }
  return null;
}

async function getLocalStageDirHandle(name, createIfMissing) {
  const stageRoot = await ensureLocalStageRootHandle(createIfMissing);
  if (!stageRoot) throw new Error('В выбранной локальной папке недоступна директория stage/');
  return stageRoot.getDirectoryHandle(name, { create: !!createIfMissing });
}

async function fetchStages() {
  const st = App.storage;

  // 1) Локальная папка через File System Access API
  if (st.mode === 'local-fs') {
    const stageRoot = await ensureLocalStageRootHandle(false);
    const items = [];
    if (stageRoot) {
      for await (const [entryName, entry] of stageRoot.entries()) {
        if (entry.kind === 'directory' && !entryName.startsWith('.')) {
          items.push(entryName);
        }
      }
    }
    for (const k of Object.keys(App.stage.customStages || {})) {
      if (!items.includes(k)) items.push(k);
    }
    items.sort((a, b) => a.localeCompare(b));
    return items;
  }

  // 2) Локальные файлы через webkitdirectory
  if (st.mode === 'local-files' && st.memoryStages) {
    const merged = new Set(Object.keys(st.memoryStages));
    for (const k of Object.keys(App.stage.customStages || {})) merged.add(k);
    return Array.from(merged).sort((a, b) => a.localeCompare(b));
  }

  // 3) Локальный сервер Node.js
  if (st.mode === 'server') {
    const r = await fetch('/api/stages');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // 4) Статический манифест stage/index.json + локальные сцены сессии
  let baseNames = [];
  try {
    const r = await fetch('stage/index.json');
    if (r.ok) {
      const j = await r.json();
      baseNames = Object.keys((j && j.stages) || {});
    }
  } catch (_) {}

  const merged = new Set();
  for (const n of baseNames) {
    if (!App.stage.deletedStages.has(n)) merged.add(n);
  }
  for (const n of Object.keys(App.stage.customStages || {})) {
    merged.add(n);
  }
  return Array.from(merged).sort((a, b) => a.localeCompare(b));
}

async function fetchStageData(name) {
  const st = App.storage;

  // 1) Локальная папка (File System Access API)
  if (st.mode === 'local-fs') {
    if (App.stage.customStages && App.stage.customStages[name] && !(await ensureLocalStageRootHandle(false))) {
      const entry = App.stage.customStages[name];
      return {
        name,
        assets: Object.keys(entry.files || {}).sort((a, b) => a.localeCompare(b)),
        stage: clone(entry.stage || buildDefaultStageClient(name))
      };
    }
    const dir = await getLocalStageDirHandle(name, true);
    const assets = [];
    for await (const [fName, entry] of dir.entries()) {
      if (entry.kind === 'file' && /\.(svg|png|jpe?g|webp|gif)$/i.test(fName)) {
        assets.push(fName);
      }
    }
    assets.sort((a, b) => a.localeCompare(b));

    let stageObj = null;
    try {
      const fh = await dir.getFileHandle('stage.json');
      const file = await fh.getFile();
      stageObj = JSON.parse(await file.text());
    } catch (_) {
      stageObj = null;
    }
    if (!stageObj) {
      stageObj = buildDefaultStageClient(name);
      try {
        const fh = await dir.getFileHandle('stage.json', { create: true });
        const wr = await fh.createWritable();
        await wr.write(JSON.stringify(stageObj, null, 2));
        await wr.close();
      } catch (_) {}
    }
    return { name, assets, stage: stageObj };
  }

  // 2) Память (webkitdirectory)
  if (st.mode === 'local-files' && st.memoryStages && st.memoryStages[name]) {
    const entry = st.memoryStages[name];
    const assets = Object.keys(entry.files || {}).sort((a, b) => a.localeCompare(b));
    if (!entry.stage) entry.stage = buildDefaultStageClient(name);
    return { name, assets, stage: clone(entry.stage) };
  }

  // 3) Локальный сервер Node.js
  if (st.mode === 'server') {
    const r = await fetch('/api/stage/' + encodeURIComponent(name));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // 4) Кастомная сцена в памяти браузера (режим repo / без stageHandle)
  if (App.stage.customStages && App.stage.customStages[name]) {
    const entry = App.stage.customStages[name];
    const assets = Object.keys(entry.files || {}).sort((a, b) => a.localeCompare(b));
    const stageObj = entry.stage ? clone(entry.stage) : buildDefaultStageClient(name);
    return { name, assets, stage: stageObj };
  }

  // 5) Статический репозиторий GitHub Pages
  let assets = [];
  try {
    const idxRes = await fetch('stage/index.json');
    if (idxRes.ok) {
      const idxJson = await idxRes.json();
      assets = (idxJson.stages && idxJson.stages[name]) || [];
    }
  } catch (_) {}

  let stageObj = null;
  try {
    const sr = await fetch('stage/' + encodeURIComponent(name) + '/stage.json');
    if (sr.ok) stageObj = await sr.json();
  } catch (_) {}

  if (!stageObj) stageObj = buildDefaultStageClient(name);
  return { name, assets, stage: stageObj };
}

function fileBlobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('Ошибка чтения файла'));
    fr.readAsDataURL(blob);
  });
}

function probeImageDimensions(dataUrlOrUrl) {
  return new Promise((resolve) => {
    if (typeof Image !== 'function') {
      resolve({ width: 1366, height: 768 });
      return;
    }
    const img = new Image();
    img.onload = () => resolve({
      width: img.naturalWidth || img.width || 1366,
      height: img.naturalHeight || img.height || 768
    });
    img.onerror = () => resolve({ width: 1366, height: 768 });
    img.src = dataUrlOrUrl;
  });
}

function buildStageSvgAssetEntry(svgText, file) {
  const root = parseSvgDocument(svgText, file);
  const w = parseFloat(root.getAttribute('width')) || 100;
  const h = parseFloat(root.getAttribute('height')) || 100;
  return {
    kind: 'svg',
    parsed: { root, width: w, height: h },
    unitToPx: root._unitToPx || 1
  };
}

async function fetchStageAssetParsed(stageName, file) {
  const key = stageName + '/' + file;
  if (App.stage.assetCache[key]) return App.stage.assetCache[key];

  const st = App.storage;
  const isSvg = /\.svg$/i.test(file);

  // Сначала проверяем загруженные в сессию кастомные файлы сцены
  if (App.stage.customStages && App.stage.customStages[stageName] &&
      App.stage.customStages[stageName].files && App.stage.customStages[stageName].files[file]) {
    const memFile = App.stage.customStages[stageName].files[file];
    if (memFile.kind === 'svg') {
      const entry = buildStageSvgAssetEntry(memFile.text, file);
      App.stage.assetCache[key] = entry;
      return entry;
    } else {
      const dims = await probeImageDimensions(memFile.dataUrl);
      const entry = { kind: 'raster', url: memFile.dataUrl, width: dims.width, height: dims.height };
      App.stage.assetCache[key] = entry;
      return entry;
    }
  }

  if (st.mode === 'local-fs') {
    const stageRoot = await ensureLocalStageRootHandle(false);
    if (stageRoot) {
      const dir = await stageRoot.getDirectoryHandle(stageName);
      const fh = await dir.getFileHandle(file);
      const f = await fh.getFile();
      if (isSvg) {
        const entry = buildStageSvgAssetEntry(await f.text(), file);
        App.stage.assetCache[key] = entry;
        return entry;
      } else {
        const dataUrl = await fileBlobToDataUrl(f);
        const dims = await probeImageDimensions(dataUrl);
        const entry = { kind: 'raster', url: dataUrl, width: dims.width, height: dims.height };
        App.stage.assetCache[key] = entry;
        return entry;
      }
    }
  }

  if (st.mode === 'local-files' && st.memoryStages && st.memoryStages[stageName] &&
      st.memoryStages[stageName].files && st.memoryStages[stageName].files[file]) {
    const mf = st.memoryStages[stageName].files[file];
    if (mf.kind === 'svg') {
      const entry = buildStageSvgAssetEntry(mf.text, file);
      App.stage.assetCache[key] = entry;
      return entry;
    } else {
      const dims = await probeImageDimensions(mf.dataUrl);
      const entry = { kind: 'raster', url: mf.dataUrl, width: dims.width, height: dims.height };
      App.stage.assetCache[key] = entry;
      return entry;
    }
  }

  const url = 'stage/' + encodeURIComponent(stageName) + '/' + encodeURIComponent(file);
  if (isSvg) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + file);
    const entry = buildStageSvgAssetEntry(await r.text(), file);
    App.stage.assetCache[key] = entry;
    return entry;
  } else {
    const dims = await probeImageDimensions(url);
    const entry = { kind: 'raster', url, width: dims.width, height: dims.height };
    App.stage.assetCache[key] = entry;
    return entry;
  }
}

async function saveStageBackend(stageName, stageObj) {
  const jsonText = JSON.stringify(stageObj, null, 2);
  const st = App.storage;

  await ensureWritableFolderIfPending();

  if (App.storage.mode === 'local-fs') {
    const stageRoot = await ensureLocalStageRootHandle(true);
    if (stageRoot) {
      const dir = await stageRoot.getDirectoryHandle(stageName, { create: true });
      const fh = await dir.getFileHandle('stage.json', { create: true });
      const wr = await fh.createWritable();
      await wr.write(jsonText);
      await wr.close();
      return { mode: 'local-fs' };
    }
  }

  if (App.storage.mode === 'server') {
    const r = await fetch('/api/stage/' + encodeURIComponent(stageName) + '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonText
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    return { mode: 'server' };
  }

  if (st.mode === 'local-files' && st.memoryStages && st.memoryStages[stageName]) {
    st.memoryStages[stageName].stage = clone(stageObj);
  }
  if (!App.stage.customStages[stageName]) {
    App.stage.customStages[stageName] = { files: {}, stage: clone(stageObj) };
  } else {
    App.stage.customStages[stageName].stage = clone(stageObj);
  }

  downloadJsonBlob(stageName + '.stage.json', jsonText);
  return { mode: 'download' };
}

async function createStageBackend(rawName) {
  await ensureWritableFolderIfPending();
  const existing = await fetchStages();
  const name = rawName ? sanitizeEntityName(rawName) : resolveAutoName(existing, 'NewStage');
  if (!name) throw new Error('Некорректное имя сцены');
  if (existing.includes(name)) throw new Error('Сцена с таким именем уже существует');

  const stageObj = buildDefaultStageClient(name);

  if (App.storage.mode === 'local-fs') {
    const stageRoot = await ensureLocalStageRootHandle(true);
    if (stageRoot) {
      const dir = await stageRoot.getDirectoryHandle(name, { create: true });
      const fh = await dir.getFileHandle('stage.json', { create: true });
      const wr = await fh.createWritable();
      await wr.write(JSON.stringify(stageObj, null, 2));
      await wr.close();
      return name;
    }
  }

  if (App.storage.mode === 'server') {
    const r = await fetch('/api/stages/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j.name || name;
  }

  if (App.storage.mode === 'local-files' && App.storage.memoryStages) {
    App.storage.memoryStages[name] = { files: {}, stage: stageObj };
    return name;
  }

  App.stage.deletedStages.delete(name);
  App.stage.customStages[name] = { files: {}, stage: stageObj };
  return name;
}

async function cloneStageBackend(srcName) {
  await ensureWritableFolderIfPending();
  const existing = await fetchStages();
  const dstName = resolveAutoName(existing, srcName + '_copy');

  if (App.storage.mode === 'server') {
    const r = await fetch('/api/stage/' + encodeURIComponent(srcName) + '/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName: dstName })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j.name || dstName;
  }

  const srcData = await fetchStageData(srcName);
  const clonedStage = clone(srcData.stage || buildDefaultStageClient(dstName));
  clonedStage.name = dstName;

  if (App.storage.mode === 'local-fs') {
    const stageRoot = await ensureLocalStageRootHandle(true);
    if (stageRoot) {
      const srcDir = await stageRoot.getDirectoryHandle(srcName);
      const dstDir = await stageRoot.getDirectoryHandle(dstName, { create: true });
      for await (const [fName, entry] of srcDir.entries()) {
        if (entry.kind !== 'file' || fName === 'stage.json') continue;
        const sf = await entry.getFile();
        const buf = await sf.arrayBuffer();
        const dfh = await dstDir.getFileHandle(fName, { create: true });
        const wr = await dfh.createWritable();
        await wr.write(buf);
        await wr.close();
      }
      const sfh = await dstDir.getFileHandle('stage.json', { create: true });
      const swr = await sfh.createWritable();
      await swr.write(JSON.stringify(clonedStage, null, 2));
      await swr.close();
      return dstName;
    }
  }

  if (App.storage.mode === 'local-files' && App.storage.memoryStages) {
    const srcEntry = App.storage.memoryStages[srcName] || { files: {} };
    App.storage.memoryStages[dstName] = { files: clone(srcEntry.files || {}), stage: clonedStage };
    return dstName;
  }

  const customFiles = (App.stage.customStages[srcName] && clone(App.stage.customStages[srcName].files)) || {};
  App.stage.deletedStages.delete(dstName);
  App.stage.customStages[dstName] = { files: customFiles, stage: clonedStage };
  return dstName;
}

async function renameStageBackend(oldName, rawNewName) {
  await ensureWritableFolderIfPending();
  const newName = sanitizeEntityName(rawNewName);
  if (!newName) throw new Error('Имя сцены не может быть пустым');
  if (newName === oldName) return oldName;

  const existing = await fetchStages();
  if (existing.includes(newName)) throw new Error('Сцена «' + newName + '» уже существует');

  if (App.storage.mode === 'server') {
    const r = await fetch('/api/stage/' + encodeURIComponent(oldName) + '/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
  } else if (App.storage.mode === 'local-fs' && (await ensureLocalStageRootHandle(false))) {
    const stageRoot = await ensureLocalStageRootHandle(false);
    const srcDir = await stageRoot.getDirectoryHandle(oldName);
    const dstDir = await stageRoot.getDirectoryHandle(newName, { create: true });
    let stObj = null;
    for await (const [fName, entry] of srcDir.entries()) {
      if (entry.kind !== 'file') continue;
      const sf = await entry.getFile();
      if (fName === 'stage.json') {
        try { stObj = JSON.parse(await sf.text()); } catch (_) {}
        continue;
      }
      const buf = await sf.arrayBuffer();
      const dfh = await dstDir.getFileHandle(fName, { create: true });
      const wr = await dfh.createWritable();
      await wr.write(buf);
      await wr.close();
    }
    if (!stObj) stObj = buildDefaultStageClient(newName);
    stObj.name = newName;
    const sfh = await dstDir.getFileHandle('stage.json', { create: true });
    const swr = await sfh.createWritable();
    await swr.write(JSON.stringify(stObj, null, 2));
    await swr.close();
    await stageRoot.removeEntry(oldName, { recursive: true });
  } else if (App.storage.mode === 'local-files' && App.storage.memoryStages) {
    const entry = App.storage.memoryStages[oldName];
    if (!entry) throw new Error('Сцена не найдена');
    if (entry.stage) entry.stage.name = newName;
    App.storage.memoryStages[newName] = entry;
    delete App.storage.memoryStages[oldName];
  } else {
    const srcData = await fetchStageData(oldName);
    srcData.stage.name = newName;
    const prevCustom = App.stage.customStages[oldName];
    App.stage.customStages[newName] = {
      files: prevCustom ? prevCustom.files : {},
      stage: srcData.stage
    };
    delete App.stage.customStages[oldName];
    App.stage.deletedStages.add(oldName);
    App.stage.deletedStages.delete(newName);
  }

  // Переносим закэшированные ассеты сцены на новое имя
  const oldPrefix = oldName + '/';
  for (const k of Object.keys(App.stage.assetCache)) {
    if (k.indexOf(oldPrefix) === 0) {
      const rest = k.slice(oldPrefix.length);
      App.stage.assetCache[newName + '/' + rest] = App.stage.assetCache[k];
      delete App.stage.assetCache[k];
    }
  }

  if (App.stage.current === oldName) {
    App.stage.current = newName;
    if (App.stage.data) App.stage.data.name = newName;
    if (els.stageName) els.stageName.value = newName;
    setPref(PREF_LAST_STAGE, newName);
  }
  return newName;
}

async function deleteStageBackend(name) {
  await ensureWritableFolderIfPending();

  if (App.storage.mode === 'server') {
    const r = await fetch('/api/stage/' + encodeURIComponent(name) + '/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
  } else if (App.storage.mode === 'local-fs' && (await ensureLocalStageRootHandle(false))) {
    const stageRoot = await ensureLocalStageRootHandle(false);
    await stageRoot.removeEntry(name, { recursive: true });
  } else if (App.storage.mode === 'local-files' && App.storage.memoryStages) {
    delete App.storage.memoryStages[name];
  } else {
    delete App.stage.customStages[name];
    App.stage.deletedStages.add(name);
  }
}

async function uploadStageAssetBackend(stageName, fileObj) {
  if (!fileObj || !stageName) throw new Error('Файл не выбран');
  const safeFileName = sanitizeEntityName(fileObj.name);
  if (!/\.(svg|png|jpe?g|webp|gif)$/i.test(safeFileName)) {
    throw new Error('Поддерживаются файлы SVG, PNG, JPG, WEBP, GIF');
  }
  const isSvg = /\.svg$/i.test(safeFileName);
  const cacheKey = stageName + '/' + safeFileName;
  delete App.stage.assetCache[cacheKey];

  await ensureWritableFolderIfPending();

  if (App.storage.mode === 'local-fs') {
    const stageRoot = await ensureLocalStageRootHandle(true);
    if (stageRoot) {
      const dir = await stageRoot.getDirectoryHandle(stageName, { create: true });
      const fh = await dir.getFileHandle(safeFileName, { create: true });
      const wr = await fh.createWritable();
      await wr.write(await fileObj.arrayBuffer());
      await wr.close();
      return safeFileName;
    }
  }

  if (App.storage.mode === 'server') {
    let payload;
    if (isSvg) {
      payload = { fileName: safeFileName, text: await fileObj.text() };
    } else {
      const dataUrl = await fileBlobToDataUrl(fileObj);
      payload = { fileName: safeFileName, dataUrl };
    }
    const r = await fetch('/api/stage/' + encodeURIComponent(stageName) + '/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j.fileName || safeFileName;
  }

  // Режим браузера (local-files / repo)
  const fileEntry = isSvg
    ? { kind: 'svg', text: await fileObj.text() }
    : { kind: 'raster', dataUrl: await fileBlobToDataUrl(fileObj) };

  if (App.storage.mode === 'local-files' && App.storage.memoryStages) {
    if (!App.storage.memoryStages[stageName]) {
      App.storage.memoryStages[stageName] = { files: {}, stage: App.stage.data || buildDefaultStageClient(stageName) };
    }
    App.storage.memoryStages[stageName].files[safeFileName] = fileEntry;
  }

  if (!App.stage.customStages[stageName]) {
    App.stage.customStages[stageName] = { files: {}, stage: App.stage.data || buildDefaultStageClient(stageName) };
  }
  App.stage.customStages[stageName].files[safeFileName] = fileEntry;
  return safeFileName;
}

