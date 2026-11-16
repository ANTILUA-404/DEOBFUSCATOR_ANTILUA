'use strict';

/**
 * Regression for the "Cannot set properties of null (setting 'textContent')"
 * failure. The old setBusy() replaced the button's innerHTML, deleting
 * #runLabel while a Luraph job was being polled; pollJob() then wrote to the
 * missing node and run()'s catch reported it as a server connection error.
 * This runs the real inline page script against a minimal DOM and checks that
 * the label survives the exact busy -> poll -> idle sequence.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(match, 'inline page script not found');

const nodes = new Map();
function element(id) {
  if (!nodes.has(id)) {
    nodes.set(id, {
      id,
      textContent: '',
      innerHTML: '',
      className: '',
      hidden: false,
      disabled: false,
      style: {},
      classList: { add() {}, remove() {} },
      addEventListener() {},
      click() {},
      scrollTop: 0,
      scrollHeight: 100,
    });
  }
  return nodes.get(id);
}

const document = {
  getElementById: (id) => element(id),
  addEventListener() {},
  createElement: () => element('_tmp'),
};
const fakeFetch = () => Promise.resolve({
  json: () => Promise.resolve({ ok: true, engines: [], status: 'done' }),
});
class MockBlob { constructor() { this.size = 1; } }
const performance = { now: () => 0 };
const navigator = { clipboard: { writeText: () => Promise.resolve() } };
const url = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
const noop = () => 0;

let script = match[1];
script += `
setBusy(true);
if (!$('runLabel')) throw new Error('runLabel missing while busy');
setText('runLabel', 'Engine berjalan…');
if ($('runLabel').textContent !== 'Engine berjalan…') throw new Error('label write failed');
renderProgress({ status: 'running', log: ['test'], elapsedMs: 1000 }, { version: '15.1' });
setBusy(false);
if (!$('runLabel')) throw new Error('runLabel missing after busy');
if ($('runLabel').textContent !== 'Deobfuscate') throw new Error('label not restored');
`;

new Function(
  'document', 'fetch', 'Blob', 'performance', 'navigator', 'URL',
  'setTimeout', 'clearTimeout', 'console', script,
)(document, fakeFetch, MockBlob, performance, navigator, url, noop, noop, console);

console.log('PASS  UI label survives busy/poll/idle cycle');
