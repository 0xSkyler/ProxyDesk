"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROXYSCRAPE_FREE_API = void 0;
exports.buildProxyScrapeFreeListUrl = buildProxyScrapeFreeListUrl;
exports.fetchProxyScrapeFreeList = fetchProxyScrapeFreeList;
exports.fetchProxyScrapeTierFeed = fetchProxyScrapeTierFeed;
exports.PROXYSCRAPE_OFFICIAL_MIRROR_JSON = void 0;
exports.PROXYSCRAPE_FREE_API = 'https://api.proxyscrape.com/v4/free-proxy-list/get';
exports.PROXYSCRAPE_OFFICIAL_MIRROR_JSON = 'https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/all/data.json';
const DEFAULT_RATE_LIMIT_MS = 5 * 60 * 1000;
const MIRROR_CACHE_MS = 5 * 60 * 1000;
let liveRateLimitedUntil = 0;
let mirrorSnapshot = null;
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
            const error = new Error(`ProxyScrape API returned HTTP ${response.status}.`);
            error.httpStatus = response.status;
            error.retryAfter = typeof response.headers?.get === 'function'
                ? response.headers.get('retry-after') : null;
            throw error;
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

function retryAfterMs(value) {
    if (value == null || String(value).trim() === '') return DEFAULT_RATE_LIMIT_MS;
    const raw = String(value).trim();
    const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN;
    const deadline = Number.isFinite(seconds) ? seconds * 1000 :
        Date.parse(raw) - Date.now();
    return Number.isFinite(deadline) ? Math.max(60_000, Math.min(24 * 60 * 60 * 1000, deadline)) :
        DEFAULT_RATE_LIMIT_MS;
}
/**
 * For the tier selector only: respect HTTP 429 by cooling down the live API,
 * and read ProxyScrape's own public, five-minute JSON mirror instead.
 * This is not a proxy check: no candidate connection, geolocation, latency or
 * quality testing is performed. Other sources and non-tier fetches are unchanged.
 */
async function fetchProxyScrapeTierFeed(options = {}) {
    if (options.signal?.aborted) throw new Error('ProxyScrape request aborted.');
    if (Date.now() < liveRateLimitedUntil)
        return fetchProxyScrapeOfficialMirror(options);
    try {
        return await fetchProxyScrapeFreeList(options);
    }
    catch (error) {
        if (error?.httpStatus !== 429) throw error;
        liveRateLimitedUntil = Date.now() + retryAfterMs(error.retryAfter);
        try {
            return await fetchProxyScrapeOfficialMirror(options);
        }
        catch (mirrorError) {
            if (options.signal?.aborted) throw new Error('ProxyScrape request aborted.');
            throw new Error('ProxyScrape live API returned HTTP 429; the official five-minute mirror was also unavailable: ' +
                mirrorError.message);
        }
    }
}
async function fetchProxyScrapeOfficialMirror(options = {}) {
    if (options.signal?.aborted) throw new Error('ProxyScrape request aborted.');
    const now = Date.now();
    if (mirrorSnapshot && now - mirrorSnapshot.at < MIRROR_CACHE_MS)
        return mirrorSnapshot.text;
    const requestTimeoutMs = Math.max(3000, Math.min(30_000, Math.floor(options.requestTimeoutMs ?? 15_000)));
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
        const response = await fetch(exports.PROXYSCRAPE_OFFICIAL_MIRROR_JSON, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller.signal
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error('official ProxyScrape mirror returned HTTP ' + response.status);
        }
        const body = await response.text();
        if (body.length > 12_000_000) throw new Error('official proxy mirror exceeded the size limit');
        // Validate the feed structure only, not individual proxy connectivity.
        let records;
        try { records = JSON.parse(body); }
        catch { throw new Error('official proxy mirror returned invalid JSON'); }
        if (!Array.isArray(records)) throw new Error('official proxy mirror returned no proxy array');
        if (controller.signal.aborted || options.signal?.aborted) throw new Error('ProxyScrape request aborted.');
        mirrorSnapshot = { text: body, at: Date.now() };
        return body;
    }
    catch (error) {
        if (options.signal?.aborted) throw new Error('ProxyScrape request aborted.');
        if (controller.signal.aborted)
            throw new Error('official ProxyScrape mirror timed out after ' + requestTimeoutMs + ' ms.');
        throw error;
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
    }
}

//# sourceMappingURL=ProxyScrapeProvider.js.map
