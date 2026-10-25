'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/preload/google-results.js'), 'utf8');

function fixture(label, text, hostname = 'research.example', containerId = 'cookie-banner') {
    const scope = { id: containerId, className: '', innerText: text, textContent: text };
    let clicked = 0;
    const button = {
        innerText: label, textContent: label, isConnected: true, parentElement: scope,
        disabled: false, getAttribute: () => null, matches: () => false,
        closest: selector => selector === '[hidden],[inert]' ? null : scope,
        getClientRects: () => [{ width: 100, height: 30 }],
        getBoundingClientRect: () => ({ left: 100, right: 200, top: 120, bottom: 150 }),
        focus() {}, scrollIntoView() {}, click() { clicked++; }
    };
    const document = {
        body: { id: 'body' }, querySelectorAll: () => [button],
        addEventListener() {}, removeEventListener() {}
    };
    const timers = new Set();
    const context = {
        process: { type: 'test' }, module: { exports: {} },
        document, window: {}, location: { protocol: 'https:', hostname },
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' }),
        MutationObserver: class { observe() {} disconnect() {} },
        performance: { now: () => 10_000, timeOrigin: 1 }, innerWidth: 940, innerHeight: 650,
        setTimeout: () => 1, clearTimeout() {},
        setInterval(fn) { timers.add(fn); return fn; }, clearInterval(fn) { timers.delete(fn); }
    };
    vm.runInNewContext(source, context, { filename: 'google-results.js' });
    return { ...context.module.exports, button, get clicked() { return clicked; }, window: context.window, timers };
}

test('only visible explicit cookie-consent choices are accepted', () => {
    const cookie = fixture('Accept all', 'We use cookies to improve your experience.');
    assert.equal(cookie.inspectSiteCookieConsent(), cookie.button);
    cookie.installSiteCookieConsentObserver();
    assert.equal(cookie.clicked, 1);
    cookie.window.__domSiteCookieConsentWatcher.stop();
    assert.equal(cookie.timers.size, 0);
});

test('generic Accept outside cookie context and unrelated Continue are ignored', () => {
    for (const [label, copy] of [
        ['Accept', 'Read our terms of service before registering.'],
        ['Continue', 'We use cookies.'],
        ['Reject all', 'We use cookies.'],
        ['Subscribe', 'Cookie settings']
    ]) {
        const current = fixture(label, copy, 'research.example', 'normal-dialog');
        assert.equal(current.inspectSiteCookieConsent(), null, label + ' must not be clicked');
        current.installSiteCookieConsentObserver();
        assert.equal(current.clicked, 0, label + ' was activated');
        current.window.__domSiteCookieConsentWatcher.stop();
    }
});

test('cookie consent supports localized acceptance and native click coordinates', () => {
    const cookie = fixture('Alle akzeptieren', 'Cookies und Datenschutz');
    const events = [];
    cookie.installSiteCookieConsentObserver(event => events.push(JSON.parse(JSON.stringify(event))));
    assert.deepEqual(events, [{ point: { x: 150, y: 135 } }]);
    assert.equal(cookie.clicked, 0, 'native mode must use the host, not a script click');
    cookie.window.__domSiteCookieConsentWatcher.stop();
});

test('Google consent stays owned by its specialized native handler', () => {
    const cookie = fixture('Accept all', 'We use cookies.', 'www.google.com');
    assert.equal(cookie.inspectSiteCookieConsent(), null);
    cookie.installSiteCookieConsentObserver();
    assert.equal(cookie.clicked, 0);
    cookie.window.__domSiteCookieConsentWatcher.stop();
});
