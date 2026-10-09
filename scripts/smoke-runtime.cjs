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
(async () => {
    try {
        app = await _electron.launch({ executablePath: target, chromiumSandbox: sandboxEnabled, args: [...(sandboxEnabled ? [] : ['--no-sandbox']), '--disable-gpu', `--user-data-dir=${profile}`], env: { ...process.env, NODE_ENV: 'production', APPIMAGE_EXTRACT_AND_RUN: '1' }, timeout: 60000 });
        if (sandboxEnabled) assert.equal(await app.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox')), false);
        const page = await app.firstWindow();
        await page.getByRole('heading', { name: 'DOM SEO Tracker Lite', exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelectorAll('.browser-card').length === 10);
        const state = await page.evaluate(() => window.app.automation.getState());
        assert.equal(state.running, false); assert.equal(state.browserCount, 10);
        await page.getByRole('button', { name: 'Start SEO Tracker', exact: true }).click();
        await page.getByText('Enter at least one keyword and a target website.', { exact: true }).waitFor();
        await app.close(); app = null;
        console.log(JSON.stringify({ artifact: path.basename(target), sandboxEnabled, rendererLoaded: true, workspaceCount: 10, inputValidation: true, gracefulClose: true }));
    } finally { if (app) await app.close().catch(() => {}); fs.rmSync(profile, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
