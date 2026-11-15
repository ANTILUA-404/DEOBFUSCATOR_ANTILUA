'use strict';

/**
 * Profile: "dispatcher" obfuscation (Norev-family).
 *
 * Observed structure (evidence: sample `NorevMusicMain`, 263 KB):
 *
 *   local FWD = function(i, ...) return DISPATCH[i](...) end        -- forwarding shim
 *   DISPATCH = {
 *     [66] = function(index)                                        -- string getter (cached)
 *       local e = STRINGS[index]
 *       if e[1] == 76 then return decA(e[2], e[3]) else return decB(e[2], e[3]) end
 *     end,
 *     ...
 *   }
 *   STRINGS = { [<obf-expr>] = { <sel>, "<cipher>", <key> }, ... }
 *
 *   decA: key = (key*73 + 40 + j*25) % 256 ; out = bxor(byte, key, (j*6  + 34 ) % 256)
 *   decB: key = (key*37 + 107 + j*30) % 256 ; out = bxor(byte, key, (j*21 + 160) % 256)
 *
 *   call sites:  FWD(66, <obf-expr>)          -> a string
 *                FWD(22, x)                   -> builtin #22
 *
 *   constants:   #{} -> 0,  // -> floor division, (a+b)-b -> a
 *
 * The sel -> variant mapping is NOT hardcoded: it is decided by decrypting
 * samples of each sel group with both ciphers and keeping whichever yields
 * readable text. That survives a rebuild that swaps the constants.
 */

const { tokenize, parseValue, format, luaQuote, checkBalance, sanitizeSemicolons, luaMod } = require('../lua');

function bxor(...args) {
  let r = 0;
  for (const a of args) r = (r ^ (a >>> 0)) >>> 0;
  return r;
}

/* ------------------------- numeric expression eval ------------------------- */

function evalNum(toks, st) {
  let left = prim(toks, st);
  for (;;) {
    const tk = toks[st.i];
    if (!tk || tk.t !== 'op') break;
    const op = tk.v;
    if (op !== '+' && op !== '-' && op !== '*' && op !== '/' && op !== '//' && op !== '%') break;
    st.i++;
    const r = prim(toks, st);
    if (op === '+') left += r;
    else if (op === '-') left -= r;
    else if (op === '*') left *= r;
    else if (op === '/') left = left / r;
    else if (op === '//') left = Math.floor(left / r);
    else left = luaMod(left, r);
  }
  return left;
}

function prim(toks, st) {
  const tk = toks[st.i];
  if (!tk) throw new Error('unexpected end of expression');
  if (tk.t === 'num') { st.i++; return Number(tk.v); }
  if (tk.t === 'op' && tk.v === '-') { st.i++; return -prim(toks, st); }
  if (tk.t === 'op' && tk.v === '#') {
    st.i++;
    if (toks[st.i] && toks[st.i].v === '{' && toks[st.i + 1] && toks[st.i + 1].v === '}') {
      st.i += 2; return 0;                       // #{} === 0
    }
    throw new Error('unsupported length expression');
  }
  if (tk.t === 'op' && tk.v === '(') {
    st.i++;
    const v = evalNum(toks, st);
    if (!toks[st.i] || toks[st.i].v !== ')') throw new Error('expected )');
    st.i++;
    return v;
  }
  throw new Error('unexpected token ' + tk.v);
}

/* ------------------------------ table parsing ------------------------------ */

function findFunctionEnd(toks, funcIdx) {
  let depth = 0, pendingDo = false;
  for (let i = funcIdx; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t !== 'name') continue;
    const v = tk.v;
    if (v === 'for' || v === 'while') { depth++; pendingDo = true; }
    else if (v === 'do') { if (pendingDo) pendingDo = false; else depth++; }
    else if (v === 'function' || v === 'if' || v === 'repeat') depth++;
    else if (v === 'end' || v === 'until') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** A table value can be a string expression or a number expression with #{}. */
function parseAny(toks, st) {
  const save = st.i;
  try { return parseValue(toks, st); } catch { st.i = save; }
  return evalNum(toks, st);
}

function parseStringTable(toks, braceIdx) {
  const st = { i: braceIdx };
  if (!toks[st.i] || toks[st.i].v !== '{') return null;
  st.i++;
  const map = new Map();
  let skipped = 0;

  // An entry is { <string>, <number>, <number> } in either order:
  //   Norev  : { sel,   cipher, key   }
  //   Loader : { cipher, key,   sel   }
  // We keep the string plus both numbers and let the data decide which number
  // is the key (keySlot) and which selects the cipher (sel).
  while (st.i < toks.length) {
    while (toks[st.i] && toks[st.i].v !== '}' && toks[st.i].v !== '[') st.i++;
    if (!toks[st.i] || toks[st.i].v === '}') break;

    const save = st.i;
    try {
      st.i++;
      const key = evalNum(toks, st);
      if (!toks[st.i] || toks[st.i].v !== ']') throw new Error('expected ]');
      st.i++;
      if (!toks[st.i] || toks[st.i].v !== '=') throw new Error('expected =');
      st.i++;
      if (!toks[st.i] || toks[st.i].v !== '{') throw new Error('expected {');
      st.i++;

      const vals = [];
      for (let k = 0; k < 3; k++) {
        vals.push(parseAny(toks, st));
        if (k < 2) {
          if (!toks[st.i] || toks[st.i].v !== ',') throw new Error('expected ,');
          st.i++;
        }
      }
      if (!toks[st.i] || toks[st.i].v !== '}') throw new Error('expected }');
      st.i++;
      if (toks[st.i] && toks[st.i].v === ',') st.i++;

      const str = vals.find(v => typeof v === 'string');
      const nums = vals.filter(v => typeof v === 'number');
      if (typeof str !== 'string' || nums.length !== 2) throw new Error('bad entry shape');
      map.set(key, { str, nums });
    } catch {
      st.i = save + 1;
      skipped++;
    }
  }
  if (!toks[st.i]) return null;
  st.i++;
  return { map, endTok: st.i, skipped };
}

/* ------------------------------ cipher params ------------------------------ */

const CIPHER_SHAPE = /\((\w+)\*(\d+)\+(\d+)\+(\w+)\*(\d+)\)%256/;
const XOR_SHAPE = /bit32\.bxor\(string\.byte\([^)]*\),\w+,\((\w+)\*(\d+)\+(\d+)\)%256\)/;

function detectCiphers(toks, src) {
  const found = [];
  for (let i = 0; i + 1 < toks.length; i++) {
    if (toks[i].v !== 'function') continue;
    const end = findFunctionEnd(toks, i);
    if (end < 0) continue;
    const body = src.slice(toks[i].s, toks[end].e);
    if (!body.includes('bit32.bxor(string.byte')) continue;
    const m1 = CIPHER_SHAPE.exec(body);
    const m2 = XOR_SHAPE.exec(body);
    if (!m1 || !m2) continue;
    // include the `local NAME =` prefix so the cut leaves no dangling assignment
    let startTok = i;
    if (toks[i - 1] && toks[i - 1].v === '=' && toks[i - 2] && toks[i - 2].t === 'name') {
      startTok = i - 2;
      if (toks[i - 3] && toks[i - 3].v === 'local') startTok = i - 3;
    }
    found.push({
      start: toks[startTok].s, end: toks[end].e,
      mul: +m1[2], add: +m1[3], mul2: +m1[5],
      mul3: +m2[2], add3: +m2[3],
    });
    i = end;
  }
  return found;
}

function decryptWith(cipherBytes, key, P) {
  const out = new Array(cipherBytes.length);
  let k = key;
  for (let j = 0; j < cipherBytes.length; j++) {
    k = luaMod(k * P.mul + P.add + j * P.mul2, 256);
    out[j] = bxor(cipherBytes[j], k, luaMod(j * P.mul3 + P.add3, 256));
  }
  return Buffer.from(out).toString('latin1');
}

function utf8Of(latin1) {
  const buf = Buffer.from(latin1, 'latin1');
  const txt = buf.toString('utf8');
  return Buffer.from(txt, 'utf8').equals(buf) ? txt : null;
}

function readableScore(latin1) {
  if (!latin1) return 0;
  const txt = utf8Of(latin1);
  if (txt === null) return 0;
  let ok = 0;
  for (const ch of txt) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13) { ok++; continue; }
    if (c >= 32 && c !== 127) ok++;
  }
  return ok / Math.max(1, txt.length);
}

/* --------------------------------- pipeline -------------------------------- */


/** Join `"a" .. "b"` back into a single literal (the obfuscator splits strings). */
function mergeStringConcat(toks) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'str') {
      let text = t.v;
      let j = i + 1;
      while (toks[j] && toks[j].t === 'op' && toks[j].v === '..'
             && toks[j + 1] && toks[j + 1].t === 'str') {
        text += toks[j + 1].v;
        j += 2;
      }
      if (j > i + 1) {
        out.push({ t: 'str', v: text, raw: luaQuote(text) });
        i = j - 1;
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

/**
 * `[i] = function(obj, key) local m = obj[key]
 *          return function(...) return m(obj, ...) end end`
 * This is a method binder: FWD(i, obj, "M")(args) === obj:M(args).
 * It is NOT a plain index getter — rewriting it to obj["M"] would drop `self`.
 */
function detectMethodBinder(toks) {
  for (let i = 0; i + 20 < toks.length; i++) {
    if (toks[i].v !== '[') continue;
    const st = { i: i + 1 };
    let idx;
    try { idx = evalNum(toks, st); } catch { continue; }
    const t = (k) => toks[st.i + k];
    if (!t(0) || t(0).v !== ']') continue;
    if (!t(1) || t(1).v !== '=') continue;
    if (!t(2) || t(2).v !== 'function') continue;
    if (!t(3) || t(3).v !== '(') continue;
    const A = t(4), B = t(6);
    if (!A || A.t !== 'name' || !B || B.t !== 'name') continue;
    if (!t(5) || t(5).v !== ',') continue;
    if (!t(7) || t(7).v !== ')') continue;
    if (!t(8) || t(8).v !== 'local') continue;
    const C = t(9);
    if (!C || C.t !== 'name') continue;
    if (!t(10) || t(10).v !== '=') continue;
    if (!t(11) || t(11).v !== A.v) continue;
    if (!t(12) || t(12).v !== '[') continue;
    if (!t(13) || t(13).v !== B.v) continue;
    if (!t(14) || t(14).v !== ']') continue;
    // the returned closure must forward `obj` as the first argument
    let ok = false;
    for (let k = st.i + 15; k < Math.min(st.i + 34, toks.length - 4); k++) {
      if (toks[k].v === C.v && toks[k + 1] && toks[k + 1].v === '('
          && toks[k + 2] && toks[k + 2].v === A.v) { ok = true; break; }
    }
    if (ok) return idx;
  }
  return null;
}

/**
 * FWD(binder, obj, "M")(...)  ->  obj:M(...)
 * Only rewritten when the call is immediate, so the result is always a valid
 * method call and `self` is preserved.
 */
function unwrapMethodBinder(toks, fwdName, binderIdx) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== 'name' || t.v !== fwdName || !toks[i + 1] || toks[i + 1].v !== '(') {
      out.push(t); continue;
    }
    const st = { i: i + 2 };
    let idx = null;
    try { idx = evalNum(toks, st); } catch { idx = null; }
    if (idx !== binderIdx || !toks[st.i] || toks[st.i].v !== ',') { out.push(t); continue; }

    // collect the receiver expression (a name, optionally followed by [..] / .x)
    let p = st.i + 1, depth = 0;
    const recv = [];
    while (p < toks.length) {
      const tk = toks[p];
      if (tk.v === '(' || tk.v === '[' || tk.v === '{') depth++;
      else if (tk.v === ')' || tk.v === ']' || tk.v === '}') depth--;
      if (depth === 0 && tk.v === ',') break;
      recv.push(tk); p++;
    }
    if (!recv.length || recv[0].t !== 'name' || !toks[p] || toks[p].v !== ',') { out.push(t); continue; }

    // key: "M" or ("M")
    let k = p + 1, keyTok = toks[k], consumed = k;
    if (keyTok && keyTok.v === '(' && toks[k + 1] && toks[k + 1].t === 'str'
        && toks[k + 2] && toks[k + 2].v === ')') { keyTok = toks[k + 1]; consumed = k + 2; }
    const close = toks[consumed + 1];
    const callParen = toks[consumed + 2];
    if (!keyTok || keyTok.t !== 'str' || !close || close.v !== ')'
        || !callParen || callParen.v !== '(' || !/^[A-Za-z_]\w*$/.test(keyTok.v)) {
      out.push(t); continue;
    }

    for (const tk of recv) out.push(tk);
    out.push({ t: 'op', v: ':', raw: ':' });
    out.push({ t: 'name', v: keyTok.v, raw: keyTok.v });
    i = consumed + 1;                 // the following '(' closes the call
  }
  return out;
}

/** local X = {ipairs, os, ...}  ->  X[n] becomes the global name */
function detectBuiltinArray(toks) {
  for (let i = 0; i + 4 < toks.length; i++) {
    if (toks[i].v !== 'local' || toks[i + 1].t !== 'name' || toks[i + 2].v !== '=' || toks[i + 3].v !== '{') continue;
    const names = [];
    let j = i + 4;
    let ok = true;
    while (toks[j] && toks[j].v !== '}') {
      if (toks[j].t !== 'name') { ok = false; break; }
      names.push(toks[j].v);
      j++;
      if (toks[j] && toks[j].v === ',') j++;
      else if (toks[j] && toks[j].v !== '}') { ok = false; break; }
    }
    if (!ok || names.length < 8) continue;
    if (!toks[j] || toks[j].v !== '}') continue;
    return { name: toks[i + 1].v, names, startTok: i, endTok: j };
  }
  return null;
}

/** X[n]  ->  names[n-1]  when n is a literal in range */
function expandBuiltinRefs(toks, bi) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'name' && t.v === bi.name && toks[i + 1] && toks[i + 1].v === '[') {
      const st = { i: i + 2 };
      let n = null;
      try { n = evalNum(toks, st); } catch { n = null; }
      if (n !== null && toks[st.i] && toks[st.i].v === ']') {
        const nm = bi.names[n - 1];
        if (nm) {
          out.push({ t: 'name', v: nm, raw: nm });
          i = st.i;
          continue;
        }
      }
    }
    out.push(t);
  }
  return out;
}

function deobfuscateDispatcher(src) {
  const notes = [];
  const t0 = Date.now();

  let banner = '';
  const bm = src.match(/^\s*--\[(=*)\[([\s\S]*?)\]\1\]\s*/);
  if (bm) { banner = bm[2].trim(); src = src.slice(bm[0].length); }

  const toks = tokenize(src);

  // 1. the encrypted string table: the biggest { [expr] = {num,"str",num}, ... }
  let table = null;
  for (let i = 0; i + 2 < toks.length; i++) {
    if (toks[i].v !== '=' || toks[i + 1].v !== '{' || toks[i + 2].v !== '[') continue;
    const parsed = parseStringTable(toks, i + 1);
    if (!parsed || parsed.map.size < 8) continue;
    if (!table || parsed.map.size > table.map.size) {
      const stmtTok = (toks[i - 2] && toks[i - 2].v === 'local') ? i - 2 : i - 1;
      table = { ...parsed, nameTok: i - 1, startTok: stmtTok };
    }
  }
  if (!table) return { ok: false, error: 'Tabel string gaya dispatcher tidak ditemukan.' };

  // 2. the per-character ciphers (one or more per build)
  const binderIdx = detectMethodBinder(toks);
  const ciphers = detectCiphers(toks, src);
  if (ciphers.length < 1) {
    return { ok: false, error: 'Dekriptor cipher tidak ditemukan.' };
  }

  // 3. which of the two numbers is the key? decide from the data, not the layout
  const allEntries = [...table.map.values()];
  const probe = allEntries.slice(0, 60);
  let keySlot = 0, keyScore = -1;
  for (const slot of [0, 1]) {
    let sum = 0;
    for (const e of probe) {
      const bytes = Buffer.from(e.str, 'latin1');
      let best = 0;
      for (const P of ciphers) best = Math.max(best, readableScore(decryptWith(bytes, e.nums[slot], P)));
      sum += best;
    }
    const sc = sum / Math.max(1, probe.length);
    if (sc > keyScore) { keyScore = sc; keySlot = slot; }
  }
  if (keyScore < 0.5) {
    return { ok: false, error: `Tidak ada kombinasi key/cipher yang cocok (skor ${(keyScore * 100).toFixed(1)}%).` };
  }
  const selSlot = 1 - keySlot;

  // 4. map each selector value to the cipher that actually decodes it
  const selValues = [...new Set(allEntries.map(e => e.nums[selSlot]))];
  const variantFor = new Map();
  for (const sel of selValues) {
    const sample = allEntries.filter(e => e.nums[selSlot] === sel).slice(0, 20);
    let best = null;
    for (const P of ciphers) {
      let sc = 0;
      for (const e of sample) {
        sc += readableScore(decryptWith(Buffer.from(e.str, 'latin1'), e.nums[keySlot], P));
      }
      sc /= Math.max(1, sample.length);
      if (!best || sc > best.score) best = { P, score: sc };
    }
    variantFor.set(sel, best);
  }
  const avg = [...variantFor.values()].reduce((x, y) => x + y.score, 0) / variantFor.size;

  // 4b. decrypt every entry once
  const plain = new Map();
  let bad = 0;
  for (const [idx, e] of table.map) {
    const v = variantFor.get(e.nums[selSlot]);
    const s = decryptWith(Buffer.from(e.str, 'latin1'), e.nums[keySlot], v.P);
    if (readableScore(s) < 0.5) bad++;
    plain.set(idx, s);
  }
  if (bad) notes.push(`${bad} entri string tidak terbaca bersih — periksa manual.`);

  // 5. locate the string-getter index and the forwarding shim
  const tableNameTok = table.nameTok;
  const tableName = toks[tableNameTok] && toks[tableNameTok].t === 'name' ? toks[tableNameTok].v : null;
  if (!tableName) return { ok: false, error: 'Nama tabel string tidak terbaca.' };

  let getterIdx = null;
  for (let i = 0; i + 3 < toks.length; i++) {
    if (toks[i].v !== '[') continue;
    const st = { i: i + 1 };
    let keyVal;
    try { keyVal = evalNum(toks, st); } catch { continue; }
    if (!toks[st.i] || toks[st.i].v !== ']') continue;
    const eq = toks[st.i + 1];
    if (!eq || eq.v !== '=') continue;
    const fn = toks[st.i + 2];
    if (!fn || fn.v !== 'function') continue;
    const end = findFunctionEnd(toks, st.i + 2);
    if (end < 0) continue;
    let refs = false;
    for (let j = st.i + 2; j <= end; j++) {
      if (toks[j].t === 'name' && toks[j].v === tableName) { refs = true; break; }
    }
    if (refs) { getterIdx = keyVal; break; }
  }
  if (getterIdx === null) return { ok: false, error: 'Indeks string-getter tidak ditemukan.' };

  // forwarding shim: function(i, ...) return TBL[i](...) end
  let fwdName = null, fwdStartTok = -1, fwdEndTok = -1;
  for (let i = 0; i + 2 < toks.length; i++) {
    if (toks[i].v !== 'function' || toks[i + 1].v !== '(') continue;
    const end = findFunctionEnd(toks, i);
    if (end < 0) continue;
    const p = toks[i + 2];
    if (!p || p.t !== 'name') continue;
    let ok = false;
    for (let j = i + 3; j < end - 6; j++) {
      if (toks[j].v === 'return'
          && toks[j + 1] && toks[j + 1].t === 'name'
          && toks[j + 2] && toks[j + 2].v === '['
          && toks[j + 3] && toks[j + 3].v === p.v
          && toks[j + 4] && toks[j + 4].v === ']'
          && toks[j + 5] && toks[j + 5].v === '(') { ok = true; break; }
    }
    if (!ok) { i = end; continue; }
    for (let k = i - 1; k >= Math.max(0, i - 6); k--) {
      if (toks[k].v === '=' && toks[k - 1] && toks[k - 1].t === 'name') {
        fwdName = toks[k - 1].v;
        fwdStartTok = (toks[k - 2] && toks[k - 2].v === 'local') ? k - 2 : k - 1;
        fwdEndTok = end; break;
      }
      if (toks[k].v === 'local') break;
    }
    if (fwdName) break;
    i = end;
  }
  if (!fwdName) return { ok: false, error: 'Fungsi forwarding dispatcher tidak ditemukan.' };

  // 6. replace every FWD(getterIdx, expr) with the decrypted literal
  const edits = [];
  let replaced = 0;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].t !== 'name' || toks[i].v !== fwdName) continue;
    if (!toks[i + 1] || toks[i + 1].v !== '(') continue;
    const st = { i: i + 2 };
    let which;
    try { which = evalNum(toks, st); } catch { continue; }
    if (which !== getterIdx) continue;
    if (!toks[st.i] || toks[st.i].v !== ',') continue;
    st.i++;
    let idx;
    try { idx = evalNum(toks, st); } catch { continue; }
    if (!toks[st.i] || toks[st.i].v !== ')') continue;
    const s = plain.get(idx);
    if (s === undefined) continue;
    edits.push({ s: toks[i].s, e: toks[st.i].e, text: luaQuote(s) });
    replaced++;
  }
  if (!replaced) return { ok: false, error: 'Tidak ada pemanggilan string-getter yang bisa diganti.' };

  // bootstrap span: ciphers + dispatch table + string table + shim
  const bootStart = Math.min(
    ...ciphers.map(c => c.start),
    toks[table.startTok].s,
    toks[fwdStartTok].s
  );
  const bootEnd = Math.max(
    ...ciphers.map(c => c.end),
    toks[table.endTok - 1].e,
    toks[fwdEndTok].e
  );
  const span = src.slice(bootStart, bootEnd);
  const safeToCut = !/(game:GetService|require\s*\(|task\.)/.test(span) && span.includes('bit32.bxor');
  if (safeToCut) edits.push({ s: bootStart, e: bootEnd, text: '' });
  else notes.push('Bootstrap tidak dihapus (terdeteksi kode asli di dalamnya).');

  edits.sort((a, b) => a.s - b.s);
  let out = '';
  let pos = 0;
  for (const ed of edits) {
    if (ed.s < pos) continue;
    out += src.slice(pos, ed.s) + ed.text;
    pos = ed.e;
  }
  out += src.slice(pos);

  // 7b. token-level cleanups: rejoin split strings, unwrap the index getter,
  //     and expand the builtin table back to real global names.
  {
    let tk = mergeStringConcat(tokenize(out));
    if (binderIdx !== null) tk = unwrapMethodBinder(tk, fwdName, binderIdx);
    const bi = detectBuiltinArray(tk);
    if (bi) {
      let end = bi.endTok + 1;
      if (tk[end] && tk[end].v === ';') end++;
      tk = tk.slice(0, bi.startTok).concat(tk.slice(end));
      tk = expandBuiltinRefs(tk, bi);
    }
    out = tk.map(t => (t.t === 'str' ? t.raw : t.v)).join(' ');
  }

  // 8. fold #{} and integer division, then arithmetic
  const folded = foldDispatcher(out);

  // 9. rename + format
  const renamed = renameMangled(folded.code);
  let code;
  try {
    const ftoks = tokenize(renamed.code);
    const bal = checkBalance(ftoks);
    if (!bal.ok) {
      notes.push(`Format dilewati: ${bal.reason}. Output minified.`);
      code = renamed.code;
    } else {
      code = format(sanitizeSemicolons(ftoks));
    }
  } catch (err) {
    notes.push('Formatter gagal: ' + err.message);
    code = renamed.code;
  }

  const header = [
    '-- Deobfuscated by NXS9 Deobfuscator (dispatcher profile)',
    `-- source banner: ${banner || '(none)'}`,
    `-- string cipher: per-character XOR, chained key, ${ciphers.length} variants`,
    `-- variants: ${[...variantFor.entries()].map(([sel, v]) => `sel=${sel}:*${v.P.mul}+${v.P.add}+j*${v.P.mul2}`).join('  ')}`,
    `-- string table: ${table.map.size} entries, getter index ${getterIdx}`,
    '',
  ].join('\n');

  return {
    ok: true,
    code: header + code,
    stats: {
      profile: 'dispatcher',
      tableEntries: table.map.size,
      calls: replaced,
      replaced,
      uniqueStrings: new Set(plain.values()).size,
      identifiersRenamed: renamed.count,
      constantsFolded: folded.count,
      inputBytes: src.length,
      outputBytes: code.length,
      ms: Date.now() - t0,
    },
    fingerprint: {
      banner,
      profile: 'dispatcher',
      tableName,
      entries: table.map.size,
      getterIdx,
      ciphers,
      variantMap: [...variantFor.entries()].map(([sel, v]) => ({ sel, mul: v.P.mul, score: +v.score.toFixed(3) })),
      cleanRatio: avg,
    },
    notes,
  };
}

/* --------------------------- constant obfuscation --------------------------- */

function foldDispatcher(text) {
  let count = 0;
  let src = text;
  // #{} is always 0. Only pay for a full token pass when it actually occurs —
  // large samples without it would otherwise be rewritten twice.
  if (/#\s*\{/.test(text)) {
    const toks = tokenize(text);
    const parts = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.t === 'op' && t.v === '#' && toks[i + 1] && toks[i + 1].v === '{' && toks[i + 2] && toks[i + 2].v === '}') {
        parts.push('0'); i += 2; count++;
        continue;
      }
      parts.push(t.t === 'str' ? t.raw : t.v);
    }
    src = parts.join(' ');
  }

  // then fold pure-arithmetic parenthesised groups, innermost first
  const INNER = /\(([^()]*)\)/g;
  const ARITH = /^\s*-?\d+(?:\s*(?:[-+*\/%]|\/\/)\s*-?\d+)+\s*$/;
  const NUM = /^\s*-?\d+\s*$/;

  const evalBody = (body) => {
    try {
      const t = tokenize(body.replace(/--/g, '- -'));
      const st = { i: 0 };
      const v = evalNum(t, st);
      if (st.i !== t.length) return null;
      return Number.isFinite(v) ? v : null;
    } catch { return null; }
  };

  for (let pass = 0; pass < 64; pass++) {
    let changed = false;
    src = src.replace(INNER, (m, body, off, whole) => {
      let v = null;
      if (ARITH.test(body)) v = evalBody(body);
      else if (NUM.test(body)) v = Number(body.trim());
      if (v === null) return m;
      let j = off - 1;
      while (j >= 0 && /\s/.test(whole[j])) j--;
      if (j >= 0 && /[A-Za-z0-9_]/.test(whole[j])) return m;   // function call / index
      let txt = String(v);
      if (txt.startsWith('-') && j >= 0 && whole[j] === '-') txt = ' ' + txt;
      if (j >= 0 && /[A-Za-z0-9_]/.test(whole[j])) txt = ' ' + txt;
      const nxt = whole[off + m.length];
      if (nxt && /[A-Za-z0-9_.]/.test(nxt)) txt += ' ';
      count++;
      changed = true;
      return txt;
    });
    if (!changed) break;
  }
  return { code: src, count };
}

function renameMangled(text) {
  const re = /\b_[A-Za-z0-9_]{12,}\b/g;
  const order = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text))) if (!seen.has(m[0])) { seen.add(m[0]); order.push(m[0]); }
  const funcs = new Set();
  const fre = /local\s+function\s+(_[A-Za-z0-9_]{12,})/g;
  while ((m = fre.exec(text))) funcs.add(m[1]);
  const map = new Map();
  let fi = 0, vi = 0;
  for (const nm of order) {
    if (funcs.has(nm)) { fi++; map.set(nm, 'fn_' + fi); }
    else { vi++; map.set(nm, 'v_' + vi); }
  }
  return { code: text.replace(re, (x) => map.get(x) || x), count: map.size };
}

module.exports = { deobfuscateDispatcher, foldDispatcher, renameMangled, evalNum, tokenize };
