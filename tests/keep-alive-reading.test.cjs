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

test('each new article gets sixty-two seconds of full-page down-and-up scrolling before an actual link click', async () => {
    const reading = reader();
    for (let page = 0; page < 2; page++) {
        const started = reading.time;
        assert.equal((await reading.run()).reading, true);
        assert.equal((await reading.run()).reading, true);
        assert.equal((await reading.run()).reading, true);
        assert.equal(reading.clicks.length, page, 'chunks cannot bypass the dwell');
        const result = await finish(reading, true, started + 63_000);
        assert.equal(result.clickedUrl, 'https://reading.test/article/' + (page + 2));
        assert.ok(reading.clicks[page].at - started >= 62_000);
        const positions = reading.scrolls.filter(s => s.page.endsWith('/' + (page + 1)));
        assert.ok(positions.some(s => s.to > s.from), 'must scroll down');
        assert.ok(positions.some(s => s.to < s.from), 'must scroll back up');
        assert.equal(Math.max(...positions.map(s => s.to)), 800, 'must reach the page bottom');
        assert.equal(positions.at(-1).to, 0, 'must return to the top');
    }
    assert.ok(reading.scrolls.length > 10);
});

test('a long article still completes its full-page pass in sixty-two seconds', async () => {
    const reading = reader(900);
    reading.content.scrollHeight = 18_000;
    for (let i = 0; i < 3; i++) assert.equal((await reading.run()).reading, true);
    assert.equal(reading.clicks.length, 0);
    const result = await finish(reading, true, 63_000);
    assert.equal(result.clickedUrl, 'https://reading.test/article/2');
    assert.ok(reading.clicks[0].at >= 62_000 && reading.clicks[0].at < 63_000);
    assert.equal(Math.max(...reading.scrolls.map(s => s.to)), 17_200);
    assert.equal(reading.scrolls.at(-1).to, 0);
});

test('scroll-only Keep Alive reads the page without following an internal link', async () => {
    const reading = reader();
    assert.equal((await reading.run(false)).reading, true);
    assert.equal((await reading.run(false)).reading, true);
    assert.deepEqual(Object.keys(await finish(reading, false, 63_000)), []);
    assert.equal(reading.clicks.length, 0);
    assert.ok(reading.time >= 62_000);
});

test('a stalled navigation cannot cause another link click on the old document', async () => {
    const reading = reader(120, false);
    await reading.run(); await reading.run(); await finish(reading, true, 63_000);
    reading.advance(1_500);
    const result = await reading.run();
    assert.equal(result.reading, true);
    assert.equal(reading.clicks.length, 1);
});

test('the scroll pass includes page height added by lazy content', async () => {
    const reading = reader();
    await reading.run();
    reading.content.scrollHeight = 9000;
    await finish(reading, true, 63_000);
    assert.equal(Math.max(...reading.scrolls.map(s => s.to)), 8200);
    assert.equal(reading.scrolls.at(-1).to, 0);
    assert.ok(reading.clicks[0].at >= 62_000 && reading.clicks[0].at < 63_000);
});

test('a browser starting mid-article covers the top and bottom before its next click', async () => {
    const reading = reader();
    reading.window.scrollY = 400;
    await finish(reading, true, 63_000);
    assert.equal(reading.clicks.length, 1);
    assert.equal(reading.scrolls[0].to, 0);
    assert.equal(Math.max(...reading.scrolls.map(s => s.to)), 800);
    assert.equal(reading.scrolls.at(-1).to, 0);
});

test('article reading moves gently and takes two-second breaks at each third', async () => {
    const reading = reader();
    const completed = await finish(reading, false, 63_000);
    assert.deepEqual(Object.keys(completed), []);
    const positions = reading.scrolls;
    const atEightSeconds = positions.find((entry) => entry.at === 8_000);
    assert.ok(atEightSeconds, 'the downwards reading pass should be moving at eight seconds');
    assert.ok(Math.abs(atEightSeconds.to - 200) < 1, 'at eight seconds the scroll should cover only one quarter of the page');
    for (const [start, end, expected] of [
        [10_000, 12_000, 800 / 3],
        [20_000, 22_000, 1600 / 3],
        [40_000, 42_000, 1600 / 3],
        [50_000, 52_000, 800 / 3]
    ]) {
        const previous = positions.filter((entry) => entry.at <= start).at(-1);
        assert.ok(previous && Math.abs(previous.to - expected) < 1,
            `the reader must reach the correct position before the break at ${start} ms`);
        assert.equal(positions.filter((entry) => entry.at > start && entry.at < end).length, 0,
            `the reader must not move during the break from ${start} to ${end} ms`);
    }
    assert.equal(reading.time, 62_000);
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

test('manual Keep Alive starts the next article promptly after its internal link click', async () => {
    const electron = fakeElectron();
    const { BrowserManager: Manager } = loadTree(path.resolve(__dirname, '../src'), electron)('main/BrowserManager.js');
    const manager = new Manager(); manager.attachWindow(electron.window);
    await manager.createBrowser(1, { startPage: 'https://reading.test/article/1' });
    const browser = manager.get(1);
    manager.keepAliveIntervalMs = 60_000;
    browser.keepAliveEnabled = true;
    browser.view.webContents.executeJavaScript = async () => ({ clickedUrl: 'https://reading.test/article/2' });
    try {
        await manager.runKeepAliveAction(browser, browser.keepAliveGeneration);
        assert.equal(browser.keepAliveEnabled, true);
        assert.equal(browser.keepAliveHops, 1);
        assert.ok(browser.keepAliveNextAt > Date.now());
        assert.ok(browser.keepAliveNextAt - Date.now() < 2_000, 'the next article cannot wait another minute before scrolling');
    } finally { await manager.destroyAll(); }
});
