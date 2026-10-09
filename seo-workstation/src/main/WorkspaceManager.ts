import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import log from 'electron-log/main';
import type { BrowserEngine, WorkspacePreferences } from '../shared/types/browser';
import type { ProxyRecord } from '../shared/types/proxy';
import type { WorkspaceState } from '../shared/types/workspace';
import type { SeoBrowserResult, SeoRunRequest, SeoRunSummary } from '../shared/types/seo';
import type { WorkspaceInputEvent, WorkspacePointerButton } from '../shared/types/interaction';
import type { WorkspacePreviewFrame, WorkspacePreviewMode } from '../shared/types/preview';
import { KeepAliveController } from './automation/KeepAliveController';
import { EngineResolver } from './browser/EngineResolver';
import { getPlaywright, type PwBrowser, type PwContext, type PwPage } from './browser/PlaywrightRuntime';
import { ProxyManager } from './ProxyManager';
import { SettingsManager } from './SettingsManager';
import { allocateSeoKeywords, parseSeoKeywords } from '../shared/seoKeywords';
import { createLaunchLimiter } from './seo/LaunchLimiter';
import { buildGoogleSearchUrl, clickVisibleTargetResult, detectGoogleChallenge, extractOrganicResults, findAnyTargetLink, hostMatchesTarget, normalizeTargetHost, unwrapGoogleResultUrl, waitForTargetLanding } from './seo/SeoTracker';

interface WorkspaceRuntime {
  state: WorkspaceState;
  browser?: PwBrowser;
  context?: PwContext;
  page?: PwPage;
  rotationTimer?: NodeJS.Timeout;
  previewTimer?: NodeJS.Timeout;
  previewMode: WorkspacePreviewMode;
  previewInFlight: boolean;
  previewRequested: boolean;
  previewSequence: number;
  previewFailures: number;
  lastPreviewSuccessAt: number;
  recovering: boolean;
  lastRecoveryAt: number;
  generation: number;
}

const DEFAULT_TARGET = 'https://www.google.com/';
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
const LIVE_ACTIVE_INTERVAL_MS = 90; // adaptive target: up to ~11 FPS while actively controlled
const LIVE_VISIBLE_INTERVAL_MS = 260; // adaptive target: ~4 FPS for visible passive cards
const LIVE_CAPTURE_TIMEOUT_MS = 2200;
const LIVE_RECOVERY_FAILURES = 4;
const LIVE_RECOVERY_COOLDOWN_MS = 20_000;
const INPUT_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 5000;
const MAX_CONCURRENT_PREVIEW_CAPTURES = 6;
const WATCHDOG_INTERVAL_MS = 5_000;
const PREVIEW_STALE_REQUEST_MS = 12_000;
const PREVIEW_STALE_RECOVER_MS = 30_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value) return DEFAULT_TARGET;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { throw new Error('Enter a valid web address'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS pages are allowed');
  return parsed.toString();
}

function publicProxy(proxy?: ProxyRecord): WorkspaceState['proxy'] {
  if (!proxy) return undefined;
  const safe = { ...proxy };
  delete safe.password;
  return safe;
}

function proxyOptions(proxy?: ProxyRecord): Record<string, unknown> | undefined {
  if (!proxy) return undefined;
  return {
    server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
    username: proxy.username,
    password: proxy.password
  };
}

function mobileOptions(engine: BrowserEngine): Record<string, unknown> {
  const common = {
    viewport: MOBILE_VIEWPORT,
    screen: MOBILE_VIEWPORT,
    deviceScaleFactor: 3,
    hasTouch: true,
    locale: 'en-US',
    colorScheme: 'dark'
  };
  if (engine === 'firefox') {
    return {
      ...common,
      userAgent: 'Mozilla/5.0 (Android 15; Mobile; rv:155.0) Gecko/155.0 Firefox/155.0'
    };
  }
  if (engine === 'webkit') {
    const iphone = getPlaywright().devices['iPhone 15'] ?? {};
    return {
      ...iphone,
      viewport: common.viewport,
      screen: common.screen,
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true,
      locale: 'en-US',
      colorScheme: 'dark',
      userAgent: typeof iphone.userAgent === 'string'
        ? iphone.userAgent
        : 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    };
  }
  if (engine === 'edge') {
    return {
      ...common,
      isMobile: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36 EdgA/153.0.0.0'
    };
  }
  if (engine === 'opera') {
    return {
      ...common,
      isMobile: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36 OPR/122.0.0.0'
    };
  }
  return {
    ...common,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36'
  };
}

export class WorkspaceManager extends EventEmitter {
  private readonly runtimes = new Map<number, WorkspaceRuntime>();
  private readonly keepAlive = new KeepAliveController();
  private readonly prefsFile = path.join(app.getPath('userData'), 'workspace-preferences.json');
  private readonly resolver: EngineResolver;
  private previewCapturesInFlight = 0;
  private readonly watchdogTimer: NodeJS.Timeout;
  private prefs: WorkspacePreferences[];
  private activeSeoRun?: { cancelled: Set<number> };

  constructor(private readonly settings: SettingsManager, private readonly proxies: ProxyManager) {
    super();
    this.resolver = new EngineResolver(() => this.settings.get().operaExecutablePath);
    // Privacy-first lifecycle: every application start begins with completely
    // fresh browser profiles. Settings/history live elsewhere and are preserved.
    this.purgeAllBrowserProfiles();
    this.prefs = this.loadPreferences();
    this.initializeStates();
    this.watchdogTimer = setInterval(() => { void this.runWatchdog(); }, WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref?.();
  }

  private profilesRoot(): string {
    return path.join(app.getPath('userData'), 'browser-profiles');
  }

  private purgeAllBrowserProfiles(): void {
    try { fs.rmSync(this.profilesRoot(), { recursive: true, force: true }); }
    catch (error) { log.warn('Could not remove browser profiles during fresh-start cleanup', error); }
  }

  private purgeWorkspaceProfiles(id: number): void {
    try {
      fs.rmSync(path.join(this.profilesRoot(), `workspace-${id}`), { recursive: true, force: true });
    } catch (error) {
      log.warn(`Could not remove browser profile for workspace ${id}`, error);
    }
  }

  private loadPreferences(): WorkspacePreferences[] {
    const settings = this.settings.get();
    let stored: Partial<WorkspacePreferences>[] = [];
    try {
      if (fs.existsSync(this.prefsFile)) stored = JSON.parse(fs.readFileSync(this.prefsFile, 'utf8')) as Partial<WorkspacePreferences>[];
    } catch { stored = []; }
    return Array.from({ length: settings.browserCount }, (_, index) => {
      const id = index + 1;
      const previous = stored.find((item) => item.id === id);
      return {
        id,
        engine: previous?.engine ?? settings.enginePlan[index] ?? 'chromium',
        // URLs and Keep Alive state are intentionally session-only. A fresh app
        // start must never reopen the previous browsing session.
        targetUrl: DEFAULT_TARGET,
        rotationSeconds: Math.max(0, Math.floor(previous?.rotationSeconds ?? settings.defaultRotationSeconds)),
        keepAlive: false
      };
    });
  }

  private savePreferences(): void {
    fs.mkdirSync(path.dirname(this.prefsFile), { recursive: true });
    // Persist only non-browsing preferences. Do not write visited/target URLs or
    // Keep Alive state to disk; those belong to the current app session only.
    const persisted = this.prefs.map((pref) => ({
      id: pref.id,
      engine: pref.engine,
      targetUrl: DEFAULT_TARGET,
      rotationSeconds: pref.rotationSeconds,
      keepAlive: false
    }));
    fs.writeFileSync(this.prefsFile, JSON.stringify(persisted, null, 2), 'utf8');
  }

  private initializeStates(): void {
    for (const pref of this.prefs) {
      const engine = this.resolver.get(pref.engine);
      this.runtimes.set(pref.id, {
        generation: 0,
        previewMode: 'hidden',
        previewInFlight: false,
        previewRequested: false,
        previewSequence: 0,
        previewFailures: 0,
        lastPreviewSuccessAt: 0,
        recovering: false,
        lastRecoveryAt: 0,
        state: {
          id: pref.id,
          title: `Browser ${pref.id}`,
          url: pref.targetUrl,
          targetUrl: pref.targetUrl,
          status: engine.available ? 'stopped' : 'unavailable',
          engine: pref.engine,
          engineLabel: engine.label,
          engineAvailable: engine.available,
          keepAlive: pref.keepAlive,
          rotationSeconds: pref.rotationSeconds,
          visitedLinks: 0,
          proxy: publicProxy(this.proxies.getAssignedProxy(pref.id)),
          error: engine.available ? undefined : engine.detail
        }
      });
    }
  }

  getStates(): WorkspaceState[] {
    return [...this.runtimes.values()].sort((a, b) => a.state.id - b.state.id).map((runtime) => structuredClone(runtime.state));
  }

  private workspaceIds(): number[] {
    return [...this.runtimes.keys()].sort((a, b) => a - b);
  }

  async reconcileBrowserCount(count: number): Promise<void> {
    const target = Math.min(100, Math.max(1, Math.floor(Number(count) || 10)));

    // Shrinking closes removed browsers first so their processes, timers and
    // profiles cannot linger after the UI removes them.
    for (const id of this.workspaceIds().filter((id) => id > target).sort((a, b) => b - a)) {
      await this.closeRuntime(id, false);
      this.purgeWorkspaceProfiles(id);
      this.runtimes.delete(id);
    }
    this.prefs = this.prefs.filter((pref) => pref.id <= target);

    const settings = this.settings.get();
    for (let id = 1; id <= target; id += 1) {
      if (this.runtimes.has(id)) continue;
      const pref: WorkspacePreferences = {
        id,
        engine: settings.enginePlan[id - 1] ?? 'chromium',
        targetUrl: DEFAULT_TARGET,
        rotationSeconds: Math.max(0, Math.floor(settings.defaultRotationSeconds)),
        keepAlive: false
      };
      this.prefs.push(pref);
      const engine = this.resolver.get(pref.engine);
      this.runtimes.set(id, {
        generation: 0,
        previewMode: 'hidden',
        previewInFlight: false,
        previewRequested: false,
        previewSequence: 0,
        previewFailures: 0,
        lastPreviewSuccessAt: 0,
        recovering: false,
        lastRecoveryAt: 0,
        state: {
          id, title: `Browser ${id}`, url: DEFAULT_TARGET, targetUrl: DEFAULT_TARGET,
          status: engine.available ? 'stopped' : 'unavailable', engine: pref.engine,
          engineLabel: engine.label, engineAvailable: engine.available, keepAlive: false,
          rotationSeconds: pref.rotationSeconds, visitedLinks: 0,
          proxy: publicProxy(this.proxies.getAssignedProxy(id)),
          error: engine.available ? undefined : engine.detail
        }
      });
    }
    this.prefs.sort((a, b) => a.id - b.id);
    this.proxies.syncBrowserCount(target);
    this.savePreferences();
  }

  private require(id: number): WorkspaceRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`Unknown workspace ${id}`);
    return runtime;
  }

  private getPref(id: number): WorkspacePreferences {
    const pref = this.prefs.find((item) => item.id === id);
    if (!pref) throw new Error(`Unknown workspace ${id}`);
    return pref;
  }

  private patch(id: number, patch: Partial<WorkspaceState>): void {
    const runtime = this.require(id);
    runtime.state = { ...runtime.state, ...patch };
    this.emit('state', structuredClone(runtime.state));
  }

  private profileDir(id: number, engine: BrowserEngine): string {
    // Browser profile formats are engine-specific. Keeping a separate directory
    // prevents a Firefox/WebKit switch from opening a Chromium profile (or vice versa).
    return path.join(this.profilesRoot(), `workspace-${id}`, engine);
  }

  private async clearOneBrowserData(id: number): Promise<void> {
    const pref = this.getPref(id);
    const runtime = this.require(id);

    // The strongest clear operation is to close the persistent browser context
    // and remove that workspace's entire profile directory. This removes HTTP
    // cache, cookies, local/session storage, IndexedDB, service workers, cache
    // storage and the previous navigation/profile state in one operation.
    await this.closeRuntime(id, false);
    this.purgeWorkspaceProfiles(id);

    pref.targetUrl = DEFAULT_TARGET;
    pref.keepAlive = false;
    this.patch(id, {
      title: `Browser ${id}`,
      targetUrl: DEFAULT_TARGET,
      url: DEFAULT_TARGET,
      keepAlive: false,
      visitedLinks: 0,
      detectedIp: undefined,
      lastIpCheckAt: undefined,
      nextRotationAt: undefined,
      error: undefined,
      status: runtime.state.engineAvailable ? 'stopped' : 'unavailable'
    });
  }

  async clearBrowserData(workspaceIds: number[]): Promise<number[]> {
    const ids = [...new Set(workspaceIds)]
      .filter((id) => Number.isInteger(id) && this.runtimes.has(id))
      .sort((a, b) => a - b);
    if (!ids.length) return [];

    for (const id of ids) await this.clearOneBrowserData(id);
    this.savePreferences();
    return ids;
  }

  private async launchTargetAfterClear(id: number, targetUrl: string): Promise<void> {
    const pref = this.getPref(id);
    const runtime = this.require(id);
    pref.targetUrl = normalizeUrl(targetUrl);
    pref.keepAlive = false;
    this.savePreferences();
    this.patch(id, {
      targetUrl: pref.targetUrl,
      url: pref.targetUrl,
      keepAlive: false,
      visitedLinks: 0,
      detectedIp: undefined,
      lastIpCheckAt: undefined,
      nextRotationAt: undefined,
      error: undefined,
      status: runtime.state.engineAvailable ? 'stopped' : 'unavailable'
    });
    await this.launch(id);
  }

  private async startFreshSession(id: number, targetUrl: string): Promise<void> {
    await this.clearOneBrowserData(id);
    await this.launchTargetAfterClear(id, targetUrl);
  }

  private browserLaunchOptions(engine: BrowserEngine): Record<string, unknown> {
    const engineInfo = this.resolver.get(engine);
    const options: Record<string, unknown> = {
      // Each workspace gets its own browser process. We intentionally prefer RAM
      // isolation over profile reuse: a stuck/crashed workspace can be restarted
      // without contaminating any other browser or leaving a persistent profile lock.
      headless: true,
      timeout: 20_000
    };
    if (engine === 'chromium' || engine === 'edge' || engine === 'opera') {
      options.args = [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion'
      ];
    }
    if (engine === 'edge') options.channel = 'msedge';
    if (engine === 'opera' && engineInfo.executablePath) options.executablePath = engineInfo.executablePath;
    return options;
  }

  private contextOptions(engine: BrowserEngine, proxy?: ProxyRecord): Record<string, unknown> {
    return {
      ...mobileOptions(engine),
      proxy: proxyOptions(proxy),
      acceptDownloads: true,
      ignoreHTTPSErrors: false
    };
  }

  private browserType(engine: BrowserEngine) {
    const pw = getPlaywright();
    if (engine === 'firefox') return pw.firefox;
    if (engine === 'webkit') return pw.webkit;
    return pw.chromium;
  }

  async launch(id: number): Promise<void> {
    const runtime = this.require(id);
    const pref = this.getPref(id);
    const engineInfo = this.resolver.get(pref.engine);
    if (!engineInfo.available) {
      this.patch(id, { status: 'unavailable', engineAvailable: false, error: engineInfo.detail });
      return;
    }

    await this.closeRuntime(id, false);
    const generation = runtime.generation + 1;
    runtime.generation = generation;
    this.patch(id, {
      status: 'launching',
      error: undefined,
      engineAvailable: true,
      engineLabel: engineInfo.label,
      proxy: publicProxy(this.proxies.getAssignedProxy(id))
    });

    let browser: PwBrowser | undefined;
    let context: PwContext | undefined;
    try {
      browser = await withTimeout(
        this.browserType(pref.engine).launch(this.browserLaunchOptions(pref.engine)),
        20_000,
        `Browser ${id} process launch`
      );
      if (runtime.generation !== generation) {
        await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, `Browser ${id} stale process close`).catch(() => undefined);
        return;
      }
      runtime.browser = browser;

      browser.on('disconnected', () => {
        const current = this.runtimes.get(id);
        if (!current || current.generation !== generation || current.browser !== browser) return;
        current.browser = undefined;
        current.context = undefined;
        current.page = undefined;
        this.keepAlive.disable(id);
        if (current.rotationTimer) clearTimeout(current.rotationTimer);
        current.rotationTimer = undefined;
        this.stopPreviewTimer(current);
        current.previewInFlight = false;
        current.previewRequested = false;
        this.emitPreviewFrame(id, undefined, 'Browser process disconnected');
        this.patch(id, { status: 'error', nextRotationAt: undefined, error: 'Browser process disconnected unexpectedly.' });
        void this.recoverWorkspace(id, 'Browser process disconnected');
      });

      context = await withTimeout(
        browser.newContext(this.contextOptions(pref.engine, this.proxies.getAssignedProxy(id))),
        15_000,
        `Browser ${id} context creation`
      );
      if (runtime.generation !== generation) {
        await withTimeout(context.close(), CLOSE_TIMEOUT_MS, `Browser ${id} stale context close`).catch(() => undefined);
        await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, `Browser ${id} stale browser close`).catch(() => undefined);
        return;
      }
      runtime.context = context;
      context.setDefaultTimeout(15_000);
      context.setDefaultNavigationTimeout(45_000);

      context.on('page', (...args: unknown[]) => {
        const nextPage = args[0] as PwPage | undefined;
        if (!nextPage) return;
        const current = this.runtimes.get(id);
        if (!current || current.generation !== generation || current.context !== context) return;
        current.page = nextPage;
        this.bindPage(id, nextPage, generation);
        void nextPage.bringToFront().catch(() => undefined);
        void this.refreshMeta(id);
        this.applyKeepAlive(id);
        this.schedulePreview(id, 0);
      });
      context.on('close', () => {
        const current = this.runtimes.get(id);
        if (!current || current.generation !== generation || current.context !== context) return;
        current.context = undefined;
        current.page = undefined;
        this.keepAlive.disable(id);
        if (current.rotationTimer) clearTimeout(current.rotationTimer);
        current.rotationTimer = undefined;
        this.stopPreviewTimer(current);
        current.previewInFlight = false;
        current.previewRequested = false;
        current.previewFailures = 0;
        this.emitPreviewFrame(id, undefined, 'Browser stopped');
        this.patch(id, { status: 'stopped', nextRotationAt: undefined });
      });

      runtime.page = context.pages()[0] ?? await context.newPage();
      this.bindPage(id, runtime.page, generation);
      await runtime.page.goto(pref.targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      if (runtime.generation !== generation || runtime.page.isClosed()) return;
      await this.refreshMeta(id);
      this.patch(id, { status: 'ready', url: runtime.page.url(), targetUrl: pref.targetUrl });
      runtime.previewFailures = 0;
      runtime.lastPreviewSuccessAt = Date.now();
      this.applyKeepAlive(id);
      this.scheduleRotation(id);
      this.schedulePreview(id, 0);
    } catch (error) {
      log.warn(`Workspace ${id} launch failed`, error);
      runtime.browser = undefined;
      runtime.context = undefined;
      runtime.page = undefined;
      runtime.previewFailures = 0;
      runtime.previewRequested = false;
      this.stopPreviewTimer(runtime);
      if (context) await withTimeout(context.close(), CLOSE_TIMEOUT_MS, `Browser ${id} failed context close`).catch(() => undefined);
      if (browser) await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, `Browser ${id} failed process close`).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      this.emitPreviewFrame(id, undefined, message);
      this.patch(id, { status: 'error', error: message });
    }
  }

  async launchAll(): Promise<void> {
    // Bounded parallel startup makes larger fleets practical without creating a
    // single CPU/RAM spike. Six concurrent launches intentionally trades more
    // memory for substantially faster startup on modern systems.
    const ids = this.workspaceIds();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(6, ids.length) }, async () => {
      while (true) {
        const id = ids[cursor++];
        if (id === undefined) return;
        await this.launch(id);
      }
    });
    await Promise.all(workers);
  }

  private bindPage(id: number, page: PwPage, generation: number): void {
    const refresh = () => {
      const runtime = this.require(id);
      if (runtime.generation !== generation || runtime.page !== page) return;
      void this.refreshMeta(id);
    };
    page.on('domcontentloaded', refresh);
    page.on('load', refresh);
    page.on('framenavigated', refresh);
    page.on('crash', () => {
      const runtime = this.require(id);
      if (runtime.generation !== generation || runtime.page !== page) return;
      void this.recoverWorkspace(id, 'Browser page crashed');
    });
  }

  private async refreshMeta(id: number): Promise<void> {
    const runtime = this.require(id);
    if (!runtime.page || runtime.page.isClosed()) return;
    try {
      const [title] = await Promise.all([runtime.page.title()]);
      this.patch(id, { title: title || `Browser ${id}`, url: runtime.page.url(), status: 'ready' });
    } catch { /* page may be between navigations */ }
  }

  private async closeRuntime(id: number, updateState = true): Promise<void> {
    const runtime = this.require(id);
    runtime.generation += 1;
    if (runtime.rotationTimer) clearTimeout(runtime.rotationTimer);
    runtime.rotationTimer = undefined;
    this.stopPreviewTimer(runtime);
    runtime.previewInFlight = false;
    runtime.previewRequested = false;
    runtime.previewFailures = 0;
    this.keepAlive.disable(id);

    const context = runtime.context;
    const browser = runtime.browser;
    runtime.context = undefined;
    runtime.browser = undefined;
    runtime.page = undefined;

    if (context) {
      await withTimeout(context.close(), CLOSE_TIMEOUT_MS, `Browser ${id} context close`).catch((error) => {
        log.warn(`[lifecycle] Browser ${id} context close did not complete cleanly`, error);
      });
    }
    if (browser?.isConnected()) {
      await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, `Browser ${id} process close`).catch((error) => {
        log.warn(`[lifecycle] Browser ${id} process close did not complete cleanly`, error);
      });
    }
    if (updateState) this.patch(id, { status: 'stopped', nextRotationAt: undefined, error: undefined });
  }

  async stop(id: number): Promise<void> {
    this.activeSeoRun?.cancelled.add(id);
    await this.closeRuntime(id, true);
  }
  async stopAll(): Promise<void> {
    const ids = this.workspaceIds();
    for (const id of ids) this.activeSeoRun?.cancelled.add(id);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(8, ids.length) }, async () => {
      while (true) {
        const id = ids[cursor++];
        if (id === undefined) return;
        await this.closeRuntime(id, true);
      }
    });
    await Promise.all(workers);
  }

  async focus(id: number): Promise<void> {
    const runtime = this.require(id);
    if (!runtime.page) await this.launch(id);
    await this.require(id).page?.bringToFront();
  }

  async navigate(id: number, input: string): Promise<void> {
    const url = normalizeUrl(input);
    const pref = this.getPref(id);
    pref.targetUrl = url;
    this.savePreferences();
    this.patch(id, { targetUrl: url, url, status: this.require(id).page ? 'loading' : this.require(id).state.status });
    const runtime = this.require(id);
    if (!runtime.page) { await this.launch(id); return; }
    await runtime.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.refreshMeta(id);
  }

  async setTarget(id: number, input: string): Promise<void> { await this.navigate(id, input); }

  async applyTargets(entries: Array<{ id: number; url: string }>): Promise<void> {
    // Central navigation can target up to 100 workspaces. Use bounded concurrency
    // so large fleet dispatches do not serialize for minutes or spike the machine
    // by launching every headed browser at the exact same instant.
    const byWorkspace = new Map<number, string>();
    for (const entry of entries) {
      if (!this.runtimes.has(entry.id)) continue;
      byWorkspace.set(entry.id, entry.url);
    }
    const queue = [...byWorkspace.entries()].map(([id, url]) => ({ id, url }));
    if (!queue.length) return;

    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        const entry = queue[index];
        if (!entry) return;
        try {
          await this.navigate(entry.id, entry.url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.patch(entry.id, { status: 'error', error: `Central navigation failed: ${message}` });
          log.warn(`Central navigation failed for workspace ${entry.id}`, error);
        }
      }
    };

    const concurrency = Math.min(8, queue.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  async googleSearch(query: string, workspaceIds?: number[]): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) return;
    const url = `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
    const ids = workspaceIds?.length ? workspaceIds.filter((id) => this.runtimes.has(id)) : this.workspaceIds();
    // Every new search starts from a clean browser identity/storage state. Use
    // bounded parallelism so a large fleet does not feel hung while preserving
    // enough headroom for the renderer/live-view pipeline.
    let cursor = 0;
    const workers = Array.from({ length: Math.min(6, ids.length) }, async () => {
      while (true) {
        const id = ids[cursor++];
        if (id === undefined) return;
        await this.startFreshSession(id, url);
      }
    });
    await Promise.all(workers);
  }

  async reload(id: number): Promise<void> {
    const runtime = this.require(id);
    if (!runtime.page) { await this.launch(id); return; }
    this.patch(id, { status: 'loading' });
    await runtime.page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.refreshMeta(id);
  }

  async reloadAll(): Promise<void> {
    const ids = this.workspaceIds();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(8, ids.length) }, async () => {
      while (true) {
        const id = ids[cursor++];
        if (id === undefined) return;
        try { await this.reload(id); } catch { /* per-workspace state reports the failure */ }
      }
    });
    await Promise.all(workers);
  }

  async setEngine(id: number, engine: BrowserEngine): Promise<void> {
    const pref = this.getPref(id);
    const wasRunning = Boolean(this.require(id).context);
    pref.engine = engine;
    this.savePreferences();
    const info = this.resolver.get(engine);
    this.patch(id, { engine, engineLabel: info.label, engineAvailable: info.available, status: info.available ? 'stopped' : 'unavailable', error: info.available ? undefined : info.detail });
    if (wasRunning && info.available) await this.launch(id);
  }

  async setRotationSeconds(id: number, seconds: number): Promise<void> {
    const pref = this.getPref(id);
    pref.rotationSeconds = Math.max(0, Math.floor(seconds));
    this.savePreferences();
    this.patch(id, { rotationSeconds: pref.rotationSeconds });
    this.scheduleRotation(id);
  }

  async setKeepAlive(id: number, enabled: boolean): Promise<void> {
    const pref = this.getPref(id);
    pref.keepAlive = enabled;
    this.savePreferences();
    this.patch(id, { keepAlive: enabled });
    this.applyKeepAlive(id);
  }


  async setKeepAliveAll(enabled: boolean): Promise<void> {
    for (const id of this.workspaceIds()) {
      const pref = this.getPref(id);
      pref.keepAlive = enabled;
      this.patch(id, { keepAlive: enabled });
      this.applyKeepAlive(id);
    }
    this.savePreferences();
  }

  async sendInput(id: number, event: WorkspaceInputEvent): Promise<void> {
    const runtime = this.require(id);
    const page = runtime.page;
    if (!page || page.isClosed()) throw new Error(`Browser ${id} is not running`);

    const finite = (value: number, fallback = 0): number => Number.isFinite(value) ? value : fallback;
    const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, finite(value)));
    const button = (value?: WorkspacePointerButton): WorkspacePointerButton => value === 'middle' || value === 'right' ? value : 'left';

    const operation = async (): Promise<void> => {
      if (event.kind === 'pointer') {
        const x = clamp(event.x, 0, MOBILE_VIEWPORT.width - 1);
        const y = clamp(event.y, 0, MOBILE_VIEWPORT.height - 1);
        const selectedButton = button(event.button);
        await page.mouse.move(x, y);
        if (event.action === 'move') return;
        if (event.action === 'down') {
          await page.mouse.down({ button: selectedButton });
          return;
        }
        if (event.action === 'up') {
          await page.mouse.up({ button: selectedButton });
          return;
        }
        await page.mouse.click(x, y, {
          button: selectedButton,
          clickCount: Math.min(2, Math.max(1, Math.floor(event.clickCount ?? 1)))
        });
        return;
      }

      if (event.kind === 'wheel') {
        const deltaX = clamp(event.deltaX, -4000, 4000);
        const deltaY = clamp(event.deltaY, -4000, 4000);
        await page.mouse.wheel(deltaX, deltaY);
        return;
      }

      if (event.kind === 'text') {
        if (!event.text) return;
        await page.keyboard.insertText(event.text.slice(0, 10_000));
        return;
      }

      const key = event.key.trim();
      if (!key || key.length > 100) return;
      await page.keyboard.press(key);
    };

    try {
      await withTimeout(operation(), INPUT_TIMEOUT_MS, `Browser ${id} input`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out|closed|disconnected|crash/i.test(message)) {
        void this.recoverWorkspace(id, 'Interactive browser input stopped responding');
      }
      throw error;
    }
  }

  private stopPreviewTimer(runtime: WorkspaceRuntime): void {
    if (runtime.previewTimer) clearTimeout(runtime.previewTimer);
    runtime.previewTimer = undefined;
  }

  private previewInterval(runtime: WorkspaceRuntime): number | undefined {
    if (runtime.previewMode === 'active') return LIVE_ACTIVE_INTERVAL_MS;
    if (runtime.previewMode === 'visible') return LIVE_VISIBLE_INTERVAL_MS;
    return undefined;
  }

  private emitPreviewFrame(id: number, dataUrl?: string, error?: string, latencyMs = 0): void {
    const runtime = this.require(id);
    runtime.previewSequence += 1;
    const frame: WorkspacePreviewFrame = {
      workspaceId: id,
      sequence: runtime.previewSequence,
      capturedAt: new Date().toISOString(),
      latencyMs,
      dataUrl,
      error,
      recovering: runtime.recovering
    };
    this.emit('preview-frame', structuredClone(frame));
  }

  private schedulePreview(id: number, delay?: number): void {
    const runtime = this.require(id);
    this.stopPreviewTimer(runtime);
    const interval = this.previewInterval(runtime);
    if (interval === undefined || !runtime.page || runtime.page.isClosed()) return;
    runtime.previewTimer = setTimeout(() => {
      runtime.previewTimer = undefined;
      void this.capturePreviewFrame(id);
    }, Math.max(0, delay ?? interval));
  }

  private async capturePreviewData(page: PwPage, timeoutMs: number): Promise<string> {
    const bytes = await page.screenshot({
      type: 'jpeg',
      quality: 46,
      animations: 'allow',
      caret: 'initial',
      scale: 'css',
      timeout: timeoutMs
    });
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
  }

  private async capturePreviewFrame(id: number, force = false): Promise<void> {
    const runtime = this.require(id);
    const page = runtime.page;
    const interval = this.previewInterval(runtime);
    if (!page || page.isClosed()) return;
    if (!force && interval === undefined) return;

    if (runtime.previewInFlight) {
      if (force) runtime.previewRequested = true;
      return;
    }

    // A large fleet can otherwise start many expensive screenshots at once.
    // Keep a generous global cap (RAM is preferred over UI stalls) and retry
    // active cards quickly if all slots are temporarily busy.
    if (this.previewCapturesInFlight >= MAX_CONCURRENT_PREVIEW_CAPTURES) {
      this.schedulePreview(id, runtime.previewMode === 'active' ? 20 : 70);
      return;
    }

    runtime.previewInFlight = true;
    runtime.previewRequested = false;
    this.previewCapturesInFlight += 1;
    const started = Date.now();
    try {
      const dataUrl = await this.capturePreviewData(page, LIVE_CAPTURE_TIMEOUT_MS);
      if (runtime.page !== page || page.isClosed()) return;
      runtime.previewFailures = 0;
      runtime.lastPreviewSuccessAt = Date.now();
      this.emitPreviewFrame(id, dataUrl, undefined, Date.now() - started);
    } catch (error) {
      runtime.previewFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (runtime.previewFailures === 1 || runtime.previewFailures % 3 === 0) {
        log.warn(`[live-view] Browser ${id} capture failure ${runtime.previewFailures}: ${message}`);
        this.emitPreviewFrame(id, undefined, `Live view retrying: ${message}`, Date.now() - started);
      }

      const now = Date.now();
      if (
        runtime.previewFailures >= LIVE_RECOVERY_FAILURES &&
        !runtime.recovering &&
        now - runtime.lastRecoveryAt >= LIVE_RECOVERY_COOLDOWN_MS
      ) {
        void this.recoverWorkspace(id, 'Live view stopped responding');
      }
    } finally {
      runtime.previewInFlight = false;
      this.previewCapturesInFlight = Math.max(0, this.previewCapturesInFlight - 1);
      if (runtime.page === page && !page.isClosed()) {
        const nextTarget = this.previewInterval(runtime);
        if (nextTarget !== undefined) {
          const elapsed = Date.now() - started;
          const failureBackoff = Math.min(2500, runtime.previewFailures * 250);
          const requestedDelay = runtime.previewRequested ? 0 : Math.max(12, nextTarget - elapsed) + failureBackoff;
          runtime.previewRequested = false;
          this.schedulePreview(id, requestedDelay);
        }
      }
    }
  }

  async setPreviewMode(id: number, mode: WorkspacePreviewMode): Promise<void> {
    const runtime = this.require(id);
    runtime.previewMode = mode === 'active' || mode === 'visible' ? mode : 'hidden';
    if (runtime.previewMode === 'hidden') {
      this.stopPreviewTimer(runtime);
      runtime.previewRequested = false;
      return;
    }
    this.schedulePreview(id, 0);
  }

  async requestPreview(id: number): Promise<void> {
    const runtime = this.require(id);
    if (!runtime.page || runtime.page.isClosed()) return;
    if (runtime.previewInFlight) {
      runtime.previewRequested = true;
      return;
    }
    await this.capturePreviewFrame(id, true);
  }

  async getPreview(id: number): Promise<string | undefined> {
    // Backward-compatible one-shot capture used by diagnostics. The normal UI
    // uses the event-driven preview stream so multiple cards cannot create
    // overlapping screenshot RPCs and hang the main process.
    const runtime = this.require(id);
    const page = runtime.page;
    if (!page || page.isClosed()) return undefined;
    try {
      return await this.capturePreviewData(page, LIVE_CAPTURE_TIMEOUT_MS);
    } catch (error) {
      log.warn(`[live-view] Browser ${id} one-shot preview failed`, error);
      return undefined;
    }
  }

  private async recoverWorkspace(id: number, reason: string): Promise<void> {
    const runtime = this.require(id);
    if (runtime.recovering) return;
    const pref = this.getPref(id);
    if (!runtime.state.engineAvailable) return;

    runtime.recovering = true;
    runtime.lastRecoveryAt = Date.now();
    this.emitPreviewFrame(id, undefined, `${reason}. Restarting browser...`);
    log.warn(`[watchdog] Browser ${id}: ${reason}; restarting workspace.`);
    try {
      const keepAlive = pref.keepAlive;
      await this.launch(id);
      pref.keepAlive = keepAlive;
      this.patch(id, { keepAlive, error: undefined });
      this.applyKeepAlive(id);
      runtime.previewFailures = 0;
      this.schedulePreview(id, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.patch(id, { status: 'error', error: `Recovery failed: ${message}` });
      this.emitPreviewFrame(id, undefined, `Recovery failed: ${message}`);
    } finally {
      runtime.recovering = false;
    }
  }

  private async runWatchdog(): Promise<void> {
    const now = Date.now();
    for (const [id, runtime] of this.runtimes) {
      if (runtime.recovering) continue;
      const shouldBeRunning = ['ready', 'loading', 'rotating'].includes(runtime.state.status);
      if (!shouldBeRunning) continue;

      if (!runtime.browser?.isConnected() || !runtime.page || runtime.page.isClosed()) {
        if (now - runtime.lastRecoveryAt >= LIVE_RECOVERY_COOLDOWN_MS) {
          void this.recoverWorkspace(id, 'Browser watchdog detected a closed or disconnected page');
        }
        continue;
      }

      if (runtime.previewMode === 'hidden') continue;
      const age = runtime.lastPreviewSuccessAt > 0 ? now - runtime.lastPreviewSuccessAt : PREVIEW_STALE_RECOVER_MS + 1;
      if (age >= PREVIEW_STALE_RECOVER_MS && now - runtime.lastRecoveryAt >= LIVE_RECOVERY_COOLDOWN_MS) {
        void this.recoverWorkspace(id, 'Live view watchdog detected a stale browser');
      } else if (age >= PREVIEW_STALE_REQUEST_MS && !runtime.previewInFlight) {
        void this.requestPreview(id).catch(() => undefined);
      }
    }
  }

  private applyKeepAlive(id: number): void {
    const runtime = this.require(id);
    const pref = this.getPref(id);
    this.keepAlive.disable(id);
    if (!pref.keepAlive || !runtime.page) return;
    try {
      const current = new URL(runtime.page.url());
      const host = current.hostname.replace(/^www\./i, '').toLowerCase();
      if ((host === 'google.com' || host.endsWith('.google.com')) && current.pathname === '/search') return;
    } catch { /* page may be between navigations */ }
    this.keepAlive.enable(id, runtime.page, this.settings.get().keepAlive, () => {
      this.patch(id, { visitedLinks: this.require(id).state.visitedLinks + 1 });
      void this.refreshMeta(id);
    });
  }

  private scheduleRotation(id: number): void {
    const runtime = this.require(id);
    const pref = this.getPref(id);
    if (runtime.rotationTimer) clearTimeout(runtime.rotationTimer);
    runtime.rotationTimer = undefined;
    if (!runtime.context || pref.rotationSeconds <= 0) {
      this.patch(id, { nextRotationAt: undefined });
      return;
    }
    const next = new Date(Date.now() + pref.rotationSeconds * 1000).toISOString();
    this.patch(id, { nextRotationAt: next });
    runtime.rotationTimer = setTimeout(() => {
      void this.rotateProxy(id).finally(() => this.scheduleRotation(id));
    }, pref.rotationSeconds * 1000);
  }

  async rotateProxy(id: number): Promise<boolean> {
    const runtime = this.require(id);
    const wasRunning = Boolean(runtime.context);
    const replacement = this.proxies.chooseReplacement(id);
    if (!replacement) {
      this.patch(id, { error: 'No unused replacement proxy is available.' });
      return false;
    }
    this.patch(id, { status: 'rotating', proxy: publicProxy(replacement), detectedIp: undefined, error: undefined });
    if (wasRunning) await this.launch(id);
    else this.patch(id, { status: 'stopped' });
    return true;
  }

  async applyAssignments(): Promise<void> {
    for (const id of this.workspaceIds()) {
      const runtime = this.require(id);
      const next = this.proxies.getAssignedProxy(id);
      this.patch(id, { proxy: publicProxy(next), detectedIp: undefined });
      // Applying a new proxy to a running Playwright context requires recreation.
      // Relaunching always returns to targetUrl, which is the central-control URL.
      if (runtime.context) await this.launch(id);
    }
  }

  async applyLiveAssignment(id: number): Promise<void> {
    const runtime = this.require(id);
    const next = this.proxies.getAssignedProxy(id);
    this.patch(id, { proxy: publicProxy(next), detectedIp: undefined, error: undefined });
    // A validated proxy should become usable immediately. If this workspace is
    // already running, recreate only this context and return to its saved target.
    if (runtime.context) await this.launch(id);
  }

  async assignOne(id: number, proxyId?: string): Promise<void> {
    this.proxies.setAssignment(id, proxyId);
    const proxy = this.proxies.getAssignedProxy(id);
    this.patch(id, { proxy: publicProxy(proxy), detectedIp: undefined });
    if (this.require(id).context) await this.launch(id);
  }

  async replaceProxy(id: number): Promise<boolean> { return this.rotateProxy(id); }

  async checkIp(id: number): Promise<string | undefined> {
    const runtime = this.require(id);
    if (!runtime.context) throw new Error('Launch the browser before checking its IP.');
    const response = await runtime.context.request.get(this.settings.get().ipCheckUrl, { timeout: this.settings.get().validation.timeoutSeconds * 1000 });
    if (!response.ok()) throw new Error(`IP check returned HTTP ${response.status()}`);
    const text = await response.text();
    let ip = text.trim();
    try {
      const parsed = JSON.parse(text) as { ip?: string };
      ip = parsed.ip ?? ip;
    } catch { /* plain text response */ }
    this.patch(id, { detectedIp: ip, lastIpCheckAt: new Date().toISOString() });
    return ip;
  }

  async checkAllIps(): Promise<Array<{ id: number; ip?: string; error?: string }>> {
    const ids = this.workspaceIds();
    const results = new Map<number, { id: number; ip?: string; error?: string }>();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(8, ids.length) }, async () => {
      while (true) {
        const id = ids[cursor++];
        if (id === undefined) return;
        try { results.set(id, { id, ip: await this.checkIp(id) }); }
        catch (error) { results.set(id, { id, error: error instanceof Error ? error.message : String(error) }); }
      }
    });
    await Promise.all(workers);
    return ids.map((id) => results.get(id) ?? { id, error: 'IP check did not return a result.' });
  }


  async runSeoTracking(request: SeoRunRequest): Promise<SeoRunSummary> {
    const keywords = parseSeoKeywords(request.keywords ?? request.keyword ?? '');
    if (!keywords.length) throw new Error('Enter at least one keyword to track.');
    const targetHost = normalizeTargetHost(request.target);
    const maxPages = Math.min(5, Math.max(1, Math.floor(request.maxPages ?? 3)));

    // Strict SEO action rule: a target match always opens immediately and Keep
    // Alive is always enabled. The legacy request flag is retained only for IPC
    // compatibility with older renderer builds.
    const autoOpenMatch = true;
    const workspaceIds = [...new Set((request.workspaceIds ?? this.workspaceIds())
      .filter((id) => Number.isInteger(id) && this.runtimes.has(id)))];
    if (!workspaceIds.length) throw new Error('Select at least one browser.');

    // Available engines get the first keyword slots so missing Edge/Opera
    // installations cannot leave a keyword with no runnable browser.
    const availableIds = workspaceIds.filter((id) => this.require(id).state.engineAvailable).sort((a, b) => a - b);
    const unavailableIds = workspaceIds.filter((id) => !this.require(id).state.engineAvailable).sort((a, b) => a - b);
    if (keywords.length > 1 && keywords.length > availableIds.length) {
      throw new Error(`Select at least ${keywords.length} available browsers to run all ${keywords.length} keywords simultaneously (${availableIds.length} available selected).`);
    }
    const assignments = allocateSeoKeywords(keywords, [...availableIds, ...unavailableIds]);
    if (this.activeSeoRun) throw new Error('An SEO run is already in progress.');
    const activeRun = { cancelled: new Set<number>() };
    this.activeSeoRun = activeRun;
    const limitLaunch = createLaunchLimiter(3);
    const cancelled = (id: number) => activeRun.cancelled.has(id) || !this.runtimes.has(id);
    const checkActive = (id: number) => {
      if (cancelled(id)) throw new Error('SEO check stopped.');
    };

    const runId = randomUUID();
    const startedAt = new Date().toISOString();

    // Privacy rule: clear every selected browser completely BEFORE the first
    // Google SEO navigation begins. This is a batch barrier: no selected
    // workspace starts searching until all selected browser profiles are gone.
    try {
      await this.clearBrowserData(workspaceIds);

      const results = await Promise.all(assignments.map(async ({ workspaceId: id, keyword }): Promise<SeoBrowserResult> => {
        const runtime = this.require(id);
        const pref = this.getPref(id);
        const queryUrl = buildGoogleSearchUrl(keyword, 0);
        const base = {
          id: `${runId}:${id}`,
          runId,
          workspaceId: id,
          keyword,
          targetHost,
          engine: pref.engine,
          engineLabel: runtime.state.engineLabel,
          proxyLabel: runtime.state.proxy ? `${runtime.state.proxy.host}:${runtime.state.proxy.port}` : undefined,
          searchedAt: new Date().toISOString(),
          queryUrl,
          openedMatch: false
        } satisfies Omit<SeoBrowserResult, 'status'>;

        let result: SeoBrowserResult;
        if (!runtime.state.engineAvailable) {
          result = { ...base, status: 'unavailable', error: runtime.state.error ?? 'Browser engine is unavailable.' };
          this.emit('seo-result', structuredClone(result));
          return result;
        }

        try {
          // The selected workspaces were already cleared as a batch before this
          // run started. Set Google as the first URL and launch without restoring
          // any prior browsing state.
          await limitLaunch(async () => {
            checkActive(id);
            await this.launchTargetAfterClear(id, queryUrl);
            checkActive(id);
          });
          const current = this.require(id);
          if (!current.page || current.page.isClosed()) throw new Error(current.state.error ?? 'Browser could not be launched.');

          // SEO measurement owns navigation while it is running. Pause normal
          // rotation and Keep Alive so neither can move the page mid-observation.
          if (current.rotationTimer) clearTimeout(current.rotationTimer);
          current.rotationTimer = undefined;
          this.patch(id, { nextRotationAt: undefined });
          this.keepAlive.disable(id);

          let final: SeoBrowserResult | undefined;
          let observedPosition = 0;

          for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
            checkActive(id);
            const pageUrl = buildGoogleSearchUrl(keyword, pageIndex);
            await current.page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

            // Google often renders result cards incrementally. Position extraction
            // remains conservative, but opening a match is now click-first: click
            // the actual visible result title, wait for the browser to land, and
            // record page.url() as the canonical matched URL. This avoids reducing
            // an article result to its breadcrumb/homepage URL.
            let latestOrganic: Awaited<ReturnType<typeof extractOrganicResults>> = [];
            for (let renderAttempt = 0; renderAttempt < 20 && !final; renderAttempt += 1) {
              checkActive(id);
              if (await detectGoogleChallenge(current.page)) {
                final = {
                  ...base,
                  status: 'challenge',
                  queryUrl: pageUrl,
                  resultPage: pageIndex + 1,
                  error: 'Google displayed an unusual-traffic/CAPTCHA challenge. No bypass was attempted.'
                };
                break;
              }

              const organic = await extractOrganicResults(current.page);
              latestOrganic = organic;
              let pagePosition: number | undefined;
              let absolutePosition: number | undefined;
              for (let resultIndex = 0; resultIndex < organic.length; resultIndex += 1) {
                const raw = organic[resultIndex];
                if (!raw) continue;
                const href = unwrapGoogleResultUrl(raw.href);
                if (!hostMatchesTarget(href, targetHost)) continue;
                pagePosition = resultIndex + 1;
                absolutePosition = observedPosition + resultIndex + 1;
                break;
              }

              const clicked = await clickVisibleTargetResult(current.page, targetHost);
              if (clicked) {
                const landedUrl = await waitForTargetLanding(current.page, targetHost, clicked.hrefHint);
                if (landedUrl) {
                  final = {
                    ...base,
                    status: 'found',
                    queryUrl: pageUrl,
                    resultPage: pageIndex + 1,
                    pagePosition,
                    position: absolutePosition,
                    matchedUrl: landedUrl,
                    matchedTitle: clicked.title,
                    openedMatch: true
                  };
                  break;
                }

                // The click did not resolve to the target. Restore this Google page
                // before retrying so a bad/intercepted click cannot strand the scan.
                if (!current.page.isClosed()) {
                  await current.page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
                }
              }

              if (!final) {
                // URL-only fallback for unusual layouts where the visible result
                // title cannot be clicked programmatically. Prefer a deep target URL
                // and navigate to it; never synthesize a homepage from the hostname.
                const fallback = await findAnyTargetLink(current.page, targetHost);
                if (fallback) {
                  const href = unwrapGoogleResultUrl(fallback.href);
                  try {
                    await current.page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
                    const landedUrl = unwrapGoogleResultUrl(current.page.url());
                    if (hostMatchesTarget(landedUrl, targetHost)) {
                      final = {
                        ...base,
                        status: 'found',
                        queryUrl: pageUrl,
                        resultPage: pageIndex + 1,
                        pagePosition,
                        position: absolutePosition,
                        matchedUrl: landedUrl,
                        matchedTitle: fallback.title,
                        openedMatch: true
                      };
                      break;
                    }
                  } catch {
                    // Restore Google below and continue polling/rendering.
                  }
                  if (!current.page.isClosed()) {
                    await current.page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
                  }
                }
              }

              if (!final && renderAttempt < 19) await new Promise((resolve) => setTimeout(resolve, 400));
            }

            if (final?.status === 'found' && final.matchedUrl) {
              checkActive(id);
              // The match is already open when possible. Persist the browser's real
              // landed article URL, then attach continuous Keep Alive to that page.
              pref.targetUrl = final.matchedUrl;
              pref.keepAlive = true;
              this.savePreferences();
              this.patch(id, {
                targetUrl: final.matchedUrl,
                keepAlive: true,
                status: 'loading',
                error: undefined
              });

              try {
                if (!final.openedMatch || !hostMatchesTarget(current.page.url(), targetHost)) {
                  await current.page.goto(final.matchedUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
                }
                await this.refreshMeta(id);
                checkActive(id);
                this.applyKeepAlive(id);
                final = { ...final, matchedUrl: current.page.url(), openedMatch: true };
              } catch (openError) {
                final = {
                  ...final,
                  openedMatch: false,
                  error: `Target detected, but opening the matched result failed: ${openError instanceof Error ? openError.message : String(openError)}`
                };
              }
            }

            if (final) break;

            // Only completed pages contribute to the cross-page observed rank.
            // Deduplicate by resolved URL so repeated sitelinks do not inflate the
            // count before the next Google page is inspected.
            observedPosition += new Set(latestOrganic.map((item) => unwrapGoogleResultUrl(item.href))).size;
            if (pageIndex + 1 < maxPages) await new Promise((resolve) => setTimeout(resolve, 600));
          }

          result = final ?? {
            ...base,
            status: 'not-found',
            queryUrl: buildGoogleSearchUrl(keyword, maxPages - 1),
            resultPage: maxPages
          };
          checkActive(id);
          this.patch(id, { status: 'ready', error: result.error });
        } catch (error) {
          result = {
            ...base,
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
          };
          if (!cancelled(id)) this.patch(id, { status: 'error', error: result.error });
        }

        this.emit('seo-result', structuredClone(result));

        // A found/opened result must always leave Keep Alive running continuously.
        if (!cancelled(id)) {
          if (result.status === 'found' && result.openedMatch) this.applyKeepAlive(id);
          if (result.status !== 'challenge') this.scheduleRotation(id);
        }
        return result;
      }));

      return {
        id: runId,
        keyword: keywords.join(' · '),
        keywords,
        target: request.target.trim(),
        targetHost,
        startedAt,
        completedAt: new Date().toISOString(),
        maxPages,
        autoOpenMatch,
        results: results.sort((a, b) => a.workspaceId - b.workspaceId)
      };
    } finally {
      if (this.activeSeoRun === activeRun) this.activeSeoRun = undefined;
    }
  }

  detectEngines() { return this.resolver.detect(); }

  async destroy(): Promise<void> {
    clearInterval(this.watchdogTimer);
    this.keepAlive.disableAll();
    await this.stopAll();
    // Best-effort shutdown cleanup. Startup cleanup runs again as a safety net
    // after crashes or forced termination.
    this.purgeAllBrowserProfiles();
  }
}
