'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree, fakeElectron } = require('./helpers.cjs');
const { withTimeout } = require('../src/main/runtime');
const root = path.resolve(__dirname, '../src');
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('every automation cycle releases and clears all browser documents before proxy fetching', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const ids = [1, 2, 3, 4, 5], events = [];
    let active = 0, peak = 0, cycle = 0;
    const browser = {
        getProxyRotationState: () => ({ proxy: null }),
        cancelMeasurementSession: id => events.push([cycle, 'stop', id]),
        setBrowserKeepAlive() {},
        assignProxy: async id => events.push([cycle, 'reset-proxy', id]),
        prepareCycleDocument: async id => {
            active++; peak = Math.max(peak, active); await tick();
            events.push([cycle, 'prepare', id]); active--;
        },
        clearCache: () => { throw new Error('Cache must not be cleared'); },
        clearCookies: () => { throw new Error('Cookies must not be cleared'); }
    };
    const proxies = { fetchAssignDirect: async () => {
        assert.equal(active, 0);
        assert.deepEqual(events.filter(e => e[0] === cycle && e[1] === 'prepare').map(e => e[2]).sort(), ids);
        events.push([cycle, 'fetch']);
    } };
    const automation = new SeoAutomationManager(proxies, browser, async () => ids);
    automation.state = { ...automation.state, running: true, browserIds: ids, query: 'first,second' };
    for (cycle = 1; cycle <= 2; cycle++) await automation.runCycle();
    assert.equal(peak, 2);
    assert.equal(events.filter(e => e[1] === 'prepare').length, 10);
    assert.equal(events.filter(e => e[1] === 'fetch').length, 2);
    assert.deepEqual(events.slice(0, 5).map(e => e[1]), ids.map(() => 'stop'));
});

test('Stop cancels stalled cycle preparation before any proxy fetch', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const gate = deferred(); let fetched = false;
    const browser = {
        getProxyRotationState: () => ({ proxy: null }), cancelMeasurementSession() {},
        setBrowserKeepAlive() {}, assignProxy: async () => {},
        prepareCycleDocument: () => gate.promise,
        clearCache() { throw new Error('cache deletion is forbidden'); }
    };
    const proxies = { cancelCurrentFetch() {}, fetchAssignDirect: async () => { fetched = true; } };
    const automation = new SeoAutomationManager(proxies, browser, async () => []);
    automation.state = { ...automation.state, running: true, browserIds: [1], query: 'first' };
    const work = automation.runCycle(); await tick(); automation.stop();
    try {
        await withTimeout(work, 200, () => { throw new Error('Stop remained blocked by page preparation'); });
        assert.equal(fetched, false);
    } finally { gate.resolve(); }
});

test('cache and cookie clearing compatibility methods are safe no-ops', async () => {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    const managed = manager.get(1);
    const oldCache = managed.session.clearCache, oldStorage = managed.session.clearStorageData;
    managed.session.clearCache = () => { throw new Error('Cache deletion forbidden'); };
    managed.session.clearStorageData = () => { throw new Error('Storage deletion forbidden'); };
    try {
        await manager.clearCache(1);
        await manager.clearCookies(1);
        await manager.clearRendererCache(managed);
        await manager.assignProxy(1, { protocol: 'http', host: '127.0.0.1', port: 8111 });
        await manager.assignProxy(1, null);
    } finally {
        await manager.destroyAll();
        managed.session.clearCache = oldCache; managed.session.clearStorageData = oldStorage;
    }
});

test('browser profiles remain isolated; cycle preparation clears their data', async () => {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank', persistSessions: false });
    await manager.createBrowser(2, { startPage: 'about:blank', persistSessions: false });
    const a = manager.get(1), b = manager.get(2);
    assert.equal(a.partition, 'persist:browser-1');
    assert.equal(b.partition, 'persist:browser-2');
    assert.notEqual(a.session, b.session);
    a.session.cookieMarker = 'accepted'; a.session.cacheMarker = 'cached';
    await manager.destroyBrowser(1);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    assert.equal(manager.get(1).session, a.session);
    assert.equal(manager.get(1).session.cookieMarker, 'accepted');
    a.session.clearStorageData = async () => { delete a.session.cookieMarker; };
    a.session.clearCache = async () => { delete a.session.cacheMarker; };
    await manager.prepareCycleDocument(1);
    assert.equal(a.session.cookieMarker, undefined);
    assert.equal(a.session.cacheMarker, undefined);
    assert.equal(b.session.cookieMarker, undefined);
    await manager.destroyAll();
});

test('browser destruction releases connections but never clears native storage', async () => {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    const managed = manager.get(1);
    managed.session.clearCache = () => { throw new Error('Cache removed on destruction'); };
    managed.session.clearStorageData = () => { throw new Error('Storage removed on destruction'); };
    await manager.destroyBrowser(1);
    assert.equal(managed.view.webContents.isDestroyed(), true);
    assert.equal(managed.session.proxy.mode, 'direct');
    await manager.destroyAll();
});

test('cycle data-clearing failures are reported instead of starting with dirty storage', async () => {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    manager.get(1).session.clearCache = async () => { throw Error('cache clearing failed'); };
    await assert.rejects(manager.prepareCycleDocument(1), /cache clearing failed/);
    await manager.destroyAll();
});

test('Stop cancels a stalled renderer-cache acknowledgement and releases request ownership', async () => {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    const managed = manager.get(1), controller = new AbortController();
    managed.view.webContents.send = () => {};
    const work = manager.prepareCycleDocument(1, controller.signal);
    await tick(); controller.abort();
    await assert.rejects(work, /cancelled/);
    assert.equal(managed.rendererCacheRequest, null);
    await manager.destroyAll();
});

test('the outgoing target’s delayed abort does not reject the new local blank document', async () => {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    const wc = manager.get(1).view.webContents, listeners = wc.listenerCount('did-navigate');
    wc.url = 'https://appareldiary.com/outgoing';
    wc.loadURL = () => {
        setImmediate(() => { wc.url = 'about:blank'; wc.emit('did-navigate', {}, 'about:blank'); });
        return Promise.reject(new Error(" (-3) loading 'https://appareldiary.com/outgoing'"));
    };
    try {
        await manager.prepareCycleDocument(1);
        assert.equal(wc.getURL(), 'about:blank');
        assert.equal(wc.listenerCount('did-navigate'), listeners);
    } finally { await manager.destroyAll(); }
});
