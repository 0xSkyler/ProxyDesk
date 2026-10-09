'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'proxydesk-desktop-'));
const mixed = process.env.PROXYDESK_TEST_MIXED === '1';
const enginePlan = mixed ? ['chromium', 'firefox', 'webkit'] : ['chromium', 'chromium', 'chromium'];
const report = { version: require('../package.json').version, platform: process.platform, scenario: 'real Electron UI and browser processes; Google and articles served by isolated Playwright routes', enginePlan, checks: {} };
let application, page;
async function waitFor(predicate, argument) {
  const deadline = Date.now() + 45_000;
  while (!await page.evaluate(predicate, argument)) {
    if (Date.now() > deadline) throw new Error('Desktop readiness condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function launch() {
  application = await _electron.launch({
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), path.join(root, 'scripts/desktop-fixture-entry.cjs')],
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0', PROXYDESK_FIXTURE_PROFILE: profile }, timeout: 60_000
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(45_000);
  await page.getByRole('button', { name: 'SEO Tracker', exact: true }).waitFor();
}
(async () => {
  try {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ browserCount: 3, enginePlan, autoAssignOnImport: true, validation: { validateBeforeAssign: false, autoStartOnImport: false } }));
    fs.writeFileSync(path.join(profile, 'proxies.txt'), ['http://127.0.0.1:19001', 'http://127.0.0.1:19002', 'http://127.0.0.1:19003'].join('\n'));
    fs.writeFileSync(path.join(profile, 'seo-history.json'), JSON.stringify([{ id: 'legacy', keyword: 'legacy keyword', target: 'fixture.test', targetHost: 'fixture.test', completedAt: new Date().toISOString(), results: [] }]));
    await launch();
    await page.getByRole('button', { name: 'Upload proxy.txt', exact: true }).click();
    await waitFor(async () => (await window.proxydesk.bootstrap()).workspaces.filter((workspace) => workspace.proxy).length === 3);
    await page.getByRole('button', { name: 'SEO Tracker', exact: true }).click();
    await page.getByLabel('Keywords (one per line)', { exact: false }).fill('alpha research\nbeta research\ngamma research\nALPHA RESEARCH');
    await page.getByLabel('Target website', { exact: true }).fill('fixture.test');
    assert.equal(await page.locator('.seo-keyword-card').count(), 3);
    await page.getByRole('button', { name: 'Track 3 keywords in 3 browsers', exact: true }).click();
    await application.evaluate(async () => {
      const deadline = Date.now() + 40_000;
      while (new Set(global.__seoFixture.requests.map((request) => request.query)).size < 3) {
        if (Date.now() > deadline) throw new Error('Three keyword navigations did not start concurrently.');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
    report.checks.concurrentKeywordsBeforeCompletion = true;
    await page.getByRole('button', { name: 'Control Center', exact: true }).click();
    await application.evaluate(() => global.__seoFixture.release());
    await waitFor(async () => (await window.proxydesk.seo.history()).some((run) => run.keywords?.length === 3));
    const current = await page.evaluate(() => window.proxydesk.bootstrap());
    assert.equal(current.workspaces.length, 3);
    assert.equal(new Set(current.workspaces.map((workspace) => workspace.proxy.id)).size, 3);
    assert.equal(current.workspaces.every((workspace) => workspace.keepAlive), true);
    report.checks.fleetAndIsolatedProxyAssignments = true;
    report.checks.exactArticleAndKeepAlive = true;
    await page.getByRole('button', { name: 'SEO Tracker', exact: true }).click();
    await page.getByRole('button', { name: 'Track 3 keywords in 3 browsers', exact: true }).waitFor();
    assert.equal(await page.locator('.seo-results-table tbody tr').count(), 3);
    assert.equal(await page.getByLabel('Keywords (one per line)', { exact: false }).inputValue(), 'alpha research\nbeta research\ngamma research\nALPHA RESEARCH');
    report.checks.runSurvivesTabSwitch = true;
    await page.getByLabel('Filter results by keyword', { exact: true }).selectOption('beta research');
    assert.equal(await page.locator('.seo-results-table tbody tr').count(), 1);
    assert.match(await page.locator('.seo-results-table tbody').innerText(), /beta research/);
    await page.getByLabel('Filter results by keyword', { exact: true }).selectOption('');
    assert.equal(await page.locator('.seo-history-wrap tbody tr').count(), 4);
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
    await waitFor(() => document.querySelector('.seo-message')?.textContent.includes('CSV exported'));
    const csv = fs.readFileSync(path.join(profile, 'export.csv'), 'utf8');
    for (const keyword of ['alpha research', 'beta research', 'gamma research']) assert.ok(csv.includes(`,"${keyword}",`));
    report.checks.keywordFilterHistoryAndCsv = true;
    await page.screenshot({ path: path.join(output, 'parallel-keywords.png'), fullPage: true });
    await page.getByRole('button', { name: 'Control Center', exact: true }).click();
    await page.getByRole('button', { name: 'Stop Keep Alive', exact: true }).click();
    await page.evaluate(() => window.proxydesk.workspace.input(1, { kind: 'wheel', deltaX: 0, deltaY: -4000 }));
    const view = page.getByRole('application', { name: /^Interactive live view for Browser 1\./ });
    await view.scrollIntoViewIfNeeded();
    await view.locator('img').waitFor();
    await waitFor(() => document.querySelector('.interactive-live-view img')?.naturalWidth > 0);
    async function clickInBrowser(x, y) {
      const box = await view.boundingBox();
      const scale = Math.min(box.width / 390, box.height / 844);
      await page.mouse.click(box.x + (box.width - 390 * scale) / 2 + x * scale, box.y + (box.height - 844 * scale) / 2 + y * scale);
    }
    await clickInBrowser(80, 60);
    await page.keyboard.type('Parallel keyword UI');
    await application.evaluate(async () => {
      const deadline = Date.now() + 10_000;
      while (await global.__seoFixture.manager.require(1).page.evaluate(() => document.querySelector('#field').value) !== 'Parallel keyword UI') {
        if (Date.now() > deadline) throw new Error('Interactive keyboard text did not reach the real browser.');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
    await clickInBrowser(80, 130);
    await application.evaluate(async () => {
      const deadline = Date.now() + 10_000;
      while (await global.__seoFixture.manager.require(1).page.evaluate(() => document.querySelector('#out').textContent) !== 'Parallel keyword UI') {
        if (Date.now() > deadline) throw new Error('Live-view mouse click did not reach the real browser.');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
    report.checks.liveViewMouseAndKeyboard = true;
    await page.keyboard.press('Escape');
    const before = await application.evaluate(() => global.__seoFixture.manager.require(1).previewSequence);
    await waitFor((sequence) => {
      const image = document.querySelector('.interactive-live-view img');
      return Boolean(image?.title) && sequence >= 0;
    }, before);
    await application.evaluate(async (sequence) => {
      const deadline = Date.now() + 10_000;
      while (global.__seoFixture.manager.require(1).previewSequence <= sequence) {
        if (Date.now() > deadline) throw new Error('Live frames stopped updating.');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }, before);
    report.checks.framesContinueStreaming = true;
    report.observation = await application.evaluate(({ app }) => ({
      browserContexts: global.__seoFixture.contexts,
      launches: global.__seoFixture.launchOptions,
      requests: global.__seoFixture.requests,
      electronProcessWorkingSetKiB: app.getAppMetrics().map((process) => process.memory?.workingSetSize ?? 0).reduce((sum, value) => sum + value, 0)
    }));
    await page.evaluate(() => window.proxydesk.workspace.stopAll());
    assert.equal(await application.evaluate(() => global.__seoFixture.closedContexts), 3);
    report.checks.stopClosesAllBrowserContexts = true;
    await application.close(); application = null;
    await launch();
    await page.getByRole('button', { name: 'SEO Tracker', exact: true }).click();
    await waitFor(() => document.querySelectorAll('.seo-history-wrap tbody tr').length === 4);
    assert.equal(await page.evaluate(async () => (await window.proxydesk.bootstrap()).proxies.length), 0);
    report.checks.reopenRestoresHistoryWithEmptyProxyPool = true;
    await application.close(); application = null;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.error = error.stack;
    if (application) report.inputDiagnostics = await application.evaluate(async () => {
      const manager = global.__seoFixture.manager;
      return {
        inputs: global.__seoFixture.inputs,
        browser: manager?.require(1).page ? await manager.require(1).page.evaluate(() => ({ value: document.querySelector('#field')?.value, active: document.activeElement?.id, scrollY: window.scrollY })) : null
      };
    }).catch(() => null);
    if (page) report.failureState = await page.evaluate(async () => ({ state: await window.proxydesk.bootstrap(), history: await window.proxydesk.seo.history() })).catch(() => null);
    if (page) await page.screenshot({ path: path.join(output, 'desktop-failure.png'), fullPage: true }).catch(() => {});
    console.error(report.error); console.error(JSON.stringify({ inputDiagnostics: report.inputDiagnostics, checks: report.checks })); process.exitCode = 1;
  } finally {
    if (application) {
      await page.evaluate(() => window.proxydesk.workspace.stopAll()).catch(() => {});
      await application.close().catch(() => {});
    }
    fs.writeFileSync(path.join(output, 'desktop-smoke.json'), JSON.stringify(report, null, 2) + '\n');
    fs.rmSync(profile, { recursive: true, force: true });
  }
})();
