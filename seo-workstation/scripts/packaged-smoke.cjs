'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron } = require('playwright');
const executablePath = process.argv[2];
if (!executablePath) throw new Error('Usage: node scripts/packaged-smoke.cjs <packaged executable>');
const report = { version: require('../package.json').version, platform: process.platform, executablePath: path.resolve(executablePath), checks: {} };
let application;
(async () => {
  try {
    const env = { ...process.env };
    // Installed apps must resolve the extraResources browser directory themselves.
    delete env.PLAYWRIGHT_BROWSERS_PATH;
    application = await _electron.launch({ executablePath: path.resolve(executablePath), env, timeout: 60_000 });
    const page = await application.firstWindow();
    await page.getByRole('button', { name: 'SEO Tracker', exact: true }).waitFor({ timeout: 45_000 });
    const data = await page.evaluate(() => window.proxydesk.bootstrap());
    assert.equal(data.diagnostics.appVersion, report.version);
    assert.equal(data.workspaces.length, 10);
    assert.equal(data.proxies.length, 0);
    for (const engine of ['chromium', 'firefox', 'webkit']) assert.equal(data.engines.find((item) => item.engine === engine)?.available, true, `${engine} binary must be installed`);
    report.checks.productionUiAndBundledBinaries = true;
    report.engines = await application.evaluate(async ({ app }) => {
      if (!app.isPackaged || !app.getAppPath().endsWith('app.asar')) throw new Error('Smoke must exercise the packaged ASAR.');
      const runtimeRequire = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
      const runtime = runtimeRequire('./dist/main/browser/PlaywrightRuntime.js').getPlaywright();
      const results = [];
      for (const engine of ['chromium', 'firefox', 'webkit']) {
        const browser = await runtime[engine].launch({ headless: true });
        try {
          const context = await browser.newContext();
          const page = await context.newPage();
          await page.setContent('<input id="field"><button id="go" onclick="document.body.dataset.clicked=document.querySelector(\'#field\').value">Go</button>');
          await page.locator('#field').fill('Packaged ProxyDesk');
          await page.locator('#go').click();
          if (await page.evaluate(() => document.body.dataset.clicked) !== 'Packaged ProxyDesk') throw new Error(`${engine} real input failed`);
          const screenshot = await page.screenshot({ type: 'jpeg' });
          if (screenshot.length < 100) throw new Error(`${engine} screenshot was empty`);
          await context.close();
          results.push({ engine, realInputAndScreenshot: true });
        } finally { await browser.close(); }
      }
      return results;
    });
    report.checks.packagedEngineInputAndRendering = true;
    await application.close(); application = null;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { report.error = error.stack; console.error(report.error); process.exitCode = 1; }
  finally {
    if (application) await application.close().catch(() => {});
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync('test-results/packaged-smoke.json', JSON.stringify(report, null, 2) + '\n');
  }
})();
