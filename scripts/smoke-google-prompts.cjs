'use strict';
// Google prompt and cache checks against the source or installed app.asar.
const { _electron } = require('playwright-core');
const asar = require('@electron/asar');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { waitForRenderer, withinDeadline } = require('./benchmark-state.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-prompts-'));
const target = process.argv[2] && path.resolve(process.argv[2]);
const source = target ? path.join(path.dirname(target), 'resources/app.asar') : path.resolve(__dirname, '..');
const metadata = JSON.parse(target ? asar.extractFile(source, 'package.json') : fs.readFileSync(path.join(source, 'package.json')));
const entry = path.join(profile, 'test-app'); fs.mkdirSync(entry);
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, main: 'entry.cjs' }));
fs.writeFileSync(path.join(entry, 'entry.cjs'), `global.__domPromptLoad=require;global.__domPromptRoot=${JSON.stringify(source)};require(${JSON.stringify(path.join(source, metadata.main))});\n`);
let application;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
    try {
        let executablePath;
        if (target) {
            const runtime = path.join(profile, 'runtime'); fs.mkdirSync(runtime);
            for (const item of fs.readdirSync(path.dirname(target))) {
                if (item === 'resources') continue;
                fs.cpSync(path.join(path.dirname(target), item), path.join(runtime, item), { recursive: true });
            }
            fs.mkdirSync(path.join(runtime, 'resources'));
            fs.cpSync(entry, path.join(runtime, 'resources/app'), { recursive: true });
            executablePath = path.join(runtime, path.basename(target));
        }
        application = await _electron.launch({ ...(executablePath ? { executablePath } : {}),
            args: [...(target ? [] : [entry]), '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}/user-data`],
            env: { ...process.env }, timeout: 60_000 });
        await waitForRenderer(application);
        const report = await withinDeadline(application.evaluate(async ({ BrowserWindow }) => {
            const load = global.__domPromptLoad;
            const { BrowserManager } = load(load('node:path').join(global.__domPromptRoot, 'src/main/BrowserManager.js'));
            const manager = new BrowserManager(), window = new BrowserWindow({ width: 1000, height: 740, show: true });
            manager.attachWindow(window);
            const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
            const traces = new Map(), modes = new Map(), timers = new Set(), stats = {};
            const title = 'Linear Programming for Sewing Line Balancing';
            const query = 'linear programming for apparel sewing line balancing';
            const googleUrl = 'https://www.google.com/search?q=' + encodeURIComponent(query);
            const later = (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; };
            const html = content => '<!doctype html><html><head><link rel="icon" href="data:,"><style>body{font:20px sans-serif}.dialog{position:fixed;inset:0;background:white;z-index:100;padding:40px}button{padding:20px;margin:10px}</style></head><body>' + content;
            const card = id => `<main id="search"><article><cite>appareldiary.com</cite><a href="https://appareldiary.com/article/${id}" onclick="document.cookie='titleClicked=1; path=/';"><h3>${title}</h3></a></article></main>`;
            const verification = (id, captcha = false) => `<div id="verification" class="dialog"><h1>Verifying your request</h1><p>You'll be able to continue in a few seconds. Don't refresh this page.</p>${captcha ? '<div class="g-recaptcha"></div>' : ''}<button id="continue" disabled onclick="document.cookie='continued=1; path=/';document.getElementById('verification').remove();">Continue</button></div><script>setTimeout(()=>document.getElementById('continue').disabled=false,1000)</script>`;
            const consent = (id, action = "document.getElementById('consent').remove()") => `<div role="dialog" id="consent" class="dialog"><h1>Before you continue to Google</h1><p>We use cookies and data. You can visit g.co/privacytools at any time.</p><button onclick="document.cookie='rejected=1; path=/';document.getElementById('consent').remove()">Reject all</button><button onclick="document.cookie='accepted=1; path=/';${action}">Accept all</button><a href="#">More options</a></div>`;
            async function create(id, mode) {
                await manager.createBrowser(id, { startPage: 'about:blank', persistSessions: false });
                const managed = manager.get(id), wc = managed.view.webContents;
                managed.view.setBounds({ x: 0, y: 0, width: 940, height: 650 });
                const trace = { searches: 0, targetRequests: 0, targetMatch: null, finishedBeforeMatch: false, errors: [], requests: [], navigations: [] };
                wc.on('console-message', (_event, level, message) => { if (level >= 2) trace.errors.push(message); });
                wc.on('did-navigate', (_event, url) => trace.navigations.push(url));
                traces.set(id, trace); modes.set(id, mode);
                wc.on('ipc-message', (_event, channel, payload) => {
                    if (channel === 'dom:google-state' && payload.state?.match && !trace.targetMatch)
                        trace.targetMatch = { loading: wc.isLoading(), parsed: payload.state.documentParsed };
                });
                wc.on('did-finish-load', () => {
                    if (wc.getURL().includes('google.com') && !trace.targetMatch) trace.finishedBeforeMatch = true;
                });
                managed.session.protocol.handle('https', async request => {
                    const url = new URL(request.url), mode = modes.get(id);
                    trace.requests.push(request.url);
                    if (url.pathname === '/favicon.ico') return new Response('', { status: 204 });
                    if (url.hostname === 'appareldiary.com') {
                        trace.targetRequests++;
                        // Reproduce a target whose first click starts loading
                        // before its URL commits, as on a busy Windows runner.
                        if (id === 613) await new Promise(resolve => later(resolve, 300));
                        return new Response(html('<h1>Article</h1>') + '</body></html>', { headers: { 'Content-Type': 'text/html' } });
                    }
                    if (url.hostname === 'www.google.com') trace.searches++;
                    if (mode === 'standalone' && url.hostname === 'www.google.com' && trace.searches === 1)
                        return Response.redirect('https://consent.google.com/m?continue=' + encodeURIComponent(request.url));
                    if (url.hostname === 'consent.google.com') {
                        const action = "location.href=new window.URL(location.href).searchParams.get('continue')";
                        return new Response(html(consent(id, action)) + '</body></html>', { headers: { 'Content-Type': 'text/html' } });
                    }
                    let content = card(id);
                    if (mode === 'overlay' || mode === 'fleet') content += consent(id);
                    if (mode === 'verification' || mode === 'captcha') content += verification(id, mode === 'captcha');
                    if (mode === 'combined') {
                        // Consent creates a second Google screen in the same document.
                        const next = verification(id).replace(/<script>[\s\S]*?<\/script>/g, '');
                        const action = `document.getElementById('consent').outerHTML=${JSON.stringify(next)};setTimeout(()=>document.getElementById('continue').disabled=false,1000)`;
                        content += consent(id, action.replace(/"/g, '&quot;'));
                    }
                    if (mode === 'unrelated') content += '<button onclick="document.cookie=\'unrelated=1; path=/\'">Continue</button>';
                    if (mode === 'foreign') content = consent(id);
                    const encoder = new TextEncoder();
                    return new Response(new ReadableStream({ start(controller) {
                        controller.enqueue(encoder.encode(html('')));
                        later(() => { try { controller.enqueue(encoder.encode(content)); } catch {} }, 250);
                        // Keep HTML parsing and full-page loading unfinished.
                    } }), { headers: { 'Content-Type': 'text/html' } });
                });
                return managed;
            }
            async function cookies(managed) {
                return Object.fromEntries((await managed.session.cookies.get({})).map(cookie => [cookie.name, cookie.value]));
            }
            async function search(id, mode) {
                const managed = await create(id, mode), started = Date.now();
                const result = await manager.broadcastSearch(id, query, 'appareldiary.com', 5, manager.startMeasurementSession(id));
                const trace = traces.get(id), choices = await cookies(managed);
                if (result.interactionStatus !== 'opened' || result.resultPage !== 1)
                    throw new Error(`${mode}: failed to open after prompt: ${JSON.stringify({ result, trace, choices, url: managed.view.webContents.getURL() })}`);
                if (choices.rejected || choices.unrelated) throw new Error(`${mode}: clicked the wrong button`);
                if (trace.targetRequests !== 1 || choices.titleClicked !== '1')
                    throw new Error(`${mode}: target was not opened by its result title exactly once: ${JSON.stringify({ id, trace, choices })}`);
                if (mode !== 'standalone' && (!trace.targetMatch?.loading || trace.targetMatch.parsed || trace.finishedBeforeMatch))
                    throw new Error(`${mode}: waited for parsing/full loading: ${JSON.stringify(trace)}`);
                if (['overlay', 'combined', 'fleet', 'standalone'].includes(mode) && choices.accepted !== '1') throw new Error(`${mode}: Accept all was not clicked`);
                if (['verification', 'combined'].includes(mode) && (choices.continued !== '1' || Date.now() - started < 1_000))
                    throw new Error(`${mode}: Continue was not clicked after becoming enabled`);
                const evidence = { elapsedMs: Date.now() - started, searches: trace.searches, choices, beforeLoad: Boolean(trace.targetMatch?.loading), resultPage: result.resultPage };
                await manager.destroyBrowser(id); return evidence;
            }
            let server;
            try {
                for (const [index, mode] of ['overlay', 'verification', 'combined', 'standalone', 'unrelated'].entries())
                    stats[mode] = await search(601 + index, mode);
                const ids = [610, 611, 612, 613];
                stats.independentBrowsers = await Promise.all(ids.map(id => search(id, 'fleet')));
                for (const [id, mode, url] of [
                    [620, 'captcha', googleUrl], [621, 'foreign', 'https://outside.test/']
                ]) {
                    const managed = await create(id, mode);
                    void managed.view.webContents.loadURL(url).catch(() => {});
                    await pause(1_700);
                    const choices = await cookies(managed);
                    if (choices.accepted || choices.continued || choices.rejected) throw new Error(`${mode}: automatic button handler escaped its scope`);
                    stats[mode] = { clicked: false }; await manager.destroyBrowser(id);
                }
                // A verification Continue redirect is handled even without a
                // result scanner/config, as on Google's standalone screen.
                const verify = await create(622, 'unrelated');
                verify.session.protocol.unhandle('https');
                let continueRequests = 0;
                verify.session.protocol.handle('https', request => {
                    if (request.url.includes('/finished')) { continueRequests++; return new Response(html('<h1>Finished</h1>'), { headers: { 'Content-Type': 'text/html' } }); }
                    const action = "document.cookie='continued=1; path=/';location.href='https://www.google.com/finished'";
                    const body = verification(622).replace("document.cookie='continued=1; path=/';document.getElementById('verification').remove();", action);
                    return new Response(html(body) + '</body></html>', { headers: { 'Content-Type': 'text/html' } });
                });
                void verify.view.webContents.loadURL('https://www.google.com/verify').catch(() => {});
                for (let count = 0; count < 40 && !continueRequests; count++) await pause(100);
                if (continueRequests !== 1) throw new Error('Standalone enabled Continue was not clicked');
                stats.standaloneContinue = { requests: continueRequests };
                await manager.destroyBrowser(622);

                // Native HTTP cache + Cache Storage: the next page must refetch
                // an image, while the per-browser consent cookie remains intact.
                const http = load('node:http'); let imageRequests = 0;
                server = http.createServer((request, response) => {
                    if (request.url === '/cached.svg') {
                        imageRequests++; response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
                        response.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>');
                    } else {
                        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
                        response.end(html('<img src="/cached.svg"><h1>Cache fixture</h1>') + '</body></html>');
                    }
                });
                await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
                await manager.createBrowser(630, { startPage: 'about:blank' });
                const cached = manager.get(630), origin = `http://127.0.0.1:${server.address().port}`;
                await cached.view.webContents.loadURL(origin + '/one');
                await cached.view.webContents.loadURL(origin + '/two');
                if (imageRequests !== 1) throw new Error('HTTP fixture was not cached before cleanup: ' + imageRequests);
                await cached.view.webContents.executeJavaScript(`(async()=>{document.cookie='accepted=1;path=/';const c=await caches.open('cycle-test');await c.put('/stored',new Response('cached'));})()`);
                await manager.clearCache(630);
                const cacheKeys = await cached.view.webContents.executeJavaScript('caches.keys()');
                if (cacheKeys.length) throw new Error('Cache Storage survived native cleanup');
                if ((await cookies(cached)).accepted !== '1') throw new Error('Cache cleanup removed consent cookies');
                await cached.view.webContents.loadURL(origin + '/three');
                if (imageRequests !== 2) throw new Error('Next page reused its old HTTP cache: ' + imageRequests);
                stats.cache = { before: 1, after: imageRequests, cacheStorageEmpty: true, consentCookieRetained: true };
                return stats;
            } finally {
                for (const timer of timers) clearTimeout(timer);
                await manager.destroyAll(); window.destroy();
                if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
            }
        }), 90_000, 'Native Google prompt/cache checks');
        console.log(JSON.stringify(report, null, 2));
    } finally {
        if (application) await application.close();
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
