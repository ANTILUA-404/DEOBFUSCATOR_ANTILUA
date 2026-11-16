'use strict';

const engine = require('../../engines/prometheus/src/index.js');
const { header } = require('../brand');

const text = (list) => (list || []).map((item) => {
  const where = item.step ? `[${item.step}] ` : '';
  return `${where}${item.message}`;
});

/**
 * Prometheus obfuscator (VM + constant encryption). The vendored engine is a
 * pure-JS pipeline, so it runs inline. Detection is its own scoring model —
 * we never force it, because a wrong match would mangle unrelated code.
 */
function deobfuscatePrometheus(source) {
  let report;
  try {
    report = engine.identify(source, null);
  } catch (err) {
    return { ok: false, error: 'Deteksi Prometheus gagal: ' + err.message };
  }

  if (!report.prometheus) {
    return {
      ok: false,
      error: 'Bukan payload Prometheus.',
      detail: report.reasons.join('; '),
    };
  }

  let result;
  try {
    result = engine.deobfuscate(source, { detect: false });
  } catch (err) {
    return {
      ok: false,
      error: 'Engine Prometheus gagal: ' + err.message,
      detail: report.reasons.join('; '),
    };
  }

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
