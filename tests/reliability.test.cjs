'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { loadTree, fakeElectron } = require('./helpers.cjs');
const root = path.resolve(__dirname, '../src');
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise((r) => resolve = r); return { resolve, promise }; };

async function managerFixture() {
    const electron = fakeElectron();
    const intervals = new Set();
    const load = loadTree(root, electron, { setInterval: (fn) => { intervals.add(fn); return fn; }, clearInterval: (fn) => intervals.delete(fn) });
    const { BrowserManager } = load('main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { persistSessions: false, startPage: 'about:blank', userAgent: '' });
    return { manager, electron, intervals };
}

test('successful timeout races release the losing timer', async () => {
    const timers = new Set();
    const { withTimeout } = loadTree(root, {}, { setTimeout: (fn) => { timers.add(fn); return fn; }, clearTimeout: (fn) => timers.delete(fn) })('main/runtime.js');
    assert.equal(await withTimeout(Promise.resolve('ready'), 14000, () => 'timeout'), 'ready');
    assert.equal(timers.size, 0);
});
test('timeout fallback and errors preserve results', async () => {
    const { withTimeout } = require('../src/main/runtime');
    assert.equal(await withTimeout(new Promise(() => {}), 5, () => null), null);
    await assert.rejects(withTimeout(new Promise(() => {}), 5, () => { throw new Error('expired'); }), /expired/);
});
test('Stop cancels long monitor sleeps immediately and detaches abort listener', async () => {
    const { cancellableDelay } = require('../src/main/runtime');
    const controller = new AbortController();
    const work = cancellableDelay(30000, controller.signal); controller.abort(); await work;
    await cancellableDelay(30000, controller.signal);
});
test('100 sleeping monitors keep cancellation listeners bounded and release every timer on rotation and Stop', async () => {
    const { getEventListeners, setMaxListeners, getMaxListeners } = require('node:events');
    class RuntimeAbortController extends AbortController {
        constructor() { super(); setMaxListeners(10, this.signal); }
    }
    const timers = new Set();
    const { SeoAutomationManager } = loadTree(root, {}, {
        AbortController: RuntimeAbortController,
        setInterval: () => 1, clearInterval() {},
        setTimeout: (fn) => { timers.add(fn); return fn; }, clearTimeout: (fn) => timers.delete(fn)
    })('main/SeoAutomationManager.js');
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    let searches = 0;
    const browser = {
        cancelMeasurementSession() {}, setBrowserKeepAlive() {}, assignProxy: async () => {},
        startMeasurementSession: () => 1, isMeasurementSessionCurrent: () => true,
        broadcastSearch: async () => { searches++; return { status: 'no-match' }; }
    };
    const proxies = { cancelCurrentFetch() {}, fetchAssignDirect: async (values, assign) => {
        for (const browserId of values) assign({ browserId, proxy: { host: '127.0.0.1', port: 8080 } });
    } };
    const automation = new SeoAutomationManager(proxies, browser, async () => ids);
    const warnings = [];
    const recordWarning = (warning) => warnings.push(warning);
    process.on('warning', recordWarning);
    try {
        await automation.start({ query: 'first, second', targetWebsite: 'fixture.local', browserCount: 100 });
        for (let i = 0; i < 10; i++) await tick();
        const oldSignal = automation.cycleController.signal;
        assert.equal(searches, 100);
        assert.equal(timers.size, 100);
        assert.equal(getEventListeners(oldSignal, 'abort').length, 100);
        assert.equal(getMaxListeners(oldSignal), 100);
        await automation.runNow(); await tick();
        assert.equal(searches, 200);
        assert.equal(getEventListeners(oldSignal, 'abort').length, 0);
        assert.equal(timers.size, 100);
        const signal = automation.cycleController.signal;
        automation.stop(); await tick();
        assert.equal(timers.size, 0);
        assert.equal(getEventListeners(signal, 'abort').length, 0);
        assert.equal(warnings.filter((warning) => warning.name === 'MaxListenersExceededWarning').length, 0);
    } finally {
        automation.stop();
        process.removeListener('warning', recordWarning);
    }
});
test('destruction closes views before stalled storage cleanup and invalidates workers', async () => {
    const { manager, electron, intervals } = await managerFixture();
    manager.configureKeepAlive(60000, 1, false);
    const managed = manager.get(1), token = manager.startMeasurementSession(1);
    const storage = deferred(); managed.session.clearStorageData = () => storage.promise;
    const cleanup = manager.destroyAll(); await tick();
    assert.equal(electron.views[0].webContents.destroyed, true);
    assert.equal(electron.views[0].attached, false);
    assert.equal(manager.isMeasurementSessionCurrent(1, token), false);
    assert.equal(intervals.size, 0);
    assert.equal(electron.app.listenerCount('login'), 0);
    storage.resolve(); await cleanup;
    assert.equal(manager.browsers.size, 0);
});
test('concurrent creation deduplicates workspace, duplicate destruction is safe', async () => {
    const { manager, electron } = await managerFixture();
    const options = { startPage: 'about:blank', persistSessions: false };
    await Promise.all([manager.createBrowser(2, options), manager.createBrowser(2, options)]);
    assert.equal(electron.views.length, 2);
    await Promise.all([manager.destroyBrowser(2), manager.destroyBrowser(2)]);
    assert.equal(manager.browsers.size, 1);
    await manager.destroyAll();
});
test('same ID recreation waits for disposal and cannot reactivate an old token', async () => {
    const { manager } = await managerFixture();
    const token = manager.startMeasurementSession(1); const wait = deferred();
    manager.get(1).session.clearStorageData = () => wait.promise;
    const disposal = manager.destroyBrowser(1); await tick();
    const creation = manager.createBrowser(1, { startPage: 'about:blank' }); await tick();
    assert.equal(manager.browsers.has(1), false);
    wait.resolve(); await disposal; await creation;
    assert.notEqual(manager.startMeasurementSession(1), token);
    await manager.destroyAll();
});
test('duplicate snapshots and unchanged bounds do not consume IPC/native updates', async () => {
    const { manager } = await managerFixture();
    let changes = 0; manager.on('stateChanged', () => changes++);
    manager.updateState(manager.get(1), { loading: false });
    manager.updateState(manager.get(1), { loading: true });
    manager.updateState(manager.get(1), { loading: true });
    assert.equal(changes, 1);
    const bounds = { x: 1, y: 2, width: 3, height: 4 };
    manager.setBounds(1, bounds); manager.setBounds(1, bounds);
    assert.equal(manager.get(1).view.webContents.boundsWrites, 1);
    manager.setBounds(99, bounds); await manager.destroyAll();
});
test('proxy change closes pooled connections while retaining proxy scheme and bypass rules', async () => {
    const { manager } = await managerFixture();
    await manager.assignProxy(1, { protocol: 'socks5', host: '127.0.0.2', port: 1080 });
    assert.equal(manager.get(1).session.proxy.proxyRules, 'socks5://127.0.0.2:1080');
    assert.equal(manager.get(1).session.proxy.proxyBypassRules, '<local>');
    assert.equal(manager.get(1).session.connectionsClosed, 1);
    await manager.assignProxy(1, null); assert.equal(manager.get(1).session.connectionsClosed, 2);
    await manager.destroyAll();
});
test('Stop during browser preparation cannot resurrect running state or a rotation timer', async () => {
    const preparation = deferred(); let timers = 0;
    const { SeoAutomationManager } = loadTree(root, {}, { setInterval: () => { timers++; return 1; } })('main/SeoAutomationManager.js');
    const automation = new SeoAutomationManager({ cancelCurrentFetch() {} }, {}, () => preparation.promise);
    const work = automation.start({ query: 'a, b', targetWebsite: 'example.test', intervalSec: 600, browserCount: 10, maxPages: 20 });
    automation.stop(); preparation.resolve([1, 2]); await work;
    assert.equal(automation.getState().running, false); assert.equal(timers, 0);
});
test('stale preparation failure cannot overwrite a newer Start', async () => {
    const preparation = deferred();
    const { SeoAutomationManager } = loadTree(root, {}, { setInterval: () => 1, clearInterval() {} })('main/SeoAutomationManager.js');
    const automation = new SeoAutomationManager({ cancelCurrentFetch() {}, fetchAssignDirect: async () => {} }, { cancelMeasurementSession() {}, setBrowserKeepAlive() {}, assignProxy: async () => {} }, () => preparation.promise);
    const work = automation.start({ query: 'a', targetWebsite: 'example.test', browserCount: 1 }); automation.stop(); preparation.resolve([]); await work;
    assert.equal(automation.getState().lastError, undefined);
});
test('keyword ordering, concurrent assignment, browser bounds and Stop behavior remain', async () => {
    const { SeoAutomationManager } = loadTree(root, {}, { setInterval: () => 1, clearInterval() {} })('main/SeoAutomationManager.js');
    const assignments = [], searches = [], enabled = [];
    const browser = { cancelMeasurementSession() {}, setBrowserKeepAlive(id, value) { enabled.push([id, value]); }, assignProxy: async (id, proxy) => assignments.push([id, proxy]), startMeasurementSession: () => 1, isMeasurementSessionCurrent: () => true, broadcastSearch: async (id, query) => { searches.push([id, query]); return { status: 'matched', interactionStatus: 'opened', matchedUrl: 'https://example.test/a' }; }, startControlledKeepAlive() {} };
    const proxies = { cancelCurrentFetch() {}, fetchAssignDirect: async (ids, callback) => ids.forEach((id) => callback({ browserId: id, proxy: { host: '127.0.0.1', port: id } })) };
    const automation = new SeoAutomationManager(proxies, browser, async () => [1, 2, 3]);
    await automation.start({ query: ' first, second ', targetWebsite: 'example.test', intervalSec: 30, browserCount: 3, maxPages: 20 }); await tick();
    assert.deepEqual(searches.map((entry) => entry[1]), ['first', 'first', 'first']);
    await automation.runNow(); await tick();
    assert.deepEqual(searches.slice(3).map((entry) => entry[1]), ['second', 'second', 'second']);
    automation.stop(); assert.equal(automation.getState().running, false); assert.equal(automation.timer, null);
    assert.equal(assignments.filter(([, proxy]) => proxy).length, 6);
    assert.equal(enabled.filter(([, value]) => value).length, 0);
});
test('direct proxy API deduplication keeps ordering and leaves surplus browsers unassigned', async () => {
    const { ProxyManager } = loadTree(root, {}, { fetch: async () => ({ ok: true, text: async () => 'http://127.0.0.1:8080\nsocks5://127.0.0.1:8080\nsocks5://127.0.0.2:1080' }) })('main/ProxyManager.js');
    const manager = new ProxyManager(); const assigned = [];
    const summary = await manager.fetchAssignDirect([1, 2, 3], (value) => assigned.push(value));
    assert.equal(assigned.length, 2); assert.equal(summary.working, 2);
    assert.equal(summary.assignments[2].proxy, null);
    assert.equal(manager.fetchController, null);
});
test('already aborted API request never performs network work', async () => {
    let requests = 0;
    const { fetchAllWorkingProxyText } = loadTree(root, {}, { fetch: async () => { requests++; } })('proxy/AllWorkingProxyProvider.js');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(fetchAllWorkingProxyText(controller.signal), /cancelled/); assert.equal(requests, 0);
});
test('IPC listeners/handlers are disposed and destroyed shells are skipped', () => {
    const handlers = new Map(); const browsers = new EventEmitter(), automation = new EventEmitter();
    const electron = { ipcMain: { handle: (channel, callback) => handlers.set(channel, callback), removeHandler: (channel) => handlers.delete(channel) }, BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => true }] } };
    const { registerIpc } = loadTree(root, electron)('main/ipc/registerIpc.js');
    const dispose = registerIpc({ browserManager: browsers, automationManager: automation });
    browsers.emit('stateChanged', {}); assert.equal(handlers.size, 8);
    dispose(); assert.equal(handlers.size, 0); assert.equal(browsers.listenerCount('stateChanged'), 0); assert.equal(automation.listenerCount('seoResult'), 0);
});
test('preload coalesces scroll geometry per frame and preserves all Promise settlements', async () => {
    const calls = []; let frame, api;
    loadTree(root, { ipcRenderer: { invoke: async (...args) => calls.push(args) }, contextBridge: { exposeInMainWorld: (_, value) => api = value } }, { requestAnimationFrame: (fn) => { frame = fn; return 1; } })('preload/preload.js');
    const first = api.browser.setBounds(1, { x: 1 }), second = api.browser.setBounds(1, { x: 2 }), third = api.browser.setBounds(2, { x: 3 });
    assert.equal(calls.length, 0); frame(); await Promise.all([first, second, third]);
    assert.equal(calls.length, 2); assert.equal(calls[0][2].x, 2);
});
test('renderer and its UI controls remain byte-for-byte identical to the reference', () => {
    const manifest = require('../docs/recovery-manifest.json');
    for (const [file, hash] of Object.entries(manifest.files).filter(([file]) => file.startsWith('dist/renderer/'))) {
        const actual = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, file.replace(/^dist\//, '')))).digest('hex');
        assert.equal(actual, hash, file);
    }
});
test('renderer Keep Alive cancellation releases its sleep and prevents a late link click', async () => {
    const { buildKeepAliveActionScript } = loadTree(root, fakeElectron())('main/BrowserManager.js');
    const timers = new Set(); const window = { innerHeight: 1000, scrollBy() {} };
    const context = require('node:vm').createContext({ window, document: { scrollingElement: { scrollHeight: 10 }, documentElement: { scrollHeight: 10 }, body: { scrollHeight: 10 } }, AbortController, URL, setTimeout: (fn) => { timers.add(fn); return fn; }, clearTimeout: (fn) => timers.delete(fn), performance: { now: () => 0 } });
    const work = require('node:vm').runInContext(buildKeepAliveActionScript(true), context);
    assert.equal(timers.size, 1); window.__proxyDeskKeepAliveController.abort();
    await assert.rejects(work, /cancelled/); assert.equal(timers.size, 0);
    assert.equal(window.__proxyDeskKeepAliveController, undefined);
});
test('overlapping proxy changes settle in request order without blocking other browsers', async () => {
    const { manager } = await managerFixture();
    await manager.createBrowser(2, { startPage: 'about:blank' });
    const stalled = deferred(); const session = manager.get(1).session;
    const order = [];
    session.setProxy = async (value) => { order.push(value.proxyRules || value.mode); if (order.length === 1) await stalled.promise; };
    const first = manager.assignProxy(1, { protocol: 'http', host: '127.0.0.1', port: 1 });
    const second = manager.assignProxy(1, { protocol: 'http', host: '127.0.0.1', port: 2 });
    await tick(); await manager.assignProxy(2, null);
    assert.equal(order.length, 1); stalled.resolve(); await Promise.all([first, second]);
    assert.deepEqual(order, ['http://127.0.0.1:1', 'http://127.0.0.1:2']);
    await manager.destroyAll();
});
test('main quit awaits owned cleanup and disposes handlers before final quit', async () => {
    const electron = fakeElectron(); const handlers = new Map(); const windows = []; const intervals = new Set();
    class BrowserWindow extends EventEmitter {
        constructor() { super(); Object.assign(this, electron.window); this.webContents = new EventEmitter(); this.webContents.isDestroyed = () => false; this.webContents.send = () => {}; windows.push(this); }
        async loadFile(file) { this.file = file; }
        async loadURL(url) { this.url = url; }
        show() { this.shown = true; }
        static getAllWindows() { return windows; }
    }
    electron.BrowserWindow = BrowserWindow;
    electron.ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) };
    electron.session.defaultSession = { setPermissionRequestHandler() {} };
    electron.app.whenReady = () => Promise.resolve();
    let finalQuit = false;
    electron.app.quit = () => { const event = { prevented: false, preventDefault() { this.prevented = true; } }; electron.app.emit('before-quit', event); if (!event.prevented) finalQuit = true; };
    electron.app.exit = () => { throw new Error('Unexpected forced exit'); };
    const testProcess = Object.assign(new EventEmitter(), { env: { NODE_ENV: 'production' }, platform: 'linux', pid: process.pid });
    loadTree(root, electron, { process: testProcess, setInterval: (fn) => { intervals.add(fn); return fn; }, clearInterval: (fn) => intervals.delete(fn) })('main/main.js');
    for (let i = 0; i < 50 && !windows[0]?.shown; i++) await tick();
    assert.equal(windows[0].shown, true); assert.ok(windows[0].file.endsWith('renderer/index.html'));
    assert.equal(handlers.size, 8); assert.equal(electron.views.length, 10);
    const pending = deferred(); const activeSession = [...electron.sessions.entries()].find(([name]) => !name.startsWith('persist:'))[1];
    activeSession.clearStorageData = () => pending.promise;
    electron.app.quit(); await tick();
    assert.equal(finalQuit, false); assert.equal(handlers.size, 0); assert.equal(intervals.size, 0);
    assert.equal(electron.views.every((view) => view.webContents.isDestroyed()), true);
    pending.resolve(); for (let i = 0; i < 50 && !finalQuit; i++) await tick();
    assert.equal(finalQuit, true);
});
