'use strict';
const { _electron } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const { waitForAutomation } = require('./benchmark-state.cjs');
const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dom-smoke-'));
const target = path.resolve(process.argv[2]);
if (target.endsWith('.AppImage')) fs.chmodSync(target, 0o755);
let app;
const servers = [];
async function serve(handler) {
    const server = http.createServer(handler);
    // Proxy fixture deliberately fails HTTPS tunnels without any external
    // traffic. This smoke checks preparation/routing/Stop, not Google results.
    server.on('connect', (_request, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'));
    servers.push(server);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}
const sandboxEnabled = process.env.DOM_TEST_SANDBOX === '1';
const disableSandboxForLinuxTestRunner = process.platform === 'linux' && !sandboxEnabled;
(async () => {
    try {
        app = await _electron.launch({ executablePath: target, chromiumSandbox: !disableSandboxForLinuxTestRunner, args: [...(disableSandboxForLinuxTestRunner ? ['--no-sandbox'] : []), '--disable-gpu', `--user-data-dir=${profile}`], env: { ...process.env, NODE_ENV: 'production', APPIMAGE_EXTRACT_AND_RUN: '1' }, timeout: 60000 });
        if (sandboxEnabled) assert.equal(await app.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox')), false);
        const page = await app.firstWindow();
        await page.getByRole('heading', { name: 'DOM SEO Tracker Lite', exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelectorAll('.browser-card').length === 10);
        const source = page.getByLabel('Proxy source', { exact: true });
        const endpoint = page.getByLabel('Proxy API URL (editable)', { exact: true });
        await source.waitFor().catch(async (error) => {
            console.error(JSON.stringify(await page.evaluate(() => ({
                providerControls: document.documentElement.dataset.domProviderControls ?? 'not-loaded',
                scripts: Array.from(document.scripts, (script) => script.src),
                trackerControls: document.querySelector('.tracker-controls')?.innerText ?? null
            }))));
            throw error;
        });
        assert.equal(await source.inputValue(), 'proxyscrape-free');
        assert.match(await endpoint.inputValue(), /^https:\/\/api\.proxyscrape\.com\//);
        await source.selectOption('all-working');
        assert.equal(await endpoint.inputValue(), 'http://169.58.35.69/data/all-working.txt');
        const state = await page.evaluate(() => window.app.automation.getState());
        assert.equal(state.running, false); assert.equal(state.browserCount, 10);
        await page.getByRole('button', { name: 'Start SEO Tracker', exact: true }).click();
        await page.getByText('Enter at least one keyword and a target website.', { exact: true }).waitFor();
        const configured = await page.evaluate(() => window.app.automation.getState());
        assert.equal(configured.proxySource, 'all-working');

        const proxies = [];
        for (let index = 0; index < 20; index++) {
            proxies.push(`http://127.0.0.1:${await serve((_request, response) => {
                response.writeHead(503); response.end('Local proxy fixture');
            })}`);
        }
        const providerPort = await serve((_request, response) => response.end(proxies.join('\n')));
        await endpoint.fill(`http://127.0.0.1:${providerPort}/proxies`);
        await page.locator('.tracker-controls label').filter({ hasText: 'Keywords' }).locator('input').fill('fixture keyword');
        await page.getByLabel('Target website', { exact: true }).fill('fixture.local');
        await page.evaluate(() => {
            window.__domPreparationEvents = [];
            window.app.automation.onStateChanged((state) => {
                if (state.preparingBrowsers) window.__domPreparationEvents.push({
                    count: state.browserCount, ready: state.preparedBrowsers
                });
            });
        });
        const growthTimingsMs = [];
        async function startFleet(count) {
            await page.getByLabel('Browsers', { exact: true }).fill(String(count));
            const started = Date.now();
            await page.getByRole('button', { name: 'Start SEO Tracker', exact: true }).click();
            const state = await waitForAutomation(page, (value, number) => value.running &&
                !value.preparingBrowsers && value.cycleNumber >= 1 && !value.cycleInProgress &&
                value.assignedBrowsers === number, count);
            assert.equal(state.lastError, undefined);
            assert.equal(state.preparedBrowsers, count);
            assert.equal((await page.evaluate(() => window.app.browser.getAll())).length, count);
            await page.waitForFunction(() => document.querySelector('.tracker-pill').textContent !== 'STARTING');
            const liveContents = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((value) => !value.isDestroyed()).length);
            assert.equal(liveContents, count + 1, 'Resizing leaked a native browser view');
            growthTimingsMs.push({ count, elapsed: Date.now() - started });
        }
        async function stopFleet() {
            await page.getByRole('button', { name: 'Stop SEO Tracker', exact: true }).click();
            await waitForAutomation(page, (value) => !value.running && !value.preparingBrowsers);
            await page.waitForFunction(() => !Array.from(document.querySelectorAll('button'))
                .find((button) => button.textContent === 'Start SEO Tracker')?.disabled);
        }
        await startFleet(20);
        await stopFleet();
        await startFleet(1);
        await stopFleet();
        await startFleet(20);
        await stopFleet();

        // The full 100-browser limit provides enough preparation work to catch
        // Stop mid-growth; cancellation must prevent all queued launches.
        await page.getByLabel('Browsers', { exact: true }).fill('100');
        await page.getByRole('button', { name: 'Start SEO Tracker', exact: true }).click();
        await page.waitForFunction(() => window.__domPreparationEvents.some((value) => value.count === 100 && value.ready >= 20 && value.ready < 100));
        await page.getByRole('status').filter({ hasText: 'Preparing browsers:' }).waitFor();
        await stopFleet();
        await startFleet(20);
        await stopFleet();
        const progress = await page.evaluate(() => window.__domPreparationEvents);
        assert.ok(progress.some((value) => value.count === 20 && value.ready > 10 && value.ready < 20));
        await app.close(); app = null;
        console.log(JSON.stringify({ artifact: path.basename(target), sandboxEnabled, rendererLoaded: true, workspaceCount: 20, proxySourceSelection: true, editableProxyEndpoint: true, inputValidation: true, browserGrowth: true, preparationProgress: true, cancelledGrowth: true, restartAfterCancellation: true, growthTimingsMs, gracefulClose: true }));
    } finally {
        if (app) await app.close().catch(() => {});
        for (const server of servers) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
        fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
