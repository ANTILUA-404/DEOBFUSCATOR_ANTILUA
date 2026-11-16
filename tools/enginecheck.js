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
const prometheus = require('../engines/prometheus/src/index.js');

const root = path.join(__dirname, '..');
const luraphSample = fs.readFileSync(path.join(root, 'tests/fixtures/luraph/obfuscated.lua'), 'latin1');
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log('PASS ', name);
  } catch (err) {
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

check('Prometheus engine rejects a Norev payload', () => {
  execFileSync(process.execPath, [path.join(root, 'tools/make_dispatcher_sample.js')], { cwd: root });
  const sample = fs.readFileSync(path.join(root, '_synthetic_dispatcher.luau'), 'latin1');
  const report = prometheus.identify(sample, null);
  assert.strictEqual(report.prometheus, false);
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
