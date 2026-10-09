const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { parseProxyLine, parseProxyText } = require(path.join(root, 'dist/proxy/ProxyParser.js'));
const { assignProxies } = require(path.join(root, 'dist/proxy/ProxyAssigner.js'));
const { parseSavedUrlPool, distributeSavedUrls } = require(path.join(root, 'dist/shared/urlPool.js'));
const { parseBrowserSelection, formatBrowserSelection } = require(path.join(root, 'dist/shared/browserSelection.js'));
const { mapLiveViewPoint, composePlaywrightShortcut } = require(path.join(root, 'dist/shared/liveView.js'));
const {
  buildGoogleSearchUrl,
  normalizeTargetHost,
  hostMatchesTarget,
  unwrapGoogleResultUrl,
  isRootPage,
  waitForTargetLanding
} = require(path.join(root, 'dist/main/seo/SeoTracker.js'));

(async () => {
  // Proxy parsing, including authenticated gateway formats used by residential providers.
  assert.deepEqual(
    { ...parseProxyLine('http://1.2.3.4:8080'), id: undefined, source: undefined },
    { id: undefined, host: '1.2.3.4', port: 8080, protocol: 'http', username: undefined, password: undefined, source: undefined, status: 'unverified' }
  );
  const auth = parseProxyLine('http://user:pass@1.2.3.4:8080');
  assert.equal(auth.username, 'user');
  assert.equal(auth.password, 'pass');
  assert.equal(parseProxyLine('socks5://1.2.3.4:1080').protocol, 'socks5');

  const gateway = parseProxyLine('demo_user:demo_password@gw.dataimpulse.com:824');
  assert.equal(gateway.protocol, 'http');
  assert.equal(gateway.host, 'gw.dataimpulse.com');
  assert.equal(gateway.port, 824);
  assert.equal(gateway.username, 'demo_user');
  assert.equal(gateway.password, 'demo_password');

  const complexPassword = parseProxyLine('user:pa:ss@word@gateway.example.com:9000');
  assert.equal(complexPassword.username, 'user');
  assert.equal(complexPassword.password, 'pa:ss@word');
  assert.equal(complexPassword.host, 'gateway.example.com');

  const imported = parseProxyText('garbage\nhttp://1.2.3.4:8080\nhttp://1.2.3.4:8080');
  assert.equal(imported.proxies.length, 1);
  assert.equal(imported.errors.length, 1);
  assert.equal(imported.duplicates, 1);

  const makeProxies = (count) => Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    host: `10.${Math.floor(index / 250)}.${Math.floor(index / 50) % 250}.${(index % 50) + 1}`,
    port: 8000 + index,
    protocol: 'http',
    source: 'smoke',
    status: 'unverified'
  }));

  let assignments = assignProxies(makeProxies(10), 10, false);
  assert.equal(assignments.filter((item) => item.proxyId).length, 10);
  assert.equal(new Set(assignments.map((item) => item.proxyId)).size, 10);
  assignments = assignProxies(makeProxies(6), 10, false);
  assert.equal(assignments.filter((item) => item.proxyId).length, 6);
  assert.equal(assignments.filter((item) => !item.proxyId).length, 4);
  assert.equal(assignProxies([], 10, false).every((item) => !item.proxyId), true);
  assignments = assignProxies(makeProxies(2), 10, true);
  assert.equal(assignments.filter((item) => item.proxyId).length, 2);
  assert.equal(new Set(assignments.map((item) => item.proxyId).filter(Boolean)).size, 2);
  const deadPool = makeProxies(2);
  deadPool[0].status = 'dead';
  assert.equal(assignProxies(deadPool, 10, false).filter((item) => item.proxyId).length, 1);
  assert.equal(assignProxies(deadPool, 10, false, true).filter((item) => item.proxyId).length, 2);
  assignments = assignProxies(makeProxies(100), 100, false);
  assert.equal(assignments.length, 100);
  assert.equal(new Set(assignments.map((item) => item.proxyId)).size, 100);

  const browserIds = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.deepEqual(parseBrowserSelection('1-5,8,10', browserIds), [1, 2, 3, 4, 5, 8, 10]);
  assert.deepEqual(parseBrowserSelection('5-3,4,3', browserIds), [3, 4, 5]);
  assert.deepEqual(parseBrowserSelection('1,20,21,99', browserIds), [1, 20]);
  assert.equal(formatBrowserSelection([1, 2, 3, 6, 8, 9, 10]), '1-3,6,8-10');

  const urls = parseSavedUrlPool('example.com/a\nhttps://example.org/b\nexample.com/a');
  assert.deepEqual(urls, ['https://example.com/a', 'https://example.org/b']);
  let distributed = distributeSavedUrls([1, 2, 3, 4, 5], ['https://a.test/', 'https://b.test/'], () => 0);
  assert.equal(distributed.length, 5);
  assert.equal(new Set(distributed.map((item) => item.id)).size, 5);
  const counts = Object.values(distributed.reduce((acc, item) => {
    acc[item.url] = (acc[item.url] ?? 0) + 1;
    return acc;
  }, {})).sort();
  assert.deepEqual(counts, [2, 3]);
  distributed = distributeSavedUrls([1, 2], ['https://a.test/', 'https://b.test/', 'https://c.test/'], () => 0.5);
  assert.equal(distributed.length, 2);
  assert.equal(new Set(distributed.map((item) => item.url)).size, 2);

  let point = mapLiveViewPoint(195, 422, { left: 0, top: 0, width: 390, height: 844 });
  assert.ok(point);
  assert.ok(Math.abs(point.x - 195) < 0.01 && Math.abs(point.y - 422) < 0.01);
  point = mapLiveViewPoint(300, 177.5, { left: 0, top: 0, width: 600, height: 355 });
  assert.ok(point);
  assert.ok(Math.abs(point.x - 195) < 0.2 && Math.abs(point.y - 422) < 0.2);
  assert.equal(mapLiveViewPoint(10, 177.5, { left: 0, top: 0, width: 600, height: 355 }), undefined);
  assert.equal(composePlaywrightShortcut('a', { ctrl: true }), 'Control+a');
  assert.equal(composePlaywrightShortcut('ArrowLeft', { ctrl: true, shift: true }), 'Control+Shift+ArrowLeft');

  assert.equal(normalizeTargetHost('Example.com'), 'example.com');
  assert.equal(normalizeTargetHost('https://www.example.com/articles/one'), 'example.com');
  assert.equal(hostMatchesTarget('https://example.com/article', 'example.com'), true);
  assert.equal(hostMatchesTarget('https://blog.example.com/article', 'example.com'), true);
  assert.equal(hostMatchesTarget('https://example.com.evil.test/article', 'example.com'), false);
  assert.equal(hostMatchesTarget('https://notexample.com/article', 'example.com'), false);
  assert.equal(unwrapGoogleResultUrl('https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Farticle&sa=U'), 'https://example.com/article');
  assert.equal(unwrapGoogleResultUrl('https://www.google.com/url?url=https%3A%2F%2Fblog.example.com%2Fdeep-dive'), 'https://blog.example.com/deep-dive');
  assert.equal(unwrapGoogleResultUrl('https://www.google.com/url?url=https%253A%252F%252Fexample.com%252Fdouble-encoded'), 'https://example.com/double-encoded');
  assert.equal(isRootPage('https://appareldiary.com/'), true);
  assert.equal(isRootPage('https://appareldiary.com'), true);
  assert.equal(isRootPage('https://appareldiary.com/rmg-cutting-process'), false);
  assert.equal(buildGoogleSearchUrl('garment sourcing Bangladesh', 0).includes('q=garment+sourcing+Bangladesh'), true);
  assert.equal(buildGoogleSearchUrl('garment sourcing Bangladesh', 1).includes('start=10'), true);
  assert.equal(buildGoogleSearchUrl('garment sourcing Bangladesh', 4).includes('start=40'), true);

  const landingUrls = [
    'https://www.google.com/search?q=rmg+cutting',
    'https://appareldiary.com/',
    'https://appareldiary.com/rmg-cutting-process-a-stage-by-stage-control-guide'
  ];
  let landingIndex = 0;
  const landingPage = {
    url: () => landingUrls[Math.min(landingIndex++, landingUrls.length - 1)],
    isClosed: () => false,
    goto: async () => undefined,
    evaluate: async () => undefined
  };
  const landed = await waitForTargetLanding(landingPage, 'appareldiary.com', undefined, 1200);
  assert.equal(landed, 'https://appareldiary.com/rmg-cutting-process-a-stage-by-stage-control-guide');

  let current = 'https://www.google.com/search?q=rmg+cutting';
  const hintedPage = {
    url: () => current,
    isClosed: () => false,
    goto: async (url) => { current = url; },
    evaluate: async () => undefined
  };
  const hinted = await waitForTargetLanding(
    hintedPage,
    'appareldiary.com',
    'https://appareldiary.com/rmg-cutting-process-a-stage-by-stage-control-guide',
    50
  );
  assert.equal(hinted, 'https://appareldiary.com/rmg-cutting-process-a-stage-by-stage-control-guide');

  console.log('ProxyDesk final smoke checks: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
