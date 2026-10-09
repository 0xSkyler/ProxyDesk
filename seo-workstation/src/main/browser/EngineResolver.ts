import fs from 'node:fs';
import path from 'node:path';
import type { BrowserEngine, EngineInfo } from '../../shared/types/browser';
import { getPlaywright } from './PlaywrightRuntime';

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function edgePath(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const candidates = [
    path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  return firstExisting(candidates);
}

function operaPath(configured = ''): string | undefined {
  if (configured && fs.existsSync(configured)) return configured;
  if (process.platform !== 'win32') return undefined;
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Opera', 'opera.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Opera GX', 'opera.exe'),
    path.join(process.env.PROGRAMFILES ?? '', 'Opera', 'opera.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Opera', 'opera.exe'),
    path.join(process.env.PROGRAMFILES ?? '', 'Opera', 'launcher.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Opera', 'launcher.exe')
  ];
  return firstExisting(candidates);
}

export class EngineResolver {
  constructor(private readonly configuredOperaPath: () => string) {}

  detect(): EngineInfo[] {
    let pw: ReturnType<typeof getPlaywright> | undefined;
    try { pw = getPlaywright(); } catch { /* reported below */ }
    const bundled = (engine: 'chromium' | 'firefox' | 'webkit'): EngineInfo => {
      let executablePath: string | undefined;
      try { executablePath = pw?.[engine].executablePath(); } catch { /* ignore */ }
      const available = Boolean(executablePath && fs.existsSync(executablePath));
      const label = engine === 'webkit' ? 'WebKit (Safari-like)' : engine === 'firefox' ? 'Firefox' : 'Chromium';
      return {
        engine,
        label,
        available,
        executablePath,
        bundled: true,
        detail: available ? 'Bundled Playwright browser' : 'Browser binary is not installed. Run npm run browsers:install.'
      };
    };
    const edge = edgePath();
    const opera = operaPath(this.configuredOperaPath());
    return [
      bundled('chromium'),
      bundled('firefox'),
      bundled('webkit'),
      { engine: 'edge', label: 'Microsoft Edge', available: Boolean(edge), executablePath: edge, bundled: false, detail: edge ? 'Installed Microsoft Edge' : 'Microsoft Edge was not found.' },
      { engine: 'opera', label: 'Opera', available: Boolean(opera), executablePath: opera, bundled: false, detail: opera ? 'Installed Opera (Playwright compatibility is best-effort)' : 'Opera was not found. Install Opera or configure its executable path.' }
    ];
  }

  get(engine: BrowserEngine): EngineInfo {
    return this.detect().find((item) => item.engine === engine)!;
  }
}
