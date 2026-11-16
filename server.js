'use strict';

/**
 * ANTILUA DEOBFUSCATOR — HTTP service.
 *
 * Inline engines (NXS9, dispatcher, Prometheus, constant-only) answer in one
 * request. Luraph runs a sandboxed trace for minutes, so it is scheduled as a
 * job and polled instead of blocking the socket.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const deob = require('./lib/deob');
const jobs = require('./lib/jobs');
const luraph = require('./lib/profiles/luraph');
const brand = require('./lib/brand');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 24 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Payload terlalu besar (maks 24 MB).')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const ENGINES = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'luraph', label: 'Luraph v15 / v15.1' },
  { id: 'prometheus', label: 'Prometheus' },
  { id: 'studiodev57', label: 'NXS9 / StudioDev57' },
  { id: 'dispatcher', label: 'Norev dispatcher family' },
  { id: 'plain', label: 'Constant-only' },
];

function engineList() {
  const status = luraph.status();
  return ENGINES.map((e) => ({
    ...e,
    ready: e.id === 'luraph' ? status.ready : true,
    note: e.id === 'luraph' && !status.ready ? status.reason : undefined,
  }));
}

function runInline(source, engine) {
  switch (engine) {
    case 'studiodev57': return deob.deobfuscateStudioDev57(source);
    case 'dispatcher': return deob.deobfuscateDispatcher(source);
    case 'prometheus': return deob.deobfuscatePrometheus(source);
    case 'plain': return deob.deobfuscatePlain(source);
    default: return deob.deobfuscate(source);
  }
}

function handleDeobfuscate(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Gunakan POST.' });

  readBody(req).then((raw) => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message || 'Body tidak valid.' });
    }

    const source = payload && payload.source;
    if (typeof source !== 'string' || !source.trim()) {
      return sendJson(res, 400, { ok: false, error: 'Field "source" kosong.' });
    }

    const requested = typeof payload.engine === 'string' ? payload.engine : 'auto';
    const detection = luraph.detectEngine(source);
    const wantsLuraph = requested === 'luraph'
      || (requested === 'auto' && detection.match);

    if (wantsLuraph) {
      if (detection.unsupported) {
        return sendJson(res, 422, {
          ok: false,
          error: `Luraph v${detection.version} terdeteksi, tapi deobfuscator v14 belum tersedia di build ini.`,
          detail: luraph.V14_NOTE + ' Engine yang tersedia hanya v15 / v15.1.',
        });
      }

      const status = luraph.status();
      if (!status.ready) {
        return sendJson(res, 503, {
          ok: false,
          error: 'Engine Luraph belum siap di server ini.',
          detail: status.reason,
        });
      }

      const job = jobs.create('luraph', (log) => luraph.deobfuscateLuraph(source, {
        onLog: log,
        version: detection.version,
        confidence: detection.confidence,
      }));

      return sendJson(res, 202, {
        ok: true,
        queued: true,
        jobId: job.id,
        engine: 'luraph',
        detection,
      });
    }

    try {
      const t0 = Date.now();
      const result = runInline(source, requested);
      result.elapsedMs = Date.now() - t0;
      return sendJson(res, result.ok ? 200 : 422, result);
    } catch (err) {
      console.error('[deob] crash:', err);
      return sendJson(res, 500, {
        ok: false,
        error: 'Terjadi kesalahan internal saat memproses script.',
        detail: err.message,
      });
    }
  }).catch((err) => {
    sendJson(res, 400, { ok: false, error: err.message || 'Body tidak valid.' });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      brand: brand.NAME,
      uptime: process.uptime(),
      engines: engineList(),
      jobs: jobs.stats(),
    });
  }

  if (p === '/api/engines') return sendJson(res, 200, { ok: true, engines: engineList() });

  if (p === '/api/deobfuscate') return handleDeobfuscate(req, res);

  if (p.startsWith('/api/jobs/')) {
    const job = jobs.get(p.slice('/api/jobs/'.length));
    if (!job) return sendJson(res, 404, { ok: false, error: 'Job tidak ditemukan atau sudah kedaluwarsa.' });
    return sendJson(res, 200, { ok: true, ...jobs.view(job) });
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`${brand.NAME} listening on http://${HOST}:${PORT}`);
  const status = luraph.status();
  console.log(status.ready
    ? `Luraph engine ready (${status.platform}, ${status.python})`
    : `Luraph engine unavailable: ${status.reason}`);
});

process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
