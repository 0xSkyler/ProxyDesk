'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree, fakeElectron } = require('./helpers.cjs');

async function fixture() {
    const electron = fakeElectron();
    const { BrowserManager } = loadTree(path.resolve(__dirname, '../src'), electron)('main/BrowserManager.js');
    const manager = new BrowserManager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'about:blank' });
    const browser = manager.get(1), wc = browser.view.webContents, inputs = [];
    wc.url = 'https://www.google.com/search?q=fixture';
    wc.mainFrame = { processId: 1, routingId: 1 };
    wc.sendInputEvent = event => inputs.push(event);
    browser.view.getBounds = () => ({ width: 900, height: 650 });
    const state = { documentUrl: wc.url, documentId: 'first', state: { kind: 'verification', enabled: true } };
    const click = { documentUrl: wc.url, documentId: 'first', kind: 'verification', point: { x: 450, y: 400 } };
    const emit = (channel, payload, senderFrame = wc.mainFrame) => wc.emit('ipc-message', { senderFrame }, channel, payload);
    emit('dom:google-prompt-state', state);
    return { manager, browser, wc, inputs, state, click, emit };
}

test('enabled Google prompts get a native click and retry if the document remains unchanged', async () => {
    const f = await fixture();
    try {
        f.emit('dom:google-prompt-click', f.click);
        assert.deepEqual(f.inputs.map(e => e.type), ['mouseMove', 'mouseDown', 'mouseUp']);
        f.emit('dom:google-prompt-click', f.click);
        assert.equal(f.inputs.length, 3, 'immediate duplicate is suppressed');
        f.browser.googlePromptClick.at -= 1_000;
        f.emit('dom:google-prompt-click', f.click);
        assert.equal(f.inputs.length, 6, 'an ignored activation can retry');
        f.emit('dom:google-prompt-state', { ...f.state, state: null });
        f.browser.googlePromptClick.at -= 1_000;
        f.emit('dom:google-prompt-click', f.click);
        assert.equal(f.inputs.length, 6, 'a dismissed prompt cannot click again');
    } finally { await f.manager.destroyAll(); }
});

test('a Continue redirect is not clicked twice while its new URL is uncommitted', async () => {
    const f = await fixture();
    try {
        f.emit('dom:google-prompt-click', f.click);
        f.wc.emit('did-start-navigation', {}, 'https://www.google.com/finished', false, true);
        f.browser.googlePromptClick.at -= 1_000;
        f.emit('dom:google-prompt-click', f.click);
        assert.equal(f.inputs.length, 3);
        const next = { ...f.state, documentId: 'second' };
        f.emit('dom:google-prompt-state', next);
        f.emit('dom:google-prompt-click', { ...f.click, documentId: 'second' });
        assert.equal(f.inputs.length, 6, 'the next document has its own prompt handler');
    } finally { await f.manager.destroyAll(); }
});

test('disabled, foreign-frame, stale-document and invalid-coordinate prompt messages cannot click', async () => {
    const f = await fixture();
    try {
        f.emit('dom:google-prompt-click', f.click, { processId: 1, routingId: 2 });
        f.emit('dom:google-prompt-click', { ...f.click, documentId: 'outgoing' });
        f.emit('dom:google-prompt-click', { ...f.click, documentUrl: 'https://outside.test/' });
        f.emit('dom:google-prompt-click', { ...f.click, kind: 'consent' });
        for (const point of [{ x: -1, y: 1 }, { x: 900, y: 1 }, { x: 1, y: 650 }, { x: NaN, y: 1 }])
            f.emit('dom:google-prompt-click', { ...f.click, point });
        f.emit('dom:google-prompt-state', { ...f.state, state: { kind: 'verification', enabled: false } });
        f.emit('dom:google-prompt-click', f.click);
        assert.equal(f.inputs.length, 0);
    } finally { await f.manager.destroyAll(); }
});
