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

const ROOT      = __dirname;
const ANIM_DIR  = path.join(ROOT, 'anim');
const PORT_FILE = path.join(ROOT, 'port.txt');

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
  return path.basename(String(name || '')).replace(/[^\w\-. ]+/g, '_');
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