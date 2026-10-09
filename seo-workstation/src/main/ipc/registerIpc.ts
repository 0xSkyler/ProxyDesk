import fs from 'node:fs';
import { buildSeoHistoryCsv } from '../../shared/seoCsv';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { BrowserEngine } from '../../shared/types/browser';
import type { AppSettings } from '../../shared/types/settings';
import type { WorkspaceState } from '../../shared/types/workspace';
import type { ProxyValidationProgress } from '../../shared/types/proxy';
import type { SeoBrowserResult, SeoRunRequest } from '../../shared/types/seo';
import type { WorkspaceInputEvent } from '../../shared/types/interaction';
import type { WorkspacePreviewFrame, WorkspacePreviewMode } from '../../shared/types/preview';
import { getPlaywrightVersion } from '../browser/PlaywrightRuntime';
import { ProxyManager } from '../ProxyManager';
import { SettingsManager } from '../SettingsManager';
import { WorkspaceManager } from '../WorkspaceManager';
import { SeoHistoryStore } from '../seo/SeoHistoryStore';

const CHANNELS = [
  'app:bootstrap',
  'workspace:launch', 'workspace:launch-all', 'workspace:stop', 'workspace:stop-all', 'workspace:focus',
  'workspace:navigate', 'workspace:set-target', 'workspace:reload', 'workspace:reload-all',
  'workspace:rotation', 'workspace:keep-alive', 'workspace:keep-alive-all', 'workspace:preview', 'workspace:preview-mode', 'workspace:preview-now', 'workspace:input', 'workspace:engine', 'workspace:rotate-proxy',
  'workspace:check-ip', 'workspace:check-all-ips', 'workspace:clear-data',
  'central:apply-targets', 'central:google-search',
  'proxy:import-file', 'proxy:list', 'proxy:assign', 'proxy:assign-one', 'proxy:replace', 'proxy:validate', 'proxy:validation-cancel', 'proxy:validation-status', 'proxy:clear',
  'settings:get', 'settings:set', 'engine:detect',
  'seo:run', 'seo:history', 'seo:clear-history', 'seo:export-csv'
] as const;

export function registerIpc(window: BrowserWindow, settings: SettingsManager, proxies: ProxyManager, workspaces: WorkspaceManager, seoHistory: SeoHistoryStore): void {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);

  ipcMain.handle('app:bootstrap', () => ({
    settings: settings.get(),
    workspaces: workspaces.getStates(),
    proxies: proxies.getPublicList(),
    validationProgress: proxies.getValidationProgress(),
    engines: workspaces.detectEngines(),
    diagnostics: {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      playwrightVersion: getPlaywrightVersion()
    }
  }));

  ipcMain.handle('workspace:launch', (_event, id: number) => workspaces.launch(id));
  ipcMain.handle('workspace:launch-all', () => workspaces.launchAll());
  ipcMain.handle('workspace:stop', (_event, id: number) => workspaces.stop(id));
  ipcMain.handle('workspace:stop-all', () => workspaces.stopAll());
  ipcMain.handle('workspace:focus', (_event, id: number) => workspaces.focus(id));
  ipcMain.handle('workspace:navigate', (_event, id: number, url: string) => workspaces.navigate(id, url));
  ipcMain.handle('workspace:set-target', (_event, id: number, url: string) => workspaces.setTarget(id, url));
  ipcMain.handle('workspace:reload', (_event, id: number) => workspaces.reload(id));
  ipcMain.handle('workspace:reload-all', () => workspaces.reloadAll());
  ipcMain.handle('workspace:rotation', (_event, id: number, seconds: number) => workspaces.setRotationSeconds(id, seconds));
  ipcMain.handle('workspace:keep-alive', (_event, id: number, enabled: boolean) => workspaces.setKeepAlive(id, enabled));
  ipcMain.handle('workspace:keep-alive-all', (_event, enabled: boolean) => workspaces.setKeepAliveAll(enabled));
  ipcMain.handle('workspace:preview', (_event, id: number) => workspaces.getPreview(id));
  ipcMain.handle('workspace:preview-mode', (_event, id: number, mode: WorkspacePreviewMode) => workspaces.setPreviewMode(id, mode));
  ipcMain.handle('workspace:preview-now', (_event, id: number) => workspaces.requestPreview(id));
  ipcMain.handle('workspace:input', (_event, id: number, input: WorkspaceInputEvent) => workspaces.sendInput(id, input));
  ipcMain.handle('workspace:engine', (_event, id: number, engine: BrowserEngine) => workspaces.setEngine(id, engine));
  ipcMain.handle('workspace:rotate-proxy', (_event, id: number) => workspaces.rotateProxy(id));
  ipcMain.handle('workspace:check-ip', (_event, id: number) => workspaces.checkIp(id));
  ipcMain.handle('workspace:check-all-ips', () => workspaces.checkAllIps());
  ipcMain.handle('workspace:clear-data', (_event, workspaceIds: number[]) => workspaces.clearBrowserData(workspaceIds));

  ipcMain.handle('central:apply-targets', (_event, entries: Array<{ id: number; url: string }>) => workspaces.applyTargets(entries));
  ipcMain.handle('central:google-search', (_event, query: string, workspaceIds?: number[]) => workspaces.googleSearch(query, workspaceIds));

  ipcMain.handle('proxy:import-file', async () => {
    const picked = await dialog.showOpenDialog(window, {
      title: 'Select proxy.txt',
      properties: ['openFile'],
      filters: [{ name: 'Proxy text file', extensions: ['txt'] }]
    });
    if (picked.canceled || !picked.filePaths[0]) return undefined;
    const text = fs.readFileSync(picked.filePaths[0], 'utf8');
    // A new manual upload replaces the in-memory pool for this app run.
    proxies.clear();
    const result = await proxies.importText(text);
    // The previous pool was cleared above. Running workspaces must not keep
    // using an endpoint that is no longer present in this app session.
    await workspaces.applyAssignments();

    const currentSettings = settings.get();
    if (result.valid > 0 && currentSettings.validation.autoStartOnImport) {
      // Streaming validation is intentionally backgrounded. The import dialog
      // returns immediately while each successful endpoint can be assigned as
      // soon as its individual check completes.
      void proxies.validateStreaming(proxies.getLastImportedIds(), async (proxy) => {
        if (!currentSettings.autoAssignOnImport || !currentSettings.validation.assignWorkingImmediately) return;
        const assignment = proxies.assignWorkingProxyImmediately(proxy.id);
        if (assignment) void workspaces.applyLiveAssignment(assignment.workspaceId).catch(() => undefined);
      });
    } else if (currentSettings.autoAssignOnImport && result.valid > 0) {
      const assignments = await proxies.buildAssignments(proxies.getLastImportedIds());
      await workspaces.applyAssignments();
      result.assigned = assignments.filter((item) => item.proxyId).length;
    }
    return result;
  });
  ipcMain.handle('proxy:list', () => proxies.getPublicList());
  ipcMain.handle('proxy:assign', async () => {
    const assignments = await proxies.buildAssignments();
    await workspaces.applyAssignments();
    return assignments.filter((item) => item.proxyId).length;
  });
  ipcMain.handle('proxy:assign-one', async (_event, workspaceId: number, proxyId?: string) => workspaces.assignOne(workspaceId, proxyId));
  ipcMain.handle('proxy:replace', async (_event, workspaceId: number) => workspaces.replaceProxy(workspaceId));
  ipcMain.handle('proxy:validate', async (_event, proxyIds?: string[]) => {
    const currentSettings = settings.get();
    return proxies.validateStreaming(proxyIds, async (proxy) => {
      if (!currentSettings.validation.assignWorkingImmediately) return;
      const assignment = proxies.assignWorkingProxyImmediately(proxy.id);
      if (assignment) void workspaces.applyLiveAssignment(assignment.workspaceId).catch(() => undefined);
    });
  });
  ipcMain.handle('proxy:validation-cancel', () => proxies.cancelValidation());
  ipcMain.handle('proxy:validation-status', () => proxies.getValidationProgress());
  ipcMain.handle('proxy:clear', async () => {
    proxies.clear();
    await workspaces.applyAssignments();
  });

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', async (_event, patch: Partial<AppSettings>) => {
    const next = settings.set(patch);
    if (patch.browserCount !== undefined) await workspaces.reconcileBrowserCount(next.browserCount);
    return next;
  });
  ipcMain.handle('engine:detect', () => workspaces.detectEngines());

  ipcMain.handle('seo:run', async (_event, request: SeoRunRequest) => {
    const run = await workspaces.runSeoTracking(request);
    seoHistory.add(run);
    return run;
  });
  ipcMain.handle('seo:history', () => seoHistory.list());
  ipcMain.handle('seo:clear-history', () => seoHistory.clear());
  ipcMain.handle('seo:export-csv', async () => {
    const runs = seoHistory.list();
    if (!runs.length) return undefined;
    const picked = await dialog.showSaveDialog(window, {
      title: 'Export SEO tracking history',
      defaultPath: `proxydesk-seo-history-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV file', extensions: ['csv'] }]
    });
    if (picked.canceled || !picked.filePath) return undefined;
    fs.writeFileSync(picked.filePath, buildSeoHistoryCsv(runs), 'utf8');
    return picked.filePath;
  });

  workspaces.on('preview-frame', (frame: WorkspacePreviewFrame) => {
    if (!window.isDestroyed()) window.webContents.send('workspace:preview-frame', frame);
  });
  workspaces.on('state', (state: WorkspaceState) => {
    if (!window.isDestroyed()) window.webContents.send('workspace:state', state);
  });
  proxies.on('changed', () => {
    if (!window.isDestroyed()) window.webContents.send('proxy:changed', proxies.getPublicList());
  });
  proxies.on('validation-progress', (progress: ProxyValidationProgress) => {
    if (!window.isDestroyed()) window.webContents.send('proxy:validation-progress', progress);
  });
  workspaces.on('seo-result', (result: SeoBrowserResult) => {
    if (!window.isDestroyed()) window.webContents.send('seo:result', result);
  });
}
