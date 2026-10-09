import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PwPage } from '../src/main/browser/PlaywrightRuntime';

const fixture = vi.hoisted(() => ({ directory: '', unavailable: new Set<string>() }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.directory } }));
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('../src/main/browser/EngineResolver', () => ({
  EngineResolver: class {
    detect() {
      return ['chromium', 'firefox', 'webkit', 'edge', 'opera'].map((engine) => ({
        engine, label: engine, available: !fixture.unavailable.has(engine), detail: 'Fixture engine unavailable'
      }));
    }
    get(engine: string) { return this.detect().find((entry) => entry.engine === engine); }
  }
}));
vi.mock('../src/main/seo/SeoTracker', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/main/seo/SeoTracker')>();
  return {
    ...original,
    detectGoogleChallenge: async (page: PwPage) => new URL(page.url()).searchParams.get('q') === 'challenge',
    extractOrganicResults: async () => [{ href: 'https://example.test/article', title: 'Article' }],
    clickVisibleTargetResult: async (page: PwPage) => {
      const keyword = new URL(page.url()).searchParams.get('q') ?? '';
      await page.goto(`https://example.test/article/${encodeURIComponent(keyword)}`);
      return { clicked: true, title: keyword };
    },
    waitForTargetLanding: async (page: PwPage) => page.url()
  };
});
import { SettingsManager } from '../src/main/SettingsManager';
import { ProxyManager } from '../src/main/ProxyManager';
import { WorkspaceManager } from '../src/main/WorkspaceManager';
import { SeoHistoryStore } from '../src/main/seo/SeoHistoryStore';
import type { SeoBrowserResult } from '../src/shared/types/seo';

let manager: WorkspaceManager | undefined;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fakePage(initial: string): PwPage {
  let url = initial;
  return {
    url: () => url,
    title: async () => 'Fixture article',
    goto: async (next: string) => { url = next; return null; },
    isClosed: () => false
  } as PwPage;
}
function setup(count = 3, launchGate?: Promise<void>) {
  const settings = new SettingsManager();
  settings.set({ browserCount: count, enginePlan: Array.from({ length: count }, () => 'chromium') });
  const proxies = new ProxyManager(settings);
  manager = new WorkspaceManager(settings, proxies);
  const launched: Array<{ id: number; keyword: string }> = [];
  vi.spyOn(manager as any, 'launchTargetAfterClear').mockImplementation(async (...args: unknown[]) => {
    const [id, url] = args as [number, string];
    launched.push({ id, keyword: new URL(url).searchParams.get('q')! });
    const runtime = (manager as any).require(id);
    const generation = runtime.generation;
    if (launchGate) await launchGate;
    if (runtime.generation !== generation) return;
    runtime.page = fakePage(url);
  });
  return { manager, launched, proxies };
}
beforeEach(() => {
  fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'proxydesk-seo-unit-'));
  fixture.unavailable.clear();
});
afterEach(async () => {
  await manager?.destroy(); manager = undefined;
  fs.rmSync(fixture.directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('workspace SEO runs', () => {
  it('starts different keywords before any earlier keyword completes and leaves matches in Keep Alive', async () => {
    const gate = deferred();
    const { manager, launched } = setup(3, gate.promise);
    const streamed: SeoBrowserResult[] = [];
    manager.on('seo-result', (result) => streamed.push(result));
    const work = manager.runSeoTracking({ keywords: ['alpha', 'beta', 'gamma'], target: 'example.test' });
    await vi.waitFor(() => expect(launched.map((entry) => entry.keyword)).toEqual(['alpha', 'beta', 'gamma']));
    expect(streamed).toHaveLength(0);
    gate.resolve();
    const run = await work;
    expect(run.results.map((result) => [result.workspaceId, result.keyword, result.status])).toEqual([
      [1, 'alpha', 'found'], [2, 'beta', 'found'], [3, 'gamma', 'found']
    ]);
    expect(manager.getStates().every((state) => state.keepAlive)).toBe(true);
    expect(run.results.map((result) => result.matchedUrl)).toEqual([
      'https://example.test/article/alpha', 'https://example.test/article/beta', 'https://example.test/article/gamma'
    ]);
  });
  it('clears all selected profiles before launching even the first search', async () => {
    const { manager, launched } = setup();
    const gate = deferred();
    const original = manager.clearBrowserData.bind(manager);
    vi.spyOn(manager, 'clearBrowserData').mockImplementation(async (ids) => { await original(ids); await gate.promise; return ids; });
    const work = manager.runSeoTracking({ keywords: ['a', 'b'], target: 'example.test' });
    await Promise.resolve(); await Promise.resolve();
    expect(launched).toHaveLength(0);
    gate.resolve(); await work;
    expect(launched).toHaveLength(3);
  });
  it('does not let a second SEO run clear or reuse occupied workspaces', async () => {
    const gate = deferred();
    const { manager, launched } = setup(3, gate.promise);
    const first = manager.runSeoTracking({ keywords: ['a', 'b'], target: 'example.test' });
    await vi.waitFor(() => expect(launched).toHaveLength(3));
    await expect(manager.runSeoTracking({ keyword: 'other', target: 'example.test' })).rejects.toThrow('already in progress');
    gate.resolve(); await first;
    expect(launched).toHaveLength(3);
  });
  it('keeps a failed or challenged keyword independent of successful keywords', async () => {
    const { manager } = setup();
    const run = await manager.runSeoTracking({ keywords: ['challenge', 'normal'], target: 'example.test' });
    expect(run.results.map((result) => result.status)).toEqual(['challenge', 'found', 'challenge']);
    expect(manager.getStates().map((state) => state.keepAlive)).toEqual([false, true, false]);
  });
  it('stops queued launches when Stop All is used and leaves workspaces stopped', async () => {
    const gate = deferred();
    const { manager, launched } = setup(9, gate.promise);
    const work = manager.runSeoTracking({ keywords: ['a', 'b', 'c'], target: 'example.test' });
    await vi.waitFor(() => expect(launched).toHaveLength(3));
    await manager.stopAll(); gate.resolve();
    const run = await work;
    expect(launched).toHaveLength(3);
    expect(run.results).toHaveLength(9);
    expect(run.results.every((result) => result.status === 'error')).toBe(true);
    expect(manager.getStates().every((state) => state.status === 'stopped' && !state.keepAlive)).toBe(true);
    const next = await manager.runSeoTracking({ keyword: 'again', target: 'example.test' });
    expect(next.results.every((result) => result.status === 'found')).toBe(true);
  });
  it('rejects insufficient available browsers before clearing any profile', async () => {
    const { manager, launched } = setup(2);
    (manager as any).require(1).state.engineAvailable = false;
    const clear = vi.spyOn(manager, 'clearBrowserData');
    await expect(manager.runSeoTracking({ keywords: ['a', 'b'], target: 'example.test' })).rejects.toThrow('available browsers');
    expect(clear).not.toHaveBeenCalled(); expect(launched).toHaveLength(0);
  });
  it('gives available engines priority so missing engines cannot steal a keyword', async () => {
    const { manager } = setup(3);
    (manager as any).require(1).state.engineAvailable = false;
    const run = await manager.runSeoTracking({ keywords: ['a', 'b'], target: 'example.test' });
    expect(run.results.filter((result) => result.status === 'found').map((result) => result.keyword)).toEqual(['a', 'b']);
    expect(run.results[0]?.status).toBe('unavailable');
  });
  it('preserves the legacy single-keyword request and does not expand the fleet', async () => {
    const { manager, launched } = setup(3);
    const run = await manager.runSeoTracking({ keyword: 'one phrase', target: 'example.test' });
    expect(run.keyword).toBe('one phrase');
    expect(run.results.every((result) => result.keyword === 'one phrase')).toBe(true);
    expect(launched).toHaveLength(3); expect(manager.getStates()).toHaveLength(3);
    await expect(manager.runSeoTracking({ keyword: 'one', target: 'example.test', workspaceIds: [] })).rejects.toThrow('Select');
  });
  it('retains both multi-keyword and old history across reopening the store', async () => {
    const { manager } = setup();
    const run = await manager.runSeoTracking({ keywords: ['alpha', 'beta'], target: 'example.test' });
    const history = new SeoHistoryStore(); history.add(run);
    history.add({ ...run, id: 'legacy', keyword: 'alpha', keywords: undefined, results: [run.results[0]!] });
    const restored = new SeoHistoryStore().list();
    expect(restored).toHaveLength(2);
    expect(restored[0]?.keyword).toBe('alpha');
    expect(restored[1]?.keywords).toEqual(['alpha', 'beta']);
    expect(restored[1]?.results).toHaveLength(3);
  });
});
