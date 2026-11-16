'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { detect } = require('../../engines/luraph/src/detect');
const { detectPattern } = require('./luraph-pattern');
const { header } = require('../brand');

const ENGINE_DIR = path.join(__dirname, '..', '..', 'engines', 'luraph');
const CLI = path.join(ENGINE_DIR, 'deob.js');
const VERSION_RE = /This file was protected using Luraph Obfuscator v(\d+(?:\.\d+)?)/i;

/**
 * We did test the community v14 engine against two real v14.7 samples from
 * terrorlua/obfuscator-samples (181 KB and 1.2 MB). Both failed to capture any
 * liftable VM function; one returned only an intercepted loadstring chunk that
 * is still VM code, the other produced no source at all. Exposing that engine
 * would look like success while returning obfuscated output, so v14 stays
 * explicitly unsupported. Keep this note in one place for API + inline router.
 */
const V14_NOTE = 'Engine v14 sengaja tidak diaktifkan: dua sample v14.7 nyata (181 KB dan 1,2 MB) gagal didevirtualisasi (0 fungsi VM tertangkap; output hanya trace/chunk VM, bukan source).';

function versionOf(source) {
  const m = VERSION_RE.exec(source.slice(0, 800));
  return m ? m[1] : null;
}

/**
 * The engine's own detector is the authority: it looks at the header comment
 * and at the VM chunk shape. We only add the version string for display.
 */
function detectEngine(source) {
  const version = versionOf(source);

  // v14.x is recognised from its header but the vendored engine only ships the
  // v15 pipeline. Report it as Luraph so it is never handed to the inline
  // formatters, and let the caller explain that the engine is missing.
  if (version && /^14\./.test(version)) {
    return {
      match: true,
      unsupported: true,
      confidence: 0.3,
      plugin: 'luraph_v14',
      label: `Luraph v${version}`,
      version,
    };
  }

  const hit = detect(source);
  if (hit.confidence >= 0.5) {
    return {
      match: true,
      unsupported: false,
      confidence: hit.confidence,
      plugin: hit.plugin.name,
      label: hit.plugin.label,
      version,
    };
  }

  // No header and no vendored-engine match: fall back to structural VM
  // fingerprints. Without this, a headerless v14 payload was handed to the
  // inline formatters and came back mangled instead of being routed to a job.
  const pattern = detectPattern(source);
  if (pattern.match) {
    return {
      match: true,
      unsupported: pattern.kind === 'v14',
      confidence: pattern.confidence,
      plugin: pattern.kind === 'v14' ? 'luraph_v14_pattern' : 'luraph_v15_pattern',
      label: pattern.kind === 'v14'
        ? 'Luraph v14 (VM pattern, tanpa header)'
        : 'Luraph v15 (VM pattern, tanpa header)',
      version,
      detectedByPattern: true,
      evidence: pattern.evidence,
    };
  }

  return {
    match: false,
    unsupported: false,
    confidence: 0,
    plugin: 'generic',
    label: 'unknown obfuscator',
    version,
  };
}

let cached = null;

/** Whether the vendored engine can actually run here (binary + Python present). */
function status() {
  if (cached) return cached;

  const bin = process.platform === 'win32' ? 'luau.exe' : 'luau';
  const binPath = path.join(ENGINE_DIR, 'bin', bin);
  if (!fs.existsSync(binPath)) {
    cached = { ready: false, reason: `binary ${bin} tidak ada di engines/luraph/bin` };
    return cached;
  }

  const python = process.env.PYTHON_BIN
    || (process.platform === 'win32' ? 'python' : 'python3');
  const probe = spawnSync(python, ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    cached = { ready: false, reason: `Python tidak ditemukan (${python})` };
    return cached;
  }

  cached = { ready: true, python, bin: binPath, platform: process.platform };
  return cached;
}

function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
    return;
  }
  try { child.kill('SIGKILL'); } catch {}
}

/**
 * Devirtualize with the vendored Luraph engine. The engine traces the script
 * in an offline Luau sandbox, so this takes minutes on real samples and must
 * run as a job rather than inside a request.
 */
function run(source, options = {}) {
  const {
    timeoutMs = 6 * 60 * 1000,
    budget = 30,
    maxRuns = 6,
    devirtRounds = 80,
    onLog = () => {},
  } = options;

  const st = status();
  if (!st.ready) {
    return Promise.resolve({ ok: false, error: `Engine Luraph belum siap: ${st.reason}` });
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'antilua-luraph-'));
  const input = path.join(work, 'input.luau');
  const output = path.join(work, 'out.luau');
  fs.writeFileSync(input, source, 'latin1');

  const args = [
    CLI, input, '-o', output,
    '--budget', String(budget),
    '--max-runs', String(maxRuns),
    '--devirt-rounds', String(devirtRounds),
  ];

  return new Promise((resolve) => {
    const child = spawn(process.env.NODE_BIN || 'node', args, {
      cwd: ENGINE_DIR,
      windowsHide: true,
      env: { ...process.env, PYTHON_BIN: st.python },
    });

    let log = '';
    let settled = false;
    const started = Date.now();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
      resolve(result);
    };

    const timer = setTimeout(() => {
      killTree(child);
      finish({
        ok: false,
        error: `Engine Luraph melewati batas waktu ${Math.round(timeoutMs / 1000)} detik.`,
        log,
        elapsedMs: Date.now() - started,
      });
    }, timeoutMs);

    const take = (buf) => {
      const text = buf.toString();
      log += text;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) onLog(trimmed);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);

    child.on('error', (err) => {
      finish({ ok: false, error: `Gagal menjalankan engine: ${err.message}`, log });
    });

    child.on('close', (code) => {
      const elapsedMs = Date.now() - started;
      let text = null;
      try { text = fs.readFileSync(output, 'utf8'); } catch {}
      if (!text || !text.trim()) {
        finish({
          ok: false,
          error: `Engine tidak menghasilkan output (exit ${code}). Lihat log untuk tahap yang gagal.`,
          log,
          elapsedMs,
        });
        return;
      }
      finish({ ok: true, code: text, log, elapsedMs });
    });
  });
}

/**
 * Same result shape as the inline profiles, so the client renders one format.
 */
async function deobfuscateLuraph(source, options = {}) {
  const result = await run(source, options);
  if (!result.ok) return result;

  const ms = result.elapsedMs;
  return {
    ok: true,
    code: header([
      ['engine', `Luraph ${options.version ? 'v' + options.version : 'v15 / v15.1'} (devirtualized in an offline Luau sandbox)`],
      ['trace', `${Math.round(ms / 1000)}s`],
    ]) + result.code,
    stats: {
      profile: 'luraph',
      replaced: 0,
      uniqueStrings: 0,
      tableEntries: 0,
      constantsFolded: 0,
      identifiersRenamed: 0,
      semanticNames: 0,
      inputBytes: Buffer.byteLength(source, 'latin1'),
      outputBytes: Buffer.byteLength(result.code, 'utf8'),
      elapsedMs: ms,
    },
    fingerprint: {
      profile: 'luraph',
      engine: 'Luraph v15 engine',
      version: options.version || null,
      confidence: options.confidence ?? null,
    },
    notes: [],
    log: result.log,
  };
}

module.exports = { detectEngine, status, run, deobfuscateLuraph, ENGINE_DIR, V14_NOTE };
