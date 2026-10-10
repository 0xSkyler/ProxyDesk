'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree, fakeElectron } = require('./helpers.cjs');
const root = path.resolve(__dirname, '..');
async function setup() {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(root, electron)('src/main/BrowserManager.js');
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
test('queued preload handshakes tolerate disposed native frames during Stop', async () => {
    const { manager, managed, wc } = await setup();
    assert.doesNotThrow(() => wc.emit('ipc-message', { senderFrame: wc.mainFrame,
        reply() { throw new Error('Render frame was disposed before WebFrameMain could be accessed'); } }, 'dom:google-preload-ready'));
    managed.disposed = true;
    Object.defineProperty(wc, 'mainFrame', { get() { throw new Error('Disposed native frame'); } });
    assert.doesNotThrow(() => wc.emit('ipc-message', {}, 'dom:google-preload-ready'));
    await manager.destroyAll();
});
