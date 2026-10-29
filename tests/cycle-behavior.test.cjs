'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { loadTree, fakeElectron } = require('./helpers.cjs');
const root = path.resolve(__dirname, '../src');
const tick = () => new Promise(setImmediate);
const options = { startPage: 'about:blank', persistSessions: false, userAgent: '' };

async function fixture(globals = {}) {
    const electron = fakeElectron();
    const load = loadTree(root, electron, globals);
    const { BrowserManager } = load('main/BrowserManager.js');
    const browser = new BrowserManager(); browser.attachWindow(electron.window);
    await browser.createBrowser(1, options);
    return { browser, electron, load };
}

test('cycle reset replaces the view and partition, preserves bounds and invalidates old work', async () => {
    const { browser, electron } = await fixture();
    const old = browser.get(1), token = browser.startMeasurementSession(1);
    const bounds = { x: 1, y: 2, width: 300, height: 200 };
    browser.setBounds(1, bounds);
    await browser.resetBrowserSession(1);
    const fresh = browser.get(1);
    assert.notEqual(fresh.session, old.session);
    assert.equal(old.view.webContents.isDestroyed(), true);
    assert.equal(old.session.connectionsClosed, 1);
    assert.equal(browser.isMeasurementSessionCurrent(1, token), false);
    assert.equal(fresh.view.webContents.getURL(), 'about:blank');
    assert.deepEqual({ ...fresh.lastBounds }, bounds);
    assert.equal(electron.views.filter(view => view.attached).length, 1);
    await browser.destroyAll();
});

test('normal Google results retain the proxy even without a target; challenge, empty results and errors fail it', async () => {
    const { browser } = await fixture();
    const proxy = { protocol: 'http', host: '127.0.0.1', port: 8001 };
    for (const failure of [{ status: 'paused' }, { status: 'no-match', resultsScanned: 0 }, { status: 'error' }]) {
        await browser.assignProxy(1, proxy);
        assert.equal(browser.canRetainProxy(1), false);
        browser.recordGoogleResult(1, { status: 'no-match', resultsScanned: 10 });
        assert.equal(browser.canRetainProxy(1), true);
        browser.recordGoogleResult(1, failure);
        assert.equal(browser.canRetainProxy(1), false);
    }
    await browser.destroyAll();
});

test('consent is injected again when a late frame finishes loading, tolerating detached frames', async () => {
    const { browser } = await fixture();
    const wc = browser.get(1).view.webContents;
    let injections = 0;
    wc.mainFrame = { framesInSubtree: [
        { executeJavaScript: async script => { assert.match(script, /proxyDeskCookieConsent/); injections++; } },
        { executeJavaScript() { throw new Error('detached'); } }
    ] };
    wc.emit('did-frame-finish-load');
    await tick();
    assert.equal(injections, 1);
    wc.emit('dom-ready');
    await tick();
    assert.equal(injections, 2);
    await browser.destroyAll();
});

test('retained proxies stay with their browser without a fresh API request', async () => {
    let requests = 0;
    const { load } = await fixture({ fetch: async () => { requests++; throw new Error('must not fetch'); } });
    const { ProxyManager } = load('main/ProxyManager.js');
    const proxies = new ProxyManager();
    const proxy = { id: 'http://one:8001', protocol: 'http', host: 'one', port: 8001 };
    const assignments = [];
    await proxies.fetchAssignDirect([1], assignment => assignments.push(assignment), null, new Map([[1, proxy]]));
    assert.equal(requests, 0);
    assert.equal(assignments[0].proxy, proxy);
    assert.equal(proxies.getAssignment(1), proxy);
});

test('replacement excludes dead and occupied endpoints, preserving exclusive feed-order assignment', async () => {
    const { load } = await fixture({ fetch: async () => ({ ok: true, text: async () => 'http://one:8001\nsocks5://one:8001\nhttp://two:8002\nhttp://three:8003\nhttp://four:8004' }) });
    const { ProxyManager } = load('main/ProxyManager.js');
    const proxies = new ProxyManager();
    await proxies.fetchAssignDirect([1, 2], () => {});
    const original = proxies.getAssignment(1);
    const replacement = await proxies.replaceFailedAssignment(2, new AbortController().signal);
    assert.equal(replacement.host, 'three');
    assert.equal(proxies.getAssignment(1), original);
    proxies.markFailed(replacement);
    await proxies.fetchAssignDirect([1, 2], () => {}, null, new Map([[1, original]]));
    assert.equal(proxies.getAssignment(2).host, 'four');
});

test('a replacement cancelled by Stop or rotation cannot commit a late proxy', async () => {
    let finish;
    const { load } = await fixture({ fetch: () => new Promise(resolve => { finish = resolve; }) });
    const { ProxyManager } = load('main/ProxyManager.js');
    const proxies = new ProxyManager(), controller = new AbortController();
    proxies.assignments.set(1, { id: 'http://one:8001', host: 'one', port: 8001 });
    const work = proxies.replaceFailedAssignment(1, controller.signal);
    controller.abort();
    finish({ ok: true, text: async () => 'http://two:8002' });
    await assert.rejects(work, /cancelled/);
    assert.equal(proxies.getAssignment(1), null);
});

test('each automation cycle resets all sessions, keeps survivors, replaces failed proxies and advances the keyword', async () => {
    const { browser, load } = await fixture({
        setInterval: () => 1, clearInterval() {},
        fetch: async () => ({ ok: true, text: async () => 'http://one:8001\nhttp://two:8002\nhttp://three:8003' })
    });
    await browser.createBrowser(2, options);
    const { ProxyManager } = load('main/ProxyManager.js');
    const { SeoAutomationManager } = load('main/SeoAutomationManager.js');
    const proxies = new ProxyManager(), searches = [];
    browser.broadcastSearch = async (id, query) => { searches.push([id, query]); return { status: 'matched', interactionStatus: 'opened', matchedUrl: 'https://fixture.local/a' }; };
    browser.startControlledKeepAlive = () => {};
    const automation = new SeoAutomationManager(proxies, browser, async () => [1, 2]);
    await automation.start({ query: 'first,second', targetWebsite: 'fixture.local', browserCount: 2 });
    for (let i = 0; i < 30 && automation.state.cycleInProgress; i++) await tick();
    const sessions = [browser.get(1).session, browser.get(2).session];
    const survivor = proxies.getAssignment(1);
    browser.recordGoogleResult(2, { status: 'paused' });
    await automation.runNow();
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(proxies.getAssignment(1), survivor);
    assert.equal(proxies.getAssignment(2).host, 'three');
    assert.notEqual(browser.get(1).session, sessions[0]);
    assert.notEqual(browser.get(2).session, sessions[1]);
    assert.deepEqual(searches, [[1, 'first'], [2, 'first'], [1, 'second'], [2, 'second']]);
    automation.stop(); await browser.destroyAll();
});

test('a failed Google observation replaces only that browser immediately', async () => {
    const { browser, load } = await fixture({ setInterval: () => 1, clearInterval() {}, fetch: async () => ({ ok: true, text: async () => 'http://one:8001\nhttp://two:8002' }) });
    const { ProxyManager } = load('main/ProxyManager.js');
    const { SeoAutomationManager } = load('main/SeoAutomationManager.js');
    const proxies = new ProxyManager(); let searches = 0;
    browser.broadcastSearch = async () => ++searches === 1 ? { status: 'paused' } : { status: 'matched', interactionStatus: 'opened', matchedUrl: 'https://fixture.local/a' };
    browser.startControlledKeepAlive = () => {};
    const automation = new SeoAutomationManager(proxies, browser, async () => [1]);
    await automation.start({ query: 'first', targetWebsite: 'fixture.local', browserCount: 1 });
    for (let i = 0; i < 30 && searches < 2; i++) await tick();
    assert.equal(searches, 2);
    assert.equal(proxies.getAssignment(1).host, 'two');
    assert.equal(browser.canRetainProxy(1), true);
    assert.equal(automation.state.cycleNumber, 1);
    automation.stop(); await browser.destroyAll();
});

async function timedAction(linkMode, allowHop = true) {
    const { load } = await fixture();
    const { buildKeepAliveActionScript } = load('main/BrowserManager.js');
    let now = 0, nextTimer = 0, clicked;
    const timers = new Map(), scrolls = [];
    const setTimer = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; };
    const window = { innerHeight: 600, scrollY: 0, scrollTo(_x, y) { this.scrollY = y; scrolls.push(y); }, scrollBy(_x, y) { this.scrollY += y; } };
    const anchor = (href) => ({ href, textContent: 'Read another useful article', hasAttribute: () => false, getAttribute: () => '', closest: () => null, querySelector: () => null, getBoundingClientRect: () => ({ width: 100, height: 20 }), scrollIntoView() {}, focus() {}, click() { clicked = { href, at: now }; } });
    const anchors = [anchor('https://fixture.local/article/next'), anchor('https://external.local/article/a'), anchor('https://other.local/article/b')];
    const document = { scrollingElement: { scrollHeight: 2000 }, documentElement: { scrollHeight: 2000 }, body: { scrollHeight: 2000 }, querySelectorAll: () => anchors };
    const context = vm.createContext({ window, document, location: { href: 'https://fixture.local/article/start' }, URL, AbortController, performance: { now: () => now }, Math: Object.assign(Object.create(Math), { random: () => 0.99 }), setTimeout: setTimer, clearTimeout: id => timers.delete(id), requestAnimationFrame: fn => setTimer(() => fn(now), 16), cancelAnimationFrame: id => timers.delete(id) });
    let settled = false, error;
    const work = vm.runInContext(buildKeepAliveActionScript(allowHop, [], 'fixture.local', linkMode), context).then(result => { settled = true; return result; }, cause => { settled = true; error = cause; });
    for (let i = 0; i < 6000 && !settled; i++) {
        await Promise.resolve();
        if (!timers.size) continue;
        const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        timers.delete(id); now = timer.at; timer.fn();
    }
    if (error) throw error;
    assert.equal(settled, true);
    const result = await work;
    assert.equal(timers.size, 0);
    assert.ok(scrolls.some(y => y >= 1399));
    assert.equal(window.scrollY, 0);
    return { result, clicked, now };
}

test('Keep Alive completes down/up scrolling and pauses before its internal click at 40 seconds', async () => {
    const { clicked } = await timedAction('internal');
    assert.equal(clicked.href, 'https://fixture.local/article/next');
    assert.equal(clicked.at, 40_000);
});

test('the second 40-second visit chooses randomly among external links only', async () => {
    const { clicked } = await timedAction('external');
    assert.equal(clicked.href, 'https://other.local/article/b');
    assert.equal(clicked.at, 40_000);
});

test('Keep Alive on the final external page keeps scrolling without clicking more links', async () => {
    const { clicked, now } = await timedAction('external', false);
    assert.equal(clicked, undefined);
    assert.equal(now, 40_000);
});

test('Stop cancels an in-flight Keep Alive navigation without advancing its stage', async () => {
    const { browser } = await fixture();
    const managed = browser.get(1);
    managed.keepAliveEnabled = true; managed.keepAliveGeneration = 1;
    managed.view.webContents.url = 'https://fixture.local/start';
    managed.view.webContents.executeJavaScript = async () => ({ clickedUrl: 'https://fixture.local/next' });
    const work = browser.runKeepAliveAction(managed, 1);
    await tick();
    assert.equal(typeof managed.cancelKeepAliveNavigation, 'function');
    browser.setBrowserKeepAlive(1, false);
    await work;
    assert.equal(managed.keepAliveStep, 0);
    assert.equal(managed.cancelKeepAliveNavigation, null);
    assert.equal(managed.keepAliveEnabled, false);
    await browser.destroyAll();
});

test('saved keywords and target survive reloading, and clearing either input removes its saved value', () => {
    const bundle = fs.readFileSync(path.join(root, 'renderer/assets/index-BZgi7Ish.js'), 'utf8');
    const helpers = bundle.slice(bundle.indexOf('function readSavedTrackerInput'), bundle.indexOf('function gp()'));
    const values = new Map();
    const localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    let context = vm.createContext({ localStorage }); vm.runInContext(helpers, context);
    context.saveTrackerInput('keywords', 'first, second'); context.saveTrackerInput('targetWebsite', 'fixture.local');
    context = vm.createContext({ localStorage }); vm.runInContext(helpers, context);
    assert.equal(context.readSavedTrackerInput('keywords'), 'first, second');
    assert.equal(context.readSavedTrackerInput('targetWebsite'), 'fixture.local');
    context.saveTrackerInput('keywords', '');
    assert.equal(context.readSavedTrackerInput('keywords'), '');
    assert.equal(context.readSavedTrackerInput('targetWebsite'), 'fixture.local');
    context.saveTrackerInput('targetWebsite', '');
    assert.equal(values.size, 0);
});

test('input persistence tolerates unavailable browser storage', () => {
    const bundle = fs.readFileSync(path.join(root, 'renderer/assets/index-BZgi7Ish.js'), 'utf8');
    const context = vm.createContext({ localStorage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('blocked'); } } });
    vm.runInContext(bundle.slice(bundle.indexOf('function readSavedTrackerInput'), bundle.indexOf('function gp()')), context);
    assert.equal(context.readSavedTrackerInput('keywords'), '');
    context.saveTrackerInput('keywords', 'a'); context.saveTrackerInput('keywords', '');
});

test('consent acceptance prioritizes Accept all, handles delayed dialogs, and skips unrelated buttons', () => {
    const { buildAcceptCookieConsentScript } = require('../src/main/CookieConsent');
    let mutation, clicks = [], pending;
    const button = (label, text) => ({ innerText: label, disabled: false, getClientRects: () => [1], getAttribute: () => '', closest: () => text ? { innerText: text } : null, click() { clicks.push(label); } });
    let buttons = [button('Continue', null), button('Accept', 'We use cookies'), button('Accept all', 'Cookie consent')];
    const document = { querySelectorAll: selector => selector === '*' ? [] : buttons };
    const context = vm.createContext({ window: {}, document, MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} }, setTimeout: fn => { pending = fn; return 1; } });
    vm.runInContext(buildAcceptCookieConsentScript(), context);
    assert.deepEqual(clicks, ['Accept all']);
    buttons = [button('I agree', 'Privacy consent for data processing')]; mutation(); pending();
    assert.deepEqual(clicks, ['Accept all', 'I agree']);
    mutation(); pending();
    assert.equal(clicks.length, 2);
});
