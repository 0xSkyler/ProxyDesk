"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyManager = void 0;
const node_events_1 = require("node:events");
const ProxyParser_1 = require("../proxy/ProxyParser");
const AllWorkingProxyProvider_1 = require("../proxy/AllWorkingProxyProvider");
const Logger_1 = require("./Logger");
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class ProxyManager extends node_events_1.EventEmitter {
    allProxies = new Map();
    assignments = new Map();
    fetchController = null;
    failedEndpoints = new Set();
    async init() {
        this.cancelCurrentFetch();
        this.allProxies.clear();
        this.assignments.clear();
        this.failedEndpoints.clear();
        Logger_1.logger.info('proxy', 'Proxy manager ready: All Working API direct assignment.');
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
    markFailed(proxy) {
        if (proxy) this.failedEndpoints.add(`${proxy.host.toLowerCase()}:${proxy.port}`);
    }
    async replaceFailedAssignment(browserId, signal) {
        this.markFailed(this.getAssignment(browserId));
        this.assignments.set(browserId, null);
        const raw = await (0, AllWorkingProxyProvider_1.fetchAllWorkingProxyText)(signal);
        if (signal.aborted) throw new Error('Proxy API request cancelled.');
        const occupied = new Set(Array.from(this.assignments.values()).filter(Boolean)
            .map((proxy) => `${proxy.host.toLowerCase()}:${proxy.port}`));
        const parsed = (0, ProxyParser_1.parseBulkText)(raw, 'All Working API');
        const proxy = parsed.proxies.find((candidate) => {
            const endpoint = `${candidate.host.toLowerCase()}:${candidate.port}`;
            return !occupied.has(endpoint) && !this.failedEndpoints.has(endpoint);
        });
        if (!proxy) throw new Error('All Working API returned no unused replacement proxy.');
        this.assignments.set(browserId, proxy);
        this.allProxies.set(proxy.id, proxy);
        return proxy;
    }
    /**
     * Fetches the current all-working.txt response and assigns proxies directly.
     * No proxy connectivity validation, latency testing, scoring, or background
     * preparation is performed.
     */
    async fetchAssignDirect(browserIds, onAssignment, onProgress, retained = new Map()) {
        this.cancelCurrentFetch();
        this.assignments.clear();
        const endpointSeen = new Set(this.failedEndpoints);
        for (const id of browserIds) {
            const proxy = retained.get(id);
            if (!proxy) continue;
            this.assignments.set(id, proxy);
            endpointSeen.add(`${proxy.host.toLowerCase()}:${proxy.port}`);
        }
        let retainedStarted = false;
        const startRetained = () => {
            if (retainedStarted) return;
            retainedStarted = true;
            for (const id of browserIds) {
                const proxy = retained.get(id);
                if (proxy) onAssignment({ browserId: id, proxy }, 0, 0);
            }
        };
        const unassigned = browserIds.filter((id) => !this.assignments.has(id));
        const retainedCount = this.assignments.size;
        onProgress?.(0, 0, retainedCount, retainedCount, 0);
        if (!unassigned.length) {
            startRetained();
            this.allProxies = new Map(Array.from(this.assignments.values()).map((proxy) => [proxy.id, proxy]));
            const summary = this.summary(browserIds, 0, retainedCount);
            this.emit('assignmentsChanged', summary);
            return summary;
        }
        const controller = new AbortController();
        this.fetchController = controller;
        try {
            const raw = await (0, AllWorkingProxyProvider_1.fetchAllWorkingProxyText)(controller.signal);
            if (controller.signal.aborted || this.fetchController !== controller) {
                throw new Error('Proxy API request cancelled.');
            }
            const parsed = (0, ProxyParser_1.parseBulkText)(raw, 'All Working API');
            // Deduplicate by network endpoint so the same host:port is not assigned
            // to multiple browsers in the same cycle, regardless of protocol label.
            const proxies = [];
            for (const proxy of parsed.proxies) {
                const endpoint = `${proxy.host.toLowerCase()}:${proxy.port}`;
                if (endpointSeen.has(endpoint))
                    continue;
                endpointSeen.add(endpoint);
                proxies.push(proxy);
            }
            if (proxies.length === 0) {
                throw new Error('All Working API returned no usable proxy entries.');
            }
            this.allProxies.clear();
            for (const proxy of this.assignments.values()) this.allProxies.set(proxy.id, proxy);
            for (const proxy of proxies)
                this.allProxies.set(proxy.id, proxy);
            const assignedCount = Math.min(unassigned.length, proxies.length);
            const total = proxies.length;
            this.emit('reloadProgress', { checked: total, total });
            onProgress?.(total, total, total + retainedCount, assignedCount + retainedCount, parsed.proxies.length);
            startRetained();
            for (let index = 0; index < assignedCount; index += 1) {
                const browserId = unassigned[index];
                const proxy = proxies[index];
                this.assignments.set(browserId, proxy);
                onAssignment({ browserId, proxy }, total, total);
            }
            for (let index = assignedCount; index < unassigned.length; index += 1) {
                this.assignments.set(unassigned[index], null);
            }
            const summary = this.summary(browserIds, parsed.proxies.length, proxies.length + retainedCount);
            this.emit('assignmentsChanged', summary);
            Logger_1.logger.info('proxy', `All Working API: fetched=${parsed.proxies.length}, unique=${proxies.length}, assigned=${assignedCount}/${browserIds.length}.`);
            return summary;
        }
        finally {
            startRetained();
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