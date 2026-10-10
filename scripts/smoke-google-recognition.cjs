'use strict';
// Exercise the shipped recognizer in real Electron BrowserViews. These local
// protocol fixtures preserve Google/target origins without public proxies or
// external search traffic, and deliberately never finish selected page loads.
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const asar = require('@electron/asar');
const { withinDeadline, waitForRenderer } = require('./benchmark-state.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-recognition-'));
const target = process.argv[2] && path.resolve(process.argv[2]);
// A test-only entry exposes Node require to Playwright's isolated main-process
// evaluation context. All production modules and preloads are loaded directly
// from the original source/app.asar, never edited or substituted.
const productionRoot = target ? path.join(path.dirname(target), 'resources', 'app.asar') : path.resolve(__dirname, '..');
const metadata = JSON.parse(target ? asar.extractFile(productionRoot, 'package.json').toString() : fs.readFileSync(path.join(productionRoot, 'package.json'), 'utf8'));
const testApp = path.join(profile, 'test-app'); fs.mkdirSync(testApp);
fs.writeFileSync(path.join(testApp, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, main: 'entry.cjs' }));
fs.writeFileSync(path.join(testApp, 'entry.cjs'), `global.__domRecognitionLoad = require; global.__domRecognitionRoot = ${JSON.stringify(productionRoot)}; require(${JSON.stringify(path.join(productionRoot, metadata.main))});\n`);
const title = 'Linear Programming for Sewing Line Balancing';
const article = 'https://appareldiary.com/linear-programming-for-sewing-line-balancing/';
const card = (href, heading = title, domain = 'appareldiary.com', extra = '') =>
    `<article>${extra}<div><cite>${domain}</cite></div><div><a href="${href}"><h3>${heading}</h3></a></div><p>Aug 22, 2026 — Set up an LP line balancing model in IE.</p></article>`;
const html = (body) => `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><div id="search"><div id="rso">${body}</div></div></body></html>`;
const cases = [
    { name: 'screenshot sibling citation/title', body: card(article), match: article },
    { name: 'rewritten title does not require all keyword tokens', body: card(article, 'Balance your sewing line'), match: article },
    { name: 'direct URL without Google classes or citation', body: `<div><a href="${article}"><h3>Production planning guide</h3></a></div>`, match: article },
    { name: 'nested Google redirect', body: card('https://www.google.com/url?q=' + encodeURIComponent('https://www.google.com/url?url=' + encodeURIComponent(article))), match: article },
    { name: 'data URL arrives independently of href', body: card('#', title).replace('href="#"', `href="#" data-url="${article}"`), match: article },
    { name: 'Unicode and invisible formatting', body: card(article, 'সেলাই লাইনের ভারসাম্য', 'ｗｗｗ.ａｐｐａｒｅｌｄｉａｒｙ.ｃｏｍ\u200b'), query: 'সেলাই লাইনের ভারসাম্য', match: article },
    { name: 'offscreen result is scrolled before native coordinates', body: `<div style="height:1800px">Other content</div>${card(article)}`, match: article, point: true },
    { name: 'prefix lookalike domain', body: card('https://evilappareldiary.com/a', title, 'evilappareldiary.com'), match: null, seen: false },
    { name: 'suffix lookalike domain', body: card('https://appareldiary.com.attacker.test/a', title, 'appareldiary.com.attacker.test'), match: null, seen: false },
    { name: 'domain mentioned in another website snippet', body: card('https://competitor.test/a', title, 'competitor.test', '<p>Review of appareldiary.com</p>'), match: null, seen: false },
    { name: 'neighboring card cannot borrow a target citation', body: card('/search?q=unresolved', 'Unresolved target') + card('https://competitor.test/a', title, 'competitor.test'), match: null, seen: true },
    { name: 'sponsored target is excluded', body: `<div id="tads">${card(article, title, 'appareldiary.com', '<span>Sponsored</span>')}</div>`, match: null, seen: false },
    { name: 'keyword relevance chooses title rather than citation/tag link', body: card('https://competitor.test/a', 'Other result', 'competitor.test') + card('https://appareldiary.com/tag/sewing', 'sewing line efficiency - Apparel Diary') + card(article), match: article, index: 2 },
    { name: 'accessible mobile heading', body: `<article><cite>appareldiary.com</cite><a href="${article}"><span role="heading">${title}</span></a></article>`, match: article },
    { name: 'hidden result cannot trigger a click', body: `<div style="display:none">${card(article)}</div>`, match: null, seen: false },
    { name: 'challenge is paused', body: '<form id="captcha-form" action="/sorry/"></form>' + card(article), match: null, blocked: true },
    { name: 'JavaScript URL is never accepted', body: card('javascript:void(0)'), match: null, seen: true },
    { name: 'matching subdomain is retained as actual destination', body: card('https://blog.appareldiary.com/a', title, 'blog.appareldiary.com'), match: 'https://blog.appareldiary.com/a' },
    { name: 'headingless citation layout', body: `<article><cite>appareldiary.com</cite><a href="${article}">${title}</a></article>`, match: article }
].map((item) => ({ ...item, body: html(item.body) }));
let application;
(async () => {
    try {
        let executablePath;
        if (target) {
            // Use the packaged native runtime without modifying the installed
            // application. The wrapper loads its original main module as well.
            const runtime = path.join(profile, 'runtime'); fs.mkdirSync(runtime);
            for (const entry of fs.readdirSync(path.dirname(target), { withFileTypes: true })) {
                if (entry.name === 'resources') continue;
                fs.cpSync(path.join(path.dirname(target), entry.name), path.join(runtime, entry.name), { recursive: true });
            }
            const resources = path.join(runtime, 'resources'); fs.mkdirSync(resources);
            fs.cpSync(testApp, path.join(resources, 'app'), { recursive: true });
            executablePath = path.join(runtime, path.basename(target));
        }
        application = await _electron.launch({
            ...(executablePath ? { executablePath } : {}),
            args: [...(target ? [] : [testApp]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}/user-data`],
            env: { ...process.env }, timeout: 60_000
        });
        await waitForRenderer(application);
        const report = await withinDeadline(application.evaluate(async ({ app, BrowserWindow }, fixtures) => {
            const load = global.__domRecognitionLoad;
            const { BrowserManager, buildGoogleResultScanScript } = load(load('node:path').join(global.__domRecognitionRoot, 'src/main/BrowserManager.js'));
            const manager = new BrowserManager();
            const window = new BrowserWindow({ width: 950, height: 750, show: true });
            manager.attachWindow(window);
            const timers = new Set();
            const stats = { cases: [], progressive: {}, late: {}, cancellation: {} };
            let body = '', mode = 'static', phase = 'initialization', googleDomReady = false, targetDomReady = false, targetRequests = 0, pages = [];
            function later(fn, ms) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); }
            try {
                await manager.createBrowser(901, { startPage: 'about:blank', persistSessions: false });
                const managed = manager.get(901), wc = managed.view.webContents;
                managed.view.setBounds({ x: 0, y: 0, width: 900, height: 680 });
                wc.on('preload-error', (_event, file, error) => { throw new Error(`Preload failed ${file}: ${error.message}`); });
                wc.on('dom-ready', () => {
                    if (wc.getURL().includes('google.com')) googleDomReady = true;
                    if (wc.getURL().includes('appareldiary.com')) targetDomReady = true;
                });
                const encoder = new TextEncoder();
                managed.session.protocol.handle('https', (request) => {
                    const url = new URL(request.url);
                    if (url.hostname.endsWith('appareldiary.com')) targetRequests++;
                    if (mode === 'static') return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
                    if (url.hostname === 'www.google.com') pages.push(url.searchParams.get('start') || '0');
                    let pending;
                    const stream = new ReadableStream({
                        start(controller) {
                            controller.enqueue(encoder.encode('<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><div id="search"><div id="rso">'));
                            if (url.hostname === 'www.google.com') {
                                // Results exist while the HTML parser and page load
                                // remain open. Late mode exceeds the old stable-page
                                // pagination grace before revealing the target.
                                controller.enqueue(encoder.encode('<article><a href="https://competitor.test/a"><h3>Other article</h3></a></article>'));
                                pending = setTimeout(() => controller.enqueue(encoder.encode(body)), mode === 'late' ? 3_500 : 250);
                                timers.add(pending);
                            } else controller.enqueue(encoder.encode('<h1>Target article</h1><p>Content is usable while its response remains open.</p>'));
                        },
                        cancel() { clearTimeout(pending); timers.delete(pending); }
                    });
                    return new Response(stream, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
                });
                for (const fixture of fixtures.cases) {
                    phase = fixture.name;
                    body = fixture.body;
                    await wc.loadURL('https://www.google.com/search?q=' + encodeURIComponent(fixture.query || fixtures.title));
                    const state = await wc.executeJavaScript(buildGoogleResultScanScript('appareldiary.com', fixture.query || fixtures.title), true);
                    if ((state.match?.url || null) !== fixture.match) throw new Error(`${fixture.name}: wrong match ${JSON.stringify(state)}`);
                    if (fixture.seen != null && state.targetTextSeen !== fixture.seen) throw new Error(`${fixture.name}: wrong domain evidence`);
                    if (fixture.blocked && !state.blocked) throw new Error(`${fixture.name}: challenge not paused`);
                    if (fixture.point && !(state.match.clickPoint?.y > 0 && state.match.clickPoint.y < 680)) throw new Error(`${fixture.name}: invalid native point`);
                    if (fixture.index != null && state.match.organicIndex !== fixture.index) throw new Error(`${fixture.name}: incorrect rank`);
                    stats.cases.push(fixture.name);
                }
                for (const scenario of ['progressive', 'late', 'linkUpdate', 'fallback']) {
                    phase = scenario;
                    mode = scenario; body = fixtures.resultCard; googleDomReady = false; targetDomReady = false; pages = [];
                    if (scenario === 'fallback') body = body.replace('<a href=', '<a onclick="return false" href=');
                    if (scenario === 'linkUpdate') body = body.replace(`href="${fixtures.article}"`, 'id="late-target" href="#"') +
                        `<script>window.__domGoogleWatcher = { state: { match: { url: 'https://competitor.test/' } } }; setTimeout(() => document.getElementById('late-target').href = ${JSON.stringify(fixtures.article)}, 400);</script>`;
                    const token = manager.startMeasurementSession(901), started = Date.now();
                    const result = await manager.broadcastSearch(901, fixtures.title, 'appareldiary.com', 3, token);
                    stats[scenario] = { result, elapsedMs: Date.now() - started, googleDomReady, targetDomReady, targetLoading: wc.isLoading(), pages: [...pages] };
                    if (result.interactionStatus !== 'opened' || result.matchedUrl !== fixtures.article || result.resultPage !== 1) throw new Error(`${scenario}: target was missed ${JSON.stringify(stats[scenario])}`);
                    if (googleDomReady || targetDomReady || !wc.isLoading()) throw new Error(`${scenario}: test did not prove recognition/click before page completion`);
                    if (pages.some((page) => page !== '0')) throw new Error(`${scenario}: skipped first-page target`);
                    manager.startControlledKeepAlive(901, 'appareldiary.com');
                    if (!managed.keepAliveEnabled) throw new Error(`${scenario}: Keep Alive did not start`);
                    manager.setBrowserKeepAlive(901, false);
                    manager.cancelMeasurementSession(901);
                    await new Promise((resolve) => later(resolve, 100));
                    await wc.loadURL('about:blank');
                }
                mode = 'progressive'; body = fixtures.resultCard; pages = []; const before = targetRequests;
                const token = manager.startMeasurementSession(901);
                const running = manager.broadcastSearch(901, fixtures.title, 'appareldiary.com', 3, token);
                later(() => manager.cancelMeasurementSession(901), 100);
                await running;
                await new Promise((resolve) => later(resolve, 500));
                stats.cancellation = { targetRequests: targetRequests - before, configCleared: managed.googleConfig === null };
                if (stats.cancellation.targetRequests || !stats.cancellation.configCleared) throw new Error('Cancelled watcher clicked a target');
                return stats;
            } catch (error) {
                throw new Error(`${phase}: ${error.message}; evidence: ${JSON.stringify(stats)}`);
            } finally {
                for (const timer of timers) clearTimeout(timer);
                await manager.destroyAll();
                window.destroy();
            }
        }, { cases, title, article, resultCard: card(article) }), 60_000, 'Native Google recognition');
        assert.equal(report.cases.length, cases.length);
        assert.ok(report.progressive.elapsedMs < 3_000);
        assert.ok(report.late.elapsedMs < 7_000);
        assert.ok(report.linkUpdate.elapsedMs < 3_000);
        assert.ok(report.fallback.elapsedMs < 7_000);
        console.log(JSON.stringify(report, null, 2));
    } finally {
        if (application) await application.close();
        fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
