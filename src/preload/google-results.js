'use strict';

// Shared by the sandboxed BrowserView preload and the main-process script
// builders. Keep these functions self-contained: sandboxed preloads cannot
// require application modules, and the same recognizer must handle every path.
function recognizeGoogleResults(targetHost, query = '') {
    function clean(text) {
        return String(text || '').normalize('NFKC')
            .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
            .replace(/\s+/g, ' ').trim();
    }
    function text(node) { return clean(node && (node.innerText || node.textContent)); }
    function host(value) {
        try {
            return new URL(/^[a-z]+:\/\//i.test(value) ? value : 'https://' + value)
                .hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
        } catch { return ''; }
    }
    const target = host(clean(targetHost));
    function matchesHost(value) {
        return Boolean(target && (value === target || value.endsWith('.' + target) ||
            (!target.includes('.') && value.split('.').includes(target))));
    }
    function google(value) { return /(^|\.)google\.[a-z.]+$/i.test(value); }
    function destination(value) {
        try {
            let url = new URL(value, location.href);
            for (let i = 0; i < 4 && google(url.hostname); i++) {
                // A search query is not a redirect URL. Only unwrap link routes.
                if (!/^\/(url|imgres|aclk)\/?$/.test(url.pathname)) break;
                const next = url.searchParams.get('url') || url.searchParams.get('q') ||
                    url.searchParams.get('adurl') || url.searchParams.get('imgurl');
                if (!next || !/^https?:\/\//i.test(next)) break;
                url = new URL(next);
            }
            return /^https?:$/.test(url.protocol) ? url : null;
        } catch { return null; }
    }
    function anchorDestination(anchor) {
        for (const attribute of ['href', 'data-href', 'data-url']) {
            const value = anchor.getAttribute(attribute);
            if (!value) continue;
            const url = destination(value);
            if (url && matchesHost(host(url.href))) return url;
        }
        return destination(anchor.getAttribute('href') || '');
    }
    function displayedHost(value) {
        // Preserve domain boundaries. Removing all punctuation would also
        // accept evil-example.com or example.com.attacker.test.
        const domains = clean(value).replace(/\s*\.\s*/g, '.')
            .match(/(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}\p{N}-]+\.?/gu) || [];
        return domains.some((domain) => matchesHost(host(domain)));
    }
    function words(value) {
        return clean(value).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    }
    const tokens = [...new Set(words(query))];
    function relevance(value) {
        const available = new Set(words(value));
        return tokens.length ? tokens.filter((token) => available.has(token)).length / tokens.length : 0;
    }
    const state = { blocked: false, observedResults: 0, signature: '', targetTextSeen: false, candidateText: '',
        documentParsed: document.readyState !== 'loading' };
    const blockedUrl = /\/sorry\/|^https?:\/\/consent\.google\./i.test(location.href);
    const challenge = document.querySelector('form[action*="/sorry/"], #captcha-form, iframe[src*="recaptcha"], .g-recaptcha');
    if (blockedUrl || challenge) { state.blocked = true; return { state, anchor: null }; }
    const root = document.querySelector('#rso') || document.querySelector('#search') ||
        document.querySelector('main') || document.body;
    if (!root || !target) return { state, anchor: null };

    const headingSelector = 'h3,h2,[role="heading"]';
    function rendered(node) {
        if (!node || !node.isConnected || !node.getClientRects().length) return false;
        const style = getComputedStyle(node);
        return style.visibility !== 'hidden' && style.display !== 'none';
    }
    function cardFor(anchor) {
        let card = anchor;
        // Associate a sibling citation/snippet with this title, without
        // climbing into the whole result list and borrowing another site's text.
        for (let current = anchor.parentElement, depth = 0;
            current && current !== root && depth < 9; current = current.parentElement, depth++) {
            const otherTitles = [...current.querySelectorAll(headingSelector)].filter((heading) => {
                const other = heading.closest('a[href],a[data-href],a[data-url]');
                return other && other !== anchor;
            });
            if (otherTitles.length) break;
            card = current;
            if (current.matches('.g,[data-snhf],article')) break;
        }
        return card;
    }
    function sponsored(card) {
        if (card.closest('#tads,#tadsb,#bottomads,[data-text-ad],[data-ad-slot]')) return true;
        return [...card.querySelectorAll('span,div')].some((node) => {
            if (node.children.length || !rendered(node)) return false;
            return /^(sponsored|ad|ads|advertisement)$/i.test(text(node));
        });
    }
    const records = [], seen = new Set();
    let winner = null;
    const anchors = [...root.querySelectorAll('a[href],a[data-href],a[data-url]')];
    for (const anchor of anchors) {
        if (!rendered(anchor)) continue;
        const heading = anchor.querySelector(headingSelector);
        const url = anchorDestination(anchor);
        const direct = url && matchesHost(host(url.href));
        // Most Google anchors are menus, tools or media controls. Do not walk
        // their ancestors or read their layout on every document mutation.
        if (!heading && !direct) continue;
        const card = cardFor(anchor);
        const citations = [...card.querySelectorAll('cite,[data-dtld]')];
        const citedTarget = citations.some((node) => rendered(node) && displayedHost(text(node) || node.getAttribute('data-dtld')));
        // Headingless mobile/accessible layouts still need a citation in the
        // same small card. A target-domain navigation/footer link is not a SERP.
        const citationTitle = !heading && !card.querySelector(headingSelector) && citations.length && text(anchor).length >= 8 &&
            !anchor.querySelector('cite') && !/^(cached|translate|more|next|previous)$/i.test(text(anchor));
        if (!heading && !citationTitle) continue;
        if (sponsored(card)) continue;
        const title = text(heading) || clean(anchor.getAttribute('aria-label')) || text(anchor);
        const key = url ? url.href.split('#')[0] : anchor.getAttribute('href');
        let organicIndex = records.findIndex((record) => record.key === key);
        if (organicIndex < 0) {
            organicIndex = records.length;
            records.push({ key, title });
        }
        if (direct || citedTarget) {
            state.targetTextSeen = true;
            state.candidateText = title;
        }
        // Visible domain text corroborates a URL; it never grants permission to
        // click a different host, an ad, a JavaScript URL or an opaque redirect.
        if (!direct || !url || google(url.hostname) || seen.has(key)) continue;
        seen.add(key);
        const score = (heading ? 100 : 0) + relevance(title) * 100 +
            relevance(text(card)) * 20 + (citedTarget ? 10 : 0);
        if (!winner || score > winner.score) winner = { anchor, url: url.href, title, organicIndex, score };
    }
    state.observedResults = records.length;
    state.signature = records.slice(0, 40).map((record) => record.key + '|' + record.title).join('||');
    if (winner) {
        // Scroll before calculating native coordinates. Results below the fold
        // can be recognized immediately and must not receive off-screen clicks.
        winner.anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        const rect = winner.anchor.getBoundingClientRect();
        const x = Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2));
        const hit = document.elementFromPoint(x, y);
        state.match = { url: winner.url, title: winner.title, organicIndex: winner.organicIndex,
            clickPoint: hit && winner.anchor.contains(hit) ? { x, y } : undefined };
    }
    return { state, anchor: winner && winner.anchor };
}

function installGoogleResultObserver(target, query = '', publish = () => {}) {
    window.__domGoogleWatcher?.stop();
    let stopped = false, scheduled = null, heartbeat = null, matchedAnchor = null, fingerprint = '';
    const watcher = { state: null, key: target + '|' + query, click, stop, scan };
    function scan() {
        scheduled = null;
        if (stopped || watcher.state?.match) return;
        const result = recognizeGoogleResults(target, query);
        watcher.state = result.state;
        matchedAnchor = result.anchor;
        const next = JSON.stringify(watcher.state);
        if (next !== fingerprint) { fingerprint = next; publish(watcher.state); }
        if (result.state.match || result.state.blocked) {
            observer.disconnect();
            clearInterval(heartbeat);
        }
    }
    function schedule() {
        if (!stopped && !scheduled && !watcher.state?.match) scheduled = setTimeout(scan, 60);
    }
    function click() {
        if (stopped || !matchedAnchor?.isConnected || !watcher.state?.match) return false;
        matchedAnchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        matchedAnchor.target = '_self';
        matchedAnchor.focus({ preventScroll: true });
        matchedAnchor.click();
        return true;
    }
    function stop() {
        stopped = true;
        observer.disconnect();
        clearTimeout(scheduled);
        clearInterval(heartbeat);
        document.removeEventListener('readystatechange', schedule);
    }
    const observer = new MutationObserver(schedule);
    // Observe document itself so this also works before <html>/<body> exist.
    observer.observe(document, { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['href', 'data-href', 'data-url', 'class', 'style', 'hidden'] });
    heartbeat = setInterval(schedule, 500);
    document.addEventListener('readystatechange', schedule);
    window.__domGoogleWatcher = watcher;
    scan();
    return watcher;
}

if (typeof process !== 'undefined' && process.type === 'renderer') {
    const { ipcRenderer } = require('electron');
    let active = null;
    ipcRenderer.on('dom:google-config', (_event, config) => {
        window.__domGoogleWatcher?.stop();
        active = config;
        if (!config) return;
        const current = new URL(location.href);
        if (!/(^|\.)google\.[a-z.]+$/i.test(current.hostname) || current.pathname !== '/search' ||
            current.searchParams.get('q') !== config.query ||
            (current.searchParams.get('start') || '0') !== config.start) return;
        installGoogleResultObserver(config.target, config.query, (state) => {
            ipcRenderer.send('dom:google-state', { navigation: config.navigation, token: config.token,
                documentUrl: location.href, state });
        });
    });
    ipcRenderer.on('dom:google-click', (_event, navigation) => {
        if (active?.navigation === navigation) window.__domGoogleWatcher?.click();
    });
    addEventListener('pagehide', () => window.__domGoogleWatcher?.stop(), { once: true });
    // This handshake runs at document start, before DOMContentLoaded or load.
    ipcRenderer.send('dom:google-preload-ready');
} else if (typeof module !== 'undefined') {
    module.exports = { recognizeGoogleResults, installGoogleResultObserver };
}
