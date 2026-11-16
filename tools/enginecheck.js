'use strict';

/**
 * Routing and branding checks. These are the properties the web app depends on:
 * a Luraph payload must never be handed to the inline formatter, a non-Prometheus
 * payload must not be claimed by the Prometheus engine, and every successful
 * result must carry the ANTILUA credit line.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const deob = require('../lib/deob');
const luraph = require('../lib/profiles/luraph');
const { deobfuscatePrometheus } = require('../lib/profiles/prometheus');
const { detectFamily } = require('../lib/profiles/family');

const root = path.join(__dirname, '..');
const luraphSample = fs.readFileSync(path.join(root, 'tests/fixtures/luraph/obfuscated.lua'), 'latin1');
let failures = 0;

function check(name, fn) {
  // A check may opt out by calling ctx.skip(reason). Skips are printed and do
  // not fail the suite: the Luau binaries only exist on the platform they were
  // built for, and the Docker build covers the other case.
  let skipped = null;
  const ctx = {
    skip(reason) {
      skipped = reason;
      throw { __skip: true };
    },
  };
  try {
    fn(ctx);
    console.log(skipped ? 'SKIP ' : 'PASS ', name, skipped ? '-> ' + skipped : '');
  } catch (err) {
    if (err && err.__skip) {
      console.log('SKIP ', name);
      return;
    }
    failures += 1;
    console.log('FAIL ', name, '->', err.message);
  }
}

check('Luraph header detected with version', () => {
  const hit = luraph.detectEngine(luraphSample);
  assert.ok(hit.match, 'sample should match');
  assert.strictEqual(hit.version, '15.1');
});

check('inline router refuses a Luraph payload', () => {
  const result = deob.deobfuscate(luraphSample);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.engine, 'luraph');
});

check('plain Lua is not claimed as Luraph', () => {
  const hit = luraph.detectEngine('local x = 1\nprint(x)\n');
  assert.strictEqual(hit.match, false);
});

check('Luraph v14 is detected and marked unsupported', () => {
  const hit = luraph.detectEngine(
    '-- This file was protected using Luraph Obfuscator v14.7 [https://lura.ph/]\nreturn setmetatable({},{})\n'
  );
  assert.strictEqual(hit.match, true);
  assert.strictEqual(hit.unsupported, true);
  assert.strictEqual(hit.version, '14.7');
});

check('headerless Luraph v14 VM entry is detected structurally', () => {
  const src = 'return(function()local a,b,c=string.byte,string.sub,loadstring;'
    + 'local d=b([==[LPH:ABC]==]);return d;end)()';
  const hit = luraph.detectEngine(src);
  assert.strictEqual(hit.match, true);
  assert.strictEqual(hit.unsupported, true);
  assert.strictEqual(hit.plugin, 'luraph_v14_pattern');
  assert.match(hit.evidence, /loadstring/);
});

check('headerless Luraph with hex-escaped APIs is detected', () => {
  const src = 'return({m=function(self,...)local z=getfenv()["\\x73\\x74\\x72"];return z;end})';
  const hit = luraph.detectEngine(src);
  assert.strictEqual(hit.match, true);
  assert.strictEqual(hit.unsupported, true);
  assert.match(hit.evidence, /hex-escaped-api/);
});

check('structurally detected Luraph never reaches the inline router', () => {
  const src = 'return(function()local a,b,c=string.byte,string.sub,loadstring;return b;end)()';
  const result = deob.deobfuscate(src);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.engine, 'luraph');
});

check('non-Luraph payloads are not claimed by pattern detection', () => {
  const src = 'return(function(...)local w={"\\123\\045"};return w;end)(...)';
  assert.strictEqual(luraph.detectEngine(src).match, false);
});

check('Luraph readiness probe reports a glibc mismatch clearly', () => {
  const glibc = luraph.judgeBinary('luau', {
    status: 1,
    stdout: '',
    stderr: '/app/engines/luraph/bin/luau: /lib/x86_64-linux-gnu/libm.so.6: '
      + "version `GLIBC_2.38' not found (required by /app/engines/luraph/bin/luau)",
  });
  assert.strictEqual(glibc.ok, false);
  assert.match(glibc.reason, /GLIBC_2\.38/);
  assert.match(glibc.reason, /rebuild image/);

  // The CLI exits non-zero for --help, so usage output must count as healthy.
  const healthy = luraph.judgeBinary('luau', { status: 1, stdout: 'Available options:', stderr: '' });
  assert.strictEqual(healthy.ok, true);

  const broken = luraph.judgeBinary('luau', { status: 0, stdout: '', stderr: '' });
  assert.strictEqual(broken.ok, false);
  assert.match(broken.reason, /tidak bisa dijalankan/);
});

check('Luraph v14 rejection explains why the engine is disabled', () => {
  const v14 = '-- This file was protected using Luraph Obfuscator v14.7 [https://lura.ph/]\nreturn setmetatable({},{})\n';
  const result = deob.deobfuscate(v14);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /belum tersedia/);
  assert.match(result.detail, /181 KB/);
});

check('Dockerfile and runtime agree on how to probe the Luau binary', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const probe = luraph.probeInvocation();

  // The runtime health probe must use --help; the CLI rejects -e and --version.
  assert.deepStrictEqual(probe.args, ['--help']);
  assert.doesNotMatch(dockerfile, /luau (?:-e|--version)\b/, 'Dockerfile uses a flag the Luau CLI rejects');
  assert.match(dockerfile, /luau --help/, 'Dockerfile must probe with --help like judgeBinary does');
  assert.match(dockerfile, /Usage:/, 'Dockerfile must assert the usage banner, the judgeBinary criterion');

  // A smoke script that runs proves the interpreter executes, not just starts.
  assert.ok(fs.existsSync(path.join(root, 'engines/luraph/smoke.luau')), 'smoke.luau must exist');
  assert.match(dockerfile, /smoke\.luau/, 'Dockerfile must run the smoke script');
});

check('Luau smoke script passes on the vendored interpreter', (t) => {
  const probe = luraph.probeInvocation();
  const local = path.join(luraph.ENGINE_DIR, 'bin',
    process.platform === 'win32' ? 'luau.exe' : 'luau');
  if (!fs.existsSync(local)) {
    t.skip(`no local ${path.basename(local)}; the Docker build covers this`);
    return;
  }
  const out = execFileSync(local, [path.join(root, 'engines/luraph/smoke.luau')], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.match(out, /luau smoke ok/, 'smoke script must report success');
  assert.match(out, /ok vector metatable is writable/, 'the lveclib patch must be applied');
  assert.ok(probe.binPath.endsWith(probe.bin));
});

check('Prometheus label payload formats without a dangling local', () => {
  const sample = fs.readFileSync(path.join(root, 'tests/fixtures/prometheus/WeAreDevs.lua'), 'latin1');
  const result = deobfuscatePrometheus(sample);
  assert.strictEqual(result.ok, true, result.error || 'should deobfuscate');
  assert.doesNotMatch(result.code, /^[ \t]*local[ \t]*$/m, 'output must not contain a bare local');
  assert.strictEqual(
    result.notes.filter((note) => /step failed/.test(note.message)).length,
    0,
    'no pipeline step should fail: ' + result.notes.join(' | ')
  );
});

check('Prometheus engine rejects a Norev payload', () => {
  execFileSync(process.execPath, [path.join(root, 'tools/make_dispatcher_sample.js')], { cwd: root });
  const sample = fs.readFileSync(path.join(root, '_synthetic_dispatcher.luau'), 'latin1');
  const result = deobfuscatePrometheus(sample);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /Prometheus/);
});

check('unsupported corpus families are named, not called unknown', () => {
  const samples = [
    ['--[Obfuscated by Hercules v1.6.2] return (function() end)', 'hercules'],
    ["_, Protected_by_MoonSecV2, Discord = 'x'", 'moonsec'],
    ['local SynapseXen_llIIIllIi=select;', 'synapsexen'],
    ['-- This script was generated using MoonVeil 2.0.12-beta [https://moonveil.cc]', 'moonveil'],
    ['return(function(l,...)local R="This file was obfuscated using PSU Obfuscator 4.0.A"', 'psu'],
    ['do local a=[[77fuscator 0.4.7 - discord.gg/kWy43Y9rR3]];', '77fuscator'],
    ['local v0=string.char;local v1=string.byte;local v2=string.sub;', 'luaobfuscator'],
  ];
  for (const [src, id] of samples) {
    const hit = detectFamily(src);
    assert.ok(hit, 'missing family for ' + id);
    assert.strictEqual(hit.id, id, 'wrong family for ' + id);
  }
});

check('every result starts with the ANTILUA credit line', () => {
  const sample = fs.readFileSync(path.join(root, '_synthetic_dispatcher.luau'), 'latin1');
  const result = deob.deobfuscate(sample);
  assert.ok(result.ok, 'dispatcher sample should decode');
  assert.ok(result.code.startsWith('-- Deobfuscated By ANTILUA DEOBFUSCATOR\n'),
    'first line was: ' + result.code.split('\n')[0]);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall engine checks passed');
process.exit(failures ? 1 : 0);
