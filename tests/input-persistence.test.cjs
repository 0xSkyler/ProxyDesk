'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bundle = fs.readFileSync(path.join(__dirname, '../src/renderer/assets/index-BZgi7Ish.js'), 'utf8');
const helpers = bundle.slice(bundle.indexOf('function readSavedDomInput'), bundle.indexOf('function gp()'));

test('DOM keywords and target survive reload and their deletion is persistent', () => {
    const values = new Map();
    const storage = { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
    const load = () => { const context = vm.createContext({ localStorage: storage }); vm.runInContext(helpers, context); return context; };
    const first = load();
    first.saveDomInput('keywords', 'first,second'); first.saveDomInput('targetWebsite', 'fixture.test');
    const second = load();
    assert.equal(second.readSavedDomInput('keywords'), 'first,second');
    assert.equal(second.readSavedDomInput('targetWebsite'), 'fixture.test');
    second.saveDomInput('keywords', ''); second.saveDomInput('targetWebsite', '');
    const third = load();
    assert.equal(third.readSavedDomInput('keywords'), '');
    assert.equal(third.readSavedDomInput('targetWebsite'), '');
    assert.equal(values.size, 0);
});

test('unavailable settings storage does not break DOM inputs', () => {
    const context = vm.createContext({ localStorage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('full'); }, removeItem() { throw Error('blocked'); } } });
    vm.runInContext(helpers, context);
    assert.equal(context.readSavedDomInput('keywords'), '');
    context.saveDomInput('keywords', 'a'); context.saveDomInput('keywords', '');
});
