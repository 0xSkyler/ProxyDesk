'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree, fakeElectron } = require('./helpers.cjs');
const root = path.resolve(__dirname, '..');
async function setup(globals = {}) {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron, globals)('src/main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    const managed = manager.get(1), wc = managed.view.webContents;
    wc.mainFrame = {};
    function publish(state, overrides = {}) {
        const config = managed.googleConfig;
        wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'dom:google-state', {
            navigation: config.navigation, token: config.token, documentUrl: wc.getURL(), state, ...overrides
        });
    }
    return { manager, managed, wc, publish };
}
test('a visible first-page target opens while loadURL and executeJavaScript never settle', async () => {
    const { manager, managed, wc, publish } = await setup();
    let scriptCalls = 0;
    wc.isLoading = () => true;
    wc.executeJavaScript = () => { scriptCalls++; return new Promise(() => {}); };
    wc.loadURL = (url) => {
        wc.url = url;
        setImmediate(() => publish({ observedResults: 1, documentParsed: false, targetTextSeen: true,
            match: { url: 'https://appareldiary.com/article', title: 'Rewritten title', organicIndex: 0 } }));
        return new Promise(() => {});
    };
    wc.send = (channel) => { if (channel === 'dom:google-click') wc.url = 'https://appareldiary.com/article'; };
    const token = manager.startMeasurementSession(1), started = Date.now();
    const result = await manager.broadcastSearch(1, 'linear programming for sewing line balancing', 'appareldiary.com', 5, token);
    assert.equal(result.interactionStatus, 'opened');
    assert.equal(result.resultPage, 1);
    assert.equal(scriptCalls, 0);
    assert.ok(Date.now() - started < 1_000);
    assert.equal(managed.state.loading, false);
    assert.equal(managed.state.googleSearchActivity, 'opening-target');
    await manager.destroyAll();
});
test('a cited Google title resolves on click without waiting for Ready or inventing a destination', async () => {
    const { manager, wc, publish } = await setup();
    let scriptCalls = 0;
    wc.executeJavaScript = () => { scriptCalls++; return new Promise(() => {}); };
    wc.isLoading = () => true;
    wc.loadURL = (url) => {
        wc.url = url;
        setImmediate(() => publish({ observedResults: 1, documentParsed: false, targetTextSeen: true,
            match: { unresolved: true, displayedHost: 'appareldiary.com', title: 'Visible title', organicIndex: 0 } }));
        return new Promise(() => {});
    };
    wc.send = (channel) => { if (channel === 'dom:google-click') wc.url = 'https://appareldiary.com/actual-article'; };
    const token = manager.startMeasurementSession(1), started = Date.now();
    const result = await manager.broadcastSearch(1, 'linear programming', 'appareldiary.com', 5, token);
    assert.equal(result.resultPage, 1);
    assert.equal(result.matchedUrl, 'https://appareldiary.com/actual-article');
    assert.equal(result.interactionStatus, 'opened');
    assert.equal(scriptCalls, 0);
    assert.ok(Date.now() - started < 1_000);
    await manager.destroyAll();
});
test('an unresolved label cannot authorize a contradictory foreign destination', async () => {
    const { manager, wc, publish } = await setup();
    let clicks = 0;
    wc.loadURL = async (url) => {
        wc.url = url;
        setImmediate(() => publish({ observedResults: 1, documentParsed: false,
            match: { unresolved: true, displayedHost: 'appareldiary.com', url: 'https://competitor.test/a', organicIndex: 0 } }));
    };
    wc.send = (channel) => { if (channel === 'dom:google-click') clicks++; };
    const token = manager.startMeasurementSession(1);
    const result = await manager.broadcastSearch(1, 'first', 'appareldiary.com', 5, token);
    assert.equal(result.status, 'error');
    assert.equal(clicks, 0);
    await manager.destroyAll();
});
test('a failed result scan is reported instead of leaving the browser waiting silently', async () => {
    const { manager, managed, wc, publish } = await setup();
    wc.loadURL = async url => {
        wc.url = url;
        setImmediate(() => publish({ observedResults: 0, recognitionError: 'Scan failed', documentParsed: false }));
    };
    const token = manager.startMeasurementSession(1);
    const result = await manager.broadcastSearch(1, 'first', 'appareldiary.com', 5, token);
    assert.equal(result.status, 'error');
    assert.match(result.error, /Google result recognition failed: Scan failed/);
    assert.equal(managed.googleConfig, null);
    await manager.destroyAll();
});
test('a visible publisher reports its unselected title link without losing the current page', async () => {
    let time = 0;
    class Clock extends Date { static now() { return time += 1_000; } }
    const { manager, managed, wc, publish } = await setup({ Date: Clock });
    const pages = [];
    wc.loadURL = async url => {
        wc.url = url; pages.push(url);
        setImmediate(() => publish({ observedResults: 1, documentParsed: false, targetTextSeen: true,
            candidateText: 'Visible article', diagnostics: { targetLinks: 0,
                publisherTitle: { reason: 'unsupported-route', tag: 'a', route: '/other' } } }));
    };
    const token = manager.startMeasurementSession(1);
    const result = await manager.broadcastSearch(1, 'first', 'appareldiary.com', 5, token);
    assert.equal(result.status, 'monitoring');
    assert.match(result.error, /Title link: unsupported-route \(a, \/other\)/);
    assert.equal(result.matchedTitle, 'Visible article');
    assert.equal(pages.length, 1);
    assert.ok(managed.googleConfig);
    await manager.destroyAll();
});
for (const scenario of ['unrecognized', 'busy']) {
    test(`${scenario} first-page results cannot be treated as an absent target and skipped`, async () => {
        let time = 0;
        class Clock extends Date { static now() { return time += 1_000; } }
        const { manager, wc, publish } = await setup({ Date: Clock });
        const pages = [];
        wc.loadURL = async (url) => {
            wc.url = url; pages.push(url);
            setImmediate(() => publish({ documentParsed: true, observedResults: scenario === 'busy' ? 10 : 0,
                pendingResults: scenario === 'busy', nextPage: true, signature: 'stable', targetTextSeen: false }));
        };
        const token = manager.startMeasurementSession(1);
        const result = await manager.broadcastSearch(1, 'first', 'appareldiary.com', 5, token);
        assert.equal(result.status, 'monitoring');
        assert.equal(pages.length, 1);
        assert.equal(new URL(pages[0]).searchParams.get('start'), null);
        await manager.destroyAll();
    });
}
test('recognition rejects obsolete tokens, navigations, different queries and iframe messages', async () => {
    const { manager, managed, wc, publish } = await setup();
    const token = manager.startMeasurementSession(1);
    wc.url = 'https://www.google.com/search?q=first';
    managed.googleConfig = { navigation: 9, token, target: 'example.test', query: 'first', start: '0' };
    publish({ observedResults: 1 }, { navigation: 8 });
    publish({ observedResults: 2 }, { token: token - 1 });
    publish({ observedResults: 3 }, { documentUrl: 'https://www.google.com/search?q=second' });
    publish({ observedResults: 4 }, { documentUrl: 'https://www.google.com/search?q=first&start=10' });
    wc.emit('ipc-message', { senderFrame: {} }, 'dom:google-state', { navigation: 9, token, documentUrl: wc.url, state: { observedResults: 5 } });
    assert.equal(managed.googleState, undefined);
    publish({ observedResults: 6 });
    assert.equal(managed.googleState.observedResults, 6);
    manager.cancelMeasurementSession(1);
    assert.equal(managed.googleConfig, null);
    wc.emit('ipc-message', { senderFrame: wc.mainFrame }, 'dom:google-state', { navigation: 9, token, documentUrl: wc.url, state: { observedResults: 7 } });
    assert.equal(managed.googleState, null);
    await manager.destroyAll();
});
test('an unfinished page retains its observer and a retry opens its target without reloading', async () => {
    let time = 0;
    class Clock extends Date { static now() { return time += 1_000; } }
    const { manager, managed, wc, publish } = await setup({ Date: Clock });
    const pages = [];
    wc.loadURL = async (url) => {
        wc.url = url; pages.push(url);
        setImmediate(() => publish({ documentParsed: false, observedResults: 1, signature: 'initial', targetTextSeen: false }));
    };
    const token = manager.startMeasurementSession(1);
    const first = await manager.broadcastSearch(1, 'first', 'appareldiary.com', 5, token);
    assert.equal(first.status, 'monitoring');
    assert.ok(managed.googleConfig, 'the live observer must survive an unfinished observation');
    publish({ documentParsed: false, observedResults: 2, targetTextSeen: true,
        match: { url: 'https://appareldiary.com/article', title: 'Late result', organicIndex: 1 } });
    wc.send = channel => { if (channel === 'dom:google-click') wc.url = 'https://appareldiary.com/article'; };
    const second = await manager.broadcastSearch(1, 'first', 'appareldiary.com', 5, token);
    assert.equal(second.interactionStatus, 'opened');
    assert.equal(second.resultPage, 1);
    assert.equal(pages.length, 1, 'retry must not reload and erase a newly rendered result');
    await manager.destroyAll();
});
test('queued preload handshakes tolerate disposed native frames during Stop', async () => {
    const { manager, managed, wc } = await setup();
    assert.doesNotThrow(() => wc.emit('ipc-message', { senderFrame: wc.mainFrame,
        reply() { throw new Error('Render frame was disposed before WebFrameMain could be accessed'); } }, 'dom:google-preload-ready'));
    managed.disposed = true;
    Object.defineProperty(wc, 'mainFrame', { get() { throw new Error('Disposed native frame'); } });
    assert.doesNotThrow(() => wc.emit('ipc-message', {}, 'dom:google-preload-ready'));
    await manager.destroyAll();
});

test('a missing startup message recovers on the visible page without waiting for load or reloading', async () => {
    let time = 0;
    class Clock extends Date { static now() { return time += 1_000; } }
    const { manager, managed, wc, publish } = await setup({ Date: Clock });
    const pages = [], requests = [];
    let scriptCalls = 0;
    wc.executeJavaScript = () => { scriptCalls++; return new Promise(() => {}); };
    wc.isLoading = () => true;
    wc.loadURL = url => { wc.url = url; pages.push(url); return new Promise(() => {}); };
    wc.send = (channel, config) => {
        if (channel === 'dom:google-config' && config) {
            requests.push(config);
            if (requests.length === 2) setImmediate(() => publish({ observedResults: 1, documentParsed: false,
                match: { url: 'https://appareldiary.com/article', title: 'Visible result', organicIndex: 0 } }));
        }
        if (channel === 'dom:google-click') wc.url = 'https://appareldiary.com/article';
    };
    const token = manager.startMeasurementSession(1);
    const result = await manager.broadcastSearch(1, 'first', 'appareldiary.com', 5, token);
    assert.equal(result.interactionStatus, 'opened');
    assert.equal(pages.length, 1);
    assert.equal(scriptCalls, 0);
    assert.ok(requests.length >= 2);
    assert.equal(new Set(requests.map(config => config.navigation)).size, 1);
    assert.equal(managed.googleState.match.url, result.matchedUrl);
    await manager.destroyAll();
});

test('current-frame messages are accepted across wrapper objects with the same native frame IDs', async () => {
    const { manager, managed, wc } = await setup();
    const token = manager.startMeasurementSession(1);
    wc.mainFrame = { processId: 7, routingId: 12 };
    wc.url = 'https://www.google.com/search?q=first';
    managed.googleConfig = { navigation: 9, token, target: 'example.test', query: 'first', start: '0' };
    const payload = { navigation: 9, token, documentUrl: wc.url, state: { observedResults: 1 } };
    wc.emit('ipc-message', { senderFrame: { processId: 7, routingId: 13 } }, 'dom:google-state', payload);
    assert.equal(managed.googleState, undefined);
    wc.emit('ipc-message', { senderFrame: { processId: 7, routingId: 12 } }, 'dom:google-state', payload);
    assert.equal(managed.googleState.observedResults, 1);
    await manager.destroyAll();
});
