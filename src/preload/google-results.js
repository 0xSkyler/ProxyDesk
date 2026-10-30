'use strict';

// Shared by the sandboxed BrowserView preload and the main-process script
// builders. Keep these functions self-contained: sandboxed preloads cannot
// require application modules, and the same recognizer must handle every path.

// Generic cookie-consent support for sites other than Google. Only explicit
// positive cookie-banner choices qualify; unrelated Accept/Continue buttons
// must never be activated.
function inspectSiteCookieConsent() {
    if (!/^https?:$/.test(location.protocol) ||
        /(^|\.)google\.(?:[a-z]{2,3}|(?:co|com)\.[a-z]{2})$/i.test(location.hostname)) return null;
    const clean = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const positive = /^(accept all(?: cookies)?|accept (?:all )?cookies|accept|allow all(?: cookies)?|allow cookies|i agree|yes,? i agree|agree and continue|agree|accept and continue|accept & continue|ok|okay|got it|alle akzeptieren|alle cookies akzeptieren|tout accepter|accepter tout|aceptar todas?|accetta tutti|aceitar todos|সব গ্রহণ করুন)$/i;
    const contextWords = /cook(?:ie|ies)|consent|tracking|privacy preference|personal data|terms and conditions|terms of use|data processing|gdpr|donn[eé]es personnelles|datenschutz|galletas/i;
    const banner = '[role="dialog"],dialog,[aria-modal="true"],[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="privacy" i],[class*="privacy" i],[id*="onetrust" i],[class*="onetrust" i]';
    for (const button of document.querySelectorAll('button,input[type="button"],input[type="submit"],[role="button"]')) {
        const label = clean(button.innerText || button.textContent || button.value || button.getAttribute('aria-label'));
        if (!positive.test(label) || !button.isConnected || button.closest('[hidden],[inert]')) continue;
        const style = getComputedStyle(button);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' ||
            style.pointerEvents === 'none' || ![...button.getClientRects()].some(r => r.width && r.height) ||
            button.disabled || button.matches(':disabled') || button.getAttribute('aria-disabled') === 'true') continue;
        let scope = button.closest(banner);
        if (!scope) {
            // Some banners have no semantic wrapper. Limit the search to the
            // immediate few ancestors to avoid using an unrelated footer label.
            let node = button.parentElement;
            for (let i = 0; i < 4 && node && node !== document.body; i++, node = node.parentElement) {
                const words = clean(node.innerText || node.textContent).slice(0, 1800);
                if (contextWords.test(words)) { scope = node; break; }
            }
        }
        if (!scope) continue;
        const words = clean(scope.innerText || scope.textContent).slice(0, 2500);
        const identity = clean(String(scope.id || '') + ' ' + String(scope.className || ''));
        if (!contextWords.test(words) && !/cookie|consent|gdpr|onetrust/i.test(identity)) continue;
        return button;
    }
    return null;
}
function installSiteCookieConsentObserver(activate = null) {
    window.__domSiteCookieConsentWatcher?.stop();
    let stopped = false, pending = null, polls = 0;
    const attempts = new WeakMap();
    function scan() {
        pending = null;
        if (stopped) return;
        const button = inspectSiteCookieConsent();
        if (!button) return;
        const now = performance.now();
        const count = attempts.get(button) || { at: -Infinity, count: 0 };
        if (now - count.at < 2_000 || count.count >= 3) return;
        attempts.set(button, { at: now, count: count.count + 1 });
        try {
            button.focus({ preventScroll: true });
            if (activate) {
                button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
                const r = button.getBoundingClientRect();
                const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
                const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
                if (right > left && bottom > top)
                    activate({ point: { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2) } });
            } else button.click();
        } catch { /* Navigation can dispose a consent element mid-action. */ }
    }
    function schedule() { if (!stopped && pending === null) pending = setTimeout(scan, 250); }
    function stop() {
        stopped = true;
        observer.disconnect(); clearTimeout(pending); clearInterval(heartbeat);
        document.removeEventListener('readystatechange', schedule);
    }
    const observer = new MutationObserver(schedule);
    observer.observe(document, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['disabled', 'aria-disabled', 'style', 'class', 'hidden'] });
    const heartbeat = setInterval(() => {
        if (++polls >= 45) stop(); else schedule();
    }, 2_000);
    document.addEventListener('readystatechange', schedule);
    window.__domSiteCookieConsentWatcher = { stop };
    scan();
}

function inspectGooglePrompt() {
    const google = /(^|\.)google\.(?:[a-z]{2,3}|(?:co|com)\.[a-z]{2})$/i.test(location.hostname);
    if (!google) return null;
    const clean = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const consentPage = /^consent\./i.test(location.hostname);
    const visible = node => {
        if (!node?.isConnected || node.closest('[hidden],[inert]')) return false;
        const style = getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' &&
            [...node.getClientRects()].some(rect => rect.width && rect.height);
    };
    const captcha = [...document.querySelectorAll('#captcha-form, iframe[src*="recaptcha"], .g-recaptcha')].some(visible);
    const body = clean(document.body?.innerText || document.body?.textContent);
    const verification = !captcha && /verifying your request|you['’]ll be able to continue in a few seconds/i.test(body);
    let consent = consentPage;
    for (const button of document.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"],a[href]')) {
        const label = clean(button.innerText || button.textContent || button.value || button.getAttribute('aria-label'));
        const accept = /^accept all$/i.test(label);
        const proceed = /^continue$/i.test(label);
        if ((!accept && !proceed) || !visible(button)) continue;
        const scope = button.closest('[role="dialog"],dialog,form,#CXQnmb,#VnjCcb') || button.parentElement?.parentElement;
        const context = clean(scope?.innerText || scope?.textContent);
        const cookieContext = consentPage || button.id === 'L2AGLb' ||
            /before you continue|we use cookies|use cookies and data|privacy tools|g\.co\/privacytools/i.test(context);
        if (accept && cookieContext) consent = true;
        if (!(accept && cookieContext) && !(proceed && (consentPage || verification) && !captcha)) continue;
        const disabled = button.disabled || button.matches(':disabled') || button.getAttribute('aria-disabled') === 'true' ||
            getComputedStyle(button).pointerEvents === 'none';
        return { kind: accept ? 'consent' : 'verification', button: disabled ? null : button };
    }
    return consent ? { kind: 'consent', button: null } : verification && !captcha ? { kind: 'verification', button: null } : null;
}

// Every BrowserView has its own preload and observer. This remains active on
// consent.google.com and verification documents, where the result scanner is
// intentionally inactive. No load/Ready event is needed to press a new button.
function installGooglePromptObserver(publish = () => {}, activate = null) {
    window.__domGooglePromptWatcher?.stop();
    let scheduled = null, stopped = false, fingerprint = '';
    const attempts = new WeakMap();
    const watcher = { state: null, stop };
    function scan() {
        scheduled = null;
        if (stopped) return;
        const prompt = inspectGooglePrompt();
        watcher.state = prompt ? { kind: prompt.kind, enabled: Boolean(prompt.button) } : null;
        const next = JSON.stringify(watcher.state);
        if (next !== fingerprint) { fingerprint = next; publish(watcher.state); }
        if (prompt?.button) {
            const now = performance.now();
            if (now - (attempts.get(prompt.button) ?? -Infinity) < 750) return;
            attempts.set(prompt.button, now);
            prompt.button.focus({ preventScroll: true });
            // Native pointer events work with Google's trusted-event handlers.
            // Retry only while the same enabled prompt is still present; a
            // dismissed dialog or a disabled Continue is never clicked again.
            if (activate) {
                prompt.button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
                const rect = prompt.button.getBoundingClientRect();
                const x = Math.round(Math.max(0, rect.left) + (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) / 2);
                const y = Math.round(Math.max(0, rect.top) + (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) / 2);
                if (x >= 0 && x < innerWidth && y >= 0 && y < innerHeight)
                    activate({ kind: prompt.kind, point: { x, y } });
            } else prompt.button.click();
            schedule();
        }
    }
    function schedule() { if (!stopped && !scheduled) scheduled = setTimeout(scan, 40); }
    function stop() {
        stopped = true; observer.disconnect(); clearTimeout(scheduled); clearInterval(heartbeat);
        document.removeEventListener('readystatechange', schedule);
    }
    const observer = new MutationObserver(schedule);
    observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: ['disabled', 'aria-disabled', 'aria-label', 'class', 'style', 'hidden', 'inert'] });
    const heartbeat = setInterval(schedule, 500);
    document.addEventListener('readystatechange', schedule);
    window.__domGooglePromptWatcher = watcher;
    scan();
    return watcher;
}

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
    function googleTitleRoute(url) {
        return Boolean(url && google(url.hostname) && /^\/(?:search|url|goto)\/?$/.test(url.pathname));
    }
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
                if (!/^\/(url|goto|imgres|aclk|interstitial|local_url)\/?$/.test(url.pathname)) break;
                const next = url.searchParams.get('url') || url.searchParams.get('q') ||
                    url.searchParams.get('adurl') || url.searchParams.get('imgurl');
                const decoded = decodeDestination(next);
                if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) && !/^https?:\/\//i.test(decoded)) return null;
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
    function displayedDomains(value) {
        // Preserve domain boundaries. Removing all punctuation would also
        // accept evil-example.com or example.com.attacker.test.
        const domains = clean(value).replace(/\s*\.\s*/g, '.')
            .match(/(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}\p{N}-]+\.?/gu) || [];
        return domains.map(host).filter(Boolean);
    }
    function displayedHost(value) { return displayedDomains(value).some(matchesHost); }
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
    const prompt = inspectGooglePrompt();
    if (prompt) { state.googlePrompt = prompt.kind; state.pendingResults = true; return { state, anchor: null }; }
    const blockedUrl = /\/sorry\/|^https?:\/\/consent\.google\./i.test(location.href);
    const challenge = document.querySelector('form[action*="/sorry/"], #captcha-form, iframe[src*="recaptcha"], .g-recaptcha');
    if (blockedUrl || challenge) { state.blocked = true; return { state, anchor: null }; }
    const rootSelector = '#search,#rso,main,[role="main"]';
    const allRoots = [...document.querySelectorAll(rootSelector)];
    const roots = allRoots.filter((node) => !allRoots.some((other) => other !== node && other.contains(node)));
    if (!roots.length && document.body) roots.push(document.body);
    if (!roots.length || !target) return { state, anchor: null };

    const headingSelector = 'h3,h2,h1,[role="heading"],.LC20lb,.DKV0Md';
    const linkSelector = 'a,[role="link"]';
    const outsideResults = 'nav,header,footer,[role="navigation"],[role="menu"],[role="menubar"],[role="dialog"]';
    const visibility = new WeakMap();
    function rendered(node) {
        // aria-hidden changes screen-reader exposure, not visual rendering.
        // Google can mark an otherwise visible title as an accessibility copy.
        if (!node || !node.isConnected) return false;
        if (visibility.has(node)) return visibility.get(node);
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
        if (typeof node.checkVisibility === 'function' && style.display !== 'contents' &&
            !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        if ([...node.getClientRects()].some((rect) => rect.width && rect.height)) {
            visibility.set(node, true); return true;
        }
        // A link can have no box while its children still paint (contents or
        // overflow). Use the actual rendered title, not HTML hidden attributes.
        if ([...node.children].some(rendered)) { visibility.set(node, true); return true; }
        const range = document.createRange(); range.selectNodeContents(node);
        const visible = [...range.getClientRects()].some((rect) => rect.width && rect.height);
        visibility.set(node, visible); return visible;
    }
    function headingLink(heading) {
        return heading.closest(linkSelector) || heading.querySelector(linkSelector);
    }
    const citationSelector = 'cite,[data-dtld],.VuuXrf,.tjvcx,.qLRx3b,span,div';
    function publisherHosts(node, targetOnly = false) {
        const value = clean(node.getAttribute('data-dtld') || node.textContent);
        if (!value || value.length > 320) return [];
        const domains = displayedDomains(value);
        if (!domains.length || (targetOnly && !domains.some(matchesHost))) return [];
        if (!node.matches('cite,[data-dtld],.VuuXrf,.tjvcx,.qLRx3b')) {
            // Ordinary URL labels must not be mentions inside snippets.
            if (node.closest('p') || node.querySelector(headingSelector + ',p') ||
                !/^(?:https?:\/\/|\/\/)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?:\/?(?:\s*[›»>|]|\s*$)|\/\S*)/u.test(value)) return [];
        }
        return rendered(node) ? domains : [];
    }
    function targetCitation(node) { return publisherHosts(node, true).some(matchesHost); }
    const citations = new WeakMap();
    function hasTargetCitation(card) {
        if (!citations.has(card)) citations.set(card, targetCitation(card) ||
            [...card.querySelectorAll(citationSelector)].some(targetCitation));
        return citations.get(card);
    }
    const conflictingPublishers = new WeakMap();
    function hasConflictingPublisher(card) {
        if (!conflictingPublishers.has(card)) {
            const labels = new Set();
            for (const node of card.querySelectorAll(citationSelector)) {
                // Breadcrumb fragments inside a citation belong to that
                // publisher label. An explicit data-dtld remains authoritative.
                const owner = node.matches('cite,[data-dtld],.VuuXrf,.tjvcx,.qLRx3b') ? node :
                    node.closest('cite,[data-dtld],.VuuXrf,.tjvcx,.qLRx3b');
                labels.add(owner && card.contains(owner) ? owner : node);
            }
            conflictingPublishers.set(card, [...labels].some(node => {
                // The first hostname is the URL's publisher. Dotted path and
                // breadcrumb terms such as article.html are not other sites.
                const publisher = publisherHosts(node)[0];
                return publisher && !matchesHost(publisher);
            }));
        }
        return conflictingPublishers.get(card);
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
            if (current.matches('.MjjYud,.g,[data-snhf],article')) break;
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
    function descriptive(value) {
        return value.length >= 8 && !/^(?:https?:\/\/|www\.)/i.test(value) &&
            !/^(cached|translate|more|next|previous)$/i.test(value) && !displayedHost(value);
    }
    function visualTitle(anchor) {
        // Newer cards can put the publisher, breadcrumb and title inside one
        // anchor without an h3. Read the title's visible text independently.
        let best = null;
        for (const node of anchor.querySelectorAll('span,div')) {
            if (node.closest('cite,[data-dtld],.VuuXrf,.tjvcx,.qLRx3b') ||
                node.querySelector('cite,[data-dtld],.VuuXrf,.tjvcx,.qLRx3b') || !rendered(node)) continue;
            const value = text(node), size = parseFloat(getComputedStyle(node).fontSize);
            if (value.length > 300 || size < 18 || !descriptive(value)) continue;
            const score = relevance(value) * 100 + size;
            if (!best || score > best.score) best = { node, value, score };
        }
        return best;
    }
    const records = [], seen = new Set();
    state.diagnostics = { targetLinks: 0, hidden: 0, outside: 0, noTitle: 0, sponsored: 0 };
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
    function considerAnchor(anchor, publisherCard, ownedHeading) {
        const url = anchorDestination(anchor);
        const direct = url && matchesHost(host(url.href));
        // The publisher-first pass can reconsider an already enumerated link.
        // Count its destination only once while sharing all selection guards.
        if (direct && !publisherCard) state.diagnostics.targetLinks++;
        if (anchor.closest(outsideResults) || anchor.matches('[disabled],[aria-disabled="true"]')) {
            if (direct && !publisherCard) state.diagnostics.outside++; return 'outside-or-disabled';
        }
        if (!rendered(anchor)) { if (direct && !publisherCard) state.diagnostics.hidden++; return 'hidden-link'; }
        const heading = ownedHeading || anchor.querySelector(headingSelector) || anchor.closest(headingSelector);
        const googleRoute = googleTitleRoute(url);
        if (!heading && !direct && !googleRoute) return 'unsupported-link';
        const label = text(anchor) || clean(anchor.getAttribute('aria-label'));
        const styledTitle = !heading && visualTitle(anchor);
        const titleText = styledTitle || descriptive(label);
        const googleTitle = titleText && googleRoute;
        // Most Google anchors are menus, tools or media controls. Do not walk
        // their ancestors or read their layout on every document mutation.
        if (!heading && !direct && !googleTitle) return 'no-title';
        const card = publisherCard || cardFor(anchor);
        const citedTarget = Boolean(publisherCard) || hasTargetCitation(card);
        // A descriptive title can use its verified target URL directly; an
        // opaque Google title also needs its own publisher citation.
        const citationTitle = !heading && titleText && !anchor.matches('cite,[data-dtld],.VuuXrf,.tjvcx,.qLRx3b') &&
            (styledTitle || !anchor.querySelector('cite,[data-dtld],.VuuXrf,.tjvcx,.qLRx3b')) &&
            (citedTarget || (direct && ((url.pathname !== '/' && words(label).length >= 2) || parseFloat(getComputedStyle(anchor).fontSize) >= 18)));
        if (!heading && !citationTitle) {
            if (direct) {
                if (!publisherCard) state.diagnostics.noTitle++;
                if (citedTarget && !sponsored(card)) {
                    state.targetTextSeen = true;
                    state.candidateText = label;
                }
            }
            return 'no-title';
        }
        if (sponsored(card)) { if (direct && !publisherCard) state.diagnostics.sponsored++; return 'sponsored'; }
        const title = text(heading) || styledTitle?.value || clean(anchor.getAttribute('aria-label')) || text(anchor);
        const key = url ? url.href.split('#')[0] : anchor.getAttribute('href');
        let organicIndex = records.findIndex((record) => record.key === key);
        if (organicIndex < 0) {
            organicIndex = records.length;
            records.push({ key, title });
        }
        const unresolved = citedTarget && googleTitleRoute(url);
        if (direct || (citedTarget && (!url || google(url.hostname)))) {
            state.targetTextSeen = true;
            state.candidateText = title;
        }
        // A verified publisher label can activate its own Google result when
        // Google resolves the destination on click. Never invent an article
        // URL, accept a different publisher, or activate a JavaScript URL.
        if ((!direct && !unresolved) || !url) return url ? 'unsupported-route' : 'unsupported-scheme';
        if (seen.has(key)) return 'selected';
        seen.add(key);
        const score = (heading ? 25 : styledTitle ? 20 : 0) + relevance(title) * 200 +
            relevance(text(card)) * 40 + (citedTarget ? 10 : 0);
        if (!winner || score > winner.score) winner = { anchor, url: direct ? url.href : undefined,
            unresolved: !direct, title, organicIndex, score };
        return 'selected';
    }
    for (const anchor of anchors) considerAnchor(anchor);
    if (!winner) {
        // A visible publisher/title can precede the anchor itself. Lock its
        // page now so later href hydration cannot be discarded by pagination.
        // When the linked title is already present, use the publisher's owning
        // card: an inner Google module can stop the anchor-first walk before it
        // reaches the sibling citation. Keep every normal link/click guard.
        for (const node of roots.flatMap((root) => [...root.querySelectorAll(citationSelector)])) {
            if (node.closest(outsideResults) || !targetCitation(node)) continue;
            const publisherModule = node.closest('.MjjYud,.g,[data-snhf],article');
            for (let parent = node.parentElement, depth = 0;
                parent && !parent.matches(rootSelector) && depth < 9; parent = parent.parentElement, depth++) {
                const headings = [...parent.querySelectorAll(headingSelector)]
                    .filter(heading => rendered(heading) && !heading.closest(outsideResults));
                if (!headings.length) continue;
                for (const heading of headings) {
                    const link = headingLink(heading), url = link && anchorDestination(link);
                    const competingTitle = headings.some(other => {
                        const otherLink = headingLink(other);
                        return other !== heading && otherLink && otherLink !== link && rendered(otherLink) &&
                            !otherLink.closest(outsideResults);
                    });
                    // Separate inner modules may decorate one owning result.
                    // Join them only at their nearest explicit result module,
                    // with one visible linked title and no different publisher.
                    // A generic list/section cannot donate a neighboring cite.
                    const crossesModule = publisherModule && !publisherModule.contains(heading);
                    if ((crossesModule && (!link || !parent.matches('.MjjYud,.g,[data-snhf],article') || competingTitle)) ||
                        hasConflictingPublisher(parent) || sponsored(parent) ||
                        (url && !google(url.hostname) && !matchesHost(host(url.href)))) continue;
                    state.targetTextSeen = true;
                    state.candidateText = text(heading);
                    const reason = competingTitle ? 'ambiguous-card' : link ? considerAnchor(link, parent, heading) : 'no-link';
                    if (reason !== 'selected') state.diagnostics.publisherTitle = {
                        reason, tag: link ? link.tagName.toLowerCase() : 'none',
                        route: url ? google(url.hostname) ? url.pathname.slice(0, 40) : 'external' : link ? 'non-http' : 'none'
                    };
                }
                // This is the nearest publisher/title scope. Never climb into
                // the result list to borrow a less closely associated title.
                break;
            }
        }
    }
    state.observedResults = records.length;
    state.signature = records.slice(0, 40).map((record) => record.key + '|' + record.title).join('||');
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
    const observeOptions = { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['href', 'data-href', 'data-url', 'data-rw', 'data-pcu', 'data-amp-cur',
            'data-dtld', 'aria-busy', 'aria-disabled', 'aria-label', 'role', 'class', 'style', 'hidden'] };
    const watcher = { state: null, key: target + '|' + query, click, stop, scan, get stopped() { return stopped; } };
    function scan(force = false) {
        scheduled = null;
        if (stopped || (!force && watcher.state?.match && !watcher.state.match.unresolved)) return;
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
            heartbeat = null;
        } else if (!heartbeat) {
            observer.observe(document, observeOptions);
            heartbeat = setInterval(schedule, 500);
        }
    }
    function schedule() {
        if (!stopped && !scheduled && (!watcher.state?.match || watcher.state.match.unresolved)) scheduled = setTimeout(scan, 60);
    }
    function click() {
        if (stopped) return false;
        if (inspectGooglePrompt()) { scan(true); return false; }
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
    observer.observe(document, observeOptions);
    heartbeat = setInterval(schedule, 500);
    document.addEventListener('readystatechange', schedule);
    window.__domGoogleWatcher = watcher;
    scan();
    return watcher;
}

if (typeof process !== 'undefined' && process.type === 'renderer') {
    const { ipcRenderer, webFrame } = require('electron');
    ipcRenderer.on('dom:clear-renderer-cache', (_event, requestId) => {
        try {
            webFrame.clearCache();
            ipcRenderer.send('dom:renderer-cache-cleared', { requestId });
        } catch (error) {
            ipcRenderer.send('dom:renderer-cache-cleared', { requestId, error: error.message });
        }
    });
    let active = null;
    // Active on every top-level website, not just Google.
    if (window === window.top && /^https?:$/.test(location.protocol)) {
        const documentId = String(performance.timeOrigin);
        installSiteCookieConsentObserver(prompt => ipcRenderer.send('dom:site-cookie-consent-click',
            { documentUrl: location.href, documentId, ...prompt }));
        addEventListener('pagehide', () => window.__domSiteCookieConsentWatcher?.stop(), { once: true });
    }
    if (window === window.top && /(^|\.)google\.(?:[a-z]{2,3}|(?:co|com)\.[a-z]{2})$/i.test(location.hostname)) {
        const documentId = String(performance.timeOrigin);
        installGooglePromptObserver(state => {
            ipcRenderer.send('dom:google-prompt-state', { documentUrl: location.href, documentId, state });
            // Revoke a stale target match if a dialog appears, and immediately
            // rescan the same result page when that dialog disappears.
            window.__domGoogleWatcher?.scan(true);
        }, prompt => ipcRenderer.send('dom:google-prompt-click', { documentUrl: location.href, documentId, ...prompt }));
        addEventListener('pagehide', () => window.__domGooglePromptWatcher?.stop(), { once: true });
    }
    ipcRenderer.on('dom:google-config', (_event, config) => {
        const existing = window.__domGoogleWatcher;
        if (!config) { existing?.stop(); active = null; return; }
        const current = new URL(location.href);
        if (!/(^|\.)google\.(?:[a-z]{2,3}|(?:co|com)\.[a-z]{2})$/i.test(current.hostname) || current.pathname !== '/search' ||
            current.searchParams.get('q') !== config.query ||
            (current.searchParams.get('start') || '0') !== config.start) {
            existing?.stop(); active = null; return;
        }
        const publish = state => ipcRenderer.send('dom:google-state', { navigation: config.navigation, token: config.token,
            documentUrl: location.href, state });
        if (active && existing && !existing.stopped && existing.key === config.target + '|' + config.query &&
            ['navigation', 'token', 'target', 'query', 'start'].every(key => active[key] === config[key])) {
            // Preserve a live watcher. Only a final-match replay needs a new
            // scan: its link/coordinates may have moved since the lost report.
            if (existing.state?.match) existing.scan(true);
            if (existing.state) publish(existing.state);
            return;
        }
        existing?.stop(); active = config;
        try { installGoogleResultObserver(config.target, config.query, publish); }
        catch (error) { publish({ blocked: false, observedResults: 0, recognitionError: 'Scanner startup: ' + String(error.message || error) }); }
    });
    ipcRenderer.on('dom:google-click', (_event, navigation) => {
        if (active?.navigation === navigation) window.__domGoogleWatcher?.click();
    });
    addEventListener('pagehide', () => window.__domGoogleWatcher?.stop(), { once: true });
    // This handshake runs at document start, before DOMContentLoaded or load.
    ipcRenderer.send('dom:google-preload-ready');
} else if (typeof module !== 'undefined') {
    module.exports = { inspectSiteCookieConsent, installSiteCookieConsentObserver, inspectGooglePrompt, installGooglePromptObserver, recognizeGoogleResults, installGoogleResultObserver };
}
