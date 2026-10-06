"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROXYSCRAPE_FREE_API = void 0;
exports.buildProxyScrapeFreeListUrl = buildProxyScrapeFreeListUrl;
exports.fetchProxyScrapeFreeList = fetchProxyScrapeFreeList;
const node_https_1 = __importDefault(require("node:https"));
exports.PROXYSCRAPE_FREE_API = 'https://api.proxyscrape.com/v4/free-proxy-list/get';
/**
 * Fetch ProxyScrape's public free-proxy feed directly.
 *
 * ProxyScrape documents a maximum page size of 2,000 proxies and supports
 * filtering by protocol and timeout. We request protocol-qualified output so
 * the existing parser can preserve HTTP / SOCKS4 / SOCKS5 correctly.
 */
function buildProxyScrapeFreeListUrl(options = {}) {
    const limit = Math.max(1, Math.min(2000, Math.floor(options.limit ?? 2000)));
    const timeoutFilterMs = Math.max(1000, Math.min(15_000, Math.floor(options.timeoutFilterMs ?? 7000)));
    const url = new URL(exports.PROXYSCRAPE_FREE_API);
    url.searchParams.set('request', 'display_proxies');
    url.searchParams.set('timeout', String(timeoutFilterMs));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('proxy_format', 'protocolipport');
    url.searchParams.set('format', 'text');
    return url;
}
async function fetchProxyScrapeFreeList(options = {}) {
    const requestTimeoutMs = Math.max(3000, Math.min(30_000, Math.floor(options.requestTimeoutMs ?? 15_000)));
    const url = buildProxyScrapeFreeListUrl(options);
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
            reject(new Error('ProxyScrape request aborted.'));
            return;
        }
        const request = node_https_1.default.get(url, {
            headers: {
                accept: 'text/plain,*/*;q=0.8',
                'user-agent': 'ProxyDesk-SEO-Lite/1.0'
            }
        }, (response) => {
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
                response.resume();
                reject(new Error(`ProxyScrape API returned HTTP ${statusCode}.`));
                return;
            }
            response.setEncoding('utf8');
            let body = '';
            response.on('data', (chunk) => {
                body += chunk;
                // A 2,000-proxy text response is tiny. Guard against a bad upstream
                // response anyway so this never becomes an unbounded memory sink.
                if (body.length > 2_000_000) {
                    request.destroy(new Error('ProxyScrape response exceeded the safety limit.'));
                }
            });
            response.on('end', () => resolve(body));
        });
        request.setTimeout(requestTimeoutMs, () => {
            request.destroy(new Error(`ProxyScrape API timed out after ${requestTimeoutMs} ms.`));
        });
        const onAbort = () => request.destroy(new Error('ProxyScrape request aborted.'));
        options.signal?.addEventListener('abort', onAbort, { once: true });
        request.on('close', () => options.signal?.removeEventListener('abort', onAbort));
        request.on('error', reject);
    });
}
//# sourceMappingURL=ProxyScrapeProvider.js.map