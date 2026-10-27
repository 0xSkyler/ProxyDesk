"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeoAutomationManager = void 0;
const node_events_1 = require("node:events");
const automation_1 = require("../shared/types/automation");
const browser_1 = require("../shared/types/browser");
const seo_1 = require("../shared/seo");
const ProxyManager_1 = require("./ProxyManager");
const ProxyTiers_1 = require("../proxy/ProxyTiers");
const Logger_1 = require("./Logger");
const { cancellableDelay, waitForPreparation } = require("./runtime");
const DEFAULT_PROXY_SOURCE = (0, ProxyManager_1.resolveProxySource)();
function createCycleController() {
    const controller = new AbortController();
    // One sleeping monitor per existing workspace is expected, not a leak.
    // Keep this allowance local and finite; Stop/rotation still detach all of
    // these listeners synchronously through cancellableDelay.
    node_events_1.setMaxListeners(browser_1.BROWSER_IDS.length, controller.signal);
    return controller;
}
/**
 * Single-purpose SEO Tracker orchestration:
 *
 * User-selected proxy API -> direct exclusive assignment
 * -> continuous Google monitoring -> challenge pause/resume
 * -> exact-host result click -> repeating same-host Keep Alive
 * -> rotate and restart on the user-configured cadence.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class SeoAutomationManager extends node_events_1.EventEmitter {
    proxyManager;
    browserManager;
    ensureBrowserCount;
    timer = null;
    generation = 0;
    pendingCycle = false;
    cycleController = createCycleController();
    state = {
        running: false,
        cycleInProgress: false,
        preparingBrowsers: false,
        preparedBrowsers: 0,
        proxySource: DEFAULT_PROXY_SOURCE.id,
        proxySourceLabel: DEFAULT_PROXY_SOURCE.label,
        proxyApiUrl: DEFAULT_PROXY_SOURCE.endpoint,
        proxyTier: null, // Legacy direct API callers without the UI remain unchanged.
        query: '',
        targetWebsite: '',
        intervalSec: 600,
        browserCount: 10,
        maxPages: 20,
        browserIds: [],
        cycleNumber: 0,
        fetchedProxies: 0,
        checkedProxies: 0,
        totalProxies: 0,
        liveProxies: 0,
        assignedBrowsers: 0,
        retainedBrowsers: 0,
        replacedBrowsers: 0
    };
    constructor(proxyManager, browserManager, ensureBrowserCount) {
        super();
        this.proxyManager = proxyManager;
        this.browserManager = browserManager;
        this.ensureBrowserCount = ensureBrowserCount;
    }
    getState() {
        return { ...this.state, browserIds: [...this.state.browserIds] };
    }
    isRunning() {
        return this.state.running;
    }
    configureProxy(config) {
        if (this.state.running)
            throw new Error('Stop SEO Tracker before changing the proxy source.');
        const source = (0, ProxyManager_1.resolveProxySource)(config?.source, config?.endpoint);
        const requestedTier = config?.tier ?? this.state.proxyTier;
        const tier = requestedTier == null ? null : (0, ProxyTiers_1.resolveProxyTier)(requestedTier);
        this.state = {
            ...this.state,
            proxySource: source.id,
            proxySourceLabel: source.label,
            proxyApiUrl: source.endpoint,
            proxyTier: tier
        };
        this.emitState();
        return this.getState();
    }
    async start(config) {
        const query = config.query.trim();
        const keywords = parseAutomationKeywords(query);
        const targetWebsite = config.targetWebsite.trim();
        const targetHost = (0, seo_1.normalizeTargetHost)(targetWebsite);
        const requestedInteractionHost = (0, seo_1.normalizeTargetHost)(config.controlledTestHost ?? '');
        if (keywords.length === 0)
            throw new Error('Enter at least one Google search keyword.');
        if (!targetHost)
            throw new Error('Enter a valid target website or site name.');
        // Target website is the interaction host by default. An explicit override
        // is allowed only when it resolves to the exact same hostname, so result
        // opening and Keep Alive can never drift to a different site.
        const controlledTestHost = requestedInteractionHost || targetHost;
        if (controlledTestHost !== targetHost) {
            throw new Error('Interaction host must exactly match the Target website host.');
        }
        const browserCount = (0, automation_1.normalizeBrowserCount)(config.browserCount);
        const maxPages = (0, automation_1.normalizeSeoMaxPages)(config.maxPages);
        const intervalSec = (0, automation_1.normalizeAutomationIntervalSeconds)(config.intervalSec);
        const proxySource = (0, ProxyManager_1.resolveProxySource)(config.proxySource ?? this.state.proxySource, config.proxyApiUrl ?? this.state.proxyApiUrl);
        const requestedTier = config.proxyTier ?? this.state.proxyTier;
        const proxyTier = requestedTier == null ? null : (0, ProxyTiers_1.resolveProxyTier)(requestedTier);
        if (keywords.length > browserCount) {
            throw new Error(`Select at least ${keywords.length} browsers to run all keywords at the same time.`);
        }
        this.stopTimerOnly();
        this.proxyManager.cancelCurrentFetch();
        this.generation += 1;
        const generation = this.generation;
        this.cycleController.abort();
        this.cycleController = createCycleController();
        this.pendingCycle = false;
        // Publish state before any browser preparation. The Start button therefore
        // reacts instantly even if Electron still has browser shells to create.
        this.state = {
            running: true,
            cycleInProgress: true,
            preparingBrowsers: true,
            preparedBrowsers: 0,
            proxySource: proxySource.id,
            proxySourceLabel: proxySource.label,
            proxyApiUrl: proxySource.endpoint,
            proxyTier,
            query,
            targetWebsite,
            controlledTestHost: controlledTestHost || undefined,
            intervalSec,
            browserCount,
            maxPages,
            browserIds: [],
            cycleNumber: 0,
            fetchedProxies: 0,
            checkedProxies: 0,
            totalProxies: 0,
            liveProxies: 0,
            assignedBrowsers: 0,
            retainedBrowsers: 0,
            replacedBrowsers: 0,
            nextCycleAt: undefined
        };
        this.emitState();
        let browserIds;
        try {
            const signal = this.cycleController.signal;
            browserIds = await waitForPreparation(this.ensureBrowserCount(browserCount, {
                signal,
                onProgress: (readyIds) => {
                    if (!this.isCurrent(generation) || !this.state.preparingBrowsers) return;
                    this.state = { ...this.state, preparedBrowsers: readyIds.length, browserIds: [...readyIds] };
                    this.emitState();
                }
            }), 60_000, signal, 'Browser preparation timed out. Try fewer browsers or retry Start.');
        }
        catch (err) {
            if (!this.isCurrent(generation)) return this.getState();
            this.cycleController.abort();
            this.state = {
                ...this.state,
                running: false,
                cycleInProgress: false,
                preparingBrowsers: false,
                nextCycleAt: undefined,
                lastError: `Browser preparation failed: ${err.message}`
            };
            this.emitState();
            throw err;
        }
        if (!this.isCurrent(generation)) return this.getState();
        if (browserIds.length === 0) {
            this.state = {
                ...this.state,
                running: false,
                cycleInProgress: false,
                preparingBrowsers: false,
                nextCycleAt: undefined,
                lastError: 'No browser workspaces are available.'
            };
            this.emitState();
            throw new Error('No browser workspaces are available.');
        }
        this.state = {
            ...this.state,
            cycleInProgress: false,
            preparingBrowsers: false,
            preparedBrowsers: browserIds.length,
            browserIds,
            nextCycleAt: new Date(Date.now() + intervalSec * 1000).toISOString()
        };
        this.emitState();
        this.timer = setInterval(() => {
            if (!this.state.running)
                return;
            this.state = {
                ...this.state,
                nextCycleAt: new Date(Date.now() + this.state.intervalSec * 1000).toISOString()
            };
            this.emitState();
            void this.requestCycle();
        }, intervalSec * 1000);
        void this.requestCycle();
        return this.getState();
    }
    stop() {
        this.cycleController.abort();
        this.generation += 1;
        this.pendingCycle = false;
        this.proxyManager.cancelCurrentFetch();
        this.stopTimerOnly();
        for (const id of this.state.browserIds) {
            try {
                this.browserManager.cancelMeasurementSession(id);
                this.browserManager.setBrowserKeepAlive(id, false, false);
            }
            catch {
                // Browser may already have been removed.
            }
        }
        this.state = {
            ...this.state,
            running: false,
            cycleInProgress: false,
            preparingBrowsers: false,
            nextCycleAt: undefined
        };
        this.emitState();
        return this.getState();
    }
    async runNow() {
        if (!this.state.running)
            throw new Error('Start SEO Tracker first.');
        await this.requestCycle();
        return this.getState();
    }
    stopTimerOnly() {
        if (!this.timer)
            return;
        clearInterval(this.timer);
        this.timer = null;
    }
    emitState() {
        this.emit('stateChanged', this.getState());
    }
    async requestCycle() {
        if (!this.state.running)
            return;
        if (this.state.cycleInProgress) {
            this.pendingCycle = true;
            return;
        }
        await this.runCycle();
    }
    async runCycle() {
        if (!this.state.running)
            return;
        const generation = this.generation;
        this.cycleController.abort();
        this.cycleController = createCycleController();
        const cycleNumber = this.state.cycleNumber + 1;
        const browserIds = [...this.state.browserIds];
        const { query, targetWebsite, controlledTestHost, maxPages, proxySource, proxyApiUrl, proxyTier } = this.state;
        const keywords = parseAutomationKeywords(query);
        const browserQueries = new Map(browserIds.map((browserId, index) =>
            [browserId, keywords[(index + cycleNumber - 1) % keywords.length] ?? query]));
        // A selected country tier always fetches and assigns directly.
        // Prior Google results, CAPTCHA flags, and connection outcomes are
        // never used to pre-validate, score, or choose tier proxies.
        const directTier = proxyTier != null;
        const rotationStates = directTier ? new Map() : new Map(browserIds.map(id => [id, this.browserManager.getProxyRotationState(id)]));
        const retained = !directTier && cycleNumber > 1 ? browserIds.filter(id => {
            const health = rotationStates.get(id);
            return health.proxy && health.targetOpened && !health.captchaSeen && !health.failed;
        }).map(browserId => ({ browserId, proxy: rotationStates.get(browserId).proxy, retained: true })) : [];
        const retainedIds = new Set(retained.map(assignment => assignment.browserId));
        const replacementIds = browserIds.filter(id => !retainedIds.has(id));
        const failedProxies = !directTier && cycleNumber > 1
            ? replacementIds.map(id => rotationStates.get(id).proxy).filter(Boolean) : [];
        this.state = {
            ...this.state,
            cycleInProgress: true,
            cycleNumber,
            fetchedProxies: 0,
            checkedProxies: 0,
            totalProxies: 0,
            liveProxies: retained.length,
            assignedBrowsers: retained.length,
            retainedBrowsers: retained.length,
            replacedBrowsers: 0,
            lastCycleStartedAt: new Date().toISOString(),
            lastError: undefined
        };
        this.emitState();
        const seoTasks = [];
        try {
            // Stop outgoing work before navigation; keep all session data.
            for (const id of browserIds) {
                if (!this.isCurrent(generation))
                    return;
                this.browserManager.cancelMeasurementSession(id);
                this.browserManager.setBrowserKeepAlive(id, false, false);
            }
            const cleanupController = this.cycleController;
            const signal = cleanupController.signal;
            let nextBrowser = 0;
            const cleanBrowser = async () => {
                while (nextBrowser < browserIds.length && this.isCurrent(generation) && !signal.aborted) {
                    const id = browserIds[nextBrowser++];
                    if (!retainedIds.has(id)) {
                        await waitForPreparation(this.browserManager.assignProxy(id, null), 15_000, signal,
                            `Browser ${id} proxy reset timed out before the next cycle.`);
                    }
                    if (!this.isCurrent(generation) || signal.aborted) return;
                    await waitForPreparation(this.browserManager.prepareCycleDocument(id, signal), 15_000, signal,
                        `Browser ${id} page preparation timed out before the next cycle.`);
                    if (!this.isCurrent(generation) || signal.aborted) return;
                }
            };
            // Bound page preparation to two browsers at a time on small PCs.
            // Proxy fetching/searching starts only after all pages are released.
            // No cache, cookie or local-storage clearing occurs.
            try {
                await Promise.all(Array.from({ length: Math.min(2, browserIds.length) }, cleanBrowser));
            } catch (error) { cleanupController.abort(); throw error; }
            if (!this.isCurrent(generation) || signal.aborted) return;
            for (const assignment of retained) {
                const browserQuery = browserQueries.get(assignment.browserId);
                seoTasks.push(this.handleAssignment(generation, cycleNumber, assignment, browserQuery,
                    targetWebsite, controlledTestHost, maxPages));
            }
            // Healthy browsers start the next keyword even if the provider is
            // unavailable. An all-healthy cycle needs no API request at all.
            if (replacementIds.length) await this.proxyManager.fetchAssignDirect(replacementIds, (assignment) => {
                if (!this.isCurrent(generation) || this.state.cycleNumber !== cycleNumber)
                    return;
                const browserQuery = browserQueries.get(assignment.browserId) ?? query;
                seoTasks.push(this.handleAssignment(generation, cycleNumber, assignment, browserQuery, targetWebsite, controlledTestHost, maxPages));
            }, (checked, total, working, assigned, fetched) => {
                if (!this.isCurrent(generation))
                    return;
                this.state = {
                    ...this.state,
                    fetchedProxies: fetched,
                    checkedProxies: checked,
                    totalProxies: total,
                    liveProxies: working + retained.length,
                    assignedBrowsers: assigned + retained.length,
                    replacedBrowsers: assigned
                };
                this.emitState();
            }, { source: proxySource, endpoint: proxyApiUrl, tier: proxyTier, retainedAssignments: retained, failedProxies });
            await Promise.allSettled(seoTasks);
            if (!this.isCurrent(generation))
                return;
            this.state = {
                ...this.state,
                cycleInProgress: false,
                lastCycleCompletedAt: new Date().toISOString()
            };
            this.emitState();
            Logger_1.logger.info('application', `SEO cycle ${cycleNumber} (${keywords.join(', ')}) complete: ${this.state.liveProxies} available, ` +
                `${this.state.assignedBrowsers}/${browserIds.length} browser(s) assigned.`);
        }
        catch (err) {
            if (!this.isCurrent(generation))
                return;
            this.state = {
                ...this.state,
                cycleInProgress: false,
                lastCycleCompletedAt: new Date().toISOString(),
                lastError: err.message
            };
            this.emitState();
            Logger_1.logger.warn('application', `SEO cycle ${cycleNumber} failed: ${err.message}`);
        }
        finally {
            if (this.isCurrent(generation) && this.pendingCycle) {
                this.pendingCycle = false;
                void this.requestCycle();
            }
        }
    }
    async handleAssignment(generation, cycleNumber, assignment, query, targetWebsite, controlledTestHost, maxPages) {
        if (!assignment.proxy || !this.isCurrent(generation) || this.state.cycleNumber !== cycleNumber)
            return;
        const { browserId, proxy } = assignment;
        try {
            if (assignment.retained) this.browserManager.beginProxyCycle(browserId);
            else await this.browserManager.assignProxy(browserId, proxy);
            if (!this.isCurrent(generation) || this.state.cycleNumber !== cycleNumber)
                return;
            this.browserManager.setBrowserKeepAlive(browserId, false, false);
            const measurementToken = this.browserManager.startMeasurementSession(browserId);
            // Run the measurement loop for the lifetime of this proxy cycle. Each
            // browser is invalidated as soon as the next rotation begins.
            void this.monitorBrowserSession(generation, cycleNumber, browserId, measurementToken, query, targetWebsite, controlledTestHost, maxPages);
        }
        catch (err) {
            if (!this.isCurrent(generation))
                return;
            this.browserManager.setBrowserKeepAlive(browserId, false, false);
            this.emit('seoResult', {
                cycleNumber,
                result: {
                    browserId,
                    status: 'error',
                    error: err.message,
                    ranAt: new Date().toISOString()
                }
            });
        }
    }
    async monitorBrowserSession(generation, cycleNumber, browserId, measurementToken, query, targetWebsite, controlledTestHost, maxPages) {
        const signal = this.cycleController.signal;
        const observationIntervalMs = 30_000;
        const interactionHost = controlledTestHost || (0, seo_1.normalizeTargetHost)(targetWebsite);
        if (!interactionHost)
            return;
        while (this.isCurrent(generation) &&
            this.state.cycleNumber === cycleNumber &&
            this.browserManager.isMeasurementSessionCurrent(browserId, measurementToken)) {
            let result;
            try {
                result = await this.browserManager.broadcastSearch(browserId, query, targetWebsite, maxPages, measurementToken);
            }
            catch (err) {
                if (!this.isCurrent(generation) ||
                    this.state.cycleNumber !== cycleNumber ||
                    !this.browserManager.isMeasurementSessionCurrent(browserId, measurementToken)) {
                    return;
                }
                this.emit('seoResult', {
                    cycleNumber,
                    result: {
                        browserId,
                        status: 'error',
                        error: err.message,
                        monitoring: true,
                        ranAt: new Date().toISOString()
                    }
                });
                await cancellableDelay(5_000, signal);
                continue;
            }
            if (!this.isCurrent(generation) ||
                this.state.cycleNumber !== cycleNumber ||
                !this.browserManager.isMeasurementSessionCurrent(browserId, measurementToken)) {
                return;
            }
            if (result.status === 'matched' &&
                result.interactionStatus === 'opened' &&
                result.matchedUrl) {
                const landedUrl = result.landedUrl || result.matchedUrl;
                const keepAliveHost = (0, seo_1.hostMatchesTarget)(landedUrl, interactionHost)
                    ? (0, seo_1.normalizeTargetHost)(landedUrl) : interactionHost;
                this.browserManager.startControlledKeepAlive(browserId, keepAliveHost);
                this.emit('seoResult', {
                    cycleNumber,
                    result: {
                        ...result,
                        keepAliveStarted: true
                    }
                });
                return;
            }
            if (result.status === 'matched' &&
                result.interactionStatus === 'click-failed') {
                this.emit('seoResult', { cycleNumber, result });
                await cancellableDelay(3_000, signal);
                continue;
            }
            if (result.status === 'matched' && result.matchedUrl) {
                let matchedHost = '';
                try {
                    matchedHost = new URL(result.matchedUrl).hostname
                        .toLowerCase()
                        .replace(/^www\./, '')
                        .replace(/\.$/, '');
                }
                catch {
                    matchedHost = '';
                }
                if (matchedHost !== interactionHost) {
                    this.emit('seoResult', {
                        cycleNumber,
                        result: {
                            ...result,
                            interactionStatus: 'click-failed',
                            error: `Matched result host ${matchedHost || 'unknown'} does not equal configured interaction host ${interactionHost}.`
                        }
                    });
                    await cancellableDelay(3_000, signal);
                    continue;
                }
                this.emit('seoResult', {
                    cycleNumber,
                    result: {
                        ...result,
                        interactionStatus: 'opening'
                    }
                });
                const clicked = await this.browserManager.clickControlledGoogleResult(browserId, query, interactionHost, result.matchedUrl, measurementToken);
                if (clicked) {
                    this.browserManager.startControlledKeepAlive(browserId, interactionHost);
                    this.emit('seoResult', {
                        cycleNumber,
                        result: {
                            ...result,
                            landedUrl: result.matchedUrl,
                            interactionStatus: 'opened',
                            keepAliveStarted: true
                        }
                    });
                    return;
                }
                this.emit('seoResult', {
                    cycleNumber,
                    result: {
                        ...result,
                        interactionStatus: 'click-failed',
                        error: 'Target was detected, but the result could not be opened. DOM will retry in this session.'
                    }
                });
                await cancellableDelay(3_000, signal);
                continue;
            }
            this.emit('seoResult', { cycleNumber, result });
            if (result.status === 'paused') {
                // Leave the current challenge available for manual recovery.
                // The CAPTCHA flag remains sticky: this proxy will be replaced
                // at the next cycle even if normal results return meanwhile.
                const recovered = await this.browserManager.waitForGoogleRecovery(browserId, observationIntervalMs);
                if (!recovered) {
                    await cancellableDelay(1_000, signal);
                }
                continue;
            }
            // Matched and no-match observations are measurements, not terminal
            // states. Recheck periodically until the next proxy rotation.
            // Unfinished pages keep their live preload and document. Resume
            // promptly so a newly rendered target is clicked instead of
            // sleeping for 30 seconds and then reloading it away.
            await cancellableDelay(result.status === 'monitoring' ? 250 : observationIntervalMs, signal);
        }
    }
    isCurrent(generation) {
        return this.state.running && generation === this.generation;
    }
}
exports.SeoAutomationManager = SeoAutomationManager;
function parseAutomationKeywords(value) {
    return value
        .split(',')
        .map((keyword) => keyword.trim())
        .filter(Boolean);
}
//# sourceMappingURL=SeoAutomationManager.js.map
