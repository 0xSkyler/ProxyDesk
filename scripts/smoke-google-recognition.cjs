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
    { name: 'title relevance takes precedence over a neighboring heading tag', body: card('https://appareldiary.com/unrelated', 'About our magazine') + `<div class="MjjYud"><a href="${article}"><span class="VuuXrf">appareldiary.com</span><cite>https://appareldiary.com › Industrial Security</cite><div style="font-size:20px;color:blue">${title}</div></a></div>`, match: article, index: 1 },
    { name: 'combined publisher and visual title in one link', body: `<div class="MjjYud"><a href="${article}"><span class="VuuXrf">appareldiary.com</span><div><cite>https://appareldiary.com › Industrial Security</cite></div><div style="font-size:20px;color:blue">${title}</div></a></div>`, match: article },
    { name: 'combined publisher and visual title in an opaque Google link', body: `<div class="MjjYud"><a href="/url?sa=t"><span class="VuuXrf">appareldiary.com</span><cite>https://appareldiary.com › Industrial Security</cite><div style="font-size:20px;color:blue">${title}</div></a></div>`, match: null, seen: true, pending: true },
    { name: 'unrelated Sponsored text above an organic Google module', body: `<section><div class="MjjYud"><span>Sponsored</span><div>AI Overview</div></div><div class="MjjYud"><cite>appareldiary.com</cite><a href="${article}"><h3>${title}</h3></a></div></section>`, match: article },
    { name: 'Sponsored text in the same Google module stays excluded', body: `<div class="MjjYud"><span>Sponsored</span><cite>appareldiary.com</cite><a href="${article}"><h3>${title}</h3></a></div>`, match: null, seen: false },
    { name: 'visible title overflowing a zero-height block link', body: `<article><cite>appareldiary.com</cite><a style="display:block;height:0" href="${article}"><h3>${title}</h3></a></article>`, match: article },
    { name: 'hidden attribute overridden by visible layout', body: `<div hidden style="display:block">${card(article)}</div>`, match: article },
    { name: 'title link gets its destination only during native activation', body: `<div class="MjjYud"><cite>appareldiary.com</cite><a jsname="UWckNb" onclick="location.href='${article}'"><h3>${title}</h3></a></div>`, match: null, seen: true, pending: true },
    { name: 'visible title remains clickable despite aria-hidden semantics', body: `<article><cite>appareldiary.com</cite><a aria-hidden="true" href="${article}"><h3>${title}</h3></a></article>`, match: article },
    { name: 'verified title link does not require a Google heading or citation', body: `<article><span>Apparel Diary</span><a href="${article}" style="font-size:20px"><span>${title}</span></a></article>`, match: article },
    { name: 'verified result outside Google named roots remains discoverable', body: `<main id="search">${card('https://competitor.test/a', 'Other result', 'competitor.test')}</main><section>${card(article)}</section>`, document: true, match: article },
    { name: 'publisher metadata is usable alongside its friendly display name', body: `<article><span data-dtld="appareldiary.com">Apparel Diary</span><a href="/url?sa=t"><h3>${title}</h3></a></article>`, match: null, seen: true, pending: true },
    { name: 'Google styled span title with an opaque link is eligible', body: `<article><div>appareldiary.com</div><a href="/url?sa=t"><span class="LC20lb">${title}</span></a></article>`, match: null, seen: true, pending: true },
    { name: 'cited headingless Google title is eligible for activation', body: `<article><div>appareldiary.com</div><a style="font-size:20px" href="/url?sa=t"><span>${title}</span></a></article>`, match: null, seen: true, pending: true },
    { name: 'publisher name link cannot replace the article title', body: `<article><a href="https://appareldiary.com"><span class="VuuXrf">Apparel Diary</span></a><div>appareldiary.com</div></article>`, match: null },
    { name: 'zero-height inline title link has a visible heading', body: `<article><cite>appareldiary.com</cite><a style="font-size:0;line-height:0" href="${article}"><h3 style="font-size:20px;line-height:26px">${title}</h3></a></article>`, match: article, point: true },
    { name: 'screenshot sibling citation/title', body: card(article), match: article },
    { name: 'heading contains the result anchor', body: `<article><div>https://appareldiary.com › Linear Programming</div><h3><a href="${article}">${title}</a></h3></article>`, match: article },
    { name: 'display contents anchor retains its visible title', body: card(article).replace('<a href=', '<a style="display:contents" href='), match: article, point: true },
    { name: 'plain domain labels and a headingless title', body: `<article><div><span>appareldiary.com</span></div><div>https://appareldiary.com › Linear Programming</div><a href="${article}"><span>${title}</span></a></article>`, match: article },
    { name: 'result outside the rso container remains in search', body: `<!doctype html><main id="search"><div id="rso">${card('https://competitor.test/a', 'Other result', 'competitor.test')}</div><section>${card(article)}</section></main>`, document: true, match: article },
    { name: 'double encoded Google destination', body: card('/url?url=' + encodeURIComponent(encodeURIComponent(article))), match: article },
    { name: 'Google AMP publisher destination', body: card('/amp/s/appareldiary.com/linear-programming-for-sewing-line-balancing/'), match: article },
    { name: 'accessible result link with an explicit destination', body: `<article><div>appareldiary.com</div><div role="link" data-href="${article}" tabindex="0"><h3>${title}</h3></div></article>`, match: article },
    { name: 'Google resolves a cited title only on click', body: `<article><div>appareldiary.com</div><a href="/search?q=unresolved"><h3>${title}</h3></a></article>`, match: null, seen: true, pending: true },
    { name: 'publisher and title are visible before the anchor arrives', body: `<article><div>https://appareldiary.com › Linear Programming</div><h3>${title}</h3></article>`, match: null, seen: true },
    { name: 'accessible Google link resolves through its click handler', body: `<article><div>appareldiary.com</div><div role="link" tabindex="0"><h3>${title}</h3></div></article>`, match: null, seen: true, pending: true },
    { name: 'snippet span containing a domain is not a publisher label', body: card('https://competitor.test/a', title, 'competitor.test', '<p><span>appareldiary.com</span> is mentioned in this review.</p>'), match: null, seen: false },
    { name: 'transparent target is not visibly rendered', body: `<div style="opacity:0">${card(article)}</div>`, match: null, seen: false },
    { name: 'a footer link cannot impersonate a search result', body: `<div>${card('https://competitor.test/a', 'Other result', 'competitor.test')}</div><footer>${card(article)}</footer>`, match: null, seen: false },
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
].map((item) => ({ ...item, body: item.document ? item.body : html(item.body) }));
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
            let body = '', mode = 'static', phase = 'initialization', googleDomReady = false, googleLoadFinished = false, googleMatch = null, targetDomReady = false, targetRequests = 0, pages = [];
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
                wc.on('did-finish-load', () => { if (wc.getURL().includes('google.com')) googleLoadFinished = true; });
                wc.on('ipc-message', (_event, channel, payload) => {
                    if (channel === 'dom:google-state' && payload.state?.match && !googleMatch)
                        googleMatch = { loading: wc.isLoading(), documentParsed: payload.state.documentParsed };
                });
                const encoder = new TextEncoder();
                managed.session.protocol.handle('https', (request) => {
                    const url = new URL(request.url);
                    if (url.hostname.endsWith('appareldiary.com')) targetRequests++;
                    if (mode === 'static') return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
                    if (url.hostname === 'pending.test') return new Response(new ReadableStream({ start() {} }), {
                        headers: { 'Content-Type': 'image/png' }
                    });
                    if (url.hostname === 'www.google.com' && url.pathname === '/search') pages.push(url.searchParams.get('start') || '0');
                    if (url.hostname === 'www.google.com' && mode === 'pagination' && !url.searchParams.get('start')) {
                        const rows = Array.from({ length: 10 }, (_, i) => `<article><cite>competitor.test</cite><a href="https://competitor.test/${i}"><h3>Other article ${i}</h3></a></article>`).join('');
                        const next = `<nav id="nav"><a href="/search?q=${encodeURIComponent(fixtures.title)}&amp;start=10">Next</a></nav>`;
                        return new Response(`<!doctype html><html><head><link rel="icon" href="data:,"></head><body><main id="search"><div id="rso">${rows}</div>${next}</main><img src="https://pending.test/image"></body></html>`, { headers: { 'Content-Type': 'text/html' } });
                    }
                    if (url.hostname === 'www.google.com' && mode === 'hydrated') {
                        // DOMContentLoaded fires while an image keeps load open.
                        // Google appends its target after the old 2.5s grace.
                        const initial = '<article><a href="https://competitor.test/a"><h3>Other article</h3></a></article>';
                        const next = `<nav id="nav"><a href="/search?q=${encodeURIComponent(fixtures.title)}&amp;start=10">Next</a></nav>`;
                        return new Response(`<!doctype html><html><head><link rel="icon" href="data:,"></head><body><main id="search"><div id="rso">${initial}</div>${next}</main><img src="https://pending.test/image"><script>setTimeout(() => document.getElementById('rso').insertAdjacentHTML('beforeend', ${JSON.stringify(body)}), 4000);</script></body></html>`, {
                            headers: { 'Content-Type': 'text/html; charset=utf-8' }
                        });
                    }
                    let pending;
                    const stream = new ReadableStream({
                        start(controller) {
                            controller.enqueue(encoder.encode('<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><div id="search"><div id="rso">'));
                            if (url.hostname === 'www.google.com') {
                                // Results exist while the HTML parser and page load
                                // remain open. Late mode exceeds the old stable-page
                                // pagination grace before revealing the target.
                                controller.enqueue(encoder.encode('<article><a href="https://competitor.test/a"><h3>Other article</h3></a></article>'));
                                pending = setTimeout(() => controller.enqueue(encoder.encode(body)), mode === 'late' ? 3_500 : mode === 'veryLate' ? 13_000 : 250);
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
                    if (fixture.pending && !state.match?.unresolved) throw new Error(`${fixture.name}: cited title was not available for activation`);
                    if (fixture.blocked && !state.blocked) throw new Error(`${fixture.name}: challenge not paused`);
                    if (fixture.point && !(state.match.clickPoint?.y > 0 && state.match.clickPoint.y < 680)) throw new Error(`${fixture.name}: invalid native point`);
                    if (fixture.index != null && state.match.organicIndex !== fixture.index) throw new Error(`${fixture.name}: incorrect rank`);
                    stats.cases.push(fixture.name);
                }
                // Drain the completed static fixture's navigation before
                // measuring never-ending responses in the following cases.
                await wc.loadURL('about:blank');
                for (const scenario of ['progressive', 'late', 'veryLate', 'veryLateTitle', 'linkUpdate', 'fallback', 'pendingClick', 'newLayout', 'headinglessClick', 'combinedTitleClick', 'aiOverviewClick', 'missingHrefClick', 'ariaHiddenClick', 'replacedLink', 'hydrated', 'pagination']) {
                    phase = scenario;
                    mode = scenario; body = fixtures.resultCard; googleDomReady = false; googleLoadFinished = false; googleMatch = null; targetDomReady = false; pages = [];
                    if (scenario === 'fallback') body = body.replace('<a href=', '<a onclick="return false" href=');
                    if (scenario === 'linkUpdate') body = body.replace(`href="${fixtures.article}"`, 'id="late-target" href="#"') +
                        `<script>window.__domGoogleWatcher = { state: { match: { url: 'https://competitor.test/' } } }; setTimeout(() => document.getElementById('late-target').href = ${JSON.stringify(fixtures.article)}, 400);</script>`;
                    if (scenario === 'pendingClick') body = body.replace(`href="${fixtures.article}"`,
                        `href="/search?q=${encodeURIComponent(fixtures.title)}" onclick="event.preventDefault(); location.href='${fixtures.article}';"`);
                    if (scenario === 'newLayout') body = `<article><div>appareldiary.com</div><h3><a style="display:contents" href="${fixtures.article}"><span>${fixtures.title}</span></a></h3></article>`;
                    if (scenario === 'headinglessClick') body = `<article><span>Apparel Diary</span><a style="font-size:20px" href="${fixtures.article}"><span>${fixtures.title}</span></a></article>`;
                    if (scenario === 'combinedTitleClick') body = `<div class="MjjYud"><a href="/url?sa=t" onclick="event.preventDefault();location.href='${fixtures.article}'"><span class="VuuXrf">appareldiary.com</span><cite>https://appareldiary.com › Industrial Security</cite><div style="font-size:20px;color:blue">${fixtures.title}</div></a></div>`;
                    if (scenario === 'aiOverviewClick') body = `<section><div class="MjjYud"><h2>AI Overview</h2><p>Access control and visitor management in apparel export factories protect intellectual property.</p><div role="progressbar" aria-busy="true">Loading...</div><span>Sponsored</span></div><div class="MjjYud"><cite>appareldiary.com</cite><a href="${fixtures.article}"><h3>Access Control and Visitor Management for Export Factories</h3></a></div></section>`;
                    if (scenario === 'missingHrefClick') body = `<div class="MjjYud"><cite>appareldiary.com</cite><a jsname="UWckNb" onclick="location.href='${fixtures.article}'"><h3>${fixtures.title}</h3></a></div>`;
                    if (scenario === 'ariaHiddenClick') body = body.replace('<a href=', '<a aria-hidden="true" href=');
                    if (scenario === 'veryLateTitle') body = `<article><div>appareldiary.com</div><h3 id="unlinked-title">${fixtures.title}</h3></article><script>setTimeout(() => { const title=document.getElementById('unlinked-title'); const a=document.createElement('a'); a.href=${JSON.stringify(fixtures.article)}; title.replaceWith(a); a.appendChild(title); }, 13000);</script>`;
                    if (scenario === 'replacedLink') body = body.replace('<a href=', '<a onclick="event.preventDefault(); const next=this.cloneNode(true); next.removeAttribute(\'onclick\'); this.replaceWith(next);" href=');
                    const token = manager.startMeasurementSession(901), started = Date.now();
                    let result = await manager.broadcastSearch(901, fixtures.title, 'appareldiary.com', 3, token);
                    if (['veryLate', 'veryLateTitle'].includes(scenario)) {
                        if (result.status !== 'monitoring' || !managed.googleConfig) throw new Error('Slow page lost its live observer');
                        while (result.status === 'monitoring' && Date.now() - started < 17_000) {
                            await new Promise(resolve => later(resolve, 250));
                            result = await manager.broadcastSearch(901, fixtures.title, 'appareldiary.com', 3, token);
                        }
                    }
                    stats[scenario] = { result, elapsedMs: Date.now() - started, googleDomReady, googleLoadFinished, googleMatch, targetDomReady, targetLoading: wc.isLoading(), pages: [...pages] };
                    if (result.interactionStatus !== 'opened' || result.matchedUrl !== fixtures.article || result.resultPage !== (scenario === 'pagination' ? 2 : 1)) throw new Error(`${scenario}: target was missed ${JSON.stringify(stats[scenario])}`);
                    // Navigation cancellation can emit did-finish-load while
                    // getURL still reports the outgoing Google URL. Inspect
                    // loading/parser state at the actual recognition message.
                    if (!googleMatch?.loading || googleMatch.documentParsed !== (scenario === 'hydrated') ||
                        targetDomReady || !wc.isLoading()) throw new Error(`${scenario}: test did not prove recognition/click before page completion`);
                    if (scenario === 'pagination' ? pages.join(',') !== '0,10' : pages.some((page) => page !== '0')) throw new Error(`${scenario}: incorrect pagination`);
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
        }, { cases, title, article, resultCard: card(article) }), 110_000, 'Native Google recognition');
        assert.equal(report.cases.length, cases.length);
        assert.ok(report.progressive.elapsedMs < 3_000);
        assert.ok(report.late.elapsedMs < 7_000);
        assert.ok(report.veryLate.elapsedMs > 12_000 && report.veryLate.elapsedMs < 17_000);
        assert.ok(report.veryLateTitle.elapsedMs > 12_000 && report.veryLateTitle.elapsedMs < 17_000);
        assert.ok(report.linkUpdate.elapsedMs < 3_000);
        assert.ok(report.fallback.elapsedMs < 7_000);
        assert.ok(report.pendingClick.elapsedMs < 3_000);
        assert.ok(report.newLayout.elapsedMs < 3_000);
        assert.ok(report.headinglessClick.elapsedMs < 3_000);
        assert.ok(report.combinedTitleClick.elapsedMs < 3_000);
        assert.ok(report.aiOverviewClick.elapsedMs < 3_000);
        assert.ok(report.missingHrefClick.elapsedMs < 3_000);
        assert.ok(report.ariaHiddenClick.elapsedMs < 3_000);
        assert.ok(report.hydrated.elapsedMs < 7_000);
        assert.ok(report.replacedLink.elapsedMs < 3_000);
        assert.ok(report.pagination.elapsedMs < 10_000);
        console.log(JSON.stringify(report, null, 2));
    } finally {
        if (application) await application.close();
        fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
