'use strict';

/**
 * Builds a synthetic sample in the "dispatcher" obfuscation format so the
 * profile can be regression-tested without shipping a real (large) sample.
 * The ciphertexts are produced by the exact inverse of the observed cipher.
 */

const fs = require('fs');
const path = require('path');

function bxor(...a) { let r = 0; for (const v of a) r = (r ^ (v >>> 0)) >>> 0; return r; }
const mod = (a, b) => ((a % b) + b) % b;

// variant A: key=(key*73+40+j*25)%256, xor(j*6+34)
// variant B: key=(key*37+107+j*30)%256, xor(j*21+160)
const V = {
  A: { mul: 73, add: 40, mul2: 25, mul3: 6, add3: 34, sel: 76 },
  B: { mul: 37, add: 107, mul2: 30, mul3: 21, add3: 160, sel: 166 },
};

function encrypt(plain, key, P) {
  const out = [];
  let k = key;
  for (let j = 0; j < plain.length; j++) {
    k = mod(k * P.mul + P.add + j * P.mul2, 256);
    out.push(bxor(plain.charCodeAt(j), k, mod(j * P.mul3 + P.add3, 256)));
  }
  return out;
}

const luaEscape = (bytes) => '"' + bytes.map(b => '\\' + String(b).padStart(3, '0')).join('') + '"';

const PLAIN = [
  'Players', 'Workspace', 'ReplicatedStorage', 'game:GetService',
  'SYSTEM UNAVAILABLE', 'MusicConfig', 'catalog', 'track',
  'NEXUS9', 'queue', 'vote', 'DJ Mode aktif',
  '%08x%08x', 'Service', 'string', 'table',
];

function main() {
  const rows = [];
  const calls = [];
  let idx = 100000;
  let n = 0;
  for (const text of PLAIN) {
    const variant = (n % 3 === 0) ? V.A : V.B;
    const key = 20 + (n * 17) % 200;
    const cipher = encrypt(text, key, variant);
    const selExpr = variant === V.A ? '((76*3)//3)' : '((166*3)//3)';
    rows.push(`[(((${idx}+7)-7)+#{})]={${selExpr},${luaEscape(cipher)},((${key}+#{}) )}`);
    calls.push(`_fwd(((66+0)+#{}),(((${idx}+7)-7)+#{}))`);
    idx += 13; n++;
  }

  const src = `--[[  SYNTHETIC::DISPATCHER ]] ` +
    `local _aX9=function(_s,_k)local _o,_y={},_k for _i=1,#_s do local _j=_i-1 _y=(_y*73+40+_j*25)%256 _o[_i]=string.char(bit32.bxor(string.byte(_s,_i),_y,(_j*6+34)%256))end return table.concat(_o)end;` +
    `local _bY7=function(_s,_k)local _o,_y={},_k for _i=1,#_s do local _j=_i-1 _y=(_y*37+107+_j*30)%256 _o[_i]=string.char(bit32.bxor(string.byte(_s,_i),_y,(_j*21+160)%256))end return table.concat(_o)end;` +
    `local _tblQ={${rows.join(',')}};` +
    `local _cacheQ={};` +
    `local _dispQ={[((66*4)//4)]=function(_i)local _v=_cacheQ[_i] if _v==nil then local _e=_tblQ[_i] if _e[1]==((76*2)//2)then _v=_aX9(_e[2],_e[3])else _v=_bY7(_e[2],_e[3])end _cacheQ[_i]=_v end return _v end};` +
    `local _fwd=function(_i,...)return _dispQ[_i](...)end;` +
    `local _out={} ` +
    calls.map((c, i) => `_out[${i + 1}]=${c}`).join(' ') +
    ` return _out`;

  const outPath = path.join(__dirname, '..', '_synthetic_dispatcher.luau');
  fs.writeFileSync(outPath, src, 'utf8');
  console.log('wrote', outPath, src.length, 'bytes');
  console.log('expected:', JSON.stringify(PLAIN));
}

main();
