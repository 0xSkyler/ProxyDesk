import { create } from 'zustand';
import type { EngineInfo } from '../../shared/types/browser';
import type { DiagnosticsInfo } from '../../shared/types/ipc';
import type { ProxyImportResult, ProxyRecord, ProxyValidationProgress } from '../../shared/types/proxy';
import type { AppSettings } from '../../shared/types/settings';
import type { WorkspaceState } from '../../shared/types/workspace';
import type { WorkspacePreviewFrame } from '../../shared/types/preview';

export type AppPage = 'workspaces' | 'seo' | 'proxies' | 'settings';

interface AppStore {
  ready: boolean;
  page: AppPage;
  settings?: AppSettings;
  workspaces: WorkspaceState[];
  previews: Record<number, WorkspacePreviewFrame>;
  proxies: ProxyRecord[];
  validationProgress: ProxyValidationProgress;
  engines: EngineInfo[];
  diagnostics?: DiagnosticsInfo;
  lastImport?: ProxyImportResult;
  error?: string;
  bootstrap(): Promise<void>;
  setPage(page: AppPage): void;
  importFile(): Promise<ProxyImportResult | undefined>;
  assign(): Promise<number>;
  refreshEngines(): Promise<void>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
}

let subscriptionsStarted = false;

export const useAppStore = create<AppStore>((set) => ({
  ready: false,
  page: 'workspaces',
  workspaces: [],
  previews: {},
  proxies: [],
  validationProgress: { runId: '', active: false, cancelled: false, total: 0, completed: 0, checking: 0, working: 0, dead: 0, assigned: 0 },
  engines: [],
  async bootstrap() {
    try {
      const data = await window.proxydesk.bootstrap();
      set({ ...data, ready: true });
      if (!subscriptionsStarted) {
        subscriptionsStarted = true;
        window.proxydesk.onWorkspaceState((state) => set((current) => ({
          workspaces: current.workspaces.map((item) => item.id === state.id ? state : item)
        })));
        window.proxydesk.onWorkspacePreview((frame) => set((current) => ({
          previews: { ...current.previews, [frame.workspaceId]: frame }
        })));
        window.proxydesk.onProxiesChanged((proxies) => set({ proxies }));
        window.proxydesk.onValidationProgress((validationProgress) => set({ validationProgress }));
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), ready: true });
    }
  },
  setPage(page) { set({ page }); },
  async importFile() {
    const result = await window.proxydesk.proxy.importFile();
    if (result) set({ lastImport: result, proxies: await window.proxydesk.proxy.list() });
    return result;
  },
  async assign() { return window.proxydesk.proxy.assign(); },
  async refreshEngines() { set({ engines: await window.proxydesk.engine.detect() }); },
  async updateSettings(patch) {
    const settings = await window.proxydesk.settings.set(patch);
    if (patch.browserCount !== undefined) {
      const data = await window.proxydesk.bootstrap();
      set({ ...data, settings, ready: true });
    } else {
      set({ settings });
    }
    const theme = settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : settings.theme;
    document.documentElement.dataset.theme = theme;
  }
}));
