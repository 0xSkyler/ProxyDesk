"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserManager = void 0;
exports.buildEphemeralPartitionName = buildEphemeralPartitionName;
exports.extractGoogleBlockContinueUrl = extractGoogleBlockContinueUrl;
exports.buildKeepAliveActionScript = buildKeepAliveActionScript;
exports.buildInstallGoogleLiveTargetObserverScript = buildInstallGoogleLiveTargetObserverScript;
exports.buildReadGoogleLiveTargetObserverScript = buildReadGoogleLiveTargetObserverScript;
exports.buildClickGoogleLiveTargetObserverScript = buildClickGoogleLiveTargetObserverScript;
exports.buildStopGoogleLiveTargetObserverScript = buildStopGoogleLiveTargetObserverScript;
exports.buildGoogleResultScanScript = buildGoogleResultScanScript;
exports.buildClickGoogleTargetResultScript = buildClickGoogleTargetResultScript;
const node_events_1 = require("node:events");
const electron_1 = require("electron");
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const constants_1 = require("../shared/constants");
const seo_1 = require("../shared/seo");
const { inspectGooglePrompt, recognizeGoogleResults, installGoogleResultObserver } = require('../preload/google-results');
const Logger_1 = require("./Logger");
const { withTimeout, waitForPreparation, preparationCancelled } = require("./runtime");
/** Cap on automatic proxy swaps triggered by hitting Google's CAPTCHA page
 * in a row, before giving up and leaving it for a manual "Change Proxy"
 * click — without this, a proxy pool that's mostly Google-flagged (a real
 * possibility with free/public lists) could otherwise have a browser
 * silently burning through proxies forever. Resets on the next explicit
 * navigate() (fresh intent) or once a page loads that ISN'T the block page. */
const MAX_GOOGLE_BLOCK_RETRIES = 3;
/**
 * If `url` is Google's "unusual traffic" / CAPTCHA interstitial
 * (`google.<tld>/sorry/...`), returns the page it was guarding — pulled
 * from the interstitial's own `continue=` query param, which Google always
 * sets to the original request URL — so a retry can go straight back to
 * what the user/browser actually wanted instead of reloading the
 * interstitial itself. Returns null for any other URL.
 */
function buildEphemeralPartitionName(id, pid = process.pid) {
    // No "persist:" prefix means Electron keeps the partition in memory only.
    // Browser id prevents sharing inside one run; process id prevents reuse
    // after the app exits and starts again.
    return `${constants_1.EPHEMERAL_PARTITION_PREFIX}${id}-${pid}`;
}
function extractGoogleBlockContinueUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return null;
    }
    if (!/(^|\.)google\.[a-z.]+$/i.test(parsed.hostname))
        return null;
    if (!parsed.pathname.startsWith('/sorry/'))
        return null;
    const continueParam = parsed.searchParams.get('continue');
    return continueParam || url;
}
function isGoogleConsentUrl(value) {
    try {
        const url = new URL(value);
        return /^https?:$/.test(url.protocol) && /^consent\.google\.(?:[a-z]{2,3}|(?:co|com)\.[a-z]{2})$/i.test(url.hostname);
    } catch { return false; }
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- standard Node EventEmitter typed-events pattern
class BrowserManager extends node_events_1.EventEmitter {
    browsers = new Map();
    window = null;
    activeId = null;
    globalLoginHandlerInstalled = false;
    keepAliveTimer = null;
    keepAliveIntervalMs = 60_000;
    keepAliveMaxHops = 25;
    keepAliveFollowLinks = true;
    keepAliveWatchdogMs = 18_000;
    keepAliveActionTimeoutMs = 14_000;
    measurementTokens = new Map();
    creating = new Map();
    disposing = new Map();
    disposed = false;
    loginHandler = null;
    partitionSequence = 0;
    reusablePartitions = new Map();
    preparationTimeoutMs = 15_000;
    legacyCleanupTimeoutMs = 2_000;
    clearedLegacyPartitions = new Set();
    attachWindow(window) {
        this.window = window;
        this.installGlobalLoginHandler();
    }
    /**
     * Installed exactly once per app lifetime (see class doc above). Routes
     * each proxy-auth challenge to the specific managed browser whose
     * WebContents triggered it, using that browser's own assigned proxy
     * credentials — never a different browser's.
     */
    installGlobalLoginHandler() {
        if (this.globalLoginHandlerInstalled)
            return;
        this.globalLoginHandlerInstalled = true;
        this.loginHandler = (event, webContents, _details, authInfo, callback) => {
            if (!authInfo.isProxy)
                return; // let page-level basic-auth challenges use Electron's default handling
            const managed = Array.from(this.browsers.values()).find((m) => m.view.webContents.id === webContents.id);
            const proxy = managed?.state.proxy;
            if (proxy?.username) {
                event.preventDefault();
                callback(proxy.username, proxy.password);
            }
            else {
                // No credentials configured for this browser's proxy — let Electron
                // fall through to its default (cancel) behavior rather than hanging.
            }
        };
        electron_1.app.on('login', this.loginHandler);
    }
    partitionFor(id, _persist) {
        const clean = this.reusablePartitions.get(id);
        if (clean) {
            this.reusablePartitions.delete(id);
            return clean;
        }
        // Recreated IDs must not reuse a session whose delayed storage cleanup
        // can still finish after a cancelled/failed preparation.
        return `${buildEphemeralPartitionName(id)}-${++this.partitionSequence}`;
    }
    async clearLegacyPersistentPartition(id) {
        if (this.clearedLegacyPartitions.has(id)) return;
        this.clearedLegacyPartitions.add(id);
        // Opening a nonexistent persistent partition creates another Chromium
        // storage/network context. Most IDs (especially newly added browsers)
        // have no legacy files at all, so avoid that expensive empty migration.
        if (!existsSync(join(electron_1.app.getPath('sessionData'), 'Partitions', `browser-${id}`))) return;
        const legacy = electron_1.session.fromPartition(`${constants_1.PARTITION_PREFIX}${id}`, { cache: true });
        await Promise.allSettled([legacy.clearStorageData(), legacy.clearCache()]);
    }
    async purgeLegacyPersistentSessions(ids) {
        for (const id of ids) {
            await this.clearLegacyPersistentPartition(id);
        }
    }
    async createBrowser(id, options) {
        if (this.disposed) return;
        if (this.creating.has(id)) return this.creating.get(id);
        const work = this.createBrowserOwned(id, options);
        this.creating.set(id, work);
        try { await work; } finally { this.creating.delete(id); }
    }
    async createBrowserOwned(id, options) {
        const { signal } = options;
        if (signal?.aborted) throw preparationCancelled();
        await waitForPreparation(this.disposing.get(id), this.preparationTimeoutMs, signal,
            `Browser ${id} cleanup timed out. Stop and retry with fewer browsers.`);
        if (this.disposed || signal?.aborted) throw preparationCancelled();
        if (this.browsers.has(id))
            return;
        // Legacy cleanup is a bounded migration, never a prerequisite for
        // isolation: the new browser uses a fresh in-memory-only partition.
        try {
            await waitForPreparation(this.clearLegacyPersistentPartition(id), this.legacyCleanupTimeoutMs, signal,
                `Browser ${id} legacy storage cleanup timed out; using a fresh memory session.`);
        } catch (error) {
            if (signal?.aborted) throw error;
            Logger_1.logger.warn('browser', error.message);
        }
        if (this.disposed || signal?.aborted) throw preparationCancelled();
        const partition = this.partitionFor(id, options.persistSessions);
        const ses = electron_1.session.fromPartition(partition, { cache: true });
        // A unique partition without "persist:" is already empty. Clearing it
        // immediately would add two native storage waits to every new browser.
        if (options.userAgent)
            ses.setUserAgent(options.userAgent);
        const view = new electron_1.BrowserView({
            webPreferences: {
                session: ses,
                preload: join(__dirname, '../preload/google-results.js'),
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
                webSecurity: true
            }
        });
        const state = {
            id,
            label: `Browser ${id}`,
            url: normalizeUrl(options.startPage),
            loading: false,
            canGoBack: false,
            canGoForward: false,
            proxy: null,
            connectionStatus: 'idle',
            crashCount: 0,
            keepAliveEnabled: false,
            keepAliveHops: 0,
            keepAliveActivity: 'idle',
            keepAliveFailureCount: 0
        };
        const managed = {
            id,
            view,
            partition,
            session: ses,
            state,
            proxyHealth: { googleReached: false, failed: false },
            restartAttempts: 0,
            googleBlockRetries: 0,
            keepAliveEnabled: false,
            keepAliveHops: 0,
            keepAliveNextAt: Date.now() + this.keepAliveIntervalMs,
            keepAliveBusy: false,
            keepAliveBusySince: 0,
            keepAliveGeneration: 0,
            keepAliveLastHeartbeatAt: 0,
            keepAliveFailureCount: 0,
            keepAliveVisited: new Set(),
            controlledKeepAliveHost: null,
            controlledKeepAliveContinuous: false
        };
        this.browsers.set(id, managed);
        this.wireEvents(managed, options);
        const startUrl = normalizeUrl(options.startPage);
        try {
            this.window?.addBrowserView(view);
            await waitForPreparation(view.webContents.loadURL(startUrl), this.preparationTimeoutMs, signal,
                `Browser ${id} initialization timed out. Try fewer browsers or retry Start.`);
            if (this.disposed || signal?.aborted) throw preparationCancelled();
        } catch (error) {
            // Close a partial renderer immediately. Waiting for its own creating
            // promise via destroyBrowser here would deadlock.
            managed.disposed = true;
            if (this.browsers.get(id) === managed) this.browsers.delete(id);
            if (this.window && !this.window.isDestroyed()) this.window.removeBrowserView(view);
            if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
            Logger_1.logger.warn('browser', `Browser ${id} failed initial load: ${error.message}`);
            throw error;
        }
    }
    wireEvents(managed, options) {
        const { view, id } = managed;
        const wc = view.webContents;
        // Treat "loading" as main-document readiness, not as "every network
        // request on the page has finished". Modern sites can keep requests open
        // indefinitely; DOM automation must not be blocked by those background
        // requests. As soon as the document DOM exists, the browser is usable.
        const readyStatus = () => {
            const currentUrl = wc.getURL();
            if (!currentUrl || currentUrl === 'about:blank')
                return managed.state.proxy ? 'proxy-checking' : 'idle';
            if (managed.googleConfig && isGoogleSearchResultsUrl(currentUrl) && !managed.googleState?.observedResults)
                return 'loading';
            return 'connected';
        };
        wc.on('ipc-message', (event, channel, payload) => {
            // Recognition runs in an isolated, sandboxed preload. Only accept
            // messages from this browser's current main frame and search cycle.
            if (managed.disposed || wc.isDestroyed()) return;
            try {
                const sender = event.senderFrame, main = wc.mainFrame;
                // Native frame identity is its process/routing pair. Electron
                // can provide different JS wrappers for the same frame.
                if (!sender || (sender !== main &&
                    (!Number.isInteger(sender.processId) || !Number.isInteger(sender.routingId) ||
                    sender.processId < 0 || sender.routingId < 0 ||
                    sender.processId !== main.processId || sender.routingId !== main.routingId))) return;
            } catch {
                // A queued handshake can outlive its render frame on Stop.
                return;
            }
            if (channel === 'dom:renderer-cache-cleared') {
                if (managed.rendererCacheRequest?.requestId === payload?.requestId)
                    managed.rendererCacheRequest.finish(payload.error);
                return;
            }
            if (channel === 'dom:google-preload-ready') {
                try {
                    event.reply('dom:google-config', managed.googleConfig || null);
                    if (managed.rendererCacheRequest) event.reply('dom:clear-renderer-cache', managed.rendererCacheRequest.requestId);
                }
                catch { /* Navigation or cancellation disposed the sender frame. */ }
                return;
            }
            if (channel === 'dom:google-prompt-state') {
                try {
                    const url = new URL(payload?.documentUrl);
                    if (payload.documentUrl !== wc.getURL() || !/^https?:$/.test(url.protocol) ||
                        !/(^|\.)google\.(?:[a-z]{2,3}|(?:co|com)\.[a-z]{2})$/i.test(url.hostname)) return;
                    managed.googlePromptState = payload;
                } catch { /* Ignore a prompt report from a replaced document. */ }
                return;
            }
            const config = managed.googleConfig;
            if (channel !== 'dom:google-state' || !config || !payload ||
                payload.navigation !== config.navigation || payload.token !== config.token ||
                !isGoogleSearchResultsUrl(payload.documentUrl)) return;
            const url = new URL(payload.documentUrl);
            if (url.searchParams.get('q') !== config.query || (url.searchParams.get('start') || '0') !== config.start) return;
            if (config.token != null && !this.isMeasurementSessionCurrent(id, config.token)) return;
            managed.googleState = payload.state;
            if (payload.state?.observedResults) {
                if (managed.state.proxy) managed.proxyHealth.googleReached = true;
                const activity = payload.state.match ? 'opening-target' : 'scanning-results';
                if (managed.state.loading || managed.state.connectionStatus !== 'connected' || managed.state.googleSearchActivity !== activity)
                    this.updateState(managed, { loading: false, connectionStatus: 'connected', googleSearchActivity: activity });
            }
        });
        wc.on('did-start-loading', () => this.updateState(managed, { loading: true, connectionStatus: 'loading', errorMessage: undefined }));
        wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
            if (isMainFrame && !isInPlace) managed.mainNavigationSequence = (managed.mainNavigationSequence || 0) + 1;
        });
        wc.on('dom-ready', () => {
            if (extractGoogleBlockContinueUrl(wc.getURL()))
                return;
            this.updateState(managed, {
                loading: false,
                canGoBack: wc.canGoBack(),
                canGoForward: wc.canGoForward(),
                connectionStatus: readyStatus(),
                errorMessage: undefined
            });
        });
        wc.on('did-stop-loading', () => {
            if (extractGoogleBlockContinueUrl(wc.getURL()))
                return;
            this.updateState(managed, {
                loading: false,
                canGoBack: wc.canGoBack(),
                canGoForward: wc.canGoForward(),
                connectionStatus: managed.state.connectionStatus === 'proxy-failed'
                    ? 'proxy-failed'
                    : readyStatus()
            });
        });
        wc.on('did-navigate', (_e, url, httpResponseCode) => {
            // A committed Google response proves reachability without waiting
            // for Ready or adding a separate proxy-validation request.
            try {
                const parsed = new URL(url);
                if (managed.state.proxy && httpResponseCode >= 100 && httpResponseCode < 600 &&
                    /(^|\.)google\.(?:[a-z]{2,3}|(?:co|com)\.[a-z]{2})$/i.test(parsed.hostname))
                    managed.proxyHealth.googleReached = true;
            } catch { /* Non-web navigation is not proxy health evidence. */ }
            this.updateState(managed, { url });
            this.maybeHandleGoogleBlock(managed, url, options);
            this.requestGoogleState(managed, true);
        });
        wc.on('did-navigate-in-page', (_e, url) => {
            this.updateState(managed, { url });
            this.requestGoogleState(managed, true);
        });
        wc.on('page-title-updated', (_e, title) => this.updateState(managed, { title }));
        wc.on('page-favicon-updated', (_e, favicons) => this.updateState(managed, { faviconUrl: favicons[0] }));
        wc.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
            if (!isMainFrame || errorCode === -3)
                return; // -3 = ERR_ABORTED (e.g. user navigated away mid-load)
            if (managed.state.proxy && /^https?:\/\//i.test(_url)) managed.proxyHealth.failed = true;
            this.updateState(managed, {
                loading: false,
                connectionStatus: managed.state.proxy ? 'proxy-failed' : 'no-proxy',
                errorMessage: errorDescription
            });
            Logger_1.logger.warn('browser', `Browser ${id} failed to load: ${errorDescription} (${errorCode})`);
        });
        wc.on('render-process-gone', (_e, details) => {
            Logger_1.logger.error('browser', `Browser ${id} renderer process gone: ${details.reason}`);
            this.updateState(managed, { connectionStatus: 'crashed', crashCount: managed.state.crashCount + 1 });
            void this.handleCrash(managed, options);
        });
        // Never let a link, target="_blank", or window.open() spawn a real new
        // OS-level window. A window created that way would NOT be one of our
        // managed BrowserViews — it would have no assigned proxy, no session
        // isolation, and no entry in this app's UI at all, making it both
        // untraceable from here and a proxy/anonymity leak (traffic from it
        // goes out directly, not through this browser's proxy). Instead, open
        // the link in this same browser/session. `did-create-window` is a
        // defensive backstop in case some other path still manages to create
        // one despite the deny below.
        wc.setWindowOpenHandler(({ url }) => {
            Logger_1.logger.info('browser', `Browser ${id}: opening "${url}" in place instead of a new window.`);
            void wc.loadURL(url).catch((err) => {
                Logger_1.logger.warn('browser', `Browser ${id} failed to open in-place link ${url}: ${err.message}`);
            });
            return { action: 'deny' };
        });
        wc.on('did-create-window', (win) => {
            Logger_1.logger.warn('browser', `Browser ${id}: a new window was created despite the deny handler — closing it.`);
            try {
                win.close();
            }
            catch {
                // Already gone — nothing to do.
            }
        });
    }
    async handleCrash(managed, options) {
        if (this.disposed || managed.disposed || managed.view.webContents.isDestroyed()) return;
        if (managed.restartAttempts >= 3) {
            Logger_1.logger.error('browser', `Browser ${managed.id} exceeded max restart attempts (3). Awaiting manual restart.`);
            return;
        }
        managed.restartAttempts += 1;
        const lastUrl = managed.state.url;
        Logger_1.logger.info('browser', `Restarting Browser ${managed.id} (attempt ${managed.restartAttempts}/3).`);
        try {
            await managed.view.webContents.loadURL(normalizeUrl(lastUrl || options.startPage));
            this.updateState(managed, { connectionStatus: 'connected' });
        }
        catch (err) {
            Logger_1.logger.warn('browser', `Browser ${managed.id} restart attempt failed: ${err.message}`);
        }
    }
    /**
     * Called on every navigation. If the URL just landed on is Google's
     * CAPTCHA interstitial, records it as a failure on this browser (so the
     * UI shows *why* nothing loaded, instead of it just looking stuck) and,
     * while still under MAX_GOOGLE_BLOCK_RETRIES, notifies the caller so it
     * can swap in a different proxy and retry the real page — see
     * BrowserManagerOptions.onGoogleBlocked. A normal page load (anything
     * that isn't the interstitial) resets the counter, so retries are
     * counted per unbroken streak of blocks, not cumulatively for the
     * browser's whole lifetime.
     */
    maybeHandleGoogleBlock(managed, url, options) {
        const continueUrl = extractGoogleBlockContinueUrl(url);
        if (!continueUrl) {
            managed.googleBlockRetries = 0;
            return;
        }
        if (managed.googleBlockRetries >= MAX_GOOGLE_BLOCK_RETRIES) {
            this.updateState(managed, {
                connectionStatus: 'proxy-failed',
                errorMessage: `Blocked by Google (CAPTCHA) — gave up after ${MAX_GOOGLE_BLOCK_RETRIES} automatic proxy retries. Use "Change Proxy" to try another manually.`
            });
            Logger_1.logger.warn('browser', `Browser ${managed.id}: exhausted ${MAX_GOOGLE_BLOCK_RETRIES} automatic proxy retries after repeated Google CAPTCHA blocks.`);
            return;
        }
        this.updateState(managed, {
            connectionStatus: 'proxy-failed',
            errorMessage: 'Blocked by Google (CAPTCHA) on this proxy — retrying automatically with a different one…'
        });
        managed.googleBlockRetries += 1;
        Logger_1.logger.warn('browser', `Browser ${managed.id}: hit Google's CAPTCHA page (attempt ${managed.googleBlockRetries}/${MAX_GOOGLE_BLOCK_RETRIES}) — requesting a proxy swap.`);
        options.onGoogleBlocked?.(managed.id, continueUrl);
    }
    updateState(managed, patch) {
        if (managed.disposed || this.disposed) return;
        if (!Object.keys(patch).some((key) => !Object.is(managed.state[key], patch[key]))) return;
        managed.state = { ...managed.state, ...patch };
        this.emit('stateChanged', managed.state);
    }
    getAll() {
        return Array.from(this.browsers.values())
            .sort((a, b) => a.id - b.id)
            .map((m) => m.state);
    }
    get(id) {
        const managed = this.browsers.get(id);
        if (!managed)
            throw new Error(`Unknown browser id: ${id}`);
        return managed;
    }
    getProxyRotationState(id) {
        const managed = this.get(id);
        return { proxy: managed.state.proxy, ...managed.proxyHealth };
    }
    beginProxyCycle(id) {
        this.get(id).proxyHealth = { googleReached: false, failed: false };
    }
    async prepareCycleDocument(id, signal) {
        // Release the outgoing page and any navigation that was still
        // committing when the cycle ended. The local blank document installs
        // its preload immediately; this never waits for Google/target Ready.
        const wc = this.get(id).view.webContents;
        let navigated;
        const closed = new Promise((resolve, reject) => {
            navigated = (_event, url) => { if (url === 'about:blank') resolve(); };
            wc.on('did-navigate', navigated);
            void wc.loadURL('about:blank').then(() => {
                if (wc.getURL() === 'about:blank') resolve();
            }).catch(error => {
                // Electron may reject this load promise with the outgoing
                // target's delayed ERR_ABORTED event. Its blank navigation
                // still commits; use that navigation's own event instead.
                if (!/ERR_ABORTED|-3/i.test(error.message || String(error))) reject(error);
            });
        });
        try {
            await waitForPreparation(closed, 15_000, signal,
                `Browser ${id} could not close its outgoing page before the next cycle.`);
        } finally { wc.removeListener('did-navigate', navigated); }
    }
    async navigate(id, url) {
        const managed = this.get(id);
        managed.googleBlockRetries = 0;
        const normalized = normalizeUrl(url);
        await managed.view.webContents.loadURL(normalized);
    }
    async reload(id) {
        this.get(id).view.webContents.reload();
    }
    async stop(id) {
        this.get(id).view.webContents.stop();
    }
    async goBack(id) {
        const wc = this.get(id).view.webContents;
        if (wc.canGoBack())
            wc.goBack();
    }
    async goForward(id) {
        const wc = this.get(id).view.webContents;
        if (wc.canGoForward())
            wc.goForward();
    }
    async reloadAll() {
        for (const managed of this.browsers.values())
            managed.view.webContents.reload();
    }
    async stopAll() {
        for (const managed of this.browsers.values())
            managed.view.webContents.stop();
    }
    async clearCookies(id) {
        await this.get(id).session.clearStorageData({ storages: ['cookies'] });
    }
    async clearCache(id) {
        const managed = this.get(id);
        if (managed.cacheClearing) return managed.cacheClearing;
        // Keep cookies (including Google's consent choice), while removing
        // HTTP resources, renderer memory and Cache Storage before a new cycle.
        const work = Promise.allSettled([
            this.clearRendererCache(managed), managed.session.clearCache(), managed.session.clearStorageData({ storages: ['cachestorage'] })
        ]).then(results => {
            const failed = results.find(result => result.status === 'rejected');
            if (failed) throw failed.reason;
        });
        managed.cacheClearing = work;
        try { await work; } finally { if (managed.cacheClearing === work) managed.cacheClearing = null; }
    }
    async clearRendererCache(managed) {
        const requestId = (managed.rendererCacheSequence || 0) + 1;
        managed.rendererCacheSequence = requestId;
        const send = () => {
            try {
                if (!managed.view.webContents.isDestroyed()) managed.view.webContents.send('dom:clear-renderer-cache', requestId);
            } catch { /* A frame swap can briefly invalidate the IPC target. */ }
        };
        const complete = new Promise((resolve, reject) => {
            managed.rendererCacheRequest = { requestId, finish: error => error ? reject(new Error(error)) : resolve() };
            send();
        });
        // Rotation can overlap a target navigation's frame swap. Replay the
        // request into the current frame until it acknowledges cleanup.
        const retry = setInterval(send, 250);
        try {
            await withTimeout(complete, 5_000, () => { throw new Error(`Browser ${managed.id} memory cache cleanup did not respond.`); });
        } finally {
            clearInterval(retry);
            if (managed.rendererCacheRequest?.requestId === requestId) managed.rendererCacheRequest = null;
        }
    }
    async openDevTools(id) {
        const wc = this.get(id).view.webContents;
        if (!wc.isDevToolsOpened())
            wc.openDevTools({ mode: 'detach' });
    }
    async restart(id) {
        const managed = this.get(id);
        managed.restartAttempts = 0;
        managed.view.webContents.reload();
    }
    setBounds(id, bounds) {
        const managed = this.browsers.get(id);
        // Scroll/resize IPC can be in flight while a count change removes a view.
        if (!managed || managed.disposed) return;
        if (managed.lastBounds && ['x', 'y', 'width', 'height'].every((key) => managed.lastBounds[key] === bounds[key])) return;
        managed.view.setBounds(bounds);
        managed.lastBounds = { ...bounds };
    }
    setActive(id) {
        this.activeId = id;
    }
    getActive() {
        return this.activeId;
    }
    /**
     * Assigns a proxy to a browser's isolated session and reloads it so the
     * new routing takes effect. `proxyRules` uses a scheme-agnostic rule
     * (e.g. "socks5://host:port") so every request from this session — not
     * just http(s) — is routed through the assigned proxy.
     */
    async assignProxy(id, proxy) {
        const managed = this.get(id);
        // Routing changes for the same session must settle in request order.
        // Other browsers continue concurrently without a shared queue.
        const previous = managed.proxyChange ?? Promise.resolve();
        const work = previous.catch(() => {}).then(() => this.assignProxyOwned(id, proxy, managed));
        managed.proxyChange = work;
        return work;
    }
    async assignProxyOwned(id, proxy, managed) {
        if (this.disposed || managed.disposed || this.browsers.get(id) !== managed) return;
        managed.proxyHealth = { googleReached: false, failed: false };
        this.cancelKeepAliveAction(managed);
        // Proxy changes define a new browsing generation. Cancel any old Keep
        // Alive worker here as a final safety net even if the orchestration layer
        // already stopped it, so a stale action can never leak into the new proxy
        // session.
        managed.keepAliveGeneration += 1;
        managed.keepAliveEnabled = false;
        managed.keepAliveBusy = false;
        managed.keepAliveBusySince = 0;
        managed.keepAliveNextAt = Number.POSITIVE_INFINITY;
        managed.controlledKeepAliveHost = null;
        managed.controlledKeepAliveContinuous = false;
        this.updateState(managed, {
            proxy,
            connectionStatus: proxy ? 'proxy-checking' : 'no-proxy',
            errorMessage: undefined,
            keepAliveEnabled: false,
            keepAliveActivity: 'idle'
        });
        if (!proxy) {
            await managed.session.setProxy({ mode: 'direct' });
            await managed.session.closeAllConnections();
            return;
        }
        const scheme = proxy.protocol === 'https' ? 'https' : proxy.protocol;
        await managed.session.setProxy({
            proxyRules: `${scheme}://${proxy.host}:${proxy.port}`,
            proxyBypassRules: '<local>'
        });
        await managed.session.closeAllConnections();
        // Do not reload the previous page here. webContents.reload() is
        // fire-and-forget, so the old about:blank reload could race and win
        // against the Google load started immediately after assignment.
        // The automation layer performs the first navigation explicitly.
    }
    async checkIp(id, ipCheckUrl) {
        const managed = this.get(id);
        try {
            const result = (await managed.view.webContents.executeJavaScript(`fetch(${JSON.stringify(ipCheckUrl)}).then(r => r.json()).then(j => j.ip ?? null).catch(() => null)`));
            return { ip: result ?? undefined };
        }
        catch (err) {
            return { error: err.message };
        }
    }
    /**
     * Starts a cancellable Google result session. Its search watches results
     * as they appear, clicks the matching result's actual title, and verifies
     * landing on the target website. Challenges pause the session until normal
     * results return.
     */
    startMeasurementSession(id) {
        const token = (this.measurementTokens.get(id) ?? 0) + 1;
        this.measurementTokens.set(id, token);
        return token;
    }
    cancelMeasurementSession(id) {
        this.measurementTokens.set(id, (this.measurementTokens.get(id) ?? 0) + 1);
        const managed = this.browsers.get(id);
        if (managed && !managed.view.webContents.isDestroyed()) {
            this.stopGoogleRecognition(managed);
            managed.view.webContents.stop();
        }
    }
    stopGoogleRecognition(managed, expectedToken) {
        if (arguments.length > 1 && managed.googleConfig?.token !== expectedToken) return;
        const active = Boolean(managed.googleConfig);
        managed.googleConfig = null;
        managed.googleState = null;
        managed.googleStateRequestedNavigation = null;
        managed.googleStateRequestedAt = 0;
        if (managed.state.googleSearchActivity) this.updateState(managed, { googleSearchActivity: undefined });
        if (active && !managed.view.webContents.isDestroyed()) {
            try { managed.view.webContents.send('dom:google-config', null); }
            catch { /* The renderer may have exited during cancellation. */ }
        }
    }
    isMeasurementSessionCurrent(id, token) {
        return !this.disposed && this.browsers.has(id) && this.measurementTokens.get(id) === token;
    }
    requestGoogleState(managed, force = false) {
        const config = managed.googleConfig, wc = managed.view.webContents;
        if (!config || managed.disposed || wc.isDestroyed() ||
            (config.token != null && !this.isMeasurementSessionCurrent(managed.id, config.token))) return;
        try {
            const url = new URL(wc.getURL());
            if (!isGoogleSearchResultsUrl(url.href) || url.searchParams.get('q') !== config.query ||
                (url.searchParams.get('start') || '0') !== config.start) return;
            const now = Date.now();
            if (!force && managed.googleStateRequestedNavigation === config.navigation &&
                now - managed.googleStateRequestedAt < 1_000) return;
            // Sending does not wait for DOMContentLoaded/load. An idempotent
            // preload request both starts a missing watcher and republishes a
            // final match whose first report was lost or rejected in transit.
            wc.send('dom:google-config', config);
            managed.googleStateRequestedNavigation = config.navigation;
            managed.googleStateRequestedAt = now;
        } catch { /* A navigation can dispose the frame; the next poll retries. */ }
    }
    async broadcastSearch(id, query, targetWebsite, maxPages = 20, measurementToken) {
        const managed = this.get(id);
        const wc = managed.view.webContents;
        const ranAt = new Date().toISOString();
        const targetHost = (0, seo_1.normalizeTargetHost)(targetWebsite);
        if (!targetHost) {
            return {
                browserId: id,
                status: 'error',
                error: 'Enter a valid target website or site name.',
                ranAt
            };
        }
        const pagesToScan = Math.max(1, Math.min(100, Math.floor(maxPages || 1)));
        const recognitionNote = (state) => {
            const diagnostics = state?.diagnostics;
            if (!diagnostics) return '';
            const reasons = { hidden: 'not visible', outside: 'navigation/disabled', noTitle: 'no title', sponsored: 'sponsored' };
            const rejected = Object.keys(reasons).filter(key => diagnostics[key])
                .map(key => reasons[key] + ' ' + diagnostics[key]).join(', ');
            const title = diagnostics.publisherTitle;
            const titleNote = title ? ` Title link: ${title.reason} (${title.tag}, ${title.route}).` : '';
            return (diagnostics.targetLinks ? ` Target links: ${diagnostics.targetLinks}.` : '') +
                (rejected ? ` Rejected: ${rejected}.` : '') + titleNote;
        };
        let totalScanned = 0;
        let lastSearchUrl = '';
        // An unfinished observation retains its preload and current document.
        // Reloading it on every retry can erase a slow proxy's visible results
        // immediately before their title links become usable.
        const config = managed.googleConfig;
        const promptPending = () => isGoogleConsentUrl(wc.getURL()) ||
            Boolean(managed.googlePromptState?.documentUrl === wc.getURL() && managed.googlePromptState.state);
        const waitingForPrompt = () => ({ browserId: id, status: 'monitoring', landedUrl: wc.getURL(),
            monitoring: true, resultsScanned: totalScanned,
            error: 'Waiting for Google’s consent or Continue button; this page stays active until it can proceed.', ranAt });
        if (config && config.token === measurementToken && config.target === targetHost &&
            config.query === query.trim() && promptPending()) return waitingForPrompt();
        let resumePage = -1;
        try {
            const current = new URL(wc.getURL());
            const start = Number(current.searchParams.get('start') || '0');
            if (config && config.token === measurementToken && config.target === targetHost &&
                config.query === query.trim() && isGoogleSearchResultsUrl(current.href) &&
                current.searchParams.get('q') === config.query && String(start) === config.start &&
                Number.isInteger(start) && start >= 0 && start % 10 === 0 && start / 10 < pagesToScan)
                resumePage = start / 10;
        } catch { /* A new navigation will install a fresh observer. */ }
        /**
         * Start Google navigation and return as soon as its DOM exists.
         * Result detection runs while the page is still rendering; full network
         * completion is never a prerequisite.
         */
        const loadSearchDom = async (url) => {
            const parsed = new URL(url);
            managed.googleState = null;
            managed.googleConfig = { target: targetHost, query: parsed.searchParams.get('q') || '', start: parsed.searchParams.get('start') || '0',
                token: measurementToken, navigation: (managed.googleNavigation || 0) + 1 };
            managed.googleNavigation = managed.googleConfig.navigation;
            this.updateState(managed, { googleSearchActivity: 'waiting-results' });
            let loadError = null;
            void wc.loadURL(url).catch((err) => {
                const message = err.message || String(err);
                if (!/ERR_ABORTED|-3/i.test(message))
                    loadError = message;
            });
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
                if (measurementToken != null && !this.isMeasurementSessionCurrent(id, measurementToken)) return;
                const current = wc.getURL();
                this.requestGoogleState(managed);
                if (extractGoogleBlockContinueUrl(current) || promptPending() || managed.googleState) return;
                if (loadError) break;
                await delay(25);
            }
            if (loadError && !managed.googleState) {
                if (managed.state.proxy) managed.proxyHealth.failed = true;
                wc.stop();
                this.updateState(managed, {
                    loading: false,
                    connectionStatus: 'proxy-failed',
                    errorMessage: loadError
                });
                throw new Error(loadError);
            }
            const currentUrl = wc.getURL();
            if (!isGoogleSearchResultsUrl(currentUrl) && !extractGoogleBlockContinueUrl(currentUrl) && !promptPending()) {
                if (managed.state.proxy) managed.proxyHealth.failed = true;
                const message = `Google navigation timed out while using this proxy (current page: ${currentUrl || 'none'}).`;
                wc.stop();
                this.updateState(managed, {
                    loading: false,
                    connectionStatus: 'proxy-failed',
                    errorMessage: message
                });
                throw new Error(message);
            }
        };
        for (let pageIndex = Math.max(0, resumePage); pageIndex < pagesToScan; pageIndex += 1) {
            if (measurementToken != null &&
                !this.isMeasurementSessionCurrent(id, measurementToken)) {
                return {
                    browserId: id,
                    status: 'monitoring',
                    landedUrl: wc.getURL(),
                    monitoring: true,
                    ranAt
                };
            }
            const searchUrl = (0, seo_1.buildGoogleSearchUrl)(query, pageIndex);
            lastSearchUrl = searchUrl;
            try {
                if (pageIndex !== resumePage) await loadSearchDom(searchUrl);
            }
            catch (err) {
                return {
                    browserId: id,
                    status: 'error',
                    error: `Failed to open Google result page ${pageIndex + 1}: ${err.message}`,
                    ranAt
                };
            }
            const currentUrl = wc.getURL();
            if (extractGoogleBlockContinueUrl(currentUrl)) {
                return {
                    browserId: id,
                    status: 'paused',
                    landedUrl: currentUrl,
                    monitoring: true,
                    resultsScanned: totalScanned,
                    ranAt
                };
            }
            // The preload installed the watcher at document start. IPC delivers
            // progressive result state without executeJavaScript's load wait.
            let watcher = managed.googleState;
            let pageMaxObserved = watcher?.observedResults ?? 0;
            let lastSignature = watcher?.signature ?? '';
            let firstObservedAt = watcher?.observedResults ? Date.now() : 0;
            let lastResultChangeAt = firstObservedAt;
            let pageConfirmedAbsent = false;
            let targetTextSeenAt = watcher?.targetTextSeen ? Date.now() : 0;
            const watchStartedAt = Date.now();
            const watchDeadline = watchStartedAt + 12_000;
            while (Date.now() < watchDeadline) {
                if (measurementToken != null &&
                    !this.isMeasurementSessionCurrent(id, measurementToken)) {
                    this.stopGoogleRecognition(managed, measurementToken);
                    return {
                        browserId: id,
                        status: 'monitoring',
                        landedUrl: wc.getURL(),
                        resultsScanned: totalScanned,
                        monitoring: true,
                        ranAt
                    };
                }
                this.requestGoogleState(managed);
                const activeUrl = wc.getURL();
                if (promptPending()) { await delay(100); continue; }
                if (extractGoogleBlockContinueUrl(activeUrl)) {
                    this.stopGoogleRecognition(managed, measurementToken);
                    return {
                        browserId: id,
                        status: 'paused',
                        landedUrl: activeUrl,
                        monitoring: true,
                        resultsScanned: totalScanned,
                        ranAt
                    };
                }
                // A watcher-triggered click may already have navigated away from
                // Google. Treat an exact target-host landing as success immediately.
                if (!isGoogleSearchResultsUrl(activeUrl)) {
                    try {
                        if ((0, seo_1.hostMatchesTarget)(activeUrl, targetHost)) {
                            totalScanned += pageMaxObserved;
                            return {
                                browserId: id,
                                status: 'matched',
                                landedUrl: activeUrl,
                                matchedUrl: watcher?.match?.url ?? activeUrl,
                                matchedTitle: watcher?.match?.title ?? '',
                                resultsScanned: totalScanned,
                                position: pageIndex * 10 + (watcher?.match?.organicIndex ?? 0) + 1,
                                resultPage: pageIndex + 1,
                                monitoring: true,
                                interactionStatus: 'opened',
                                keepAliveStarted: false,
                                ranAt
                            };
                        }
                    }
                    catch {
                        // Transitional navigation URL; keep observing.
                    }
                }
                if (managed.googleState) watcher = managed.googleState;
                if (watcher?.recognitionError) {
                    this.stopGoogleRecognition(managed, measurementToken);
                    return { browserId: id, status: 'error', monitoring: true, landedUrl: wc.getURL(),
                        error: `Google result recognition failed: ${watcher.recognitionError}`, ranAt };
                }
                if (watcher?.blocked) {
                    this.stopGoogleRecognition(managed, measurementToken);
                    return {
                        browserId: id,
                        status: 'paused',
                        landedUrl: wc.getURL(),
                        monitoring: true,
                        resultsScanned: totalScanned,
                        ranAt
                    };
                }
                if (watcher) {
                    pageMaxObserved = Math.max(pageMaxObserved, watcher.observedResults || 0);
                    if (watcher.match) {
                        // Match detection and first click are deliberately coupled to the
                        // same page watcher so Google cannot paginate between them.
                        let matched = watcher.match;
                        if (!(0, seo_1.hostMatchesTarget)(matched.url, targetHost) &&
                            !(!matched.url && matched.unresolved && matched.displayedHost === targetHost)) {
                            this.stopGoogleRecognition(managed, measurementToken);
                            return { browserId: id, status: 'error', error: 'Detected result destination did not match the target website.', ranAt };
                        }
                        const navigationBeforeClick = managed.mainNavigationSequence || 0;
                        if (matched.clickPoint &&
                            Number.isFinite(matched.clickPoint.x) &&
                            Number.isFinite(matched.clickPoint.y)) {
                            try {
                                const x = Math.max(1, Math.round(matched.clickPoint.x));
                                const y = Math.max(1, Math.round(matched.clickPoint.y));
                                wc.sendInputEvent({ type: 'mouseMove', x, y });
                                wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
                                wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
                            }
                            catch {
                                // The isolated preload will activate the anchor.
                            }
                            const activationDeadline = Date.now() + 500;
                            while ((managed.mainNavigationSequence || 0) === navigationBeforeClick &&
                                isGoogleSearchResultsUrl(wc.getURL()) && Date.now() < activationDeadline &&
                                (measurementToken == null || this.isMeasurementSessionCurrent(id, measurementToken))) {
                                await delay(25);
                            }
                        }
                        if (measurementToken != null && !this.isMeasurementSessionCurrent(id, measurementToken)) {
                            return { browserId: id, status: 'monitoring', landedUrl: wc.getURL(), monitoring: true, ranAt };
                        }
                        if (isGoogleSearchResultsUrl(wc.getURL()) && (managed.mainNavigationSequence || 0) === navigationBeforeClick) {
                            // A native click can already be navigating while
                            // getURL still reports Google. Activate through the
                            // preload only if that click started no navigation.
                            wc.send('dom:google-click', managed.googleConfig.navigation);
                        }
                        const verifyTargetLanding = () => {
                            let current = '';
                            try { current = wc.getURL(); } catch { /* A transient navigation may dispose the frame. */ }
                            if (measurementToken != null && !this.isMeasurementSessionCurrent(id, measurementToken)) {
                                return { url: current, result: { browserId: id, status: 'monitoring', landedUrl: current,
                                    resultsScanned: totalScanned, monitoring: true, keepAliveStarted: false, ranAt } };
                            }
                            if (!(0, seo_1.hostMatchesTarget)(current, targetHost)) return { url: current };
                            totalScanned += pageMaxObserved;
                            return { url: current, result: {
                                browserId: id,
                                status: 'matched',
                                landedUrl: current,
                                matchedUrl: matched.url || current,
                                matchedTitle: matched.title,
                                resultsScanned: totalScanned,
                                position: pageIndex * 10 + matched.organicIndex + 1,
                                resultPage: pageIndex + 1,
                                monitoring: true,
                                interactionStatus: 'opened',
                                keepAliveStarted: false,
                                ranAt
                            } };
                        };
                        // Preserve the previous total landing window while
                        // waiting solely for navigation from the title click.
                        const navigationDeadline = Date.now() + 8_500;
                        while (Date.now() < navigationDeadline) {
                            if (measurementToken != null &&
                                !this.isMeasurementSessionCurrent(id, measurementToken)) {
                                return {
                                    browserId: id,
                                    status: 'monitoring',
                                    landedUrl: wc.getURL(),
                                    resultsScanned: totalScanned,
                                    monitoring: true,
                                    ranAt
                                };
                            }
                            // Google can populate href after hydration or a first
                            // click. The isolated watcher keeps observing that link.
                            const resolved = managed.googleState?.match;
                            if (matched.unresolved && resolved?.url &&
                                (0, seo_1.hostMatchesTarget)(resolved.url, targetHost)) {
                                matched = resolved;
                                wc.send('dom:google-click', managed.googleConfig.navigation);
                            }
                            const landing = verifyTargetLanding();
                            if (landing.result) return landing.result;
                            await delay(75);
                        }
                        // A commit can arrive during the final poll's delay.
                        // Check it once more, then reuse that same URL snapshot
                        // for any failure so a landed target is not rejected.
                        const finalLanding = verifyTargetLanding();
                        if (finalLanding.result) return finalLanding.result;
                        if (!(0, seo_1.hostMatchesTarget)(matched.url, targetHost)) {
                            this.stopGoogleRecognition(managed, measurementToken);
                            totalScanned += pageMaxObserved;
                            return { browserId: id, status: 'matched', landedUrl: finalLanding.url,
                                matchedTitle: matched.title, resultsScanned: totalScanned,
                                position: pageIndex * 10 + matched.organicIndex + 1, resultPage: pageIndex + 1,
                                monitoring: true, interactionStatus: 'click-failed', keepAliveStarted: false,
                                error: 'The target publisher is visible, but Google did not resolve or open its title link. DOM will retry this page without paginating.', ranAt };
                        }
                        // Success must follow a click on this Google result's
                        // title. An ignored click remains an explicit failure.
                        totalScanned += pageMaxObserved;
                        return {
                            browserId: id,
                            status: 'matched',
                            landedUrl: finalLanding.url,
                            matchedUrl: matched.url,
                            matchedTitle: matched.title,
                            resultsScanned: totalScanned,
                            position: pageIndex * 10 + matched.organicIndex + 1,
                            resultPage: pageIndex + 1,
                            monitoring: true,
                            interactionStatus: 'click-failed',
                            error: 'Target appeared in Google, but clicking its result title did not open the target website.',
                            keepAliveStarted: false,
                            ranAt
                        };
                    }
                    if (watcher.targetTextSeen) {
                        if (!targetTextSeenAt)
                            targetTextSeenAt = Date.now();
                        // A visible target locks this Google page. If Google exposes the
                        // text before its clickable anchor, keep the live observer
                        // and document across observations instead of reloading.
                        if (!watcher.match && Date.now() - targetTextSeenAt >= 3_000) {
                            totalScanned += pageMaxObserved;
                            return {
                                browserId: id,
                                status: 'monitoring',
                                landedUrl: wc.getURL(),
                                matchedTitle: watcher.candidateText || query,
                                resultsScanned: totalScanned,
                                resultPage: pageIndex + 1,
                                monitoring: true,
                                error: 'The target publisher is visible; continuing to watch its title link on this page.' + recognitionNote(watcher),
                                keepAliveStarted: false,
                                ranAt
                            };
                        }
                    }
                    if (watcher.observedResults > 0 && !watcher.targetTextSeen) {
                        if (!firstObservedAt)
                            firstObservedAt = lastResultChangeAt = Date.now();
                        if (watcher.signature !== lastSignature) {
                            lastSignature = watcher.signature;
                            lastResultChangeAt = Date.now();
                        }
                        // A match never waits for these negative checks. Before
                        // moving on, allow JS-hydrated rows to arrive and require
                        // a rendered footer/next link or a full set of results.
                        // Full network loading and the browser's Ready label
                        // are deliberately irrelevant to this decision.
                        if (watcher.documentParsed && !watcher.pendingResults &&
                            (watcher.nextPage || watcher.paginationRendered || watcher.observedResults >= 10) &&
                            Date.now() - firstObservedAt >= 6_000 && Date.now() - lastResultChangeAt >= 2_000) {
                            pageConfirmedAbsent = true;
                            break;
                        }
                    }
                }
                await delay(100);
            }
            totalScanned += pageMaxObserved;
            if (promptPending() || watcher?.googlePrompt) return waitingForPrompt();
            if (watcher?.targetTextSeen) {
                return {
                    browserId: id,
                    status: 'monitoring',
                    landedUrl: wc.getURL(),
                    matchedTitle: watcher.candidateText || query,
                    resultsScanned: totalScanned,
                    resultPage: pageIndex + 1,
                    monitoring: true,
                    error: 'The target publisher is visible; continuing to watch its title link on this page.' + recognitionNote(watcher),
                    keepAliveStarted: false,
                    ranAt
                };
            }
            if (!pageConfirmedAbsent) {
                // Unknown markup, pending hydration, or an incomplete response
                // is not evidence that a target is absent. Keep this page.
                return { browserId: id, status: 'monitoring', landedUrl: wc.getURL(),
                    resultsScanned: totalScanned, monitoring: true,
                    error: watcher ? `Watching ${watcher.observedResults || 0} candidate results for ${targetHost}; keeping this page active.${recognitionNote(watcher)}` :
                        'The Google result observer has not responded; keeping this page active.', ranAt };
            }
            this.stopGoogleRecognition(managed, measurementToken);
            if (wc.isLoading())
                wc.stop();
            // Only a page with no target text is allowed to paginate.
            continue;
        }
        return {
            browserId: id,
            status: 'no-match',
            landedUrl: lastSearchUrl || wc.getURL(),
            resultsScanned: totalScanned,
            monitoring: true,
            ranAt
        };
    }
    async waitForGoogleRecovery(id, maxWaitMs) {
        const managed = this.get(id);
        const wc = managed.view.webContents;
        const deadline = Date.now() + Math.max(1_000, maxWaitMs);
        while (Date.now() < deadline) {
            if (wc.isDestroyed())
                return false;
            const url = wc.getURL();
            if (isGoogleSearchResultsUrl(url)) {
                try {
                    const state = (await withTimeout(
                        wc.executeJavaScript(`(function() {
              var text = (document.body && document.body.innerText) || '';
              var blocked =
                /unusual traffic|not a robot|recaptcha|verify you are human/i.test(text.slice(0, 5000)) ||
                /\\/sorry\\/|consent\\.google\\./i.test(location.href);
              var hasResults = Boolean(
                document.querySelector('#search') ||
                document.querySelector('#rso') ||
                document.querySelector('main')
              );
              return { blocked: blocked, hasResults: hasResults };
            })()`, true),
                        500, () => null));
                    if (state && !state.blocked && state.hasResults)
                        return true;
                }
                catch {
                    // Navigation may still be replacing the challenge document.
                }
            }
            await delay(1_000);
        }
        return false;
    }
    async destroyBrowser(id) {
        if (this.disposing.has(id)) return this.disposing.get(id);
        await this.creating.get(id)?.catch(() => {});
        if (this.disposing.has(id)) return this.disposing.get(id);
        const managed = this.browsers.get(id);
        if (!managed)
            return;
        // Invalidate workers and detach/close before asynchronous storage work.
        // BrowserViews have an independent lifetime from their owning window.
        managed.disposed = true;
        this.cancelKeepAliveAction(managed);
        managed.keepAliveGeneration += 1;
        managed.keepAliveEnabled = false;
        managed.keepAliveVisited.clear();
        this.cancelMeasurementSession(id);
        this.browsers.delete(id);
        if (this.window && !this.window.isDestroyed()) this.window.removeBrowserView(managed.view);
        if (!managed.view.webContents.isDestroyed()) managed.view.webContents.close({ waitForBeforeUnload: false });
        const cleanup = Promise.resolve(managed.proxyChange).catch(() => {}).then(() => Promise.allSettled([
            managed.cacheClearing,
            managed.session.closeAllConnections(),
            managed.session.clearStorageData(),
            managed.session.clearCache(),
            managed.session.setProxy({ mode: 'direct' })
        ])).then((results) => {
            // Reuse only after successful cleanup. This keeps native storage
            // context count bounded during normal shrink/regrowth while a failed
            // cleanup can never clear data inside the next browsing session.
            if (!this.disposed && results.every((result) => result.status === 'fulfilled'))
                this.reusablePartitions.set(id, managed.partition);
        });
        this.disposing.set(id, cleanup);
        try { await cleanup; } finally { this.disposing.delete(id); }
    }
    async destroyAll() {
        this.disposed = true;
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
        if (this.loginHandler) electron_1.app.removeListener('login', this.loginHandler);
        this.loginHandler = null;
        this.globalLoginHandlerInstalled = false;
        await Promise.allSettled(this.creating.values());
        await Promise.all(Array.from(this.browsers.keys()).map((id) => this.destroyBrowser(id)));
        await Promise.allSettled(this.disposing.values());
        this.window = null;
    }
    async clickControlledGoogleResult(id, query, controlledHost, expectedUrl, measurementToken) {
        const managed = this.get(id);
        const wc = managed.view.webContents;
        const normalizedHost = (0, seo_1.normalizeTargetHost)(controlledHost);
        if (!normalizedHost || !this.isMeasurementSessionCurrent(id, measurementToken))
            return false;
        try {
            const expectedHost = new URL(expectedUrl).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
            if (expectedHost !== normalizedHost)
                return false;
        }
        catch {
            return false;
        }
        if (!isGoogleSearchResultsUrl(wc.getURL()))
            return false;
        try {
            const scan = (await wc.executeJavaScript(buildGoogleResultScanScript(normalizedHost, query), true));
            if (!this.isMeasurementSessionCurrent(id, measurementToken))
                return false;
            if (!scan.match || !scan.match.url)
                return false;
            const matchHost = new URL(scan.match.url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
            if (matchHost !== normalizedHost)
                return false;
            const point = scan.match.clickPoint;
            let clickDispatched = false;
            if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
                const x = Math.max(1, Math.round(point.x));
                const y = Math.max(1, Math.round(point.y));
                wc.sendInputEvent({ type: 'mouseMove', x, y });
                wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
                wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
                clickDispatched = true;
            }
            else {
                clickDispatched = (await wc.executeJavaScript(buildClickGoogleTargetResultScript(normalizedHost, query), true).catch(() => false));
            }
            if (clickDispatched) {
                const deadline = Date.now() + 5_000;
                while (Date.now() < deadline) {
                    if (!this.isMeasurementSessionCurrent(id, measurementToken))
                        return false;
                    const current = wc.getURL();
                    try {
                        const host = new URL(current).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
                        if (host === normalizedHost)
                            return true;
                    }
                    catch {
                        // Keep waiting through transient navigation URLs.
                    }
                    await delay(100);
                }
            }
            // One DOM-level retry is allowed if the native event was ignored.
            if (isGoogleSearchResultsUrl(wc.getURL()) && this.isMeasurementSessionCurrent(id, measurementToken)) {
                const clicked = (await wc.executeJavaScript(buildClickGoogleTargetResultScript(normalizedHost, query), true).catch(() => false));
                if (clicked) {
                    const retryDeadline = Date.now() + 5_000;
                    while (Date.now() < retryDeadline) {
                        if (!this.isMeasurementSessionCurrent(id, measurementToken))
                            return false;
                        try {
                            const host = new URL(wc.getURL()).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
                            if (host === normalizedHost)
                                return true;
                        }
                        catch {
                            // Navigation is still settling.
                        }
                        await delay(100);
                    }
                }
            }
        }
        catch (err) {
            Logger_1.logger.warn('browser', `Browser ${id}: controlled test result click failed: ${err.message}`);
        }
        return false;
    }
    startControlledKeepAlive(id, controlledHost) {
        const managed = this.get(id);
        const normalizedHost = (0, seo_1.normalizeTargetHost)(controlledHost);
        if (!normalizedHost)
            throw new Error('Invalid controlled test host.');
        let currentHost = '';
        try {
            currentHost = new URL(managed.view.webContents.getURL()).hostname
                .toLowerCase()
                .replace(/^www\./, '')
                .replace(/\.$/, '');
        }
        catch {
            throw new Error('Browser is not on a valid controlled test page.');
        }
        if (currentHost !== normalizedHost) {
            throw new Error(`Controlled Keep Alive requires exact host ${normalizedHost}; browser is on ${currentHost || 'unknown'}.`);
        }
        this.cancelKeepAliveAction(managed);
        this.ensureKeepAliveTimer();
        managed.keepAliveGeneration += 1;
        managed.controlledKeepAliveHost = normalizedHost;
        managed.controlledKeepAliveContinuous = true;
        managed.keepAliveEnabled = true;
        managed.keepAliveHops = 0;
        managed.keepAliveBusy = false;
        managed.keepAliveBusySince = 0;
        managed.keepAliveFailureCount = 0;
        managed.keepAliveVisited.clear();
        managed.keepAliveVisited.add(managed.view.webContents.getURL());
        managed.keepAliveNextAt = Date.now();
        managed.keepAliveLastHeartbeatAt = Date.now();
        this.updateState(managed, {
            keepAliveEnabled: true,
            keepAliveHops: 0,
            keepAliveActivity: 'starting',
            keepAliveFailureCount: 0,
            lastKeepAliveHeartbeatAt: new Date(managed.keepAliveLastHeartbeatAt).toISOString()
        });
        queueMicrotask(() => this.tickKeepAlive());
    }
    copyToClipboard(text) {
        electron_1.clipboard.writeText(text);
    }
    ensureKeepAliveTimer() {
        if (this.disposed) return;
        if (this.keepAliveTimer)
            return;
        // Keep the driver independent from bootstrap timing. Individual browser
        // buttons can therefore start Keep Alive even during late initialization.
        this.keepAliveTimer = setInterval(() => this.tickKeepAlive(), 500);
    }
    cancelKeepAliveAction(managed) {
        const wc = managed.view.webContents;
        if (!wc.isDestroyed()) {
            void wc.executeJavaScript('window.__domKeepAliveController?.abort(); delete window.__domKeepAliveReading;', true).catch(() => undefined);
        }
    }
    configureKeepAlive(intervalMs, maxHops, followLinks) {
        this.keepAliveIntervalMs = Math.max(5_000, Math.min(3_600_000, Math.floor(intervalMs || 60_000)));
        this.keepAliveMaxHops = Math.max(1, Math.min(1000, Math.floor(maxHops || 1)));
        // Lite measurement builds keep link-following disabled by default.
        // Manual Keep Alive reads the page even when link-following is disabled.
        this.keepAliveFollowLinks = followLinks;
        this.ensureKeepAliveTimer();
    }
    setKeepAlive(enabled, intervalMs) {
        this.configureKeepAlive(intervalMs, this.keepAliveMaxHops, this.keepAliveFollowLinks);
        this.setKeepAliveAll(enabled, enabled);
    }
    setBrowserKeepAlive(id, enabled, resetHops = false) {
        this.ensureKeepAliveTimer();
        const managed = this.get(id);
        this.cancelKeepAliveAction(managed);
        managed.keepAliveGeneration += 1;
        managed.keepAliveEnabled = enabled;
        managed.keepAliveBusy = false;
        managed.keepAliveBusySince = 0;
        managed.keepAliveFailureCount = 0;
        managed.keepAliveLastHeartbeatAt = Date.now();
        if (!enabled) {
            managed.controlledKeepAliveHost = null;
            managed.controlledKeepAliveContinuous = false;
        }
        if (resetHops) {
            managed.keepAliveHops = 0;
            managed.keepAliveVisited.clear();
            const currentUrl = managed.view.webContents.getURL();
            if (currentUrl)
                managed.keepAliveVisited.add(currentUrl);
        }
        managed.keepAliveNextAt = enabled ? Date.now() : Number.POSITIVE_INFINITY;
        this.updateState(managed, {
            keepAliveEnabled: enabled,
            keepAliveHops: managed.keepAliveHops,
            keepAliveActivity: enabled ? 'starting' : 'idle',
            keepAliveFailureCount: 0,
            lastKeepAliveHeartbeatAt: new Date(managed.keepAliveLastHeartbeatAt).toISOString()
        });
        if (enabled)
            queueMicrotask(() => this.tickKeepAlive());
    }
    setKeepAliveAll(enabled, resetHops = false) {
        this.ensureKeepAliveTimer();
        for (const managed of this.browsers.values()) {
            this.cancelKeepAliveAction(managed);
            managed.keepAliveGeneration += 1;
            managed.keepAliveEnabled = enabled;
            managed.keepAliveBusy = false;
            managed.keepAliveBusySince = 0;
            managed.keepAliveFailureCount = 0;
            managed.keepAliveLastHeartbeatAt = Date.now();
            if (!enabled) {
                managed.controlledKeepAliveHost = null;
                managed.controlledKeepAliveContinuous = false;
            }
            if (resetHops) {
                managed.keepAliveHops = 0;
                managed.keepAliveVisited.clear();
                const currentUrl = managed.view.webContents.getURL();
                if (currentUrl)
                    managed.keepAliveVisited.add(currentUrl);
            }
            managed.keepAliveNextAt = enabled ? Date.now() : Number.POSITIVE_INFINITY;
            this.updateState(managed, {
                keepAliveEnabled: enabled,
                keepAliveHops: managed.keepAliveHops,
                keepAliveActivity: enabled ? 'starting' : 'idle',
                keepAliveFailureCount: 0,
                lastKeepAliveHeartbeatAt: new Date(managed.keepAliveLastHeartbeatAt).toISOString()
            });
        }
        if (enabled)
            queueMicrotask(() => this.tickKeepAlive());
    }
    tickKeepAlive() {
        const now = Date.now();
        for (const managed of this.browsers.values()) {
            if (!managed.keepAliveEnabled)
                continue;
            const wc = managed.view.webContents;
            if (wc.isDestroyed()) {
                managed.keepAliveGeneration += 1;
                managed.keepAliveEnabled = false;
                managed.keepAliveBusy = false;
                managed.keepAliveBusySince = 0;
                this.updateState(managed, {
                    keepAliveEnabled: false,
                    keepAliveActivity: 'idle'
                });
                continue;
            }
            // A stale "busy" flag used to leave the UI green forever while no
            // Keep Alive work was actually happening. Recover it deterministically.
            if (managed.keepAliveBusy) {
                if (managed.keepAliveBusySince > 0 &&
                    now - managed.keepAliveBusySince > this.keepAliveWatchdogMs) {
                    managed.keepAliveGeneration += 1;
                    managed.keepAliveBusy = false;
                    managed.keepAliveBusySince = 0;
                    managed.keepAliveFailureCount += 1;
                    managed.keepAliveNextAt = now + 750;
                    managed.keepAliveLastHeartbeatAt = now;
                    this.updateState(managed, {
                        keepAliveActivity: 'recovering',
                        keepAliveFailureCount: managed.keepAliveFailureCount,
                        lastKeepAliveHeartbeatAt: new Date(now).toISOString()
                    });
                    Logger_1.logger.warn('browser', `Browser ${managed.id}: Keep Alive watchdog recovered a stale worker.`);
                }
                continue;
            }
            if (now < managed.keepAliveNextAt)
                continue;
            // Do NOT gate on webContents.isLoading(). A document can be fully
            // interactive while analytics/images/streaming requests keep Chromium's
            // network loading flag true. The action itself probes the live DOM and
            // is bounded by a timeout.
            const generation = managed.keepAliveGeneration;
            managed.keepAliveBusy = true;
            managed.keepAliveBusySince = now;
            managed.keepAliveLastHeartbeatAt = now;
            this.updateState(managed, {
                keepAliveActivity: 'scrolling',
                lastKeepAliveHeartbeatAt: new Date(now).toISOString()
            });
            void this.runKeepAliveAction(managed, generation).finally(() => {
                if (generation !== managed.keepAliveGeneration)
                    return;
                managed.keepAliveBusy = false;
                managed.keepAliveBusySince = 0;
                if (!managed.keepAliveEnabled)
                    return;
                if (managed.keepAliveNextAt <= Date.now()) {
                    const jitter = 0.8 + Math.random() * 0.4;
                    managed.keepAliveNextAt = Date.now() + Math.round(this.keepAliveIntervalMs * jitter);
                }
                managed.keepAliveLastHeartbeatAt = Date.now();
                this.updateState(managed, {
                    keepAliveActivity: 'waiting',
                    lastKeepAliveHeartbeatAt: new Date(managed.keepAliveLastHeartbeatAt).toISOString()
                });
            });
        }
    }
    async runKeepAliveAction(managed, generation) {
        const wc = managed.view.webContents;
        const pagesVisited = managed.keepAliveHops + 1;
        const controlled = managed.controlledKeepAliveContinuous && Boolean(managed.controlledKeepAliveHost);
        const canHop = controlled || (this.keepAliveFollowLinks && pagesVisited < this.keepAliveMaxHops);
        try {
            if (controlled && managed.controlledKeepAliveHost) {
                let currentHost = '';
                try {
                    currentHost = new URL(wc.getURL()).hostname
                        .toLowerCase()
                        .replace(/^www\./, '')
                        .replace(/\.$/, '');
                }
                catch {
                    currentHost = '';
                }
                if (currentHost !== managed.controlledKeepAliveHost) {
                    throw new Error(`Keep Alive left controlled host ${managed.controlledKeepAliveHost}; current host is ${currentHost || 'unknown'}.`);
                }
            }
            const actionPromise = wc.executeJavaScript(buildKeepAliveActionScript(canHop, Array.from(managed.keepAliveVisited), managed.controlledKeepAliveHost ?? undefined), true);
            const result = await withTimeout(
                actionPromise,
                this.keepAliveActionTimeoutMs, () => {
                    throw new Error(`Keep Alive DOM action exceeded ${this.keepAliveActionTimeoutMs} ms.`);
                });
            if (generation !== managed.keepAliveGeneration || !managed.keepAliveEnabled)
                return;
            const completedAt = new Date().toISOString();
            managed.keepAliveLastHeartbeatAt = Date.now();
            managed.keepAliveFailureCount = 0;
            if (result.reading) {
                // Reading resumes in bounded chunks, keeping Stop, the DOM
                // action timeout and the watchdog responsive on long articles.
                managed.keepAliveNextAt = Date.now() + 250;
                return;
            }
            if (!controlled && pagesVisited >= this.keepAliveMaxHops) {
                managed.keepAliveEnabled = false;
                this.updateState(managed, {
                    lastKeepAliveAt: completedAt,
                    keepAliveEnabled: false,
                    keepAliveHops: managed.keepAliveHops,
                    keepAliveActivity: 'idle',
                    keepAliveFailureCount: 0,
                    lastKeepAliveHeartbeatAt: new Date(managed.keepAliveLastHeartbeatAt).toISOString()
                });
                return;
            }
            if (!canHop || !result.clickedUrl) {
                if (controlled) {
                    managed.keepAliveNextAt = Date.now() + 2_000;
                    this.updateState(managed, {
                        lastKeepAliveAt: completedAt,
                        keepAliveEnabled: true,
                        keepAliveHops: managed.keepAliveHops,
                        keepAliveActivity: 'waiting',
                        keepAliveFailureCount: 0,
                        lastKeepAliveHeartbeatAt: new Date(managed.keepAliveLastHeartbeatAt).toISOString()
                    });
                    return;
                }
                managed.keepAliveEnabled = false;
                this.updateState(managed, {
                    lastKeepAliveAt: completedAt,
                    keepAliveEnabled: false,
                    keepAliveHops: managed.keepAliveHops,
                    keepAliveActivity: 'idle',
                    keepAliveFailureCount: 0,
                    lastKeepAliveHeartbeatAt: new Date(managed.keepAliveLastHeartbeatAt).toISOString()
                });
                return;
            }
            managed.keepAliveVisited.add(result.clickedUrl);
            managed.keepAliveHops += 1;
            if (controlled)
                managed.keepAliveNextAt = Date.now() + 1_500;
            this.updateState(managed, {
                keepAliveEnabled: true,
                keepAliveHops: managed.keepAliveHops,
                lastKeepAliveAt: completedAt,
                keepAliveActivity: 'opening-link',
                keepAliveFailureCount: 0,
                lastKeepAliveHeartbeatAt: new Date(managed.keepAliveLastHeartbeatAt).toISOString()
            });
        }
        catch (err) {
            if (generation !== managed.keepAliveGeneration || !managed.keepAliveEnabled)
                return;
            managed.keepAliveFailureCount += 1;
            managed.keepAliveLastHeartbeatAt = Date.now();
            managed.keepAliveNextAt = Date.now() + 1_250;
            this.updateState(managed, {
                keepAliveActivity: 'recovering',
                keepAliveFailureCount: managed.keepAliveFailureCount,
                lastKeepAliveHeartbeatAt: new Date(managed.keepAliveLastHeartbeatAt).toISOString()
            });
            Logger_1.logger.warn('browser', `Browser ${managed.id}: Keep Alive action failed; retrying: ${err.message}`);
        }
    }
}
exports.BrowserManager = BrowserManager;
function buildKeepAliveActionScript(allowHop, visitedUrls = [], allowedHost) {
    return `(async () => {
    window.__domKeepAliveController?.abort();
    const controller = new AbortController();
    window.__domKeepAliveController = controller;
    const signal = controller.signal;
    signal.addEventListener('abort', () => window.scrollTo?.({ top: window.scrollY || 0, behavior: 'instant' }), { once: true });
    try {
    const visited = new Set(${JSON.stringify(visitedUrls)});
    const allowedHost = ${JSON.stringify(allowedHost?.toLowerCase() ?? '')};
    const wait = (ms) => new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Keep Alive cancelled.')); return; }
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Keep Alive cancelled.')); };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
    const root = document.scrollingElement || document.documentElement || document.body;
    const pageHeight = () => Math.max(
      root ? root.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );
    const maxScroll = () => Math.max(0, pageHeight() - window.innerHeight);

    // State belongs to this document, so every real page navigation starts
    // a new minimum dwell. Chunks retain progress without restarting at top.
    const pageKey = () => typeof location === 'undefined' ? '' : String(location.href).split('#')[0];
    const now = performance.now();
    let reading = window.__domKeepAliveReading;
    if (!reading || reading.page !== pageKey()) {
      reading = { page: pageKey(), startedAt: now, lastTickAt: now, startY: Math.max(0, window.scrollY || 0), duration: 30_000 };
      window.__domKeepAliveReading = reading;
    }
    if (reading.clickedAt != null && now - reading.clickedAt < 8_500) return { reading: true };
    reading.clickedAt = undefined;
    const content = document.querySelector?.('article') || document.querySelector?.('main,[role="main"]') || document.body;
    const words = String(content?.innerText || content?.textContent || '').match(/[\\p{L}\\p{N}\\p{M}]+/gu)?.length || 0;
    reading.duration = Math.max(reading.duration, 30_000, words * 60_000 / 450,
      Math.max(0, maxScroll() - reading.startY) * 1000 / 120);
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      if (reading.page !== pageKey()) return { reading: true };
      const tickAt = performance.now();
      const elapsed = tickAt - reading.startedAt;
      const progress = Math.min(1, elapsed / reading.duration);
      const end = maxScroll();
      const desired = reading.startY + Math.max(0, end - reading.startY) * progress;
      // Lazy images/content can increase height. Bound the next movement so
      // layout growth cannot jump past paragraphs that have just appeared.
      const step = 120 * Math.min(1, Math.max(0, tickAt - reading.lastTickAt) / 1000);
      reading.lastTickAt = tickAt;
      const next = Math.min(desired, (window.scrollY || 0) + step);
      // Native smooth scrolling avoids a per-frame JavaScript loop in every
      // browser. Reading only advances; it does not cycle down and back up.
      if (next > (window.scrollY || 0) + 1) window.scrollTo({ top: next, behavior: 'smooth' });
      if (progress >= 1 && end - (window.scrollY || 0) <= 2) break;
      await wait(Math.min(200, Math.max(1, deadline - performance.now())));
    }
    if (reading.page !== pageKey() || performance.now() - reading.startedAt < reading.duration || maxScroll() - (window.scrollY || 0) > 2)
      return { reading: true };

    if (!${allowHop ? 'true' : 'false'}) return {};

    const blocked = /(login|log-in|logout|sign-in|signin|signup|register|account|cart|basket|checkout|payment|subscribe|privacy|terms|contact|download|delete|remove|admin|wp-admin|wp-login|author|tag|category)/i;
    const currentUrl = new URL(location.href);
    currentUrl.hash = '';
    const currentHost = currentUrl.hostname.toLowerCase().replace(/^www\\./, '');
    const seen = {};
    const candidates = [];

    Array.from(document.querySelectorAll('a[href]')).forEach((anchor) => {
      try {
        if (anchor.hasAttribute('download')) return;
        const rel = (anchor.getAttribute('rel') || '').toLowerCase();
        if (rel.includes('sponsored') || rel.includes('nofollow sponsored')) return;

        const text = (anchor.textContent || '').trim();
        if (text.length < 6 || blocked.test(text)) return;

        const url = new URL(anchor.href, location.href);
        if (!/^https?:$/.test(url.protocol)) return;

        const host = url.hostname.toLowerCase().replace(/^www\\./, '');
        if (host !== currentHost) return;
        if (allowedHost && host !== allowedHost) return;

        url.hash = '';
        const normalized = url.href;
        if (normalized === currentUrl.href || visited.has(normalized)) return;
        if (blocked.test(url.pathname + url.search)) return;
        if (seen[normalized]) return;
        seen[normalized] = true;

        // Favor article-looking links, but keep a same-site content fallback.
        var score = 0;
        const lowerPath = url.pathname.toLowerCase();
        if (
          lowerPath.includes('/article/') ||
          lowerPath.includes('/blog/') ||
          lowerPath.includes('/post/') ||
          lowerPath.includes('/news/') ||
          lowerPath.includes('/story/')
        ) score += 100;
        if (anchor.closest && anchor.closest('article')) score += 80;
        if (anchor.querySelector && anchor.querySelector('h1,h2,h3,h4')) score += 60;
        if (text.length >= 20) score += 30;
        if (url.pathname.split('/').filter(Boolean).length >= 2) score += 20;

        const rect = anchor.getBoundingClientRect();
        if (rect.width > 1 && rect.height > 1) score += 10;

        candidates.push({ anchor, url: normalized, score });
      } catch (_) {
        // Ignore malformed/non-web anchors.
      }
    });

    if (!candidates.length) return {};

    candidates.sort((a, b) => b.score - a.score);
    const topScore = candidates[0].score;
    const top = candidates.filter((candidate) => candidate.score >= topScore - 15);
    const chosen = top[Math.floor(Math.random() * top.length)];

    try {
      // An earlier inline link can be clicked without reversing the reading scroll.
      const rect = chosen.anchor.getBoundingClientRect();
      if (rect.top >= window.innerHeight) chosen.anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      await wait(250);
      chosen.anchor.target = '_self';
      chosen.anchor.focus({ preventScroll: true });
      if (reading.page !== pageKey() || signal.aborted) return { reading: true };
      reading.clickedAt = performance.now();
      chosen.anchor.click();
      return { clickedUrl: chosen.url };
    } catch (_) {
      return {};
    }
    } finally {
      if (window.__domKeepAliveController === controller) delete window.__domKeepAliveController;
    }
  })()`;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isGoogleSearchResultsUrl(url) {
    try {
        const parsed = new URL(url);
        return /(^|\.)google\.[a-z.]+$/i.test(parsed.hostname) && parsed.pathname === '/search';
    }
    catch {
        return false;
    }
}
function buildInstallGoogleLiveTargetObserverScript(targetHost, query = '') {
    return `(function() {
        const inspectGooglePrompt = ${inspectGooglePrompt.toString()};
        const recognizeGoogleResults = ${recognizeGoogleResults.toString()};
        const installGoogleResultObserver = ${installGoogleResultObserver.toString()};
        return installGoogleResultObserver(${JSON.stringify(targetHost)}, ${JSON.stringify(query)}).state;
    })()`;
}
function buildReadGoogleLiveTargetObserverScript() {
    return `window.__domGoogleWatcher?.state || null`;
}
function buildClickGoogleLiveTargetObserverScript() {
    return `Boolean(window.__domGoogleWatcher?.click())`;
}
function buildStopGoogleLiveTargetObserverScript() {
    return `(function() { window.__domGoogleWatcher?.stop(); delete window.__domGoogleWatcher; return true; })()`;
}
function buildGoogleResultScanScript(targetHost, query = '') {
    return `(function() {
        const inspectGooglePrompt = ${inspectGooglePrompt.toString()};
        const recognizeGoogleResults = ${recognizeGoogleResults.toString()};
        const state = recognizeGoogleResults(${JSON.stringify(targetHost)}, ${JSON.stringify(query)}).state;
        return Object.assign(state, { ready: state.observedResults > 0, resultsScanned: state.observedResults });
    })()`;
}
function buildClickGoogleTargetResultScript(targetHost, query = '') {
    return `(function() {
        const inspectGooglePrompt = ${inspectGooglePrompt.toString()};
        const recognizeGoogleResults = ${recognizeGoogleResults.toString()};
        const result = recognizeGoogleResults(${JSON.stringify(targetHost)}, ${JSON.stringify(query)});
        if (!result.anchor || !result.state.match) return false;
        result.anchor.target = '_self';
        result.anchor.click();
        return true;
    })()`;
}
function normalizeUrl(input) {
    const trimmed = input.trim();
    // Accept non-network schemes used internally, especially about:blank.
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed))
        return trimmed;
    if (/^localhost(:\d+)?/.test(trimmed) || /^\d{1,3}(\.\d{1,3}){3}/.test(trimmed)) {
        return `http://${trimmed}`;
    }
    return `https://${trimmed}`;
}
//# sourceMappingURL=BrowserManager.js.map
