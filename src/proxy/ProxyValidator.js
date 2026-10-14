"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyValidator = void 0;
exports.buildAgent = buildAgent;
const node_https_1 = __importDefault(require("node:https"));
const https_proxy_agent_1 = require("https-proxy-agent");
const socks_proxy_agent_1 = require("socks-proxy-agent");
const constants_1 = require("../shared/constants");
function buildAgentUrl(proxy) {
    const auth = proxy.username
        ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@`
        : '';
    const scheme = proxy.protocol === 'https' ? 'https' : proxy.protocol === 'http' ? 'http' : proxy.protocol;
    return `${scheme}://${auth}${proxy.host}:${proxy.port}`;
}
/** Exported for GoogleTrustChecker, which needs to route a real request
 * through the same proxy-agent machinery used here rather than duplicating
 * it. */
function buildAgent(proxy) {
    const url = buildAgentUrl(proxy);
    if (proxy.protocol === 'socks4' || proxy.protocol === 'socks5') {
        return new socks_proxy_agent_1.SocksProxyAgent(url);
    }
    return new https_proxy_agent_1.HttpsProxyAgent(url);
}
/**
 * Validates a single proxy by performing a real HTTP request THROUGH it to a
 * configurable IP-check endpoint. This exercises actual proxy traffic rather
 * than merely opening a TCP socket, so a proxy that accepts connections but
 * silently drops requests is correctly reported dead.
 */
class ProxyValidator {
    static async validate(proxy, options = {}) {
        const timeoutMs = clampTimeout(options.timeoutMs ?? constants_1.DEFAULT_PROXY_TIMEOUT_MS);
        const ipCheckUrl = options.ipCheckUrl ?? 'https://api.ipify.org?format=json';
        const checkedAt = new Date().toISOString();
        const start = Date.now();
        let agent;
        try {
            agent = buildAgent(proxy);
        }
        catch (err) {
            return {
                proxyId: proxy.id,
                status: 'dead',
                error: `Invalid proxy configuration: ${err.message}`,
                checkedAt
            };
        }
        return new Promise((resolve) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            if (options.signal) {
                if (options.signal.aborted)
                    controller.abort();
                else
                    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
            }
            let settled = false;
            const finish = (result) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                clearTimeout(backstop);
                resolve(result);
            };
            // Independent wall-clock backstop: `req.on('timeout', ...)` only
            // fires on socket IDLE time (a proxy that trickles a byte every few
            // seconds keeps resetting that clock and never triggers it, even
            // though the whole request has long since blown past timeoutMs),
            // and aborting via controller.abort() is only handled here through
            // the 'error' event — if a given Node/Electron version instead
            // emits 'abort' for that (no listener for it below), finish() would
            // never run either way. Either gap leaves this promise unresolved
            // forever, which hangs validateMany's Promise.all, which hangs the
            // whole reload — exactly the class of bug already found and fixed
            // in the provider fetch layer, just recurring here in validation.
            // This backstop guarantees finish() always runs within a bounded
            // time regardless of which request-level event does or doesn't fire.
            const backstop = setTimeout(() => {
                req.destroy();
                finish({ proxyId: proxy.id, status: 'dead', error: 'Validation timed out', checkedAt });
            }, timeoutMs + 1000);
            let target;
            try {
                target = new URL(ipCheckUrl);
            }
            catch {
                finish({ proxyId: proxy.id, status: 'dead', error: 'Invalid IP check URL', checkedAt });
                return;
            }
            const req = node_https_1.default.request({
                hostname: target.hostname,
                path: `${target.pathname}${target.search}`,
                port: target.port || 443,
                method: 'GET',
                agent,
                signal: controller.signal,
                timeout: timeoutMs,
                headers: { 'User-Agent': 'DOM/1.0 (+proxy-validation)' }
            }, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const latencyMs = Date.now() - start;
                    if (!res.statusCode || res.statusCode >= 400) {
                        finish({
                            proxyId: proxy.id,
                            status: 'dead',
                            latencyMs,
                            error: `HTTP ${res.statusCode ?? 'unknown'}`,
                            checkedAt
                        });
                        return;
                    }
                    let detectedIp;
                    try {
                        const body = Buffer.concat(chunks).toString('utf8');
                        const parsed = JSON.parse(body);
                        detectedIp = parsed.ip;
                    }
                    catch {
                        // Non-JSON response is still a successful proxied request.
                    }
                    finish({ proxyId: proxy.id, status: 'working', latencyMs, detectedCountryCode: undefined, checkedAt });
                    void detectedIp;
                });
            });
            req.on('timeout', () => {
                req.destroy();
            });
            req.on('error', (err) => {
                finish({
                    proxyId: proxy.id,
                    status: 'dead',
                    latencyMs: Date.now() - start,
                    error: sanitizeError(err),
                    checkedAt
                });
            });
            req.end();
        });
    }
    /** Runs validations with bounded concurrency so 10+ checks never overwhelm the network stack. */
    static async validateMany(proxies, options = {}) {
        const maxConcurrent = Math.max(1, options.maxConcurrent ?? 10);
        const results = new Array(proxies.length);
        let cursor = 0;
        let completed = 0;
        async function worker() {
            while (cursor < proxies.length) {
                const index = cursor++;
                results[index] = await ProxyValidator.validate(proxies[index], options);
                completed++;
                options.onResult?.(results[index], completed, proxies.length);
                options.onProgress?.(completed, proxies.length);
            }
        }
        const workers = Array.from({ length: Math.min(maxConcurrent, proxies.length) }, () => worker());
        await Promise.all(workers);
        return results;
    }
}
exports.ProxyValidator = ProxyValidator;
function clampTimeout(ms) {
    return Math.min(60000, Math.max(1000, ms));
}
function sanitizeError(err) {
    const message = err instanceof Error ? err.message : String(err);
    // Never let proxy credentials leak into error strings/logs.
    return message.replace(/\/\/[^@/]+@/g, '//***@');
}
//# sourceMappingURL=ProxyValidator.js.map