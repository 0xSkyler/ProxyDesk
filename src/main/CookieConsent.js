'use strict';

function buildAcceptCookieConsentScript() {
    return `(() => {
        if (window.__proxyDeskCookieConsent) return;
        const accepted = new WeakSet();
        const labels = /^(accept all(?: cookies)?|allow all(?: cookies)?|agree to all|accept(?: cookies)?|accept (?:and|&) continue|i agree|agree(?: and continue)?|i consent|consent|allow|got it|ok(?:ay)?|continue)$/i;
        function scan(root) {
            const buttons = Array.from(root.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]'));
            const labelFor = element => (element.innerText || element.value || element.getAttribute('aria-label') || '').trim();
            buttons.sort((a,b) => Number(/all/i.test(labelFor(b))) - Number(/all/i.test(labelFor(a))));
            for (const element of buttons) {
                if (accepted.has(element) || element.disabled || !element.getClientRects().length) continue;
                const label = labelFor(element);
                if (!labels.test(label)) continue;
                const dialog = element.closest('[role="dialog"],[aria-modal="true"],[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i]');
                if (!dialog || !/cookies?|consent|privacy|terms|data processing/i.test(dialog.innerText || dialog.textContent || '')) continue;
                accepted.add(element);
                element.click();
                break;
            }
            for (const element of root.querySelectorAll('*')) if (element.shadowRoot) scan(element.shadowRoot);
        }
        let timer;
        const observer = new MutationObserver(() => {
            if (timer) return;
            timer = setTimeout(() => { timer = null; scan(document); }, 250);
        });
        window.__proxyDeskCookieConsent = true;
        observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class','style','hidden'] });
        scan(document);
    })()`;
}

module.exports = { buildAcceptCookieConsentScript };
