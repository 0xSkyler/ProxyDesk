"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeoAutomationManager = void 0;
const node_events_1 = require("node:events");
const automation_1 = require("../shared/types/automation");
const browser_1 = require("../shared/types/browser");
const seo_1 = require("../shared/seo");
const Logger_1 = require("./Logger");
const { cancellableDelay } = require("./runtime");
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
 * All Working API -> direct exclusive assignment
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
        proxySource: 'All Working API',
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
        assignedBrowsers: 0
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
            proxySource: 'All Working API',
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
            nextCycleAt: new Date(Date.now() + intervalSec * 1000).toISOString()
        };
        this.emitState();
        let browserIds;
        try {
            browserIds = await this.ensureBrowserCount(browserCount);
        }
        catch (err) {
            if (!this.isCurrent(generation)) return this.getState();
            this.state = {
                ...this.state,
                running: false,
                cycleInProgress: false,
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
                nextCycleAt: undefined,
                lastError: 'No browser workspaces are available.'
            };
            this.emitState();
            throw new Error('No browser workspaces are available.');
        }
        this.state = {
            ...this.state,
            cycleInProgress: false,
            browserIds
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
        const { query, targetWebsite, controlledTestHost, maxPages } = this.state;
        const keywords = parseAutomationKeywords(query);
        const browserQueries = new Map(browserIds.map((browserId, index) => [browserId, keywords[index % keywords.length] ?? query]));
        this.state = {
            ...this.state,
            cycleInProgress: true,
            cycleNumber,
            fetchedProxies: 0,
            checkedProxies: 0,
            totalProxies: 0,
            liveProxies: 0,
            assignedBrowsers: 0,
            lastCycleStartedAt: new Date().toISOString(),
            lastError: undefined
        };
        this.emitState();
        const seoTasks = [];
        try {
            // Every rotation starts from a clean browser routing state.
            for (const id of browserIds) {
                if (!this.isCurrent(generation))
                    return;
                this.browserManager.cancelMeasurementSession(id);
                this.browserManager.setBrowserKeepAlive(id, false, false);
                await this.browserManager.assignProxy(id, null);
            }
            await this.proxyManager.fetchAssignDirect(browserIds, (assignment) => {
                if (!this.isCurrent(generation))
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
                    liveProxies: working,
                    assignedBrowsers: assigned
                };
                this.emitState();
            });
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
        if (!assignment.proxy || !this.isCurrent(generation))
            return;
        const { browserId, proxy } = assignment;
        try {
            await this.browserManager.assignProxy(browserId, proxy);
            if (!this.isCurrent(generation))
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
                this.browserManager.startControlledKeepAlive(browserId, interactionHost);
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
                        error: 'Target was detected, but the result could not be opened. ProxyDesk will retry in this session.'
                    }
                });
                await cancellableDelay(3_000, signal);
                continue;
            }
            this.emit('seoResult', { cycleNumber, result });
            if (result.status === 'paused') {
                // Keep the same browser, proxy, cookies, and Google session. We do not
                // solve or bypass the challenge; we simply wait for normal results to
                // return, then resume the saved keyword/website measurement.
                const recovered = await this.browserManager.waitForGoogleRecovery(browserId, observationIntervalMs);
                if (!recovered) {
                    await cancellableDelay(1_000, signal);
                }
                continue;
            }
            // Matched and no-match observations are measurements, not terminal
            // states. Recheck periodically until the next proxy rotation.
            await cancellableDelay(observationIntervalMs, signal);
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
