"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROXYSCRAPE_FREE_API = void 0;
exports.buildProxyScrapeFreeListUrl = buildProxyScrapeFreeListUrl;
exports.fetchProxyScrapeFreeList = fetchProxyScrapeFreeList;
exports.PROXYSCRAPE_FREE_API = 'https://api.proxyscrape.com/v4/free-proxy-list/get';
/**
 * Fetch ProxyScrape's public free-proxy feed directly.
 *
 * ProxyScrape documents a maximum page size of 2,000 proxies and supports
 * filtering by protocol and timeout. We request protocol-qualified output so
 * the existing parser can preserve HTTP / SOCKS4 / SOCKS5 correctly.
 */
function buildProxyScrapeFreeListUrl(options = {}) {
    const url = new URL(exports.PROXYSCRAPE_FREE_API);
    url.searchParams.set('request', 'display_proxies');
    if (options.timeoutFilterMs != null) {
        const timeoutFilterMs = Math.max(1000, Math.min(15_000, Math.floor(options.timeoutFilterMs)));
        url.searchParams.set('timeout', String(timeoutFilterMs));
    }
    if (options.limit != null) {
        const limit = Math.max(1, Math.min(2000, Math.floor(options.limit)));
        url.searchParams.set('limit', String(limit));
    }
    url.searchParams.set('proxy_format', 'protocolipport');
    url.searchParams.set('format', 'text');
    return url;
}
async function fetchProxyScrapeFreeList(options = {}) {
    const requestTimeoutMs = Math.max(3000, Math.min(30_000, Math.floor(options.requestTimeoutMs ?? 15_000)));
    const url = options.endpoint ? new URL(options.endpoint) : buildProxyScrapeFreeListUrl(options);
    if (options.signal?.aborted)
        throw new Error('ProxyScrape request aborted.');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Accept: 'text/plain,*/*;q=0.8',
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache',
                'User-Agent': 'DOM-SEO-Lite/1.0'
            },
            signal: controller.signal
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`ProxyScrape API returned HTTP ${response.status}.`);
        }
        const text = await response.text();
        if (text.length > 2_000_000)
            throw new Error('ProxyScrape response exceeded the safety limit.');
        if (!text.trim())
            throw new Error('ProxyScrape API returned an empty response.');
        return text;
    }
    catch (err) {
        if (options.signal?.aborted)
            throw new Error('ProxyScrape request aborted.');
        if (controller.signal.aborted)
            throw new Error(`ProxyScrape API timed out after ${requestTimeoutMs} ms.`);
        throw err;
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
    }
}
//# sourceMappingURL=ProxyScrapeProvider.js.map
