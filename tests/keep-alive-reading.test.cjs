'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { loadTree, fakeElectron } = require('./helpers.cjs');
const { buildKeepAliveActionScript } = loadTree(path.resolve(__dirname, '../src'), fakeElectron())('main/BrowserManager.js');

function reader(words = 120, commitClick = true) {
    let time = 0;
    const clicks = [], scrolls = [];
    const location = { href: 'https://reading.test/article/1' };
    const window = { innerHeight: 800, scrollY: 0,
        scrollTo({ top }) { scrolls.push({ at: time, page: location.href, from: this.scrollY, to: top }); this.scrollY = top; } };
    const content = { innerText: Array(words).fill('paragraph').join(' '), scrollHeight: 1600 };
    const link = { textContent: 'Read the next internal article',
        get href() { return 'https://reading.test/article/' + (Number(location.href.split('/').at(-1)) + 1); },
        hasAttribute: () => false, getAttribute: () => '', closest: () => content, querySelector: () => null,
        getBoundingClientRect: () => ({ width: 300, height: 30, top: 1500 - window.scrollY }),
        scrollIntoView() {}, focus() {},
        click() { const to = this.href; clicks.push({ at: time, from: location.href, to }); if (commitClick) { location.href = to; window.scrollY = 0; } } };
    const context = vm.createContext({ window, location, document: { scrollingElement: content,
        documentElement: content, body: content, querySelector: () => content, querySelectorAll: () => [link] },
        AbortController, URL, performance: { now: () => time },
        setTimeout: (fn, ms) => setImmediate(() => { time += ms; fn(); }), clearTimeout: clearImmediate });
    return { clicks, scrolls, window, content, get time() { return time; },
        advance(ms) { time += ms; },
        run(hop = true) { return vm.runInContext(buildKeepAliveActionScript(hop, [], 'reading.test'), context); } };
}

async function finish(reading, hop = true, deadline = reading.time + 10_000) {
    while (reading.time <= deadline) {
        const result = await reading.run(hop);
        if (!result.reading) return result;
    }
    assert.fail('Reading did not finish within its expected time');
}

test('each new page gets thirty seconds of forward reading before its next actual link click', async () => {
    const reading = reader();
    for (let page = 0; page < 2; page++) {
        const started = reading.time;
        assert.equal((await reading.run()).reading, true);
        assert.equal((await reading.run()).reading, true);
        assert.equal(reading.clicks.length, page, 'chunks cannot bypass the dwell');
        const result = await finish(reading, true, started + 31_000);
        assert.equal(result.clickedUrl, 'https://reading.test/article/' + (page + 2));
        assert.ok(reading.clicks[page].at - started >= 30_000);
    }
    assert.ok(reading.scrolls.length > 10);
    assert.ok(reading.scrolls.every(s => s.to >= s.from), 'automatic scrolling cannot reverse direction');
});

test('long articles use the reading pace rather than leaving at the thirty-second minimum', async () => {
    const reading = reader(900);
    for (let i = 0; i < 11; i++) assert.equal((await reading.run()).reading, true);
    assert.equal(reading.clicks.length, 0);
    const result = await finish(reading, true, 121_000);
    assert.equal(result.clickedUrl, 'https://reading.test/article/2');
    assert.ok(reading.clicks[0].at >= 120_000, '900 words need two minutes at 450 words/minute');
});

test('scroll-only Keep Alive reads the page without following an internal link', async () => {
    const reading = reader();
    assert.equal((await reading.run(false)).reading, true);
    assert.equal((await reading.run(false)).reading, true);
    assert.deepEqual(Object.keys(await finish(reading, false, 31_000)), []);
    assert.equal(reading.clicks.length, 0);
    assert.ok(reading.time >= 30_000);
});

test('a stalled navigation cannot cause another link click on the old document', async () => {
    const reading = reader(120, false);
    await reading.run(); await reading.run(); await finish(reading, true, 31_000);
    reading.advance(1_500);
    const result = await reading.run();
    assert.equal(result.reading, true);
    assert.equal(reading.clicks.length, 1);
});

test('lazy page growth cannot cause an abrupt reading jump', async () => {
    const reading = reader();
    await reading.run();
    reading.content.scrollHeight = 9000;
    await reading.run();
    assert.equal(reading.clicks.length, 0);
    assert.ok(reading.scrolls.every((s, i) => !i || s.to - s.from <= 120 * (s.at - reading.scrolls[i - 1].at) / 1000 + 1));
});

test('combining marks stay within a word at the fast-reading pace', async () => {
    const reading = reader(450);
    reading.content.innerText = Array(450).fill('মেশিন').join(' ');
    for (let i = 0; i < 5; i++) assert.equal((await reading.run()).reading, true);
    await finish(reading, true, 61_000);
    assert.equal(reading.clicks.length, 1);
    assert.ok(reading.clicks[0].at >= 60_000 && reading.clicks[0].at < 61_000);
});

test('an unfinished reading chunk stays enabled even with the manual one-page limit', async () => {
    const electron = fakeElectron();
    const { BrowserManager: Manager } = loadTree(path.resolve(__dirname, '../src'), electron)('main/BrowserManager.js');
    const manager = new Manager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'https://reading.test/article/1' });
    const browser = manager.get(1);
    manager.keepAliveMaxHops = 1; manager.keepAliveFollowLinks = false;
    browser.keepAliveEnabled = true;
    browser.view.webContents.executeJavaScript = async () => ({ reading: true });
    try {
        await manager.runKeepAliveAction(browser, browser.keepAliveGeneration);
        assert.equal(browser.keepAliveEnabled, true);
        assert.equal(browser.keepAliveHops, 0);
        assert.ok(browser.keepAliveNextAt > Date.now());
        assert.ok(browser.keepAliveNextAt - Date.now() < 2_000, 'reading must resume without a minute-long gap');
    } finally { await manager.destroyAll(); }
});
