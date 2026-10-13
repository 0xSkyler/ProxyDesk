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
        setBrowserKeepAlive() {}, clearCache: async id => events.push(['clean', id]),
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
        { proxy: proxy(1), googleReached: true, failed: false },
        { proxy: proxy(2), googleReached: true, failed: false },
        { proxy: proxy(3), googleReached: true, failed: true }
    ], async (ids, assign, progress, source) => {
        fetchedIds = [...ids]; options = source;
        assert.equal(f.events.filter(e => e[0] === 'clean').length, 3);
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
    const f = controllerFixture([1, 2, 3].map(n => ({ proxy: proxy(n), googleReached: true, failed: false })),
        async () => { throw new Error('Healthy cycles must not fetch proxies'); });
    await f.automation.runCycle(); await f.automation.runCycle(); await f.automation.runCycle();
    assert.equal(f.events.filter(e => e[0] === 'proxy').length, 0);
    assert.equal(f.events.filter(e => e[0] === 'clean').length, 9);
    assert.deepEqual(f.events.filter(e => e[0] === 'search').map(e => e.slice(1)), [
        [1, 'second', 2], [2, 'third', 2], [3, 'first', 2],
        [1, 'third', 3], [2, 'first', 3], [3, 'second', 3],
        [1, 'first', 4], [2, 'second', 4], [3, 'third', 4]
    ]);
    assert.equal(f.automation.state.lastError, undefined);
});

test('a replacement API outage leaves healthy proxies and their new keyword searches intact', async () => {
    const f = controllerFixture([
        { proxy: proxy(1), googleReached: true, failed: false },
        { proxy: proxy(2), googleReached: false, failed: false }
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

test('Google reachability is tracked before Ready; aborted loads and Google challenges do not invalidate the proxy', async () => {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' }); await manager.assignProxy(1, proxy(1));
    const managed = manager.get(1), wc = managed.view.webContents;
    wc.emit('did-start-loading');
    wc.emit('did-navigate', {}, 'https://www.google.com/search?q=first', 200);
    assert.equal(managed.state.loading, true);
    assert.equal(manager.getProxyRotationState(1).googleReached, true);
    wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://www.google.com/search?q=first', true);
    wc.emit('did-navigate', {}, 'https://www.google.com/sorry/index', 429);
    assert.equal(manager.getProxyRotationState(1).failed, false);
    wc.emit('did-fail-load', {}, -130, 'ERR_PROXY_CONNECTION_FAILED', 'https://appareldiary.com/article', true);
    assert.equal(manager.getProxyRotationState(1).failed, true);
    // A subsequent ready/result event must not erase an earlier transport
    // failure: the proxy did not remain alive throughout this cycle.
    wc.emit('did-navigate', {}, 'https://www.google.com/search?q=first', 200);
    assert.equal(manager.getProxyRotationState(1).failed, true);
    await manager.assignProxy(1, proxy(4));
    assert.equal(manager.getProxyRotationState(1).googleReached, false);
    assert.equal(manager.getProxyRotationState(1).failed, false);
    await manager.destroyAll();
});
