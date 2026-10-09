import type { KeepAliveRules } from '../../shared/types/settings';
import type { PwPage } from '../browser/PlaywrightRuntime';

interface KeepAliveRuntime {
  page: PwPage;
  rules: KeepAliveRules;
  timer?: NodeJS.Timeout;
  enabled: boolean;
  hops: number;
  visited: Set<string>;
  onHop(): void;
}

const BLOCKED_PATH_WORDS = ['login', 'signin', 'signup', 'register', 'account', 'checkout', 'cart', 'logout', 'download', 'subscribe', 'privacy', 'terms'];

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (Math.max(min, max) - min + 1));
}

export class KeepAliveController {
  private readonly runtimes = new Map<number, KeepAliveRuntime>();

  enable(id: number, page: PwPage, rules: KeepAliveRules, onHop: () => void): void {
    this.disable(id);
    const runtime: KeepAliveRuntime = { page, rules, enabled: true, hops: 0, visited: new Set([page.url()]), onHop };
    this.runtimes.set(id, runtime);
    this.schedule(id, runtime);
  }

  disable(id: number): void {
    const runtime = this.runtimes.get(id);
    if (runtime?.timer) clearTimeout(runtime.timer);
    this.runtimes.delete(id);
  }

  disableAll(): void {
    for (const id of this.runtimes.keys()) this.disable(id);
  }

  private schedule(id: number, runtime: KeepAliveRuntime): void {
    if (!runtime.enabled) return;
    const delaySeconds = randomInt(runtime.rules.minActionSeconds, runtime.rules.maxActionSeconds);
    runtime.timer = setTimeout(() => { void this.tick(id, runtime); }, delaySeconds * 1000);
  }

  private async tick(id: number, runtime: KeepAliveRuntime): Promise<void> {
    if (!runtime.enabled || runtime.page.isClosed()) { this.disable(id); return; }
    try {
      const direction = Math.random() < 0.82 ? 1 : -1;
      const distance = randomInt(180, 720) * direction;
      await runtime.page.evaluate((delta) => {
        window.scrollBy({ top: delta, behavior: 'smooth' });
      }, distance);

      const shouldFollow = runtime.hops < runtime.rules.maxArticleHops && Math.random() * 100 < runtime.rules.followLinkChancePercent;
      if (shouldFollow) {
        const candidates = await runtime.page.evaluate((sameOriginOnly) => {
          const origin = location.origin;
          const blocked = ['login', 'signin', 'signup', 'register', 'account', 'checkout', 'cart', 'logout', 'download', 'subscribe', 'privacy', 'terms'];
          const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('article a[href], main a[href], [role="main"] a[href]'));
          return anchors.map((anchor) => {
            try {
              const url = new URL(anchor.href, location.href);
              const rect = anchor.getBoundingClientRect();
              const text = (anchor.innerText || anchor.textContent || '').trim();
              const rel = (anchor.rel || '').toLowerCase();
              const path = `${url.pathname}${url.search}`.toLowerCase();
              if (!['http:', 'https:'].includes(url.protocol)) return undefined;
              if (sameOriginOnly && url.origin !== origin) return undefined;
              if (url.href === location.href) return undefined;
              if (rect.width < 4 || rect.height < 4 || text.length < 8) return undefined;
              if (rel.includes('sponsored') || rel.includes('nofollow') && text.length < 18) return undefined;
              if (blocked.some((word) => path.includes(word))) return undefined;
              return url.href;
            } catch { return undefined; }
          }).filter((value): value is string => Boolean(value));
        }, runtime.rules.sameOriginOnly);

        const unseen = candidates.filter((url) => !runtime.visited.has(url) && !BLOCKED_PATH_WORDS.some((word) => url.toLowerCase().includes(word)));
        if (unseen.length) {
          const next = unseen[randomInt(0, unseen.length - 1)];
          if (next) {
            runtime.visited.add(next);
            runtime.hops += 1;
            await runtime.page.goto(next, { waitUntil: 'domcontentloaded', timeout: 30000 });
            runtime.onHop();
          }
        }
      }
    } catch {
      // Keep-alive is intentionally non-fatal. Navigation failures simply defer to the next cycle.
    } finally {
      if (runtime.enabled) this.schedule(id, runtime);
    }
  }
}
