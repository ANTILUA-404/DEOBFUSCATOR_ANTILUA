'use strict';

const engine = require('../../engines/prometheus/src/index.js');
const { header } = require('../brand');

const text = (list) => (list || []).map((item) => {
  const where = item.step ? `[${item.step}] ` : '';
  return `${where}${item.message}`;
});

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

  return {
    ok: true,
    code: header([
      ['engine', 'Prometheus (vendored engine)'],
      ['stats', `${strings} string · ${functions} fungsi · ${blocks} blok`],
    ]) + result.code,
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
      outputBytes: Buffer.byteLength(result.code, 'utf8'),
    },
    fingerprint: {
      profile: 'prometheus',
      layers: s['decrypt.preludeRemoved'] || 0,
      evidence: (report.evidence || []).map((e) => e.label).join(', '),
      weight: report.weight,
    },
    notes: text(result.warnings),
  };
}

module.exports = { deobfuscatePrometheus };
