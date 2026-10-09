'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { _electron } = require('playwright-core');
const asar = require('@electron/asar');
const { withinDeadline, waitForAutomation } = require('./benchmark-state.cjs');
const [runtimeArg, sourceArg, outputArg, durationArg = '60', countArg = '10'] = process.argv.slice(2);
if (!runtimeArg || !sourceArg || !outputArg) throw new Error('Usage: benchmark.cjs <linux-unpacked> <source-app> <output.json> [active seconds=60] [browsers=10]');
const runtime = path.resolve(runtimeArg), source = path.resolve(sourceArg), output = path.resolve(outputArg);
const activeMs = Number(durationArg) * 1000, count = Number(countArg);
assert.ok(Number.isFinite(activeMs) && activeMs >= 1000 && activeMs <= 24 * 3600 * 1000 && Number.isInteger(count) && count >= 1 && count <= 100);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-benchmark-'));
const servers = []; let application, exitObserved = false;
const report = { schema: 2, platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length, electron: require('../package.json').devDependencies.electron, testedBrowserCount: count, activeSeconds: activeMs / 1000, rendering: 'software/Xvfb', sandboxDisabled: true, scenario: 'local HTTP proxy fixtures; external search discovery substituted, original scroll/link/cycle code', samples: [], checks: {} };
async function server(handler) {
    const value = http.createServer(handler); servers.push(value);
    await new Promise((resolve, reject) => { value.once('error', reject); value.listen(0, '127.0.0.1', resolve); }); return value.address().port;
}
function fixture(req, res) {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<html><head><link rel="icon" href="data:,"></head><body><article><h1>Local article fixture</h1>${Array.from({ length: 80 }, (_, i) => `<p>Local scrolling content ${i} for DOM rendering verification.</p>`).join('')}${Array.from({ length: 100 }, (_, i) => `<a href="http://fixture.local/article/${i}">Read local article number ${i}</a><br>`).join('')}</article></body></html>`);
}
async function snapshot(stage, page) {
    const sample = await withinDeadline(application.evaluate(() => global.__probe.snapshot()), 15_000, 'Main-process snapshot');
    sample.stage = stage;
    sample.rendererFramesPerSecond = await withinDeadline(page.evaluate(() => new Promise((resolve) => {
        const start = performance.now(); let frames = 0;
        function frame(now) { frames++; if (now - start >= 1000) resolve(frames * 1000 / (now - start)); else requestAnimationFrame(frame); }
        requestAnimationFrame(frame);
    })), 15_000, 'Renderer frame sample');
    report.samples.push(sample); return sample;
}
function processStart(pid) {
    try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; } catch { return null; }
}
(async () => {
    try {
        const proxies = [];
        for (let i = 0; i < count; i++) proxies.push(`http://127.0.0.1:${await server(fixture)}`);
        const fixturePort = await server((req, res) => req.url === '/proxies' ? res.end(proxies.join('\n')) : fixture(req, res));
        const resources = path.join(temporary, 'resources'); await fsp.mkdir(resources);
        // Test runtime is a copy; installed distribution and source remain untouched.
        for (const entry of await fsp.readdir(runtime, { withFileTypes: true })) {
            if (entry.name === 'resources') continue;
            await fsp.cp(path.join(runtime, entry.name), path.join(temporary, entry.name), { recursive: true });
        }
        const appTree = path.join(temporary, 'instrumented-app'); await fsp.mkdir(appTree);
        const metadata = JSON.parse(await fsp.readFile(path.join(source, 'package.json'), 'utf8'));
        for (const dir of ['src', 'dist', 'node_modules', 'third-party']) {
            if (fs.existsSync(path.join(source, dir))) {
                // Reference includes its shipped dependencies. Optimized runtime has none.
                if (dir === 'node_modules' && metadata.main.startsWith('src/')) continue;
                await fsp.cp(path.join(source, dir), path.join(appTree, dir), { recursive: true });
            }
        }
        metadata.probeOriginalMain = metadata.main; metadata.main = 'probe-entry.cjs'; delete metadata.devDependencies; delete metadata.build;
        await fsp.writeFile(path.join(appTree, 'package.json'), JSON.stringify(metadata));
        await fsp.copyFile(path.join(__dirname, 'probe-entry.cjs'), path.join(appTree, 'probe-entry.cjs'));
        await asar.createPackage(appTree, path.join(resources, 'app.asar'));
        const executable = path.join(temporary, 'dom');
        const launchStart = performance.now();
        application = await _electron.launch({ executablePath: executable, args: ['--no-sandbox', '--disable-gpu', '--host-resolver-rules=MAP fixture.local 127.0.0.1', `--user-data-dir=${temporary}/profile`], env: { ...process.env, NODE_ENV: 'production', DOM_FIXTURE_API: `http://127.0.0.1:${fixturePort}/proxies`, DOM_FIXTURE_SITE: 'http://fixture.local' }, timeout: 60000 });
        application.process().once('exit', () => { exitObserved = true; });
        const page = await application.firstWindow();
        await page.getByRole('heading', { name: `${metadata.productName} SEO Tracker Lite`, exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelectorAll('.browser-card').length === 10);
        report.startupMs = performance.now() - launchStart; report.checks.rendererLoaded = true;
        const defaults = await page.locator('.tracker-controls input').evaluateAll((inputs) => inputs.map((input) => input.value));
        assert.deepEqual(defaults, ['', '', '', '10', '20', '600']); report.checks.defaultsPreserved = true;
        await application.evaluate(() => global.__probe.resetCpu());
        await pause(5000); await snapshot('idle', page);
        const keywordInput = page.locator('.tracker-controls label').filter({ hasText: 'Keywords' }).locator('input');
        const fixtureKeywords = count > 1 ? 'first, second' : 'first';
        await keywordInput.fill(fixtureKeywords);
        await page.getByLabel('Target website', { exact: true }).fill('fixture.local');
        await page.getByLabel('Browsers', { exact: true }).fill(String(count));
        await page.getByRole('button', { name: 'Start SEO Tracker', exact: true }).click();
        await waitForAutomation(page, (state, number) => state.running && state.cycleNumber >= 1 && !state.cycleInProgress && state.assignedBrowsers === number, count);
        report.checks.startAndAssignment = true;
        const firstCycleSearches = await application.evaluate(() => global.__probe.searches.slice(0, global.__probe.automation.getState().browserIds.length));
        report.firstCycleSearches = firstCycleSearches;
        if (metadata.probeOriginalMain.startsWith('src/')) {
            const expectedQueries = Array.from({ length: count }, (_, index) => count > 1 && index % 2 === 1 ? 'second' : 'first');
            assert.deepEqual(firstCycleSearches.map(({ query }) => query), expectedQueries);
            report.checks.concurrentKeywords = true;
        }
        await snapshot('active-start', page);
        const activeStart = performance.now();
        while (performance.now() - activeStart < activeMs) { await pause(Math.min(5000, activeMs - (performance.now() - activeStart))); await snapshot('active', page); }
        const beforeRotation = await waitForAutomation(page, (state) => state.running && !state.cycleInProgress);
        report.automaticCyclesCompleted = beforeRotation.cycleNumber - 1;
        report.checks.automaticRotation = activeMs >= beforeRotation.intervalSec * 1000 + 15_000 ? report.automaticCyclesCompleted >= 1 : null;
        if (report.checks.automaticRotation !== null) assert.equal(report.checks.automaticRotation, true, 'The configured automatic rotation did not complete during the soak');
        const expectedCycle = beforeRotation.cycleNumber + 1;
        await page.getByRole('button', { name: 'Rotate / Run Now', exact: true }).click();
        await waitForAutomation(page, (state, expected) => state.cycleNumber >= expected && !state.cycleInProgress, expectedCycle);
        report.checks.rotation = true;
        await page.getByRole('button', { name: 'Stop SEO Tracker', exact: true }).click();
        await waitForAutomation(page, (state) => !state.running);
        assert.equal(await application.evaluate(() => global.__probe.browser.getAll().some((browser) => browser.keepAliveEnabled)), false);
        report.checks.stop = true; await snapshot('stopped', page);
        // Repeated resize of workspace pool exposes BrowserView lifetime leaks.
        const counts = [];
        report.workspaceRecreationDetails = [];
        for (let round = 0; round < 3; round++) {
            await keywordInput.fill('first');
            await page.getByLabel('Browsers', { exact: true }).fill('1');
            await page.getByRole('button', { name: 'Start SEO Tracker', exact: true }).click();
            await waitForAutomation(page, (state) => state.running && state.cycleNumber >= 1 && !state.cycleInProgress && state.browserIds.length === 1 && state.assignedBrowsers === 1);
            await page.getByRole('button', { name: 'Stop SEO Tracker', exact: true }).click();
            await waitForAutomation(page, (state) => !state.running);
            await page.getByLabel('Browsers', { exact: true }).fill(String(count));
            await page.getByRole('button', { name: 'Start SEO Tracker', exact: true }).click();
            await waitForAutomation(page, (state, number) => state.running && state.cycleNumber >= 1 && !state.cycleInProgress && state.browserIds.length === number && state.assignedBrowsers === number, count);
            await page.getByRole('button', { name: 'Stop SEO Tracker', exact: true }).click();
            await waitForAutomation(page, (state) => !state.running);
            const details = await application.evaluate(({ webContents }) => ({
                managed: Array.from(global.__probe.browser.browsers.values()).map((browser) => ({ id: browser.id, contentId: browser.view.webContents.id })),
                contents: webContents.getAllWebContents().filter((wc) => !wc.isDestroyed()).map((wc) => ({ id: wc.id, type: wc.getType(), url: wc.getURL() })),
                state: global.__probe.automation.getState()
            }));
            counts.push(details.contents.length);
            report.workspaceRecreationDetails.push(details);
        }
        report.workspaceRecreationCounts = counts;
        report.checks.workspaceRecreation = counts.every((value) => value === count + 1);
        const last = await snapshot('after-recreation', page);
        const trustedProc = last.pidNamespaceConsistent;
        const tracked = last.metrics.map((metric) => ({ pid: metric.pid, start: processStart(metric.pid) })).filter((entry) => {
            try { return fs.readlinkSync(`/proc/${entry.pid}/exe`) === executable; } catch { return false; }
        });
        const closeStart = performance.now();
        await application.close(); application = null;
        await pause(2000);
        report.shutdownMs = performance.now() - closeStart - 2000;
        report.processObservationValid = trustedProc && tracked.length > 0;
        report.survivingChildren = report.processObservationValid ? tracked.filter((entry) => entry.start !== null && processStart(entry.pid) === entry.start) : null;
        report.checks.exitObserved = exitObserved;
        report.checks.noOrphans = report.survivingChildren ? report.survivingChildren.length === 0 : null;
        // Reference failures are measurements, not a reason to hide its report.
        if (metadata.probeOriginalMain.startsWith('src/')) {
            assert.equal(report.checks.workspaceRecreation, true, 'Workspace contents did not return to the requested pool size');
            if (report.processObservationValid) assert.equal(report.checks.noOrphans, true, 'Child processes survived normal application close');
        }
    } catch (error) { report.error = error.stack; process.exitCode = 1; }
    finally {
        if (application) await application.close().catch(() => {});
        for (const value of servers) { value.closeAllConnections(); await new Promise((resolve) => value.close(resolve)); }
        await fsp.mkdir(path.dirname(output), { recursive: true });
        await fsp.writeFile(output, JSON.stringify(report, null, 2) + '\n');
        await fsp.rm(temporary, { recursive: true, force: true });
        console.log(JSON.stringify({ output, startupMs: report.startupMs, checks: report.checks, workspaceRecreationCounts: report.workspaceRecreationCounts, recreationFailureDetails: report.checks.workspaceRecreation === false ? report.workspaceRecreationDetails : undefined, error: report.error }));
    }
})();
