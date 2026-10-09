const assert = require('node:assert/strict');
const { chromium, firefox, webkit } = require('playwright');

const TIMEOUT_MS = 25_000;
function bounded(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    })
  ]).finally(() => clearTimeout(timer));
}

async function checkEngine(name, browserType) {
  let browser;
  try {
    browser = await bounded(browserType.launch({ headless: true }), `${name} launch`);
    const context = await bounded(browser.newContext({ viewport: { width: 390, height: 844 } }), `${name} context`);
    const page = await bounded(context.newPage(), `${name} page`);
    await bounded(page.setContent(`<!doctype html><html><body>
      <input id="field" aria-label="field"><button id="go" onclick="document.querySelector('#out').textContent=document.querySelector('#field').value">Go</button>
      <div id="out"></div><div style="height:1400px"></div>
    </body></html>`), `${name} content`);
    await page.locator('#field').click();
    await page.keyboard.type('ProxyDesk SEO');
    await page.locator('#go').click();
    assert.equal(await page.locator('#out').textContent(), 'ProxyDesk SEO');
    await page.mouse.wheel(0, 500);
    const image = await bounded(page.screenshot({ type: 'jpeg', quality: 45, scale: 'css' }), `${name} screenshot`);
    assert.ok(image.length > 100, `${name} screenshot should contain image data`);
    await bounded(context.close(), `${name} context close`);
    console.log(`${name}: PASS`);
  } finally {
    if (browser) await bounded(browser.close(), `${name} browser close`).catch(() => undefined);
  }
}

(async () => {
  await checkEngine('Chromium', chromium);
  await checkEngine('Firefox', firefox);
  await checkEngine('WebKit', webkit);
  console.log('Bundled Playwright browser runtime smoke: PASS');
})().catch((error) => {
  console.error('Bundled Playwright browser runtime smoke: FAIL');
  console.error(error);
  process.exitCode = 1;
});
