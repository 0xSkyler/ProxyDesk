'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTree } = require('./helpers.cjs');
const root = path.resolve(__dirname, '../src');

function data() {
    return [
        { protocol: 'http', ip: '192.0.2.11', port: 8011, country_code: 'US', country: 'United States' },
        { protocol: 'socks5', ip: '192.0.2.12', port: 1080, country_code: 'DE', country: 'Germany' },
        { protocol: 'socks4', ip: '192.0.2.21', port: 1080, country_code: 'PL', country: 'Poland' },
        { protocol: 'http', ip: '192.0.2.22', port: 8022, country_code: 'ZA', country: 'South Africa' },
        { protocol: 'http', ip: '192.0.2.31', port: 8031, country_code: 'BD', country: 'Bangladesh' },
        { protocol: 'http', ip: '192.0.2.32', port: 8032, country_code: 'NG', country: 'Nigeria' },
        { protocol: 'http', ip: '192.0.2.33', port: 8033, country_code: 'IN', country: 'India' },
        { protocol: 'http', ip: '192.0.2.99', port: 8099 }, // No country metadata: Tier 3.
        { protocol: 'http', ip: '192.0.2.34', port: 8034, country_code: 'ZZ' }, // Unknown label: Tier 3.
        { protocol: 'http', ip: '192.0.2.11', port: 8011, country_code: 'US' } // Duplicate address.
    ];
}

test('Tier 1 and 2 are fixed and Tier 3 contains all remaining countries', () => {
    const { PROXY_TIERS, resolveProxyTier, matchesProxyTier } = loadTree(root, {})('proxy/ProxyTiers.js');
    assert.deepEqual(Object.keys(PROXY_TIERS), ['tier1','tier2','tier3']);
    assert.deepEqual(Object.values(PROXY_TIERS).map(v => Object.keys(v.countries).length), [25,22,26]);
    const total = Object.values(PROXY_TIERS).flatMap(v => Object.keys(v.countries));
    assert.equal(new Set(total).size, 73, 'countries may not appear in multiple tiers');
    assert.equal(resolveProxyTier(), 'tier1');
    assert.equal(resolveProxyTier('tier2'), 'tier2');
    assert.throws(() => resolveProxyTier('tier4'), /Unknown proxy tier/);
    assert.equal(matchesProxyTier('US', 'tier1'), true);
    assert.equal(matchesProxyTier('BD', 'tier3'), true);
    assert.equal(matchesProxyTier('NG', 'tier1'), false);
    assert.equal(matchesProxyTier('', 'tier2'), false);
    assert.equal(matchesProxyTier('US', 'tier3'), false);
    assert.equal(matchesProxyTier('PL', 'tier3'), false);
    assert.equal(matchesProxyTier('BD', 'tier3'), true);
    assert.equal(matchesProxyTier('IS', 'tier3'), true); // Iceland was never listed.
    assert.equal(matchesProxyTier('ZZ', 'tier3'), true); // Unknown provider country label.
    assert.equal(matchesProxyTier('', 'tier3'), true); // Missing provider country label.
});

test('country JSON classification uses provider metadata without independent geolocation', () => {
    const { parseGeoProxyFeed, matchesProxyTier } = loadTree(root, {})('proxy/ProxyTiers.js');
    const feed = JSON.stringify({ data: { proxies: data() } });
    const parsed = parseGeoProxyFeed(feed, 'fixture');
    assert.equal(parsed.totalRecords, 10);
    assert.equal(parsed.proxies.length, 10, 'all valid records, including unknown country, remain available');
    assert.equal(parsed.proxies.filter(p => matchesProxyTier(p.countryCode, 'tier1')).length, 3);
    assert.equal(parsed.proxies.filter(p => matchesProxyTier(p.countryCode, 'tier2')).length, 2);
    assert.equal(parsed.proxies.filter(p => matchesProxyTier(p.countryCode, 'tier3')).length, 5);
    assert.ok(parsed.proxies.every(p => p.countryVerified === false));
    const byName = parseGeoProxyFeed(JSON.stringify([
        { protocol: 'http', ip: '192.0.2.80', port: 8180, country: 'South Korea' },
        { protocol: 'http', ip: '192.0.2.81', port: 8181, country: 'PH' }
    ]), 'fixture').proxies;
    assert.deepEqual(Array.from(byName, p => p.countryCode), ['KR', 'PH']);
    assert.throws(() => parseGeoProxyFeed('http://192.0.2.1:8080', 'text-only'), /country-labeled JSON/);
});

test('each tier directly assigns only matching proxies with zero preflight requests', async () => {
    const { ProxyManager } = loadTree(root, {}, {
        fetch: async url => {
            calls.push(String(url));
            return { ok: true, text: async () => JSON.stringify(data()) };
        }
    })('main/ProxyManager.js');
    const calls = [];
    for (const [tier, expected] of [
        ['tier1', ['US', 'DE']],
        ['tier2', ['PL', 'ZA']],
        ['tier3', ['BD', 'NG', 'IN', '', 'ZZ']]
    ]) {
        const manager = new ProxyManager(), assigned = [];
        const summary = await manager.fetchAssignDirect([1, 2, 3, 4, 5, 6], a => assigned.push(a), undefined,
            { source: 'proxyscrape-free', tier });
        assert.equal(summary.tier, tier);
        assert.deepEqual(assigned.map(a => a.proxy.countryCode), expected);
        assert.equal(summary.countryMatched, tier === 'tier1' ? 3 : expected.length);
        assert.equal(summary.assignments[expected.length]?.proxy ?? null, null);
        assert.equal(calls.length, ['tier1','tier2','tier3'].indexOf(tier) + 1, 'one provider request per tier, no proxy probes');
        assert.equal(new URL(calls.at(-1)).searchParams.get('format'), 'json', 'API request asks for country-labeled records');
        assert.ok(assigned.every(a => a.proxy.countryVerified === false));
    }
});

test('missing country metadata is excluded from Tier 1/2 but included in Tier 3', async () => {
    const noCountry = JSON.stringify([{ protocol: 'http', ip: '192.0.2.1', port: 8080 }]);
    const { ProxyManager } = loadTree(root, {}, {
        fetch: async () => ({ ok: true, text: async () => noCountry })
    })('main/ProxyManager.js');
    const manager = new ProxyManager(), assigned = [];
    for (const tier of ['tier1', 'tier2']) {
        await assert.rejects(manager.fetchAssignDirect([1], a => assigned.push(a), undefined,
            { source: 'proxyscrape-free', tier }), /no assignable entries/);
        assert.equal(assigned.length, 0);
    }
    const summary = await manager.fetchAssignDirect([1], a => assigned.push(a), undefined,
        { source: 'proxyscrape-free', tier: 'tier3' });
    assert.equal(summary.countryMatched, 1);
    assert.equal(assigned[0].proxy.countryCode, '');
    assert.equal(assigned[0].proxy.countryVerified, false);
});

test('text-only All Working source works in Tier 3 as unclassified leftovers', async () => {
    const { ProxyManager } = loadTree(root, {}, {
        fetch: async () => ({ ok: true, text: async () => 'http://192.0.2.1:8080' })
    })('main/ProxyManager.js');
    const manager = new ProxyManager(), selected = [];
    for (const tier of ['tier1', 'tier2']) {
        await assert.rejects(manager.fetchAssignDirect([1], a => selected.push(a), undefined,
            { source: 'all-working', tier }), /country-labeled JSON/);
    }
    assert.equal(selected.length, 0);
    const tier3 = await manager.fetchAssignDirect([1], a => selected.push(a), undefined,
        { source: 'all-working', tier: 'tier3' });
    assert.equal(tier3.countryMatched, 1);
    assert.equal(selected[0].proxy.countryCode, '');
    assert.equal(selected[0].proxy.countryVerified, false);
    const legacy = await manager.fetchAssignDirect([1], a => selected.push(a), undefined,
        { source: 'all-working' });
    assert.equal(legacy.assignments.length, 1);
    assert.equal(selected.length, 2);
});

test('retained assignments cannot escape a newly selected tier', async () => {
    const { ProxyManager } = loadTree(root, {}, {
        fetch: async () => ({ ok: true, text: async () => JSON.stringify(data()) })
    })('main/ProxyManager.js');
    const manager = new ProxyManager(), assigned = [];
    const retained = [{ browserId: 1, proxy: { id:'old', host:'192.0.2.44', port:8080, countryCode:'BD' } }];
    const summary = await manager.fetchAssignDirect([2], a => assigned.push(a), undefined, {
        source: 'proxyscrape-free', tier: 'tier1', retainedAssignments: retained
    });
    assert.equal(manager.getAssignment(1), null);
    assert.equal(assigned[0].proxy.countryCode, 'US');
    assert.equal(summary.assignments.length, 1);
});

test('UI has exactly three country tiers and passes the selected tier to automation', () => {
    const ui = fs.readFileSync(path.join(root, 'renderer/provider-controls.js'), 'utf8');
    const metadata = JSON.stringify(['tier1','tier2','tier3']);
    assert.ok(ui.includes('data-dom-proxy-tier') || ui.includes('domProxyTier'));
    assert.ok(ui.includes("tier: tierSelect.value"));
    assert.ok(ui.includes('All remaining / unknown countries'));
    for (const tier of JSON.parse(metadata)) assert.ok(ui.includes(tier));
});

test('automation manager carries the user choice into the source request', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    let requested = null;
    const browser = {
        getProxyRotationState: () => ({ proxy: null }),
        prepareCycleDocument: async () => {},
        cancelMeasurementSession() {}, setBrowserKeepAlive() {},
        assignProxy: async () => {}, startMeasurementSession: () => 1
    };
    const proxyManager = {
        fetchAssignDirect: async (_ids, _onAssignment, _progress, options) => { requested = options; }
    };
    const automation = new SeoAutomationManager(proxyManager, browser, async () => []);
    const state = automation.configureProxy({source:'proxyscrape-free', tier:'tier3'});
    assert.equal(state.proxyTier, 'tier3');
    automation.state = { ...automation.state, running:true, cycleNumber:0, browserIds:[1],
        query:'fabric gsm', targetWebsite:'fixture.test' };
    await automation.runCycle();
    assert.equal(requested.tier,'tier3');
    assert.equal(automation.getState().proxyTier,'tier3');
});

test('tier selection retains proven successful proxies and only replaces unsuccessful or out-of-tier slots', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const events = [], requests = [];
    const existing = new Map([
        [1, { proxy: { id:'old-1', host:'192.0.2.11', port:8080, countryCode:'PL' },
            targetOpened:true, captchaSeen:false, failed:false }],
        [2, { proxy: { id:'old-2', host:'192.0.2.12', port:8080, countryCode:'PL' },
            targetOpened:false, captchaSeen:false, failed:false }],
        [3, { proxy: { id:'old-3', host:'192.0.2.13', port:8080, countryCode:'US' },
            targetOpened:true, captchaSeen:false, failed:false }]
    ]);
    const browser = {
        getProxyRotationState: id => existing.get(id),
        beginProxyCycle: id => events.push(['retain', id]),
        cancelMeasurementSession() {}, setBrowserKeepAlive() {}, prepareCycleDocument: async () => {},
        assignProxy: async (id, proxy) => events.push(['assign', id, proxy?.id || null]),
        startMeasurementSession: () => 1
    };
    const proxyManager = {
        fetchAssignDirect: async (ids, assign, _progress, options) => {
            requests.push({ ids: [...ids], options });
            ids.forEach(id => assign({ browserId:id,
                proxy: { id:'new-' + id, host:'192.0.2.' + (70 + id), port:8080, countryCode:'PL' } }));
        }
    };
    const automation = new SeoAutomationManager(proxyManager, browser, async () => []);
    automation.configureProxy({ source:'proxyscrape-free', tier:'tier2' });
    automation.state = { ...automation.state, running:true, cycleNumber:1, browserIds:[1,2,3],
        query:'example topic', targetWebsite:'fixture.test' };
    automation.monitorBrowserSession = async () => {};
    await automation.runCycle();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.tier, 'tier2');
    assert.deepEqual(requests[0].ids, [2,3], 'only unsuccessful/out-of-tier slots get new proxies');
    assert.deepEqual(requests[0].options.retainedAssignments.map(a => a.browserId), [1]);
    assert.deepEqual(requests[0].options.failedProxies.map(p => p.id), ['old-2'],
        'an out-of-tier address is not treated as an in-tier failed candidate');
    assert.deepEqual(events, [
        ['assign', 2, null], ['assign', 3, null],
        ['retain', 1], ['assign', 2, 'new-2'], ['assign', 3, 'new-3']
    ]);
    assert.equal(automation.getState().retainedBrowsers, 1);
    assert.equal(automation.getState().replacedBrowsers, 0, 'test provider did not publish progress');
    assert.equal(automation.getState().lastError, undefined);
});

test('an all-successful tier cycle retains proxies without fetching new ones', async () => {
    const { SeoAutomationManager } = loadTree(root, {})('main/SeoAutomationManager.js');
    const events = [];
    const browser = {
        getProxyRotationState: id => ({ proxy: { id:'retained-'+id,
            host:'192.0.2.'+id, port:8080, countryCode:'BD' },
            targetOpened:true, captchaSeen:false, failed:false }),
        beginProxyCycle: id => events.push(['retain',id]),
        cancelMeasurementSession() {}, setBrowserKeepAlive() {}, prepareCycleDocument: async () => {},
        assignProxy: async () => { throw new Error('successful proxy routing must remain unchanged'); },
        startMeasurementSession: () => 1
    };
    const provider = { fetchAssignDirect: async () => {
        throw new Error('no API fetch is necessary for fully retained browsers');
    } };
    const automation = new SeoAutomationManager(provider, browser, async () => []);
    automation.configureProxy({ source:'proxyscrape-free', tier:'tier3' });
    automation.state = { ...automation.state, running:true, cycleNumber:1, browserIds:[1,2],
        query:'first,second', targetWebsite:'fixture.test' };
    automation.monitorBrowserSession = async () => {};
    await automation.runCycle();
    assert.deepEqual(events, [['retain',1], ['retain',2]]);
    assert.equal(automation.getState().retainedBrowsers, 2);
    assert.equal(automation.getState().lastError, undefined);
});
