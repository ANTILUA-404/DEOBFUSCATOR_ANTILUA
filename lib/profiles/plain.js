'use strict';

/**
 * Profile: constant-only obfuscation.
 *
 * Some builds ship no encrypted string table at all — only:
 *   - identifier mangling (`__l00II1__00l1l0OI1l_1O_I0I1_l1`)
 *   - constant obfuscation (`((8194-8193)+(1734-1734))`, `(a*3)//3`)
 *
 * Observed on `NorevMusicSystemClient` (3.87 MB): 0 occurrences of
 * `bit32.bxor(string.byte`, 0 string tables, 619 `//`, hundreds of folded
 * arithmetic groups. So there is nothing to decrypt — folding, renaming and
 * formatting is the whole recovery.
 *
 * This profile is deliberately conservative: it refuses to run unless the
 * sample actually looks obfuscated, so ordinary source is left untouched.
 */

const { tokenize, format, checkBalance, sanitizeSemicolons } = require('../lua');
const { foldDispatcher, renameMangled, cleanBanner } = require('./dispatcher');
const brand = require('../brand');

const ARITH_GROUP = /\(\s*-?\d+\s*(?:[-+*\/%]|\/\/)\s*-?\d+\s*\)/g;
const MANGLED = /\b_[A-Za-z0-9_]{14,}\b/g;

const MAX_FORMAT_BYTES = 6 * 1024 * 1024;   // formatting 6 MB+ is not worth the wait

function countMatches(text, re) {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text)) n++;
  return n;
}

function deobfuscatePlain(src) {
  const t0 = Date.now();
  const notes = [];

  let banner = '';
  const bm = src.match(/^\s*--\[(=*)\[([\s\S]*?)\]\1\]\s*/);
  if (bm) { banner = cleanBanner(bm[2]); src = src.slice(bm[0].length); }

  const arith = countMatches(src, ARITH_GROUP);
  const mangled = new Set();
  {
    MANGLED.lastIndex = 0;
    let m;
    while ((m = MANGLED.exec(src))) mangled.add(m[0]);
  }

  // refuse to touch anything that does not look obfuscated
  if (mangled.size < 20 && arith < 100) {
    return {
      ok: false,
      error: `Tidak terlihat ter-obfuscate (${mangled.size} nama mangled, ${arith} grup konstanta).`,
    };
  }

  const folded = foldDispatcher(src);
  const renamed = renameMangled(folded.code);

  let code = renamed.code;
  let formatted = false;
  if (code.length <= MAX_FORMAT_BYTES) {
    try {
      const toks = tokenize(code);
      const bal = checkBalance(toks);
      if (bal.ok) {
        code = format(sanitizeSemicolons(toks));
        formatted = true;
      } else {
        notes.push(`Format dilewati: ${bal.reason}.`);
      }
    } catch (err) {
      notes.push('Formatter gagal: ' + err.message);
    }
  } else {
    notes.push(`File ${(code.length / 1048576).toFixed(1)} MB — formatting dilewati, output tetap minified.`);
  }

  const header = brand.header([
    ['engine', 'constant-only (no encrypted string table)'],
    ['source banner', banner || '(none)'],
    ['transform', 'constants folded + identifiers renamed'],
    ['counts', `${folded.count} groups folded, ${renamed.count} identifiers renamed`],
  ]);

  return {
    ok: true,
    code: header + code,
    stats: {
      profile: 'plain',
      tableEntries: 0,
      calls: 0,
      replaced: 0,
      uniqueStrings: 0,
      identifiersRenamed: renamed.count,
      constantsFolded: folded.count,
      inputBytes: src.length,
      outputBytes: code.length,
      formatted,
      ms: Date.now() - t0,
    },
    fingerprint: {
      profile: 'plain',
      banner,
      arithGroups: arith,
      mangledNames: mangled.size,
      cleanRatio: 1,
    },
    notes,
  };
}

module.exports = { deobfuscatePlain };
