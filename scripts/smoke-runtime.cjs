'use strict';
const { _electron } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dom-smoke-'));
const target = path.resolve(process.argv[2]);
if (target.endsWith('.AppImage')) fs.chmodSync(target, 0o755);
let app;
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
        await source.waitFor();
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
        await app.close(); app = null;
        console.log(JSON.stringify({ artifact: path.basename(target), sandboxEnabled, rendererLoaded: true, workspaceCount: 10, proxySourceSelection: true, editableProxyEndpoint: true, inputValidation: true, gracefulClose: true }));
    } finally { if (app) await app.close().catch(() => {}); fs.rmSync(profile, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
