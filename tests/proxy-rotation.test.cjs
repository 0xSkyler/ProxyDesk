'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree, fakeElectron } = require('./helpers.cjs');
const root = path.resolve(__dirname, '../src');
const tick = () => new Promise(setImmediate);
const proxy = n => ({ id: 'proxy-' + n, protocol: 'http', host: '127.0.0.' + n, port: 8080 });

function controllerFixture(health, fetchAssignDirect) {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const events = [], states = new Map(health.map((value, i) => [i + 1, value]));
    const browser = {
        getProxyRotationState: id => ({ ...states.get(id) }), prepareCycleDocument: async () => {},
        beginProxyCycle: id => events.push(['begin', id]),
        cancelMeasurementSession: id => events.push(['stop', id]),
        setBrowserKeepAlive() {}, clearCache: () => { throw new Error('Cache deletion must never occur'); },
        assignProxy: async (id, value) => { events.push(['proxy', id, value?.id || null]); },
        startMeasurementSession: () => 1
    };
    const automation = new SeoAutomationManager({ fetchAssignDirect }, browser, async () => []);
    automation.state = { ...automation.state, running: true, cycleNumber: 1, browserIds: [...states.keys()],
        query: 'first,second,third', targetWebsite: 'fixture.test' };
    automation.monitorBrowserSession = async (_generation, cycle, id, _token, keyword) => events.push(['search', id, keyword, cycle]);
    return { automation, events, states };
}

test('only failed/unproven slots rotate, retained browsers keep routing and move to the next keyword', async () => {
    let fetchedIds, options;
    const f = controllerFixture([
        { proxy: proxy(1), googleReached: true, targetOpened: true, captchaSeen: false, failed: false },
        { proxy: proxy(2), googleReached: true, targetOpened: true, captchaSeen: false, failed: false },
        { proxy: proxy(3), googleReached: true, targetOpened: true, captchaSeen: false, failed: true }
    ], async (ids, assign, progress, source) => {
        fetchedIds = [...ids]; options = source;
        assert.equal(f.events.filter(e => e[0] === 'clean').length, 0, 'cache must be retained');
        assert.equal(f.events.filter(e => e[0] === 'search').length, 2, 'healthy searches must start before the provider request finishes');
        progress(4, 4, 1, 1, 4); assign({ browserId: 3, proxy: proxy(4) });
    });
    await f.automation.runCycle();
    assert.deepEqual(fetchedIds, [3]);
    assert.deepEqual(f.events.filter(e => e[0] === 'proxy'), [['proxy', 3, null], ['proxy', 3, 'proxy-4']]);
    assert.deepEqual(f.events.filter(e => e[0] === 'search'), [['search', 1, 'second', 2], ['search', 2, 'third', 2], ['search', 3, 'first', 2]]);
    assert.deepEqual(Array.from(options.retainedAssignments, a => a.proxy.id), ['proxy-1', 'proxy-2']);
    assert.deepEqual(Array.from(options.failedProxies, p => p.id), ['proxy-3']);
    assert.equal(f.automation.state.assignedBrowsers, 3);
    assert.equal(f.automation.state.retainedBrowsers, 2);
    assert.equal(f.automation.state.replacedBrowsers, 1);
});

test('all-healthy cycles never call the API or reset routing, and keywords wrap on later cycles', async () => {
    const f = controllerFixture([1, 2, 3].map(n => ({ proxy: proxy(n), googleReached: true, targetOpened: true, captchaSeen: false, failed: false })),
        async () => { throw new Error('Healthy cycles must not fetch proxies'); });
    await f.automation.runCycle(); await f.automation.runCycle(); await f.automation.runCycle();
    assert.equal(f.events.filter(e => e[0] === 'proxy').length, 0);
    assert.equal(f.events.filter(e => e[0] === 'clean').length, 0, 'all-healthy cycles preserve cache');
    assert.deepEqual(f.events.filter(e => e[0] === 'search').map(e => e.slice(1)), [
        [1, 'second', 2], [2, 'third', 2], [3, 'first', 2],
        [1, 'third', 3], [2, 'first', 3], [3, 'second', 3],
        [1, 'first', 4], [2, 'second', 4], [3, 'third', 4]
    ]);
    assert.equal(f.automation.state.lastError, undefined);
});

test('only a target-opening proxy with no CAPTCHA or later failure is retained', async () => {
    let replacements, excluded;
    const f = controllerFixture([
        { proxy: proxy(1), googleReached: true, targetOpened: true, captchaSeen: false, failed: false },
        { proxy: proxy(2), googleReached: true, targetOpened: true, captchaSeen: true, failed: false },
        { proxy: proxy(3), googleReached: true, targetOpened: false, captchaSeen: false, failed: false },
        { proxy: proxy(4), googleReached: true, targetOpened: true, captchaSeen: false, failed: true }
    ], async (ids, assign, progress, options) => {
        replacements = [...ids]; excluded = options.failedProxies;
        progress(7, 7, 3, 3, 7);
        ids.forEach((id, i) => assign({ browserId: id, proxy: proxy(5 + i) }));
    });
    await f.automation.runCycle();
    assert.deepEqual(replacements, [2, 3, 4]);
    assert.deepEqual(Array.from(excluded, p => p.id), ['proxy-2', 'proxy-3', 'proxy-4']);
    assert.equal(f.events.some(e => e[0] === 'proxy' && e[1] === 1), false);
    assert.equal(f.automation.state.retainedBrowsers, 1);
    assert.equal(f.automation.state.replacedBrowsers, 3);
});

test('a replacement API outage leaves healthy proxies and their new keyword searches intact', async () => {
    const f = controllerFixture([
        { proxy: proxy(1), googleReached: true, targetOpened: true, captchaSeen: false, failed: false },
        { proxy: proxy(2), googleReached: false, targetOpened: false, captchaSeen: false, failed: false }
    ], async () => { throw new Error('Provider is offline'); });
    await f.automation.runCycle();
    assert.deepEqual(f.events.filter(e => e[0] === 'proxy'), [['proxy', 2, null]]);
    assert.deepEqual(f.events.filter(e => e[0] === 'search'), [['search', 1, 'second', 2]]);
    assert.equal(f.automation.state.lastError, 'Provider is offline');
    assert.equal(f.automation.state.retainedBrowsers, 1);
});

test('retained endpoints and recently failed endpoints cannot be reassigned, including under another protocol', async () => {
    const feed = 'http://127.0.0.1:8080\nsocks5://127.0.0.1:8080\nhttp://127.0.0.2:8080\nhttp://127.0.0.3:8080\nhttp://127.0.0.4:8080';
    const { ProxyManager } = loadTree(root, {}, { fetch: async () => ({ ok: true, text: async () => feed }) })('main/ProxyManager.js');
    const manager = new ProxyManager(), retained = [{ browserId: 1, proxy: proxy(1) }, { browserId: 2, proxy: proxy(2) }], assigned = [];
    const summary = await manager.fetchAssignDirect([3, 4], a => assigned.push(a), undefined,
        { retainedAssignments: retained, failedProxies: [proxy(3)] });
    assert.equal(assigned.length, 1);
    assert.equal(assigned[0].proxy.host, '127.0.0.4');
    assert.equal(manager.getAssignment(1), retained[0].proxy);
    assert.equal(manager.getAssignment(2), retained[1].proxy);
    assert.equal(manager.getAssignment(4), null, 'short pools must leave slots waiting rather than steal a retained endpoint');
    assert.equal(summary.assignments[1].proxy, null);
});

test('CAPTCHA and connection failures remain recorded until the next proxy cycle', async () => {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' }); await manager.assignProxy(1, proxy(1));
    const managed = manager.get(1), wc = managed.view.webContents;
    wc.emit('did-start-loading');
    wc.emit('did-navigate', {}, 'https://www.google.com/search?q=first', 200);
    assert.equal(managed.state.loading, true);
    assert.equal(manager.getProxyRotationState(1).googleReached, true);
    assert.equal(manager.getProxyRotationState(1).targetOpened, false);
    wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://www.google.com/search?q=first', true);
    wc.emit('did-navigate', {}, 'https://www.google.com/sorry/index', 429);
    assert.equal(manager.getProxyRotationState(1).failed, false);
    assert.equal(manager.getProxyRotationState(1).captchaSeen, true);
    wc.emit('did-fail-load', {}, -130, 'ERR_PROXY_CONNECTION_FAILED', 'https://appareldiary.com/article', true);
    assert.equal(manager.getProxyRotationState(1).failed, true);
    // A subsequent ready/result event must not erase an earlier transport
    // failure: the proxy did not remain alive throughout this cycle.
    wc.emit('did-navigate', {}, 'https://www.google.com/search?q=first', 200);
    assert.equal(manager.getProxyRotationState(1).failed, true);
    await manager.assignProxy(1, proxy(4));
    assert.equal(manager.getProxyRotationState(1).googleReached, false);
    assert.equal(manager.getProxyRotationState(1).targetOpened, false);
    assert.equal(manager.getProxyRotationState(1).captchaSeen, false);
    assert.equal(manager.getProxyRotationState(1).failed, false);
    await manager.destroyAll();
});

test('target retention proof requires a successful current-search target commit before Ready', async () => {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' }); await manager.assignProxy(1, proxy(1));
    const managed = manager.get(1), wc = managed.view.webContents;
    try {
        wc.emit('did-navigate', {}, 'https://fixture.test/direct', 200);
        assert.equal(manager.getProxyRotationState(1).targetOpened, false, 'a page outside the active target search does not qualify');
        const token = manager.startMeasurementSession(1);
        managed.googleConfig = { target: 'fixture.test', query: 'first', start: '0', navigation: 1, token };
        wc.emit('did-navigate', {}, 'https://other.test/article', 200);
        wc.emit('did-navigate', {}, 'https://fixture.test/article', 503);
        assert.equal(manager.getProxyRotationState(1).targetOpened, false, 'a different host or failed target response does not qualify');
        wc.emit('did-start-loading');
        wc.emit('did-navigate', {}, 'https://fixture.test/article', 200);
        assert.equal(manager.getProxyRotationState(1).targetOpened, true);
        assert.equal(managed.state.loading, true, 'target commit does not wait for Ready');
        manager.beginProxyCycle(1);
        assert.equal(manager.getProxyRotationState(1).targetOpened, false, 'every cycle must open a target again');
        manager.cancelMeasurementSession(1);
        managed.googleConfig = { target: 'fixture.test', token };
        wc.emit('did-navigate', {}, 'https://fixture.test/stale', 200);
        assert.equal(manager.getProxyRotationState(1).targetOpened, false, 'an outgoing token cannot prove success in a new cycle');
        wc.emit('did-fail-load', {}, -20, 'ERR_BLOCKED_BY_CLIENT', 'https://other.test/advert', false);
        assert.equal(manager.getProxyRotationState(1).failed, false, 'an unrelated blocked child frame is not a dead proxy');
        wc.emit('did-fail-load', {}, -130, 'ERR_PROXY_CONNECTION_FAILED', 'https://fixture.test/frame', false);
        assert.equal(manager.getProxyRotationState(1).failed, true, 'an explicit proxy failure counts even in a child frame');
    } finally { await manager.destroyAll(); }
});

test('inline CAPTCHA detection is sticky across recovery and cannot be supplied by a stale frame or search', async () => {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' }); await manager.assignProxy(1, proxy(1));
    const managed = manager.get(1), wc = managed.view.webContents;
    wc.mainFrame = { processId: 1, routingId: 1 }; wc.url = 'https://www.google.com/search?q=first';
    const token = manager.startMeasurementSession(1);
    managed.googleConfig = { target: 'fixture.test', query: 'first', start: '0', navigation: 1, token };
    const payload = { documentUrl: wc.url, navigation: 1, token, state: { blocked: true, observedResults: 0 } };
    const emit = (value, senderFrame = wc.mainFrame) => wc.emit('ipc-message', { senderFrame }, 'dom:google-state', value);
    try {
        emit(payload, { processId: 2, routingId: 1 });
        emit({ ...payload, token: token - 1 });
        emit({ ...payload, documentUrl: 'https://www.google.com/search?q=other' });
        emit({ ...payload, state: { googlePrompt: 'verification', pendingResults: true, blocked: false } });
        assert.equal(manager.getProxyRotationState(1).captchaSeen, false, 'ordinary Continue is not CAPTCHA');
        emit(payload);
        assert.equal(manager.getProxyRotationState(1).captchaSeen, true);
        emit({ ...payload, state: { blocked: false, observedResults: 1, match: { url: 'https://fixture.test/article' } } });
        wc.emit('did-navigate', {}, 'https://fixture.test/article', 200);
        assert.equal(manager.getProxyRotationState(1).targetOpened, true);
        assert.equal(manager.getProxyRotationState(1).captchaSeen, true, 'opening a target after CAPTCHA does not erase it');
        manager.beginProxyCycle(1);
        assert.equal(manager.getProxyRotationState(1).captchaSeen, false);
        assert.equal(manager.getProxyRotationState(1).targetOpened, false);
    } finally { await manager.destroyAll(); }
});
