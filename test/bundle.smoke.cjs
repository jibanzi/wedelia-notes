// Loads dist/main.js the way Obsidian's plugin loader does, with the API it
// injects stubbed. Guards two things a unit test cannot see: that the bundle
// is loadable CommonJS at all (an ESM bundle loads as an empty module with no
// error, which looks like a plugin that installed fine and does nothing), and
// that the tested core is inside it rather than re-implemented in main.ts.
const Module = require('node:module');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

class Plugin {
  constructor() { this.app = { vault: {} }; }
  addSettingTab() {}
  async loadData() { return {}; }
  async saveData() {}
}
const original = Module._load;
Module._load = function (request) {
  if (request === 'obsidian') {
    return { Plugin, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, App: class {} };
  }
  return original.apply(this, arguments);
};

const bundle = join(__dirname, '..', 'dist', 'main.js');
const mod = require(bundle);
const Exported = mod.default ?? mod;

assert.strictEqual(typeof Exported, 'function', 'bundle must export a class');
assert.ok(Exported.prototype instanceof Plugin, 'must extend Obsidian Plugin');
for (const method of ['onload', 'onunload', 'start', 'stop', 'save']) {
  assert.strictEqual(typeof Exported.prototype[method], 'function', `missing ${method}`);
}

const source = readFileSync(bundle, 'utf8');
for (const marker of [
  'search_my_notes', 'read_my_note',
  '/v1/notes/poll', '/v1/notes/result', '/v1/vault/notes/ticket',
  'Memories', 'Itineraries', 'result_sha256',
]) {
  assert.ok(source.includes(marker), `bundle is missing ${marker}`);
}

console.log('ok: loadable CJS, extends Plugin, and the tested core is bundled in');
