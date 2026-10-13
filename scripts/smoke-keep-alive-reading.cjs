'use strict';
// Real-time dwell and scroll checks against the source or installed app.asar.
const { _electron } = require('playwright-core');
const asar = require('@electron/asar');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { waitForRenderer, withinDeadline } = require('./benchmark-state.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-reading-'));
const target = process.argv[2] && path.resolve(process.argv[2]);
const source = target ? path.join(path.dirname(target), 'resources/app.asar') : path.resolve(__dirname, '..');
const metadata = JSON.parse(target ? asar.extractFile(source, 'package.json') : fs.readFileSync(path.join(source, 'package.json')));
const entry = path.join(profile, 'test-app'); fs.mkdirSync(entry);
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, main: 'entry.cjs' }));
fs.writeFileSync(path.join(entry, 'entry.cjs'), `global.__domReadingLoad=require;global.__domReadingRoot=${JSON.stringify(source)};require(${JSON.stringify(path.join(source, metadata.main))});\n`);
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
        await application.evaluate(async ({ BrowserWindow }) => {
            const load = global.__domReadingLoad;
            const { BrowserManager } = load(load('node:path').join(global.__domReadingRoot, 'src/main/BrowserManager.js'));
            const manager = new BrowserManager(), window = new BrowserWindow({ width: 960, height: 740, show: true });
            manager.attachWindow(window);
            await manager.createBrowser(801, { startPage: 'about:blank', persistSessions: false });
            const browser = manager.get(801), visits = [];
            browser.view.setBounds({ x: 0, y: 0, width: 900, height: 600 });
            browser.session.protocol.handle('https', request => {
                const url = new URL(request.url);
                if (url.hostname !== 'reading.test') throw new Error('Keep Alive left its internal host: ' + request.url);
                const page = Number(url.pathname.split('/').at(-1));
                visits.push({ page, at: Date.now() });
                const paragraphs = Array.from({ length: 14 }, (_, i) => `<p>Reading paragraph ${i}: follow the article calmly and continue.</p>`).join('');
                return new Response(`<!doctype html><html><head><link rel="icon" href="data:,"><style>body{margin:24px;font:20px/1.8 sans-serif}p{margin:12px 0}</style></head><body><article><h1>Reading article ${page}</h1>${paragraphs}<a href="https://reading.test/article/${page + 1}">Read the next internal article</a><br><a href="https://outside.test/article">Visit another website</a></article></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
            });
            global.__domReadingProbe = { manager, window, browser, visits };
            await browser.view.webContents.loadURL('https://reading.test/article/1');
            manager.startControlledKeepAlive(801, 'reading.test');
        });
        const samples = [], started = Date.now();
        let visits, lastReportedPage = 1;
        while (Date.now() - started < 90_000) {
            const sample = await withinDeadline(application.evaluate(async () => {
                const { browser, visits } = global.__domReadingProbe;
                let document;
                try { document = await browser.view.webContents.executeJavaScript('({url:location.href,y:window.scrollY})'); }
                catch { /* Navigation can replace the sampling frame. */ }
                return { visits: [...visits], document, failures: browser.keepAliveFailureCount };
            }), 5_000, 'Reading progress');
            visits = sample.visits;
            if (sample.document) samples.push(sample.document);
            if (visits.length > 1) {
                const dwell = visits.at(-1).at - visits.at(-2).at;
                assert.ok(dwell >= 30_000, `Page ${visits.at(-2).page} was left after ${dwell} ms`);
                if (visits.at(-1).page !== lastReportedPage) {
                    console.log(`Page ${visits.at(-2).page} dwell: ${dwell} ms`);
                    lastReportedPage = visits.at(-1).page;
                }
            }
            if (visits.length >= 3) break;
            await wait(400);
        }
        assert.deepEqual(visits.map(v => v.page), [1, 2, 3]);
        for (const page of [1, 2]) {
            const positions = samples.filter(s => s.url === `https://reading.test/article/${page}`).map(s => s.y);
            assert.ok(positions.length > 20 && Math.max(...positions) > 50, `Page ${page} did not scroll while reading`);
            assert.ok(positions.every((y, i) => !i || y >= positions[i - 1] - 1), `Page ${page} scrolled backwards`);
        }
        await wait(2_500);
        await application.evaluate(() => global.__domReadingProbe.manager.setBrowserKeepAlive(801, false));
        await wait(500);
        const stopped = await application.evaluate(async () => {
            const { manager, browser, visits, window } = global.__domReadingProbe;
            const document = await browser.view.webContents.executeJavaScript('({controller:Boolean(window.__domKeepAliveController),reading:Boolean(window.__domKeepAliveReading)})');
            const result = { enabled: browser.keepAliveEnabled, document, visits: [...visits] };
            await manager.destroyAll(); window.destroy();
            return result;
        });
        assert.equal(stopped.enabled, false);
        assert.equal(stopped.document.controller, false);
        assert.equal(stopped.document.reading, false);
        assert.equal(stopped.visits.length, 3);
        console.log(JSON.stringify({ version: metadata.version, dwellMs: visits.slice(1).map((v, i) => v.at - visits[i].at),
            forwardScroll: true, stopped: true, sampleCount: samples.length }, null, 2));
    } finally {
        if (application) await application.close();
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
