'use strict';

const engine = require('../../engines/prometheus/src/index.js');
const { header } = require('../brand');

const text = (list) => (list || []).map((item) => {
  const where = item.step ? `[${item.step}] ` : '';
  return `${where}${item.message}`;
});

// Reserved words that cannot continue `local name, ... = ...`. `function` is
// deliberately absent: `local function f()` is valid even across a newline.
const BLOCK_CONTINUATION = /^(?:and|break|do|else|elseif|end|false|for|goto|if|in|local|nil|not|or|repeat|return|then|true|until|while|continue)\b/;
const IDENTIFIER_START = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Safety net for a partially applied 09-fmt pass. A formatter crash used to
 * leave a bare `local` behind, which is invalid Lua. We only drop the line
 * when the following statement cannot legally continue the declaration, so a
 * genuine `local\n  name = value` is preserved.
 */
function sanitize(code) {
  const lines = code.split('\n');
  const out = [];
  let dropped = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^[ \t]*local[ \t]*$/.test(lines[i])) {
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next += 1;
      const following = next < lines.length ? lines[next].trim() : '';
      if (!IDENTIFIER_START.test(following) || BLOCK_CONTINUATION.test(following)) {
        dropped += 1;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return {
    code: out.join('\n').replace(/\n{3,}/g, '\n\n'),
    dropped,
  };
}

/**
 * Prometheus obfuscator (VM + constant encryption). The vendored engine is a
 * pure-JS pipeline, so it runs inline. Detection is its own scoring model and
 * needs the parsed chunk for its shape signals, so we go through the engine's
 * public entry point instead of calling identify() by hand.
 */
function deobfuscatePrometheus(source) {
  let result;
  try {
    result = engine.deobfuscate(source, { detect: true });
  } catch (err) {
    if (err.name === 'NotPrometheusError') {
      return {
        ok: false,
        error: 'Bukan payload Prometheus.',
        detail: (err.report && err.report.reasons || []).join('; '),
      };
    }
    return { ok: false, error: 'Engine Prometheus gagal: ' + err.message };
  }

  const report = result.detected || { evidence: [], weight: 0 };

  if (!result.code || !result.code.trim()) {
    return { ok: false, error: 'Engine Prometheus menghasilkan output kosong.' };
  }

  const s = result.stats || {};
  const strings = s['decrypt.strings'] || 0;
  const constants = s['fold.count'] || 0;
  const functions = s['devirtualize.functions'] || 0;
  const blocks = s['devirtualize.blocks'] || 0;

  const clean = sanitize(result.code);
  const warnings = text(result.warnings);
  if (clean.dropped) {
    warnings.push(`Sanitizer menghapus ${clean.dropped} deklarasi local kosong dari output engine.`);
  }

  return {
    ok: true,
    code: header([
      ['engine', 'Prometheus (vendored engine)'],
      ['stats', `${strings} string · ${functions} fungsi · ${blocks} blok`],
    ]) + clean.code,
    stats: {
      profile: 'prometheus',
      replaced: strings,
      uniqueStrings: strings,
      tableEntries: s['decrypt.constants'] || 0,
      constantsFolded: constants,
      identifiersRenamed: 0,
      semanticNames: 0,
      functions,
      blocks,
      inputBytes: Buffer.byteLength(source, 'latin1'),
      outputBytes: Buffer.byteLength(clean.code, 'utf8'),
    },
    fingerprint: {
      profile: 'prometheus',
      layers: s['decrypt.preludeRemoved'] || 0,
      evidence: (report.evidence || []).map((e) => e.label).join(', '),
      weight: report.weight,
    },
    notes: warnings,
  };
}

module.exports = { deobfuscatePrometheus };
