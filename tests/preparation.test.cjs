'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree, fakeElectron } = require('./helpers.cjs');
const { withTimeout } = require('../src/main/runtime');
const { BrowserPreparation } = require('../src/main/BrowserPreparation');
const root = path.resolve(__dirname, '../src');
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { resolve, promise }; };

function browserFixture() {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('main/BrowserManager.js');
    const manager = new BrowserManager();
    manager.attachWindow(electron.window);
    manager.preparationTimeoutMs = 10;
    manager.legacyCleanupTimeoutMs = 5;
    return { manager, electron };
}

test('stalled legacy storage cannot hold a fresh browser at Starting forever', async () => {
    const { manager } = browserFixture();
    const legacy = deferred();
    manager.clearLegacyPersistentPartition = () => legacy.promise;
    const work = manager.createBrowser(1, { startPage: 'about:blank' });
    try {
        await withTimeout(work, 200, () => { throw new Error('Startup remained blocked on legacy storage.'); });
        assert.equal(manager.getAll().length, 1);
        assert.equal(manager.get(1).state.loading, false);
    } finally { legacy.resolve(); await work.catch(() => {}); await manager.destroyAll(); }
});

test('stalled initial renderer reports failure, closes its view, and can retry', async () => {
    const { manager, electron } = browserFixture();
    const initial = deferred();
    const Original = electron.BrowserView;
    electron.BrowserView = class extends Original {
        constructor(options) { super(options); this.webContents.loadURL = () => initial.promise; }
    };
    const work = manager.createBrowser(1, { startPage: 'about:blank' });
    try {
        await assert.rejects(withTimeout(work, 200, () => { throw new Error('Initial blank page remained blocked.'); }), /Browser 1.*initializ.*timed out/i);
        assert.equal(manager.getAll().length, 0);
        assert.equal(electron.views[0].attached, false);
        assert.equal(electron.views[0].webContents.destroyed, true);
        electron.BrowserView = Original;
        await manager.createBrowser(1, { startPage: 'about:blank' });
        assert.equal(manager.getAll().length, 1);
    } finally { initial.resolve(); await work.catch(() => {}); await manager.destroyAll(); }
});

test('Stop cancels a stalled native initialization and closes the partial view', async () => {
    const { manager, electron } = browserFixture();
    const initial = deferred(), controller = new AbortController();
    const Original = electron.BrowserView;
    electron.BrowserView = class extends Original {
        constructor(options) { super(options); this.webContents.loadURL = () => initial.promise; }
    };
    const work = manager.createBrowser(1, { startPage: 'about:blank', signal: controller.signal });
    await tick(); controller.abort();
    try {
        await assert.rejects(withTimeout(work, 200, () => { throw new Error('Stop did not release preparation.'); }), { name: 'AbortError' });
        assert.equal(manager.getAll().length, 0);
        assert.equal(electron.views[0].webContents.destroyed, true);
    } finally { initial.resolve(); await work.catch(() => {}); await manager.destroyAll(); }
});

test('100 workspaces are prepared with only two native launches in flight and visible progress', async () => {
    const browsers = new Map(), progress = [];
    let active = 0, peak = 0, heartbeat = false;
    const manager = {
        getAll: () => Array.from(browsers.values()),
        createBrowser: async (id) => {
            active++; peak = Math.max(peak, active);
            await tick();
            browsers.set(id, { id }); active--;
        }
    };
    setImmediate(() => { heartbeat = true; });
    const preparation = new BrowserPreparation(manager, { pauseMs: 0 });
    const ids = await preparation.ensure(100, { onProgress: (ready) => progress.push(ready.length) });
    assert.equal(ids.length, 100); assert.equal(browsers.size, 100);
    assert.equal(peak, 2); assert.equal(heartbeat, true);
    assert.equal(progress[0], 0); assert.equal(progress.at(-1), 100);
    assert.ok(progress.includes(20));
});

test('cancelled resize does not launch remaining browsers or block a new smaller Start', async () => {
    const browsers = new Map(), gate = deferred(), controller = new AbortController();
    const launched = [];
    let block = true;
    const manager = {
        getAll: () => Array.from(browsers.values()),
        createBrowser: async (id, { signal }) => {
            launched.push(id);
            if (block) await require('../src/main/runtime').waitForPreparation(gate.promise, 200, signal, 'test timeout');
            browsers.set(id, { id });
        },
        destroyBrowser: async (id) => { browsers.delete(id); }
    };
    const preparation = new BrowserPreparation(manager, { pauseMs: 0 });
    const work = preparation.ensure(50, { signal: controller.signal });
    await tick(); controller.abort();
    await assert.rejects(work, { name: 'AbortError' });
    assert.equal(launched.length, 2);
    block = false;
    assert.deepEqual(await preparation.ensure(3), [1, 2, 3]);
    assert.equal(browsers.size, 3);
    gate.resolve();
});

test('Stop settles Start even if browser preparation never resolves or handles cancellation', async () => {
    const { SeoAutomationManager } = loadTree(root, {}, { setInterval: () => 1, clearInterval() {} })('main/SeoAutomationManager.js');
    const preparation = deferred();
    const automation = new SeoAutomationManager({ cancelCurrentFetch() {} }, {}, () => preparation.promise);
    const work = automation.start({ query: 'keyword', targetWebsite: 'fixture.local', browserCount: 20 });
    automation.stop();
    try {
        await withTimeout(work, 200, () => { throw new Error('Start stayed pending after Stop.'); });
        assert.equal(automation.getState().running, false);
    } finally { preparation.resolve([]); await work.catch(() => {}); }
});

test('normal recreation reuses a fully cleaned memory partition without another storage barrier', async () => {
    const { manager } = browserFixture();
    await manager.createBrowser(1, { startPage: 'about:blank' });
    const first = manager.get(1).session;
    await manager.destroyBrowser(1);
    first.clearStorageData = () => { throw new Error('Empty partition must not be cleared again during creation'); };
    await manager.createBrowser(1, { startPage: 'about:blank' });
    const second = manager.get(1).session;
    try { assert.equal(first, second); } finally { first.clearStorageData = async () => {}; await manager.destroyAll(); }
});

test('failed cleanup cannot contaminate the recreated browser memory session', async () => {
    const { manager } = browserFixture();
    await manager.createBrowser(1, { startPage: 'about:blank' });
    const first = manager.get(1).session;
    first.clearStorageData = async () => { throw new Error('storage failure'); };
    await manager.destroyBrowser(1);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    try { assert.notEqual(first, manager.get(1).session); } finally { await manager.destroyAll(); }
});
