'use strict';
// Test-only fixture adapter. It is excluded from electron-builder's dist files.
const path = require('node:path');
const { app, dialog } = require('electron');
const root = path.resolve(__dirname, '..');
const profile = process.env.PROXYDESK_FIXTURE_PROFILE;
if (!profile) throw new Error('Desktop fixture requires an isolated profile.');
app.setPath('userData', profile);
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(profile, 'proxies.txt')] });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(profile, 'export.csv') });
const fixture = global.__seoFixture = { requests: [], launchOptions: [], contexts: 0, closedContexts: 0, manager: null, release: null };
let release;
const gate = new Promise((resolve) => { release = resolve; });
fixture.release = () => release();
const { getPlaywright } = require(path.join(root, 'dist/main/browser/PlaywrightRuntime.js'));
const runtime = getPlaywright();
const escape = (value) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
for (const engine of ['chromium', 'firefox', 'webkit']) {
  const launch = runtime[engine].launch.bind(runtime[engine]);
  runtime[engine].launch = async (options) => {
    const browser = await launch(options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (contextOptions) => {
      fixture.launchOptions.push({ engine, proxyServer: contextOptions.proxy?.server });
      const context = await newContext(contextOptions);
      fixture.contexts += 1;
      context.once('close', () => fixture.closedContexts += 1);
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === 'www.google.com' && url.pathname === '/search') {
          const query = url.searchParams.get('q') || '';
          fixture.requests.push({ query, at: Date.now(), engine });
          await gate;
          await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><main id="search"><a href="https://fixture.test/article/${encodeURIComponent(query)}"><h3>${escape(query)} article</h3></a><cite>fixture.test</cite></main></body></html>` });
          return;
        }
        if (url.hostname === 'fixture.test') {
          await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;color:#111;background:#fff}input{position:absolute;left:20px;top:40px;width:240px;height:35px}button{position:absolute;left:20px;top:110px;width:130px;height:40px}#out{position:absolute;left:20px;top:175px}article{padding-top:240px}</style></head><body><input id="field" aria-label="Fixture text"><button onclick="document.querySelector('#out').textContent=document.querySelector('#field').value">Apply text</button><div id="out"></div><article><h1>Keyword ${escape(decodeURIComponent(url.pathname.split('/').pop()))}</h1>${'<p>Fixture scrolling content.</p>'.repeat(70)}</article></body></html>` });
          return;
        }
        await route.abort();
      });
      return context;
    };
    return browser;
  };
}
const { WorkspaceManager } = require(path.join(root, 'dist/main/WorkspaceManager.js'));
fixture.inputs = [];
const input = WorkspaceManager.prototype.sendInput;
WorkspaceManager.prototype.sendInput = function (id, event) { fixture.inputs.push({ id, ...event }); return input.call(this, id, event); };
const run = WorkspaceManager.prototype.runSeoTracking;
WorkspaceManager.prototype.runSeoTracking = function (request) { fixture.manager = this; return run.call(this, request); };
require(path.join(root, 'dist/main/main.js'));
