// ============================================================
//  Animation Editor — server (zero dependencies)
//  - находит свободный порт в диапазоне 8000..8200
//  - пишет выбранный порт в port.txt (его читает start.bat)
//  - отдаёт статику из корня проекта
//  - API: список объектов, чтение/сохранение settings.json
// ============================================================

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const net  = require('net');
const url  = require('url');

const PORT_MIN = 8000;
const PORT_MAX = 8200;
const HOST     = process.env.HOST || '0.0.0.0';

const ROOT       = __dirname;
const ANIM_DIR   = path.join(ROOT, 'anim');
const STAGE_DIR  = path.join(ROOT, 'stage');
const CHAR3D_DIR = path.join(ROOT, 'char3d');
const PORT_FILE  = path.join(ROOT, 'port.txt');

// ------------------------------------------------------------
// утилиты
// ------------------------------------------------------------

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function isPortFree(port) {
  return new Promise(function (resolve) {
    const tester = net.createServer();
    tester.once('error', function () { resolve(false); });
    tester.once('listening', function () {
      tester.close(function () { resolve(true); });
    });
    tester.listen(port, HOST);
  });
}

async function findFreePort() {
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error('Нет свободного порта в диапазоне ' + PORT_MIN + '-' + PORT_MAX);
}

function safeName(name) {
  const base = path.basename(String(name || '').trim())
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_');
  if (!base || base === '.' || base === '..') return '';
  return base;
}

// строит базовый settings.json по списку svg-файлов в папке объекта
function buildDefaultSettings(name, svgs) {
  const parts = svgs.map(function (file) {
    const id = file.replace(/\.svg$/i, '');
    return {
      id:         id,
      file:       file,
      parent:     null,
      pivot:      { x: 0.5, y: 0.5 },
      transform:  {
        position: { x: 0, y: 0 },
        rotation: 0,
        scale:    { x: 1, y: 1 },
        skew:     { x: 0, y: 0 }
      },
      visible:    true,
      opacity:    1
    };
  });

  return {
    version:    1,
    name:       name,
    fps:        60,
    frame:      { width: 512, height: 512, background: 'grid' },
    clip:       { pivot: { x: 0.5, y: 0.5 } },
    parts:      parts,
    animations: [
      {
        name:     'idle',
        duration: 1.0,
        loop:     true,
        tracks:   []
      }
    ]
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.glb':  'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.txt':  'text/plain; charset=utf-8'
};

function send(res, status, body, headers) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, headers || {});
  res.writeHead(status, h);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function sendFile(res, filePath) {
  fs.stat(filePath, function (err, st) {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function readBody(req, cb) {
  let chunks = [];
  let size = 0;
  const LIMIT = 200 * 1024 * 1024; // 200 MB
  req.on('data', function (c) {
    size += c.length;
    if (size > LIMIT) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () {
    cb(null, Buffer.concat(chunks).toString('utf8'));
  });
  req.on('error', function (e) { cb(e); });
}

// ------------------------------------------------------------
// API-роуты
// ------------------------------------------------------------

function apiObjects(req, res) {
  try {
    const items = fs.readdirSync(ANIM_DIR, { withFileTypes: true })
      .filter(function (d) { return d.isDirectory(); })
      .map(function (d) { return d.name; })
      .sort(function (a, b) { return a.localeCompare(b); });
    sendJson(res, 200, items);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

function apiObjectGet(req, res, name) {
  const safe = safeName(name);
  const dir = path.join(ANIM_DIR, safe);
  let st;
  try { st = fs.statSync(dir); } catch (e) { st = null; }
  if (!st || !st.isDirectory()) return sendJson(res, 404, { error: 'Объект не найден' });

  try {
    const files = fs.readdirSync(dir);
    const svgs = files.filter(function (f) {
      return f.toLowerCase().endsWith('.svg');
    });

    const settingsPath = path.join(dir, 'settings.json');
    let settings = null;

    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch (e) {
        // файл повреждён — не падаем, а пересоздаём базовый
        console.warn('[settings] damaged, regenerating: ' + settingsPath + ' (' + e.message + ')');
        settings = null;
      }
    }

    if (!settings) {
      settings = buildDefaultSettings(safe, svgs);
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
      console.log('[settings] created: ' + path.relative(ROOT, settingsPath) +
                  ' (' + svgs.length + ' parts)');
    }

    sendJson(res, 200, { name: safe, svgs: svgs, settings: settings });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

function apiObjectSave(req, res, name) {
  const safe = safeName(name);
  const dir = path.join(ANIM_DIR, safe);
  let st;
  try { st = fs.statSync(dir); } catch (e) { st = null; }
  if (!st || !st.isDirectory()) return sendJson(res, 404, { error: 'Объект не найден' });

  readBody(req, function (err, body) {
    if (err) return sendJson(res, 400, { error: err.message });
    let data;
    try { data = JSON.parse(body); }
    catch (e) { return sendJson(res, 400, { error: 'Невалидный JSON: ' + e.message }); }

    try {
      const settingsPath = path.join(dir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf8');
      sendJson(res, 200, { ok: true, path: path.relative(ROOT, settingsPath) });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
}

function listAnimObjectNames() {
  if (!fs.existsSync(ANIM_DIR)) return [];
  return fs.readdirSync(ANIM_DIR, { withFileTypes: true })
    .filter(function (d) { return d.isDirectory() && !d.name.startsWith('.'); })
    .map(function (d) { return d.name; });
}

function resolveAutoNameServer(prefix) {
  const used = new Set(listAnimObjectNames());
  let idx = 0;
  while (used.has(prefix + idx)) idx++;
  return prefix + idx;
}

function resolveCloneNameServer(sourceName) {
  const used = new Set(listAnimObjectNames());
  const stem = String(sourceName || 'object').replace(/_clone_\d+$/, '');
  let idx = 0;
  while (used.has(stem + '_clone_' + idx)) idx++;
  return stem + '_clone_' + idx;
}

function apiObjectCreate(req, res) {
  readBody(req, function (err, body) {
    if (err) return sendJson(res, 400, { error: err.message });
    let data;
    try { data = JSON.parse(body || '{}'); }
    catch (e) { return sendJson(res, 400, { error: 'Невалидный JSON' }); }

    const candidate = data.name ? safeName(data.name) : resolveAutoNameServer('untitled_');
    if (!candidate) return sendJson(res, 400, { error: 'Некорректное имя объекта' });

    const dir = path.join(ANIM_DIR, candidate);
    if (fs.existsSync(dir)) {
      return sendJson(res, 409, { error: 'Объект «' + candidate + '» уже существует' });
    }

    try {
      fs.mkdirSync(dir, { recursive: true });
      const settings = buildDefaultSettings(candidate, []);
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
      sendJson(res, 200, { ok: true, name: candidate });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
}

function apiObjectClone(req, res, srcName) {
  const safeSrc = safeName(srcName);
  if (!safeSrc) return sendJson(res, 400, { error: 'Некорректное имя исходного объекта' });
  const srcDir = path.join(ANIM_DIR, safeSrc);
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    return sendJson(res, 404, { error: 'Исходный объект не найден' });
  }

  readBody(req, function (err, body) {
    if (err) return sendJson(res, 400, { error: err.message });
    let data;
    try { data = JSON.parse(body || '{}'); }
    catch (e) { return sendJson(res, 400, { error: 'Невалидный JSON' }); }

    const safeDst = data.newName ? safeName(data.newName) : resolveCloneNameServer(safeSrc);
    if (!safeDst) return sendJson(res, 400, { error: 'Некорректное имя клона' });
    const dstDir = path.join(ANIM_DIR, safeDst);
    if (fs.existsSync(dstDir)) {
      return sendJson(res, 409, { error: 'Объект «' + safeDst + '» уже существует' });
    }

    try {
      fs.mkdirSync(dstDir, { recursive: true });
      const files = fs.readdirSync(srcDir, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile()) continue;
        fs.copyFileSync(path.join(srcDir, f.name), path.join(dstDir, f.name));
      }
      const settingsPath = path.join(dstDir, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        try {
          const stObj = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          stObj.name = safeDst;
          fs.writeFileSync(settingsPath, JSON.stringify(stObj, null, 2), 'utf8');
        } catch (_) {}
      }
      sendJson(res, 200, { ok: true, name: safeDst });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
}

function apiObjectRename(req, res, oldName) {
  const safeOld = safeName(oldName);
  if (!safeOld) return sendJson(res, 400, { error: 'Некорректное имя объекта' });
  const oldDir = path.join(ANIM_DIR, safeOld);
  if (!fs.existsSync(oldDir) || !fs.statSync(oldDir).isDirectory()) {
    return sendJson(res, 404, { error: 'Объект не найден' });
  }

  readBody(req, function (err, body) {
    if (err) return sendJson(res, 400, { error: err.message });
    let data;
    try { data = JSON.parse(body || '{}'); }
    catch (e) { return sendJson(res, 400, { error: 'Невалидный JSON' }); }

    const safeNew = safeName(data.newName);
    if (!safeNew) return sendJson(res, 400, { error: 'Некорректное новое имя' });
    if (safeNew === safeOld) return sendJson(res, 200, { ok: true, name: safeNew });

    const newDir = path.join(ANIM_DIR, safeNew);
    if (fs.existsSync(newDir)) {
      return sendJson(res, 409, { error: 'Объект «' + safeNew + '» уже существует' });
    }

    try {
      fs.renameSync(oldDir, newDir);
      const settingsPath = path.join(newDir, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        try {
          const stObj = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          stObj.name = safeNew;
          fs.writeFileSync(settingsPath, JSON.stringify(stObj, null, 2), 'utf8');
        } catch (_) {}
      }
      sendJson(res, 200, { ok: true, name: safeNew });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
}

function apiObjectDelete(req, res, name) {
  const safe = safeName(name);
  if (!safe) return sendJson(res, 400, { error: 'Некорректное имя объекта' });
  const dir = path.join(ANIM_DIR, safe);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return sendJson(res, 404, { error: 'Объект не найден' });
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

const PRESETS_FILE = path.join(ROOT, 'presets.json');

function apiPresetsGet(req, res) {
  try {
    if (!fs.existsSync(PRESETS_FILE)) {
      return sendJson(res, 200, { version: 1, presets: [] });
    }
    const raw = fs.readFileSync(PRESETS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    sendJson(res, 200, parsed);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

function apiPresetsSave(req, res) {
  readBody(req, function (err, body) {
    if (err) return sendJson(res, 400, { error: err.message });
    let data;
    try { data = JSON.parse(body); }
    catch (e) { return sendJson(res, 400, { error: 'Невалидный JSON: ' + e.message }); }
    try {
      fs.writeFileSync(PRESETS_FILE, JSON.stringify(data, null, 2), 'utf8');
      sendJson(res, 200, { ok: true, path: 'presets.json' });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
}

// ------------------------------------------------------------
// API сцен (stage/)
// ------------------------------------------------------------

function buildDefaultStage(name) {
  return {
    version: 1,
    name: name,
    frame: { width: 1366, height: 768 },
    background: {
      color: '#243447',
      file: '',
      fit: 'stretch',
      opacity: 1
    },
    items: []
  };
}

function listStageNames() {
  ensureDir(STAGE_DIR);
  return fs.readdirSync(STAGE_DIR, { withFileTypes: true })
    .filter(function (d) { return d.isDirectory() && !d.name.startsWith('.'); })
    .map(function (d) { return d.name; })
    .sort(function (a, b) { return a.localeCompare(b); });
}

function listStageAssetsInDir(dir) {
  return fs.readdirSync(dir)
    .filter(function (f) { return /\.(svg|png|jpe?g|webp|gif)$/i.test(f); })
    .sort(function (a, b) { return a.localeCompare(b); });
}

function apiStages(req, res) {
  try {
    sendJson(res, 200, listStageNames());
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

function apiStageGet(req, res, name) {
  const safe = safeName(name);
  if (!safe) return sendJson(res, 400, { error: 'Некорректное имя сцены' });
  const dir = path.join(STAGE_DIR, safe);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return sendJson(res, 404, { error: 'Сцена не найдена' });
  }

  try {
    const assets = listStageAssetsInDir(dir);
    const stagePath = path.join(dir, 'stage.json');
    let stageData = null;
    if (fs.existsSync(stagePath)) {
      stageData = JSON.parse(fs.readFileSync(stagePath, 'utf8'));
    } else {
      stageData = buildDefaultStage(safe);
      fs.writeFileSync(stagePath, JSON.stringify(stageData, null, 2), 'utf8');
    }
    sendJson(res, 200, { name: safe, assets: assets, stage: stageData });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

function apiStageSave(req, res, name) {
  const safe = safeName(name);
  if (!safe) return sendJson(res, 400, { error: 'Некорректное имя сцены' });
  const dir = path.join(STAGE_DIR, safe);
  ensureDir(dir);
  readBody(req, function (err, body) {
    if (err) return sendJson(res, 400, { error: err.message });
    let data;
    try { data = JSON.parse(body); }
    catch (e) { return sendJson(res, 400, { error: 'Невалидный JSON: ' + e.message }); }
    try {
      const stagePath = path.join(dir, 'stage.json');
      fs.writeFileSync(stagePath, JSON.stringify(data, null, 2), 'utf8');
      sendJson(res, 200, { ok: true, path: path.relative(ROOT, stagePath) });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
}

function apiStageCreate(req, res) {
  readBody(req, function (err, body) {
    if (err) return sendJson(res, 400, { error: err.message });
    let data;
    try { data = JSON.parse(body || '{}'); }
    catch (e) { return sendJson(res, 400, { error: 'Невалидный JSON' }); }

    const used = new Set(listStageNames());
    let candidate = data.name ? safeName(data.name) : '';
    if (!candidate) {
      let idx = 0;
      while (used.has('untitled_' + idx)) idx++;
      candidate = 'untitled_' + idx;
    }
    const dir = path.join(STAGE_DIR, candidate);
    if (fs.existsSync(dir)) {
      return sendJson(res, 409, { error: 'Сцена «' + candidate + '» уже существует' });
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const stageData = buildDefaultStage(candidate);
      fs.writeFileSync(path.join(dir, 'stage.json'), JSON.stringify(stageData, null, 2), 'utf8');
      sendJson(res, 200, { ok: true, name: candidate });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
}

function apiStageClone(req, res, srcName) {
  const safeSrc = safeName(srcName);
  if (!safeSrc) return sendJson(res, 400, { error: 'Некорректное имя сцены' });
  const srcDir = path.join(STAGE_DIR, safeSrc);
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    return sendJson(res, 404, { error: 'Исходная сцена не найдена' });
  }

  readBody(req, function (err, body) {
    if (err) return sendJson(res, 400, { error: err.message });
    let data;
    try { data = JSON.parse(body || '{}'); }
    catch (e) { return sendJson(res, 400, { error: 'Невалидный JSON' }); }

    const used = new Set(listStageNames());
    let safeDst = data.newName ? safeName(data.newName) : '';
    if (!safeDst) {
      const stem = String(safeSrc).replace(/_clone_\d+$/, '');
      let idx = 0;
      while (used.has(stem + '_clone_' + idx)) idx++;
      safeDst = stem + '_clone_' + idx;
    }
    const dstDir = path.join(STAGE_DIR, safeDst);
    if (fs.existsSync(dstDir)) {
      return sendJson(res, 409, { error: 'Сцена «' + safeDst + '» уже существует' });
    }

    try {
      fs.mkdirSync(dstDir, { recursive: true });
      const files = fs.readdirSync(srcDir, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile()) continue;
        fs.copyFileSync(path.join(srcDir, f.name), path.join(dstDir, f.name));
      }
      const stPath = path.join(dstDir, 'stage.json');
      if (fs.existsSync(stPath)) {
        try {
          const stObj = JSON.parse(fs.readFileSync(stPath, 'utf8'));
          stObj.name = safeDst;
          fs.writeFileSync(stPath, JSON.stringify(stObj, null, 2), 'utf8');
        } catch (_) {}
      }
      sendJson(res, 200, { ok: true, name: safeDst });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
}

function apiStageRename(req, res, oldName) {
  const safeOld = safeName(oldName);
  if (!safeOld) return sendJson(res, 400, { error: 'Некорректное имя сцены' });
  const oldDir = path.join(STAGE_DIR, safeOld);
  if (!fs.existsSync(oldDir) || !fs.statSync(oldDir).isDirectory()) {
    return sendJson(res, 404, { error: 'Сцена не найдена' });
  }

  readBody(req, function (err, body) {
    if (err) return sendJson(res, 400, { error: err.message });
    let data;
    try { data = JSON.parse(body || '{}'); }
    catch (e) { return sendJson(res, 400, { error: 'Невалидный JSON' }); }

    const safeNew = safeName(data.newName);
    if (!safeNew) return sendJson(res, 400, { error: 'Некорректное новое имя' });
    if (safeNew === safeOld) return sendJson(res, 200, { ok: true, name: safeNew });

    const newDir = path.join(STAGE_DIR, safeNew);
    if (fs.existsSync(newDir)) {
      return sendJson(res, 409, { error: 'Сцена «' + safeNew + '» уже существует' });
    }

    try {
      fs.renameSync(oldDir, newDir);
      const stPath = path.join(newDir, 'stage.json');
      if (fs.existsSync(stPath)) {
        try {
          const stObj = JSON.parse(fs.readFileSync(stPath, 'utf8'));
          stObj.name = safeNew;
          fs.writeFileSync(stPath, JSON.stringify(stObj, null, 2), 'utf8');
        } catch (_) {}
      }
      sendJson(res, 200, { ok: true, name: safeNew });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
}

function apiStageDelete(req, res, name) {
  const safe = safeName(name);
  if (!safe) return sendJson(res, 400, { error: 'Некорректное имя сцены' });
  const dir = path.join(STAGE_DIR, safe);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return sendJson(res, 404, { error: 'Сцена не найдена' });
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    sendJson(res, 200, { ok: true, name: safe });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

function apiStageUploadAsset(req, res, name) {
  const safe = safeName(name);
  if (!safe) return sendJson(res, 400, { error: 'Некорректное имя сцены' });
  const dir = path.join(STAGE_DIR, safe);
  ensureDir(dir);
  readBody(req, function (err, body) {
    if (err) return sendJson(res, 400, { error: err.message });
    let data;
    try { data = JSON.parse(body || '{}'); }
    catch (e) { return sendJson(res, 400, { error: 'Невалидный JSON' }); }

    const fileName = safeName(data.fileName);
    if (!fileName || !/\.(svg|png|jpe?g|webp|gif)$/i.test(fileName)) {
      return sendJson(res, 400, { error: 'Поддерживаются файлы SVG, PNG, JPG, WebP, GIF' });
    }
    try {
      const targetPath = path.join(dir, fileName);
      if (typeof data.dataBase64 === 'string' && data.dataBase64.length > 0) {
        fs.writeFileSync(targetPath, Buffer.from(data.dataBase64, 'base64'));
      } else if (typeof data.dataUrl === 'string' && data.dataUrl.indexOf('base64,') >= 0) {
        const b64 = data.dataUrl.split('base64,')[1];
        fs.writeFileSync(targetPath, Buffer.from(b64, 'base64'));
      } else if (typeof data.text === 'string') {
        fs.writeFileSync(targetPath, data.text, 'utf8');
      } else {
        return sendJson(res, 400, { error: 'Пустое содержимое файла' });
      }
      sendJson(res, 200, { ok: true, fileName: fileName, assets: listStageAssetsInDir(dir) });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
}

// ------------------------------------------------------------
// роутер
// ------------------------------------------------------------

function handle(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);
  const method = req.method;

  // --- API ---
  if (pathname === '/api/objects' && method === 'GET') {
    return apiObjects(req, res);
  }

  if (pathname === '/api/objects/create' && method === 'POST') {
    return apiObjectCreate(req, res);
  }

  if (pathname === '/api/stages' && method === 'GET') {
    return apiStages(req, res);
  }

  if (pathname === '/api/stages/create' && method === 'POST') {
    return apiStageCreate(req, res);
  }

  if (pathname === '/api/presets' && method === 'GET') {
    return apiPresetsGet(req, res);
  }

  if (pathname === '/api/presets' && method === 'POST') {
    return apiPresetsSave(req, res);
  }

  let m = pathname.match(/^\/api\/object\/([^\/]+)$/);
  if (m && method === 'GET') {
    return apiObjectGet(req, res, m[1]);
  }

  m = pathname.match(/^\/api\/object\/([^\/]+)\/save$/);
  if (m && method === 'POST') {
    return apiObjectSave(req, res, m[1]);
  }

  m = pathname.match(/^\/api\/object\/([^\/]+)\/clone$/);
  if (m && method === 'POST') {
    return apiObjectClone(req, res, m[1]);
  }

  m = pathname.match(/^\/api\/object\/([^\/]+)\/rename$/);
  if (m && method === 'POST') {
    return apiObjectRename(req, res, m[1]);
  }

  m = pathname.match(/^\/api\/object\/([^\/]+)\/delete$/);
  if (m && method === 'POST') {
    return apiObjectDelete(req, res, m[1]);
  }

  m = pathname.match(/^\/api\/stage\/([^\/]+)$/);
  if (m && method === 'GET') {
    return apiStageGet(req, res, m[1]);
  }

  m = pathname.match(/^\/api\/stage\/([^\/]+)\/save$/);
  if (m && method === 'POST') {
    return apiStageSave(req, res, m[1]);
  }

  m = pathname.match(/^\/api\/stage\/([^\/]+)\/clone$/);
  if (m && method === 'POST') {
    return apiStageClone(req, res, m[1]);
  }

  m = pathname.match(/^\/api\/stage\/([^\/]+)\/rename$/);
  if (m && method === 'POST') {
    return apiStageRename(req, res, m[1]);
  }

  m = pathname.match(/^\/api\/stage\/([^\/]+)\/delete$/);
  if (m && method === 'POST') {
    return apiStageDelete(req, res, m[1]);
  }

  m = pathname.match(/^\/api\/stage\/([^\/]+)\/upload$/);
  if (m && method === 'POST') {
    return apiStageUploadAsset(req, res, m[1]);
  }

  // --- API 3D-персонажей (char3d/) ---
  if (pathname === '/api/chars3d' && method === 'GET') {
    ensureDir(CHAR3D_DIR);
    const list = fs.readdirSync(CHAR3D_DIR, { withFileTypes: true })
      .filter(function (d) { return d.isDirectory(); })
      .map(function (d) { return d.name; })
      .sort();
    return sendJson(res, 200, { characters: list });
  }

  m = pathname.match(/^\/api\/char3d\/([^\/]+)$/);
  if (m && method === 'GET') {
    const safe = safeName(decodeURIComponent(m[1]));
    if (!safe) return sendJson(res, 400, { error: 'Некорректное имя' });
    const fp = path.join(CHAR3D_DIR, safe, 'character.json');
    if (!fs.existsSync(fp)) return sendJson(res, 404, { error: '3D-персонаж не найден' });
    try {
      const ch = JSON.parse(fs.readFileSync(fp, 'utf8'));
      return sendJson(res, 200, { character: ch });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  m = pathname.match(/^\/api\/char3d\/([^\/]+)\/save$/);
  if (m && method === 'POST') {
    const safe = safeName(decodeURIComponent(m[1]));
    if (!safe) return sendJson(res, 400, { error: 'Некорректное имя' });
    return readBody(req, function (err, body) {
      if (err) return sendJson(res, 400, { error: err.message });
      try {
        const obj = JSON.parse(body || '{}');
        obj.name = safe;
        const dir = path.join(CHAR3D_DIR, safe);
        ensureDir(dir);
        fs.writeFileSync(path.join(dir, 'character.json'), JSON.stringify(obj, null, 2), 'utf8');
        // Обновляем char3d/index.json для статического хостинга (GitHub Pages)
        const list = fs.readdirSync(CHAR3D_DIR, { withFileTypes: true })
          .filter(function (d) { return d.isDirectory(); })
          .map(function (d) { return d.name; })
          .sort();
        fs.writeFileSync(path.join(CHAR3D_DIR, 'index.json'), JSON.stringify({ characters: list }, null, 2), 'utf8');
        sendJson(res, 200, { ok: true, name: safe });
      } catch (e) {
        sendJson(res, 400, { error: 'Невалидный JSON: ' + e.message });
      }
    });
  }

  if (pathname.indexOf('/api/') === 0) {
    return sendJson(res, 404, { error: 'API not found: ' + pathname });
  }

  // --- статика ---
  if (method !== 'GET' && method !== 'HEAD') {
    return send(res, 405, 'Method not allowed');
  }

  // защита от traversal
  let rel = pathname.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const filePath = path.resolve(ROOT, rel);
  if (filePath.indexOf(ROOT) !== 0) return send(res, 403, 'Forbidden');

  // если каталог — ищем index.html внутри
  fs.stat(filePath, function (err, st) {
    if (!err && st.isDirectory()) {
      return sendFile(res, path.join(filePath, 'index.html'));
    }
    sendFile(res, filePath);
  });
}

// ------------------------------------------------------------
// main
// ------------------------------------------------------------

async function main() {
  ensureDir(ANIM_DIR);
  ensureDir(STAGE_DIR);
  ensureDir(CHAR3D_DIR);

  const PORT = await findFreePort();

  const server = http.createServer(function (req, res) {
    try { handle(req, res); }
    catch (e) {
      console.error('Handler error:', e);
      try { sendJson(res, 500, { error: e.message }); } catch (_) {}
    }
  });

  server.on('error', function (e) {
    console.error('Server error:', e);
    process.exit(1);
  });

  server.listen(PORT, HOST, function () {
    fs.writeFileSync(PORT_FILE, String(PORT), 'utf8');
    console.log('');
    console.log('  Animation Editor server');
    console.log('  ------------------------------');
    console.log('  URL:      http://localhost:' + PORT + '/');
    console.log('  ROOT:     ' + ROOT);
    console.log('  ANIM:     ' + ANIM_DIR);
    console.log('  PORTFILE: ' + PORT_FILE);
    console.log('');
  });

  function cleanup() {
    try { if (fs.existsSync(PORT_FILE)) fs.unlinkSync(PORT_FILE); } catch (_) {}
  }
  process.on('exit', cleanup);
  process.on('SIGINT',  function () { cleanup(); process.exit(0); });
  process.on('SIGTERM', function () { cleanup(); process.exit(0); });
  process.on('uncaughtException', function (err) {
    console.error('Uncaught:', err);
    cleanup();
    process.exit(1);
  });
}

main().catch(function (err) {
  console.error('Fatal:', err);
  process.exit(1);
});