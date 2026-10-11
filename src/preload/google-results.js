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
    function google(value) { return /(^|\.)google\.(?:[a-z]{2,3}|(?:co|com)\.[a-z]{2})$/i.test(value); }
    function decodeDestination(value) {
        let decoded = clean(value);
        // Decode wrappers, without changing escapes in an already valid URL.
        for (let i = 0; i < 3 && /^(?:https?%|%2f%2f)/i.test(decoded); i++) {
            try { decoded = decodeURIComponent(decoded); } catch { break; }
        }
        return decoded;
    }
    function destination(value) {
        try {
            let url = new URL(decodeDestination(value), location.href);
            for (let i = 0; i < 4 && google(url.hostname); i++) {
                if (/^\/amp\/(?:s\/)?[^/]+\./.test(url.pathname)) {
                    const secure = url.pathname.startsWith('/amp/s/');
                    url = new URL((secure ? 'https://' : 'http://') + url.pathname.slice(secure ? 7 : 5) + url.search);
                    continue;
                }
                // A search query is not a redirect URL. Only unwrap link routes.
                if (!/^\/(url|imgres|aclk|interstitial|local_url)\/?$/.test(url.pathname)) break;
                const next = url.searchParams.get('url') || url.searchParams.get('q') ||
                    url.searchParams.get('adurl') || url.searchParams.get('imgurl');
                const decoded = decodeDestination(next);
                if (!/^(?:https?:)?\/\//i.test(decoded)) break;
                url = new URL(decoded, url.href);
            }
            return /^https?:$/.test(url.protocol) ? url : null;
        } catch { return null; }
    }
    function anchorDestination(anchor) {
        for (const attribute of ['href', 'data-href', 'data-url', 'data-rw', 'data-pcu', 'data-amp-cur']) {
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
        documentParsed: document.readyState !== 'loading', nextPage: false, paginationRendered: false, pendingResults: false };
    const blockedUrl = /\/sorry\/|^https?:\/\/consent\.google\./i.test(location.href);
    const challenge = document.querySelector('form[action*="/sorry/"], #captcha-form, iframe[src*="recaptcha"], .g-recaptcha');
    if (blockedUrl || challenge) { state.blocked = true; return { state, anchor: null }; }
    const rootSelector = '#search,#rso,main,[role="main"]';
    const allRoots = [...document.querySelectorAll(rootSelector)];
    const roots = allRoots.filter((node) => !allRoots.some((other) => other !== node && other.contains(node)));
    if (!roots.length && document.body) roots.push(document.body);
    if (!roots.length || !target) return { state, anchor: null };

    const headingSelector = 'h3,h2,h1,[role="heading"],.LC20lb,.DKV0Md';
    const linkSelector = 'a[href],a[data-href],a[data-url],a[data-rw],a[data-pcu],a[data-amp-cur],[role="link"]';
    const outsideResults = 'nav,header,footer,[role="navigation"],[role="menu"],[role="menubar"],[role="dialog"]';
    function rendered(node) {
        // aria-hidden changes screen-reader exposure, not visual rendering.
        // Google can mark an otherwise visible title as an accessibility copy.
        if (!node || !node.isConnected || node.closest('[hidden]')) return false;
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
        if ([...node.getClientRects()].some((rect) => rect.width && rect.height)) {
            return typeof node.checkVisibility !== 'function' || node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        }
        // display:contents has no box of its own, but its title remains visible.
        if (style.display !== 'contents') return false;
        if ([...node.children].some(rendered)) return true;
        const range = document.createRange(); range.selectNodeContents(node);
        return [...range.getClientRects()].some((rect) => rect.width && rect.height);
    }
    function headingLink(heading) {
        return heading.closest(linkSelector) || heading.querySelector(linkSelector);
    }
    const citationSelector = 'cite,[data-dtld],.VuuXrf,.tjvcx,.qLRx3b,span,div';
    function targetCitation(node) {
        const value = clean(node.getAttribute('data-dtld') || node.textContent);
        if (!value || value.length > 320 || !displayedHost(value)) return false;
        if (!node.matches('cite,[data-dtld],.VuuXrf,.tjvcx,.qLRx3b')) {
            // Ordinary URL labels must not be mentions inside snippets.
            if (node.closest('p') || node.querySelector(headingSelector + ',p') ||
                !/^(?:https?:\/\/|\/\/)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?:\/?(?:\s*[›»>|]|\s*$)|\/\S*)/u.test(value)) return false;
        }
        return rendered(node);
    }
    function hasTargetCitation(card) {
        return [...card.querySelectorAll(citationSelector)].some(targetCitation);
    }
    function cardFor(anchor, ownedHeading) {
        let card = anchor;
        // Associate a sibling citation/snippet with this title, without
        // climbing into the whole result list and borrowing another site's text.
        for (let current = anchor.parentElement, depth = 0;
            current && !current.matches(rootSelector) && depth < 9; current = current.parentElement, depth++) {
            const titles = [...current.querySelectorAll(headingSelector)];
            if (current.matches(headingSelector)) titles.push(current);
            const otherTitles = titles.filter((heading) => {
                if (heading === ownedHeading) return false;
                const other = headingLink(heading);
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
    const anchors = [...new Set(roots.flatMap((root) => [...root.querySelectorAll(linkSelector)]))];
    // Google can render result modules beside its named search containers.
    // Supplement roots with target URLs or publisher-corroborated headings.
    const primary = new Set(anchors);
    for (const anchor of document.querySelectorAll(linkSelector)) {
        if (primary.has(anchor)) continue;
        const url = anchorDestination(anchor);
        if ((url && matchesHost(host(url.href))) ||
            ((anchor.querySelector(headingSelector) || anchor.closest(headingSelector)) && hasTargetCitation(cardFor(anchor)))) anchors.push(anchor);
    }
    for (const anchor of anchors) {
        if (anchor.closest(outsideResults)) continue;
        if (anchor.matches('[disabled],[aria-disabled="true"]')) continue;
        if (!rendered(anchor)) continue;
        const heading = anchor.querySelector(headingSelector) || anchor.closest(headingSelector);
        const url = anchorDestination(anchor);
        const direct = url && matchesHost(host(url.href));
        const label = text(anchor) || clean(anchor.getAttribute('aria-label'));
        const titleText = label.length >= 8 && !/^(?:https?:\/\/|www\.)/i.test(label) &&
            !/^(cached|translate|more|next|previous)$/i.test(label) && !displayedHost(label);
        const googleTitle = titleText && url && google(url.hostname) && /^\/(?:search|url)\/?$/.test(url.pathname);
        // Most Google anchors are menus, tools or media controls. Do not walk
        // their ancestors or read their layout on every document mutation.
        if (!heading && !direct && !googleTitle) continue;
        const card = cardFor(anchor);
        const citedTarget = hasTargetCitation(card);
        // A descriptive title can use its verified target URL directly; an
        // opaque Google title also needs its own publisher citation.
        const citationTitle = !heading && titleText && !anchor.matches('cite,[data-dtld],.VuuXrf,.tjvcx,.qLRx3b') &&
            !anchor.querySelector('cite,[data-dtld],.VuuXrf,.tjvcx,.qLRx3b') &&
            (citedTarget || (direct && ((url.pathname !== '/' && words(label).length >= 2) || parseFloat(getComputedStyle(anchor).fontSize) >= 18)));
        if (!heading && !citationTitle) continue;
        if (sponsored(card)) continue;
        const title = text(heading) || clean(anchor.getAttribute('aria-label')) || text(anchor);
        const key = url ? url.href.split('#')[0] : anchor.getAttribute('href');
        let organicIndex = records.findIndex((record) => record.key === key);
        if (organicIndex < 0) {
            organicIndex = records.length;
            records.push({ key, title });
        }
        const unresolved = citedTarget && url && google(url.hostname) && /^\/(?:search|url)\/?$/.test(url.pathname);
        if (direct || (citedTarget && (!url || google(url.hostname)))) {
            state.targetTextSeen = true;
            state.candidateText = title;
        }
        // A verified publisher label can activate its own Google result when
        // Google resolves the destination on click. Never invent an article
        // URL, accept a different publisher, or activate a JavaScript URL.
        if ((!direct && !unresolved) || !url || seen.has(key)) continue;
        seen.add(key);
        const score = (heading ? 100 : 0) + relevance(title) * 100 +
            relevance(text(card)) * 20 + (citedTarget ? 10 : 0);
        if (!winner || score > winner.score) winner = { anchor, url: direct ? url.href : undefined,
            unresolved: !direct, title, organicIndex, score };
    }
    state.observedResults = records.length;
    state.signature = records.slice(0, 40).map((record) => record.key + '|' + record.title).join('||');
    if (!state.targetTextSeen) {
        // A visible publisher/title can precede the anchor itself. Lock its
        // page now so later href hydration cannot be discarded by pagination.
        for (const node of roots.flatMap((root) => [...root.querySelectorAll(citationSelector)])) {
            if (node.closest(outsideResults) || !targetCitation(node)) continue;
            for (let parent = node.parentElement, depth = 0;
                parent && !parent.matches(rootSelector) && depth < 9; parent = parent.parentElement, depth++) {
                const heading = parent.querySelector(headingSelector);
                if (!heading) continue;
                const card = cardFor(node, heading), link = headingLink(heading);
                const url = link && anchorDestination(link);
                if (rendered(heading) && !sponsored(card) && (!url || google(url.hostname) || matchesHost(host(url.href)))) {
                    state.targetTextSeen = true;
                    state.candidateText = text(heading);
                }
                break;
            }
            if (state.targetTextSeen) break;
        }
    }
    state.pendingResults = roots.some((root) => [...root.querySelectorAll('[aria-busy="true"],[role="progressbar"]')]
        .some(rendered)) || roots.some((root) => root.getAttribute('aria-busy') === 'true');
    for (const link of document.querySelectorAll('a[href]')) {
        const url = destination(link.getAttribute('href'));
        if (url && google(url.hostname) && url.pathname === '/search' &&
            url.searchParams.get('q') === new URL(location.href).searchParams.get('q') &&
            Number(url.searchParams.get('start') || 0) > Number(new URL(location.href).searchParams.get('start') || 0) && rendered(link)) {
            state.nextPage = true; break;
        }
    }
    const footer = document.querySelector('#nav,#foot,#botstuff');
    state.paginationRendered = state.nextPage || Boolean(footer && rendered(footer));
    if (winner) {
        // Scroll before calculating native coordinates. Results below the fold
        // can be recognized immediately and must not receive off-screen clicks.
        winner.anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        let rect = winner.anchor.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            const range = document.createRange(); range.selectNodeContents(winner.anchor);
            rect = range.getBoundingClientRect();
        }
        const x = Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2));
        const hit = document.elementFromPoint(x, y);
        state.match = { url: winner.url, title: winner.title, organicIndex: winner.organicIndex,
            unresolved: winner.unresolved, displayedHost: target,
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
        if (stopped || (watcher.state?.match && !watcher.state.match.unresolved)) return;
        let result;
        try { result = recognizeGoogleResults(target, query); }
        catch (error) {
            // Surface a failed scan instead of silently leaving the browser
            // at Waiting/Scanning forever. The heartbeat can retry the DOM.
            result = { anchor: null, state: { blocked: false, observedResults: 0,
                documentParsed: document.readyState !== 'loading', recognitionError: String(error.message || error) } };
        }
        watcher.state = result.state;
        matchedAnchor = result.anchor;
        const next = JSON.stringify(watcher.state);
        if (next !== fingerprint) { fingerprint = next; publish(watcher.state); }
        if ((result.state.match && !result.state.match.unresolved) || result.state.blocked) {
            observer.disconnect();
            clearInterval(heartbeat);
        }
    }
    function schedule() {
        if (!stopped && !scheduled && (!watcher.state?.match || watcher.state.match.unresolved)) scheduled = setTimeout(scan, 60);
    }
    function click() {
        if (stopped) return false;
        if (!matchedAnchor?.isConnected) {
            // Hydration/click handlers can replace the title after recognition.
            // Activate the current result element instead of a detached node.
            const result = recognizeGoogleResults(target, query);
            watcher.state = result.state;
            matchedAnchor = result.anchor;
            publish(watcher.state);
        }
        if (!matchedAnchor?.isConnected || !watcher.state?.match) return false;
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
        attributes: true, attributeFilter: ['href', 'data-href', 'data-url', 'data-rw', 'data-pcu', 'data-amp-cur',
            'data-dtld', 'aria-busy', 'aria-disabled', 'aria-label', 'role', 'class', 'style', 'hidden'] });
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
        if (!/(^|\.)google\.(?:[a-z]{2,3}|(?:co|com)\.[a-z]{2})$/i.test(current.hostname) || current.pathname !== '/search' ||
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
