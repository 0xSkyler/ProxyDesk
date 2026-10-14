'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree, fakeElectron } = require('./helpers.cjs');
const { withTimeout } = require('../src/main/runtime');
const root = path.resolve(__dirname, '../src');
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('each cycle clears every cache before fetching/assigning proxies, with two cleanups at most', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const ids = [1, 2, 3, 4, 5], events = [];
    let active = 0, peak = 0, cycle = 0;
    const browser = {
        getProxyRotationState: () => ({proxy:null}), prepareCycleDocument: async () => {}, cancelMeasurementSession: id => events.push([cycle, 'stop', id]), setBrowserKeepAlive() {},
        assignProxy: async id => events.push([cycle, 'reset', id]),
        clearCache: async id => {
            active++; peak = Math.max(peak, active); await tick();
            events.push([cycle, 'clean', id]); active--;
        }
    };
    const proxies = { fetchAssignDirect: async () => {
        assert.equal(active, 0);
        assert.deepEqual(events.filter(e => e[0] === cycle && e[1] === 'clean').map(e => e[2]).sort(), ids);
        events.push([cycle, 'fetch']);
    } };
    const automation = new SeoAutomationManager(proxies, browser, async () => ids);
    automation.state = { ...automation.state, running: true, browserIds: ids, query: 'first,second' };
    for (cycle = 1; cycle <= 2; cycle++) await automation.runCycle();
    assert.equal(peak, 2);
    assert.equal(events.filter(e => e[1] === 'clean').length, 10);
    assert.equal(events.filter(e => e[1] === 'fetch').length, 2);
    assert.deepEqual(events.slice(0, 5).map(e => e[1]), ids.map(() => 'stop'));
});

test('Stop releases a hung native cache clear and never starts a new search', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const gate = deferred(); let fetched = false;
    const browser = { getProxyRotationState: () => ({proxy:null}), prepareCycleDocument: async () => {}, cancelMeasurementSession() {}, setBrowserKeepAlive() {}, assignProxy: async () => {}, clearCache: () => gate.promise };
    const proxy = { cancelCurrentFetch() {}, fetchAssignDirect: async () => { fetched = true; } };
    const automation = new SeoAutomationManager(proxy, browser, async () => []);
    automation.state = { ...automation.state, running: true, browserIds: [1], query: 'first' };
    const work = automation.runCycle(); await tick(); automation.stop();
    try {
        await withTimeout(work, 200, () => { throw new Error('Stop remained blocked by cache cleanup'); });
        assert.equal(fetched, false);
        assert.equal(automation.state.lastError, undefined);
    } finally { gate.resolve(); }
});

test('cache cleanup failure is reported and prevents proxy fetching', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    let fetched = false;
    const browser = { getProxyRotationState: () => ({proxy:null}), prepareCycleDocument: async () => {}, cancelMeasurementSession() {}, setBrowserKeepAlive() {}, assignProxy: async () => {},
        clearCache: async () => { throw new Error('Cache could not be cleared'); } };
    const automation = new SeoAutomationManager({ fetchAssignDirect: async () => { fetched = true; } }, browser, async () => []);
    automation.state = { ...automation.state, running: true, browserIds: [1], query: 'first' };
    await automation.runCycle();
    assert.equal(fetched, false);
    assert.equal(automation.state.lastError, 'Cache could not be cleared');
    assert.equal(automation.state.cycleInProgress, false);
});

test('native cache clearing is deduplicated, clears Cache Storage, and retains cookies', async () => {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    const browser = manager.get(1), gate = deferred(), storages = [];
    let clears = 0;
    browser.session.clearCache = () => { clears++; return gate.promise; };
    browser.session.clearStorageData = async options => storages.push(options);
    const first = manager.clearCache(1), second = manager.clearCache(1);
    await tick(); assert.equal(clears, 1);
    assert.equal(browser.view.webContents.sent.filter(message => message.channel === 'dom:clear-renderer-cache').length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(storages)), [{ storages: ['cachestorage'] }]);
    gate.resolve(); await Promise.all([first, second]);
    await manager.clearCache(1); assert.equal(clears, 2);
    browser.session.clearCache = async () => {};
    await manager.destroyAll();
});

test('memory cache acknowledgements require the current main frame and request ID', async () => {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    const managed = manager.get(1), wc = managed.view.webContents;
    wc.mainFrame = { processId: 1, routingId: 10 }; wc.send = () => {};
    let done = false;
    const work = manager.clearRendererCache(managed).then(() => { done = true; });
    const requestId = managed.rendererCacheRequest.requestId;
    wc.emit('ipc-message', { senderFrame: { processId: 2, routingId: 10 } }, 'dom:renderer-cache-cleared', { requestId });
    wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'dom:renderer-cache-cleared', { requestId: requestId + 1 });
    await tick(); assert.equal(done, false);
    wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'dom:renderer-cache-cleared', { requestId });
    await work; assert.equal(done, true); assert.equal(managed.rendererCacheRequest, null);
    await manager.destroyAll();
});

test('a lost cache-cleanup message is replayed instead of stalling rotation during a frame swap', async () => {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    const managed = manager.get(1), wc = managed.view.webContents, send = wc.send.bind(wc);
    let requests = 0;
    wc.send = (channel, ...args) => {
        if (channel === 'dom:clear-renderer-cache' && ++requests === 1) return;
        send(channel, ...args);
    };
    try {
        await withTimeout(manager.clearRendererCache(managed), 1_000, () => { throw new Error('A dropped message stalled cache cleanup'); });
        assert.equal(requests, 2);
        assert.equal(managed.rendererCacheRequest, null);
    } finally { await manager.destroyAll(); }
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
