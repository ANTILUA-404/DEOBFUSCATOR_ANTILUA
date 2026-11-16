'use strict';

/**
 * Structural Luraph fingerprints for payloads whose header comment was
 * stripped (or rewritten by a loader). Derived from real samples in
 * terrorlua/obfuscator-samples; validated against v14.3, v14.7 x2, v15.0 x2,
 * v15.1 x3, Prometheus and the NXS9 fixture. No signature matched a non-Luraph
 * sample in that set.
 *
 * This only classifies. It never claims that a VM was successfully lifted.
 */

// v14.3 / v14.7: `return(function()local a,b,c=string.byte,string.sub,...`
const V14_VM_ENTRY = /return\s*\(\s*function\s*\(\s*\)\s*local\s+[\w,]+\s*=\s*string\.(?:byte|char)/;
// v14.7 "lura.phz" build: API names hidden as hex escapes behind getfenv().
const V14_HEX_API = /getfenv\(\)\s*\[\s*"\\x[0-9a-fA-F]{2}\\x[0-9a-fA-F]{2}/;
const LPH_MARKER = /\[=*\[LPH:/;
const LOADSTRING = /\bloadstring\b/;
// v15 VM chunk root. The vendored detector normally catches this; it is kept
// here as a fallback for chunks whose constant table shape differs.
const V15_VM_ROOT = /return\s*setmetatable\s*\(\s*\{/;
const VM_TABLE_HINT = /\[\d+\]\s*=\s*(?:bit32|buffer|string|table|math)\.\w+|setmetatable\s*\(|loadstring/;

/**
 * @returns {{match: boolean, kind: 'v14'|'v15'|null, confidence: number, evidence: string}}
 */
function detectPattern(source) {
  const text = String(source || '');
  const head = text.slice(0, 65536);
  const empty = { match: false, kind: null, confidence: 0, evidence: '' };

  const v14Entry = V14_VM_ENTRY.test(head);
  const v14Hex = V14_HEX_API.test(head);
  const lph = LPH_MARKER.test(head);
  const loadstring = LOADSTRING.test(head);

  if (v14Hex || (v14Entry && loadstring) || (lph && loadstring && !V15_VM_ROOT.test(head))) {
    const evidence = [
      v14Entry && 'vm-entry',
      v14Hex && 'hex-escaped-api',
      lph && 'LPH-marker',
      loadstring && 'loadstring',
    ].filter(Boolean).join('+');
    return { match: true, kind: 'v14', confidence: v14Hex ? 0.75 : 0.7, evidence };
  }

  if (V15_VM_ROOT.test(head)) {
    const at = head.search(V15_VM_ROOT);
    const around = text.slice(at, at + 20000);
    if (VM_TABLE_HINT.test(around)) {
      return { match: true, kind: 'v15', confidence: 0.65, evidence: 'vm-root' };
    }
  }

  return empty;
}

module.exports = { detectPattern };
