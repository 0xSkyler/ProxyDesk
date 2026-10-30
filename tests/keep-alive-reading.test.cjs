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

test('each new article scrolls slowly for at least two minutes before following an internal link', async () => {
    const reading = reader();
    for (let page = 0; page < 2; page++) {
        const started = reading.time;
        for (let i = 0; i < 3; i++) assert.equal((await reading.run()).reading, true);
        assert.equal(reading.clicks.length, page, 'bounded chunks cannot bypass reading time');
        const result = await finish(reading, true, started + 155_000);
        assert.equal(result.clickedUrl, 'https://reading.test/article/' + (page + 2));
        const dwell = reading.clicks[page].at - started;
        assert.ok(dwell >= 136_000 && dwell <= 155_000, 'each page must be slow enough to read');
        const positions = reading.scrolls.filter(v => v.page.endsWith('/' + (page + 1)));
        assert.ok(positions.some(v => v.to > v.from), 'must scroll downward');
        assert.ok(positions.some(v => v.to < v.from), 'must scroll upward');
        assert.equal(Math.max(...positions.map(v => v.to)), 800, 'must reach the bottom');
        assert.equal(positions.at(-1).to, 0, 'must return to the top');
    }
    assert.ok(reading.scrolls.length > 20);
});

test('long article takes proportionally longer instead of scrolling faster', async () => {
    const reading = reader(900);
    reading.content.scrollHeight = 18_000; // 17,200 scrollable pixels
    for (let i = 0; i < 3; i++) assert.equal((await reading.run()).reading, true);
    assert.equal(reading.clicks.length, 0);
    const result = await finish(reading, true, 475_000);
    assert.equal(result.clickedUrl, 'https://reading.test/article/2');
    assert.ok(reading.clicks[0].at >= 445_000, 'a long page needs extra reading time');
    assert.equal(Math.max(...reading.scrolls.map(v => v.to)), 17_200);
    assert.equal(reading.scrolls.at(-1).to, 0);
    const movements = reading.scrolls.filter(v => Math.abs(v.to - v.from) > 1);
    for (let i = 1; i < movements.length; i++) {
        const prev = movements[i - 1], current = movements[i];
        const seconds = (current.at - prev.at) / 1_000;
        assert.ok(Math.abs(current.to - prev.to) <= seconds * 80 + 1.5,
            'Keep Alive must never move faster than eighty pixels per second');
    }
});

test('scroll-only Keep Alive reads without following a link', async () => {
    const reading = reader();
    assert.equal((await reading.run(false)).reading, true);
    assert.equal((await reading.run(false)).reading, true);
    assert.deepEqual(Object.keys(await finish(reading, false, 155_000)), []);
    assert.equal(reading.clicks.length, 0);
    assert.ok(reading.time >= 136_000);
});

test('a stalled navigation cannot trigger a second click on the old document', async () => {
    const reading = reader(120, false);
    await reading.run(); await reading.run(); await finish(reading, true, 155_000);
    reading.advance(1_500);
    assert.equal((await reading.run()).reading, true);
    assert.equal(reading.clicks.length, 1);
});

test('lazy-loaded sections increase reading time and remain fully visible', async () => {
    const reading = reader();
    await reading.run();
    reading.content.scrollHeight = 9_000;
    const result = await finish(reading, true, 260_000);
    assert.equal(result.clickedUrl, 'https://reading.test/article/2');
    assert.equal(Math.max(...reading.scrolls.map(v => v.to)), 8_200);
    assert.equal(reading.scrolls.at(-1).to, 0);
    assert.ok(reading.clicks[0].at >= 200_000);
});

test('mid-article entry restarts gently at the top before the slow pass', async () => {
    const reading = reader();
    reading.window.scrollY = 400;
    await finish(reading, true, 155_000);
    assert.equal(reading.clicks.length, 1);
    assert.equal(reading.scrolls[0].to, 0);
    assert.equal(Math.max(...reading.scrolls.map(v => v.to)), 800);
    assert.equal(reading.scrolls.at(-1).to, 0);
});

test('reading pauses for at least three seconds at each third on both passes', async () => {
    const reading = reader();
    const result = await finish(reading, false, 155_000);
    assert.deepEqual(Object.keys(result), []);
    const positions = reading.scrolls;
    for (const [checkpoint, label] of [
        [800 / 3, 'one-third'], [1_600 / 3, 'two-thirds']
    ]) {
        const stops = positions.filter(v => Math.abs(v.to - checkpoint) < 0.15);
        assert.equal(stops.length, 2, label + ' should be visited once on each direction');
        for (const stop of stops) {
            const later = positions.find(v => v.at > stop.at);
            assert.ok(later && later.at - stop.at >= 3_000,
                label + ' reading break must last at least three seconds');
        }
    }
    assert.ok(reading.time >= 136_000);
});

test('a throttled timer never causes a sudden large jump when scrolling resumes', async () => {
    const reading = reader();
    await reading.run();
    const before = reading.scrolls.at(-1);
    reading.advance(50_000);
    await reading.run();
    const after = reading.scrolls.find(v => v.at > before.at);
    if (after && Math.abs(after.to - before.to) > 1)
        assert.ok(Math.abs(after.to - before.to) <= 18,
            'an inactive browser cannot catch up with a large jump');
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
