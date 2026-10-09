import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppSettings } from '../shared/types/settings';

const ENGINE_CYCLE: AppSettings['enginePlan'] = ['chromium', 'firefox', 'webkit', 'edge', 'opera'];

function buildEnginePlan(count: number, existing: AppSettings['enginePlan'] = []): AppSettings['enginePlan'] {
  return Array.from({ length: count }, (_, index) => existing[index] ?? ENGINE_CYCLE[index % ENGINE_CYCLE.length] ?? 'chromium');
}

const DEFAULT_ENGINE_PLAN = buildEnginePlan(10);

const DEFAULT_SETTINGS: AppSettings = {
  browserCount: 10,
  theme: 'dark',
  defaultRotationSeconds: 0,
  autoAssignOnImport: true,
  allowProxyReuse: true,
  validation: {
    validateBeforeAssign: true,
    autoStartOnImport: true,
    assignWorkingImmediately: true,
    timeoutSeconds: 8,
    attempts: 1,
    concurrency: 8,
    testUrl: 'https://api.ipify.org?format=json',
    maxLatencyMs: 0
  },
  keepAlive: {
    minActionSeconds: 8,
    maxActionSeconds: 20,
    followLinkChancePercent: 20,
    maxArticleHops: 8,
    sameOriginOnly: true
  },
  savedUrlPool: [],
  ipCheckUrl: 'https://api.ipify.org?format=json',
  operaExecutablePath: '',
  enginePlan: DEFAULT_ENGINE_PLAN
};

function sanitizeSettings(input: Partial<AppSettings>): AppSettings {
  const validation = { ...DEFAULT_SETTINGS.validation, ...(input.validation ?? {}) };
  const keepAlive = { ...DEFAULT_SETTINGS.keepAlive, ...(input.keepAlive ?? {}) };
  const browserCount = Math.min(100, Math.max(1, Math.floor(Number(input.browserCount ?? DEFAULT_SETTINGS.browserCount) || DEFAULT_SETTINGS.browserCount)));
  const plan = buildEnginePlan(browserCount, Array.isArray(input.enginePlan) ? input.enginePlan : DEFAULT_ENGINE_PLAN);
  const savedUrlPool = Array.isArray(input.savedUrlPool)
    ? input.savedUrlPool.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean).slice(0, 5000)
    : [];
  return {
    ...DEFAULT_SETTINGS,
    ...input,
    browserCount,
    validation: {
      ...validation,
      timeoutSeconds: Math.min(120, Math.max(1, Number(validation.timeoutSeconds) || 8)),
      attempts: Math.min(5, Math.max(1, Number(validation.attempts) || 1)),
      concurrency: Math.min(16, Math.max(1, Number(validation.concurrency) || 8)),
      maxLatencyMs: Math.max(0, Number(validation.maxLatencyMs) || 0)
    },
    keepAlive: {
      ...keepAlive,
      minActionSeconds: Math.min(300, Math.max(3, Number(keepAlive.minActionSeconds) || 8)),
      maxActionSeconds: Math.min(600, Math.max(Number(keepAlive.minActionSeconds) || 8, Number(keepAlive.maxActionSeconds) || 20)),
      followLinkChancePercent: Math.min(100, Math.max(0, Number(keepAlive.followLinkChancePercent) || 0)),
      maxArticleHops: Math.min(1000, Math.max(0, Number(keepAlive.maxArticleHops) || 0))
    },
    savedUrlPool,
    defaultRotationSeconds: Math.max(0, Math.floor(Number(input.defaultRotationSeconds ?? DEFAULT_SETTINGS.defaultRotationSeconds))),
    enginePlan: [...plan]
  };
}

export class SettingsManager {
  private settings: AppSettings = DEFAULT_SETTINGS;
  private readonly filePath = path.join(app.getPath('userData'), 'settings.json');

  constructor() { this.load(); }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const stored = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<AppSettings>;
      this.settings = sanitizeSettings(stored);
    } catch {
      this.settings = DEFAULT_SETTINGS;
    }
  }

  get(): AppSettings { return structuredClone(this.settings); }

  set(patch: Partial<AppSettings>): AppSettings {
    this.settings = sanitizeSettings({ ...this.settings, ...patch });
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf8');
    return this.get();
  }
}
