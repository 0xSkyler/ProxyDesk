import type { ProxyRecord } from '../shared/types/proxy';
import { getPlaywright, type PwBrowser, type PwContext } from './browser/PlaywrightRuntime';

function proxyOptions(proxy: ProxyRecord): Record<string, unknown> {
  return {
    server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
    username: proxy.username,
    password: proxy.password
  };
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

async function closeQuietly(browser?: PwBrowser, context?: PwContext): Promise<void> {
  try { if (context) await bounded(context.close(), 3000, 'Proxy validation context close'); } catch { /* validation cleanup only */ }
  try { if (browser?.isConnected()) await bounded(browser.close(), 3000, 'Proxy validation browser close'); } catch { /* validation cleanup only */ }
}

/**
 * Browser-level proxy validation.
 *
 * Older builds used Electron's net module, which could mark a proxy working even
 * when Playwright browsers later failed TLS/authentication. This validator uses
 * the same Chromium/Playwright networking path that actual workspaces use, so a
 * proxy is only marked working after a real HTTPS page navigation succeeds.
 */
export class ProxyValidator {
  async validate(proxy: ProxyRecord, checkUrl: string, timeoutMs: number): Promise<ProxyRecord> {
    const started = Date.now();
    let browser: PwBrowser | undefined;
    let context: PwContext | undefined;

    try {
      browser = await bounded(
        getPlaywright().chromium.launch({ headless: true, timeout: Math.max(10_000, timeoutMs) }),
        Math.max(12_000, timeoutMs + 2_000),
        'Proxy validation browser launch'
      );
      context = await browser.newContext({
        proxy: proxyOptions(proxy),
        ignoreHTTPSErrors: false,
        serviceWorkers: 'block',
        viewport: { width: 900, height: 700 }
      });
      context.setDefaultTimeout(timeoutMs);
      context.setDefaultNavigationTimeout(timeoutMs);
      const page = await context.newPage();
      const response = await page.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      if (!response) throw new Error('No HTTP response received');
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);

      // A successful navigation with readable document content proves that the
      // browser can actually pass traffic through the endpoint rather than only
      // establishing a low-level socket.
      await page.evaluate(() => document.readyState);
      return {
        ...proxy,
        status: 'working',
        latencyMs: Date.now() - started,
        lastCheckedAt: new Date().toISOString(),
        lastError: undefined
      };
    } catch (error) {
      return {
        ...proxy,
        status: 'dead',
        latencyMs: undefined,
        lastCheckedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : 'Browser-level validation failed'
      };
    } finally {
      await closeQuietly(browser, context);
    }
  }
}
