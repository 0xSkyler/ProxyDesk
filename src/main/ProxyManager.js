"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyManager = void 0;
exports.DEFAULT_PROXY_SOURCE_ID = exports.PROXY_SOURCE_IDS = void 0;
exports.resolveProxySource = resolveProxySource;
const node_events_1 = require("node:events");
const ProxyParser_1 = require("../proxy/ProxyParser");
const AllWorkingProxyProvider_1 = require("../proxy/AllWorkingProxyProvider");
const ProxyScrapeProvider_1 = require("../proxy/ProxyScrapeProvider");
const Logger_1 = require("./Logger");
exports.PROXY_SOURCE_IDS = Object.freeze({
    allWorking: 'all-working',
    proxyScrapeFree: 'proxyscrape-free'
});
exports.DEFAULT_PROXY_SOURCE_ID = exports.PROXY_SOURCE_IDS.proxyScrapeFree;
function resolveProxySource(sourceId, endpoint) {
    const id = sourceId === exports.PROXY_SOURCE_IDS.allWorking
        ? exports.PROXY_SOURCE_IDS.allWorking
        : sourceId === exports.PROXY_SOURCE_IDS.proxyScrapeFree || sourceId == null || sourceId === ''
            ? exports.PROXY_SOURCE_IDS.proxyScrapeFree
            : (() => { throw new Error(`Unknown proxy source: ${sourceId}`); })();
    const label = id === exports.PROXY_SOURCE_IDS.allWorking ? 'All Working API' : 'ProxyScrape Free API';
    const defaultEndpoint = id === exports.PROXY_SOURCE_IDS.allWorking
        ? AllWorkingProxyProvider_1.ALL_WORKING_PROXY_URL
        : (0, ProxyScrapeProvider_1.buildProxyScrapeFreeListUrl)().href;
    let url;
    try {
        url = new URL(String(endpoint || defaultEndpoint).trim());
    }
    catch {
        throw new Error(`${label} URL is invalid.`);
    }
    if (!['http:', 'https:'].includes(url.protocol))
        throw new Error(`${label} URL must use HTTP or HTTPS.`);
    if (url.username || url.password)
        throw new Error(`${label} URL must not contain credentials.`);
    return { id, label, endpoint: url.href };
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class ProxyManager extends node_events_1.EventEmitter {
    allProxies = new Map();
    assignments = new Map();
    fetchController = null;
    sourceCursors = new Map();
    async init() {
        this.cancelCurrentFetch();
        this.allProxies.clear();
        this.assignments.clear();
        Logger_1.logger.info('proxy', 'Proxy manager ready: selectable API direct assignment.');
    }
    getAll() {
        return Array.from(this.allProxies.values()).map((proxy) => ({ ...proxy, password: undefined }));
    }
    getAssignment(browserId) {
        return this.assignments.get(browserId) ?? null;
    }
    cancelCurrentFetch() {
        this.fetchController?.abort();
        this.fetchController = null;
    }
    /**
     * Fetches the user-selected source and assigns proxies directly.
     * No proxy connectivity validation, latency testing, scoring, or background
     * preparation is performed.
     */
    async fetchAssignDirect(browserIds, onAssignment, onProgress, sourceOptions = {}) {
        this.cancelCurrentFetch();
        const controller = new AbortController();
        this.fetchController = controller;
        try {
            const source = resolveProxySource(sourceOptions.source, sourceOptions.endpoint);
            const raw = source.id === exports.PROXY_SOURCE_IDS.allWorking
                ? await (0, AllWorkingProxyProvider_1.fetchAllWorkingProxyText)(controller.signal, source.endpoint)
                : await (0, ProxyScrapeProvider_1.fetchProxyScrapeFreeList)({ signal: controller.signal, endpoint: source.endpoint });
            if (controller.signal.aborted || this.fetchController !== controller) {
                throw new Error('Proxy API request cancelled.');
            }
            const parsed = (0, ProxyParser_1.parseBulkText)(raw, source.label);
            // Deduplicate by network endpoint so the same host:port is not assigned
            // to multiple browsers in the same cycle, regardless of protocol label.
            const endpointSeen = new Set();
            const proxies = [];
            for (const proxy of parsed.proxies) {
                const endpoint = `${proxy.host.toLowerCase()}:${proxy.port}`;
                if (endpointSeen.has(endpoint))
                    continue;
                endpointSeen.add(endpoint);
                proxies.push(proxy);
            }
            if (proxies.length === 0) {
                throw new Error(`${source.label} returned no usable proxy entries.`);
            }
            // Each rotation advances through the provider list. A dead proxy at
            // the top of a stable public feed therefore cannot pin a browser to
            // the same blank page on every cycle.
            const cursor = (this.sourceCursors.get(source.id) ?? 0) % proxies.length;
            const orderedProxies = [...proxies.slice(cursor), ...proxies.slice(0, cursor)];
            this.sourceCursors.set(source.id, (cursor + browserIds.length) % proxies.length);
            this.allProxies.clear();
            this.assignments.clear();
            for (const proxy of orderedProxies)
                this.allProxies.set(proxy.id, proxy);
            const assignedCount = Math.min(browserIds.length, orderedProxies.length);
            const total = orderedProxies.length;
            this.emit('reloadProgress', { checked: total, total });
            onProgress?.(total, total, total, assignedCount, parsed.proxies.length);
            for (let index = 0; index < assignedCount; index += 1) {
                const browserId = browserIds[index];
                const proxy = orderedProxies[index];
                this.assignments.set(browserId, proxy);
                onAssignment({ browserId, proxy }, total, total);
            }
            for (let index = assignedCount; index < browserIds.length; index += 1) {
                this.assignments.set(browserIds[index], null);
            }
            const summary = this.summary(browserIds, parsed.proxies.length, orderedProxies.length);
            this.emit('assignmentsChanged', summary);
            Logger_1.logger.info('proxy', `${source.label}: fetched=${parsed.proxies.length}, unique=${orderedProxies.length}, assigned=${assignedCount}/${browserIds.length}.`);
            return summary;
        }
        finally {
            if (this.fetchController === controller)
                this.fetchController = null;
        }
    }
    summary(browserIds, found, available) {
        return {
            found,
            countryMatched: found,
            working: available,
            assignments: browserIds.map((browserId) => ({
                browserId,
                proxy: this.assignments.get(browserId) ?? null
            }))
        };
    }
}
exports.ProxyManager = ProxyManager;
//# sourceMappingURL=ProxyManager.js.map
