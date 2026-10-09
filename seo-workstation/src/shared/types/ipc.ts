import type { AppSettings } from './settings';
import type { BrowserEngine, EngineInfo } from './browser';
import type { ProxyImportResult, ProxyRecord, ProxyValidationProgress } from './proxy';
import type { WorkspaceState } from './workspace';
import type { SeoBrowserResult, SeoRunRequest, SeoRunSummary } from './seo';
import type { WorkspaceInputEvent } from './interaction';
import type { WorkspacePreviewFrame, WorkspacePreviewMode } from './preview';

export interface DiagnosticsInfo {
  appVersion: string;
  electronVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  playwrightVersion?: string;
}

export interface ProxyDeskApi {
  bootstrap(): Promise<{ settings: AppSettings; workspaces: WorkspaceState[]; proxies: ProxyRecord[]; validationProgress: ProxyValidationProgress; engines: EngineInfo[]; diagnostics: DiagnosticsInfo }>;
  workspace: {
    launch(id: number): Promise<void>;
    launchAll(): Promise<void>;
    stop(id: number): Promise<void>;
    stopAll(): Promise<void>;
    focus(id: number): Promise<void>;
    navigate(id: number, url: string): Promise<void>;
    setTarget(id: number, url: string): Promise<void>;
    reload(id: number): Promise<void>;
    reloadAll(): Promise<void>;
    setRotationSeconds(id: number, seconds: number): Promise<void>;
    setKeepAlive(id: number, enabled: boolean): Promise<void>;
    setKeepAliveAll(enabled: boolean): Promise<void>;
    getPreview(id: number): Promise<string | undefined>;
    setPreviewMode(id: number, mode: WorkspacePreviewMode): Promise<void>;
    requestPreview(id: number): Promise<void>;
    input(id: number, event: WorkspaceInputEvent): Promise<void>;
    setEngine(id: number, engine: BrowserEngine): Promise<void>;
    rotateProxy(id: number): Promise<boolean>;
    checkIp(id: number): Promise<string | undefined>;
    checkAllIps(): Promise<Array<{ id: number; ip?: string; error?: string }>>;
    clearData(workspaceIds: number[]): Promise<number[]>;
  };
  central: {
    applyTargets(entries: Array<{ id: number; url: string }>): Promise<void>;
    googleSearch(query: string, workspaceIds?: number[]): Promise<void>;
  };
  proxy: {
    importFile(): Promise<ProxyImportResult | undefined>;
    list(): Promise<ProxyRecord[]>;
    assign(): Promise<number>;
    assignOne(workspaceId: number, proxyId?: string): Promise<void>;
    replace(workspaceId: number): Promise<boolean>;
    validate(proxyIds?: string[]): Promise<ProxyRecord[]>;
    validationStatus(): Promise<ProxyValidationProgress>;
    cancelValidation(): Promise<void>;
    clear(): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  engine: {
    detect(): Promise<EngineInfo[]>;
  };
  seo: {
    run(request: SeoRunRequest): Promise<SeoRunSummary>;
    history(): Promise<SeoRunSummary[]>;
    clearHistory(): Promise<void>;
    exportCsv(): Promise<string | undefined>;
  };
  onWorkspaceState(listener: (state: WorkspaceState) => void): () => void;
  onWorkspacePreview(listener: (frame: WorkspacePreviewFrame) => void): () => void;
  onProxiesChanged(listener: (proxies: ProxyRecord[]) => void): () => void;
  onValidationProgress(listener: (progress: ProxyValidationProgress) => void): () => void;
  onSeoResult(listener: (result: SeoBrowserResult) => void): () => void;
}
