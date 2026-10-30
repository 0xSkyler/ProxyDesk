'use strict';
// Selective proxy rotation and keyword-cycle checks against the source or installed app.asar.
const { _electron } = require('playwright-core');
const asar = require('@electron/asar');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { waitForRenderer, withinDeadline } = require('./benchmark-state.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-rotation-'));
const target = process.argv[2] && path.resolve(process.argv[2]);
const source = target ? path.join(path.dirname(target), 'resources/app.asar') : path.resolve(__dirname, '..');
const metadata = JSON.parse(target ? asar.extractFile(source, 'package.json') : fs.readFileSync(path.join(source, 'package.json')));
const entry = path.join(profile, 'test-app'); fs.mkdirSync(entry);
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, main: 'entry.cjs' }));
fs.writeFileSync(path.join(entry, 'entry.cjs'), `global.__domRotationLoad=require;global.__domRotationRoot=${JSON.stringify(source)};require(${JSON.stringify(path.join(source, metadata.main))});\n`);
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
            const load = global.__domRotationLoad, root = global.__domRotationRoot;
            const { BrowserManager } = load(load('node:path').join(root, 'src/main/BrowserManager.js'));
            const { ProxyManager } = load(load('node:path').join(root, 'src/main/ProxyManager.js'));
            const { SeoAutomationManager } = load(load('node:path').join(root, 'src/main/SeoAutomationManager.js'));
            const manager = new BrowserManager(), proxies = new ProxyManager();
            const window = new BrowserWindow({ width: 1000, height: 740, show: true });
            manager.attachWindow(window);
            const ids = [901, 902, 903, 904, 905, 906], traces = new Map();
            const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
            async function until(predicate, label) {
                const deadline = Date.now() + 12_000;
                while (Date.now() < deadline) { if (predicate()) return; await pause(50); }
                throw new Error(label + ': ' + JSON.stringify({ state: automation.getState(), traces: [...traces], browsers: manager.getAll() }));
            }
            let apiCalls = 0;
            const server = load('node:http').createServer((_request, response) => {
                apiCalls++;
                if (apiCalls > 2) { response.writeHead(503); response.end('No further API request is needed'); return; }
                response.writeHead(200, { 'Content-Type': 'text/plain' });
                response.end(Array.from({ length: 11 }, (_, i) => i + 1).map(n => `http://127.0.0.${n}:8111`).join('\n'));
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            const automation = new SeoAutomationManager(proxies, manager, async () => ids);
            try {
                for (const id of ids) {
                    await manager.createBrowser(id, { startPage: 'about:blank', persistSessions: false });
                    const managed = manager.get(id), trace = { keywords: [], targets: 0, routingChanges: 0, connectionResets: 0, cacheClears: 0, storageClears: 0, targetBeforeReady: false, recovered: false, failTarget: false, preloadErrors: [], cacheIpc: [] };
                    managed.view.webContents.on('preload-error', (_event, _file, error) => trace.preloadErrors.push(error.message));
                    managed.view.webContents.on('ipc-message', (event, channel, payload) => {
                        if (!['dom:google-preload-ready'].includes(channel)) return;
                        let sender, main;
                        try { sender = event.senderFrame; main = managed.view.webContents.mainFrame; } catch {}
                        trace.cacheIpc.push({ channel, requestId: payload?.requestId, error: payload?.error,
                            sender: sender && [sender.processId, sender.routingId], main: main && [main.processId, main.routingId] });
                    });
                    traces.set(id, trace); managed.view.setBounds({ x: 0, y: 0, width: 920, height: 640 });
                    const setProxy = managed.session.setProxy.bind(managed.session);
                    const close = managed.session.closeAllConnections.bind(managed.session);
                    managed.session.clearCache = () => { trace.cacheClears++; throw new Error('Cache deletion forbidden'); };
                    managed.session.clearStorageData = () => { trace.storageClears++; throw new Error('Storage deletion forbidden'); };
                    managed.session.setProxy = options => { trace.routingChanges++; return setProxy(options); };
                    managed.session.closeAllConnections = () => { trace.connectionResets++; return close(); };
                    managed.view.webContents.on('did-navigate', (_event, url) => {
                        if (url.startsWith('https://appareldiary.com/') && manager.getProxyRotationState(id).targetOpened)
                            trace.targetBeforeReady ||= managed.view.webContents.isLoading();
                    });
                    managed.session.protocol.handle('https', request => {
                        const url = new URL(request.url);
                        if (url.pathname === '/favicon.ico') return new Response('', { status: 204 });
                        if (url.hostname === 'www.google.com') {
                            if (url.pathname === '/sorry/index') return new Response('<!doctype html><html><body><form id="captcha-form">Google CAPTCHA</form></body></html>', { status: 429, headers: { 'Content-Type': 'text/html' } });
                            trace.keywords.push(url.searchParams.get('q'));
                            if (managed.state.proxy?.host === '127.0.0.3') return Response.error();
                            const endpoint = managed.state.proxy?.host;
                            if (endpoint === '127.0.0.2' && !trace.recovered)
                                return new Response('<!doctype html><html><body><form id="captcha-form" action="/sorry/"><h1>Google CAPTCHA</h1></form></body></html>', { headers: { 'Content-Type': 'text/html' } });
                            if (endpoint === '127.0.0.4')
                                return new Response('<!doctype html><html><body><main id="search"><article><a href="https://other.test/article"><h3>Different publisher article</h3></a></article></main></body></html>', { headers: { 'Content-Type': 'text/html' } });
                            if (endpoint === '127.0.0.6') return Response.redirect('https://www.google.com/sorry/index?continue=' + encodeURIComponent(request.url));
                            const article = `https://appareldiary.com/article/${id}/${trace.keywords.length}`;
                            return new Response(`<!doctype html><html><head><link rel="icon" href="data:,"></head><body><main id="search"><article><cite>appareldiary.com</cite><a href="${article}"><h3>Article for ${url.searchParams.get('q')}</h3></a></article></main></body></html>`, { headers: { 'Content-Type': 'text/html' } });
                        }
                        if (managed.state.proxy?.host === '127.0.0.5' && trace.failTarget) return Response.error();
                        trace.targets++;
                        return new Response('<!doctype html><html><head><link rel="icon" href="data:,"></head><body><article><h1>Target article</h1><p>Reading content.</p></article></body></html>', { headers: { 'Content-Type': 'text/html' } });
                    });
                }
                await automation.start({ query: 'first,second,third', targetWebsite: 'appareldiary.com', browserCount: ids.length,
                    intervalSec: 600, maxPages: 1, proxySource: 'all-working', proxyApiUrl: `http://127.0.0.1:${server.address().port}/proxies` });
                await until(() => automation.getState().cycleNumber === 1 && !automation.getState().cycleInProgress &&
                    manager.getProxyRotationState(901).targetOpened && manager.getProxyRotationState(902).captchaSeen &&
                    manager.getProxyRotationState(903).failed && manager.getProxyRotationState(904).googleReached &&
                    manager.getProxyRotationState(905).targetOpened && manager.getProxyRotationState(906).captchaSeen, 'First cycle');
                if (apiCalls !== 1) throw new Error('First cycle must fetch one proxy pool');

                // Simulate manual recovery in the same CAPTCHA browser. A real
                // result click then opens the target, but cannot erase its flag.
                traces.get(902).recovered = true;
                await manager.get(902).view.webContents.loadURL('https://www.google.com/search?q=second&num=10&hl=en');
                await until(() => manager.getProxyRotationState(902).targetOpened, 'CAPTCHA recovery target click');
                if (!manager.getProxyRotationState(902).captchaSeen) throw new Error('Manual recovery erased the CAPTCHA flag');

                // A later target navigation failure must invalidate a proxy
                // that opened its first article successfully.
                traces.get(905).failTarget = true;
                void manager.get(905).view.webContents.loadURL('https://appareldiary.com/article/905/failed').catch(() => {});
                await until(() => manager.getProxyRotationState(905).failed, 'Failure after target opened');
                const first = ids.map(id => ({ id, ...manager.getProxyRotationState(id), proxy: manager.get(id).state.proxy.host,
                    routingChanges: traces.get(id).routingChanges, connectionResets: traces.get(id).connectionResets }));
                if (first.find(row => row.id === 904).targetOpened) throw new Error('Google-only browsing qualified as target success');
                if (!traces.get(901).targetBeforeReady) throw new Error('Target success waited for Ready');
                const targetsBeforeSecond = new Map(ids.map(id => [id, traces.get(id).targets]));
                await automation.runNow();
                await until(() => !automation.getState().cycleInProgress && ids.every(id => manager.getProxyRotationState(id).targetOpened &&
                    traces.get(id).targets > targetsBeforeSecond.get(id)), 'Second cycle');
                const healthy = first[0], trace = traces.get(901), current = manager.get(901);
                if (current.state.proxy.host !== healthy.proxy || trace.routingChanges !== healthy.routingChanges ||
                    trace.connectionResets !== healthy.connectionResets) throw new Error('Qualified browser changed its routing or connections');
                const nativeRoute = await current.session.resolveProxy('https://www.google.com');
                if (!nativeRoute.includes(healthy.proxy + ':8111')) throw new Error('Native route did not retain the qualified proxy: ' + nativeRoute);
                for (const [index, id] of ids.slice(1).entries()) {
                    const expected = '127.0.0.' + (index + 7);
                    if (manager.get(id).state.proxy.host !== expected) throw new Error(`Browser ${id} did not receive replacement ${expected}`);
                    if (manager.getProxyRotationState(id).captchaSeen || manager.getProxyRotationState(id).failed)
                        throw new Error('Replacement inherited an outgoing failure flag');
                }
                if (apiCalls !== 2) throw new Error('Second cycle must fetch one pool for its disqualified slots');
                const expectedKeywords = cycle => ids.map((_, index) => ['first', 'second', 'third'][(index + cycle - 1) % 3]).join(',');
                const second = ids.map(id => ({ id, proxy: manager.get(id).state.proxy.host, keyword: traces.get(id).keywords.at(-1) }));
                if (second.map(r => r.keyword).join(',') !== expectedKeywords(2)) throw new Error('Second-cycle keywords did not advance: ' + JSON.stringify(second));
                const secondStatus = automation.getState();
                if (secondStatus.retainedBrowsers !== 1 || secondStatus.replacedBrowsers !== 5 || secondStatus.assignedBrowsers !== ids.length)
                    throw new Error('Second-cycle retention counters are incorrect');
                const targetsBeforeThird = new Map(ids.map(id => [id, traces.get(id).targets]));
                await automation.runNow();
                await until(() => !automation.getState().cycleInProgress && ids.every(id => manager.getProxyRotationState(id).targetOpened &&
                    traces.get(id).targets > targetsBeforeThird.get(id)), 'Third cycle');
                if (apiCalls !== 2) throw new Error('All-qualified cycle called the unavailable API');
                const third = ids.map(id => ({ id, proxy: manager.get(id).state.proxy.host, keyword: traces.get(id).keywords.at(-1), cacheClears: traces.get(id).cacheClears }));
                if (third.map(r => r.keyword).join(',') !== expectedKeywords(3)) throw new Error('Third-cycle keywords did not advance');
                if (third.some((row, index) => row.proxy !== second[index].proxy || row.cacheClears !== 0 || traces.get(row.id).storageClears !== 0))
                    throw new Error('All-qualified cycle changed routing or deleted cache/storage');
                if (automation.getState().retainedBrowsers !== ids.length || automation.getState().replacedBrowsers !== 0)
                    throw new Error('All-qualified retention counters are incorrect');
                return { apiCalls, first, second, third, healthyRoutingUnchanged: true, allHealthyApiSkipped: true,
                    captchaRecoveredButReplaced: true, captchaRedirectReplaced: true, googleOnlyReplaced: true,
                    failureAfterTargetReplaced: true, targetOpenedBeforeReady: true, cachePreservedEveryCycle: true, exactKeywordRotation: true };
            } finally {
                automation.stop(); await manager.destroyAll(); window.destroy();
                server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
            }
        }), 60_000, 'Native selective proxy rotation');
        console.log(JSON.stringify(report, null, 2));
    } finally {
        if (application) await application.close();
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
