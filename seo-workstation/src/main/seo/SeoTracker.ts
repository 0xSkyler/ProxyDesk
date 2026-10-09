import type { PwPage } from '../browser/PlaywrightRuntime';

export interface OrganicResult {
  href: string;
  title: string;
}

export interface GoogleTargetClick {
  clicked: boolean;
  title: string;
  hrefHint?: string;
}

export function normalizeTargetHost(input: string): string {
  const raw = input.trim().toLowerCase();
  if (!raw) throw new Error('Enter a target website or domain.');
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { throw new Error('Enter a valid target website, for example example.com.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Target website must use HTTP or HTTPS.');
  const hostname = parsed.hostname.replace(/^www\./i, '').replace(/\.$/, '');
  if (!hostname || !hostname.includes('.')) throw new Error('Enter a complete website domain, for example example.com.');
  return hostname;
}

function decodeRepeated(value: string): string {
  let current = value;
  for (let index = 0; index < 4; index += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current.replace(/&amp;/gi, '&');
}

export function unwrapGoogleResultUrl(input: string): string {
  try {
    const parsed = new URL(decodeRepeated(input));
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'google.com' || host.endsWith('.google.com')) {
      const keys = ['q', 'url', 'imgurl', 'target', 'dest', 'destination'];
      for (const key of keys) {
        const raw = parsed.searchParams.get(key);
        if (!raw) continue;
        const redirected = decodeRepeated(raw);
        if (/^https?:\/\//i.test(redirected)) {
          try {
            return new URL(redirected).toString();
          } catch {
            // Continue to the next redirect parameter.
          }
        }
      }
    }
    return parsed.toString();
  } catch {
    return input;
  }
}

export function hostMatchesTarget(candidateUrl: string, targetHost: string): boolean {
  try {
    const host = new URL(candidateUrl).hostname.toLowerCase().replace(/^www\./i, '').replace(/\.$/, '');
    return host === targetHost || host.endsWith(`.${targetHost}`);
  } catch {
    return false;
  }
}

export function isRootPage(candidateUrl: string): boolean {
  try {
    const url = new URL(candidateUrl);
    const path = url.pathname.replace(/\/+$/, '');
    return (path === '' || path === '/') && !url.search && !url.hash;
  } catch {
    return true;
  }
}

export function buildGoogleSearchUrl(keyword: string, pageIndex: number): string {
  const params = new URLSearchParams({ q: keyword });
  if (pageIndex > 0) params.set('start', String(pageIndex * 10));
  return `https://www.google.com/search?${params.toString()}`;
}

export async function detectGoogleChallenge(page: PwPage): Promise<boolean> {
  return page.evaluate(() => {
    const title = document.title.toLowerCase();
    const text = (document.body?.innerText ?? '').slice(0, 10000).toLowerCase();
    const hasCaptchaFrame = Boolean(document.querySelector('iframe[src*="recaptcha"], iframe[src*="captcha"]'));
    return hasCaptchaFrame
      || title.includes('unusual traffic')
      || text.includes('our systems have detected unusual traffic')
      || text.includes('unusual traffic from your computer network')
      || text.includes('to continue, please type the characters below')
      || text.includes('recaptcha');
  });
}

/**
 * Conservative organic parser used for observed position only. The navigation
 * decision no longer depends on this parser; Google markup changes must not stop
 * ProxyDesk from opening a visibly matched target result.
 */
export async function extractOrganicResults(page: PwPage): Promise<OrganicResult[]> {
  return page.evaluate(() => {
    const results: Array<{ href: string; title: string }> = [];
    const seen = new Set<string>();
    const root = document.querySelector('#search') ?? document.querySelector('main') ?? document.body;
    const anchors = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'));

    const normalizeHost = (value: string): string => value.toLowerCase().replace(/^www\./i, '').replace(/\.$/, '');
    const unwrap = (href: string): string => {
      try {
        const parsed = new URL(href, location.href);
        const host = normalizeHost(parsed.hostname);
        if (host === 'google.com' || host.endsWith('.google.com')) {
          for (const key of ['q', 'url', 'imgurl', 'target', 'dest', 'destination']) {
            const raw = parsed.searchParams.get(key);
            if (!raw) continue;
            let decoded = raw;
            for (let i = 0; i < 4; i += 1) {
              try {
                const next = decodeURIComponent(decoded);
                if (next === decoded) break;
                decoded = next;
              } catch { break; }
            }
            if (/^https?:\/\//i.test(decoded)) {
              try { return new URL(decoded).toString(); } catch { /* try next */ }
            }
          }
        }
        return parsed.toString();
      } catch {
        return href;
      }
    };

    const isGoogleNavigation = (href: string): boolean => {
      try {
        const url = new URL(href);
        const host = normalizeHost(url.hostname);
        if (!(host === 'google.com' || host.endsWith('.google.com'))) return false;
        return url.pathname === '/search'
          || url.pathname.startsWith('/preferences')
          || url.pathname.startsWith('/accounts')
          || url.pathname.startsWith('/setprefs')
          || url.pathname.startsWith('/advanced_search');
      } catch {
        return true;
      }
    };

    for (const anchor of anchors) {
      const rawHref = anchor.href;
      if (!rawHref || !/^https?:/i.test(rawHref)) continue;
      const href = unwrap(rawHref);
      if (!/^https?:\/\//i.test(href) || seen.has(href) || isGoogleNavigation(href)) continue;

      const block = anchor.closest('[data-text-ad], [data-ad], [aria-label*="Sponsored" i], [aria-label*="Ads" i]');
      const nearbyText = (anchor.parentElement?.parentElement?.textContent ?? anchor.parentElement?.textContent ?? '').trim().slice(0, 260);
      if (block || /(^|\s)(sponsored|advertisement|ad)(\s|·|:|$)/i.test(nearbyText)) continue;

      const heading = anchor.querySelector('h3, [role="heading"]')
        ?? anchor.closest('a')?.querySelector('h3, [role="heading"]');
      const title = (heading?.textContent ?? anchor.getAttribute('aria-label') ?? anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
      const looksLikeResult = Boolean(heading) || anchor.querySelector('cite') !== null || (anchor.hasAttribute('data-ved') && title.length >= 8);
      if (!looksLikeResult || !title) continue;

      seen.add(href);
      results.push({ href, title: title.slice(0, 300) });
    }
    return results;
  });
}

/**
 * Click the actual Google result-title element associated with a visible target
 * domain. This is intentionally click-first: the browser's eventual URL is the
 * source of truth, so ProxyDesk does not have to reverse-engineer every Google
 * redirect/data attribute variation.
 */
export async function clickVisibleTargetResult(page: PwPage, targetHost: string): Promise<GoogleTargetClick | undefined> {
  return page.evaluate((wantedHostRaw: string) => {
    const wantedHost = wantedHostRaw.toLowerCase().replace(/^www\./i, '').replace(/\.$/, '');
    const root = document.querySelector('#search') ?? document.querySelector('main') ?? document.body;
    const normalizeHost = (value: string): string => value.toLowerCase().replace(/^www\./i, '').replace(/\.$/, '');

    const decodeMany = (value: string): string => {
      let current = value;
      for (let index = 0; index < 4; index += 1) {
        try {
          const decoded = decodeURIComponent(current);
          if (decoded === current) break;
          current = decoded;
        } catch { break; }
      }
      return current.replace(/&amp;/gi, '&');
    };

    const resolveHref = (rawValue: string): string | undefined => {
      const raw = decodeMany(rawValue.trim());
      if (!raw) return undefined;
      try {
        const url = new URL(raw, location.href);
        const host = normalizeHost(url.hostname);
        if (host === 'google.com' || host.endsWith('.google.com')) {
          for (const key of ['q', 'url', 'imgurl', 'target', 'dest', 'destination']) {
            const value = url.searchParams.get(key);
            if (!value) continue;
            const decoded = decodeMany(value);
            if (!/^https?:\/\//i.test(decoded)) continue;
            try { return new URL(decoded).toString(); } catch { /* try next */ }
          }
        }
        return url.toString();
      } catch {
        return undefined;
      }
    };

    const matchesHref = (href: string | undefined): boolean => {
      if (!href) return false;
      try {
        const host = normalizeHost(new URL(href).hostname);
        return host === wantedHost || host.endsWith(`.${wantedHost}`);
      } catch { return false; }
    };

    const isSponsored = (element: Element): boolean => {
      if (element.closest('[data-text-ad], [data-ad], [aria-label*="Sponsored" i], [aria-label*="Ads" i], [data-snf*="ad" i]')) return true;
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
      return /(^|\s)(sponsored|advertisement|ad)(\s|·|:|$)/i.test(text);
    };

    const textOf = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();

    const findOwningAnchor = (heading: Element): HTMLAnchorElement | undefined => {
      const direct = heading.closest('a[href]');
      if (direct instanceof HTMLAnchorElement) return direct;
      let node: Element | null = heading.parentElement;
      for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
        if (node instanceof HTMLAnchorElement && node.hasAttribute('href')) return node;
        const nested = node.querySelector(':scope > a[href]');
        if (nested instanceof HTMLAnchorElement && nested.contains(heading)) return nested;
      }
      return undefined;
    };

    const cardFor = (element: Element): Element => {
      let node: Element | null = element;
      let best: Element = element;
      for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
        best = node;
        const text = textOf(node).toLowerCase();
        const hasHostLabel = text.includes(wantedHost);
        const hasHeading = Boolean(node.querySelector('h3, [role="heading"]'));
        if (hasHostLabel && hasHeading) return node;
        if (node === root) break;
      }
      return best;
    };

    type Candidate = {
      anchor: HTMLAnchorElement;
      heading: Element;
      title: string;
      hrefHint?: string;
      score: number;
    };

    const candidates: Candidate[] = [];
    const seen = new Set<HTMLAnchorElement>();
    const headings = Array.from(root.querySelectorAll<HTMLElement>('h3, [role="heading"]'));

    for (const heading of headings) {
      const title = textOf(heading);
      if (!title || title.length < 3) continue;
      const anchor = findOwningAnchor(heading);
      if (!anchor || seen.has(anchor) || isSponsored(anchor)) continue;
      const card = cardFor(heading);
      if (isSponsored(card)) continue;

      const cardText = textOf(card).toLowerCase();
      const hrefHint = resolveHref(anchor.getAttribute('href') ?? anchor.href ?? '');
      const hostVisible = cardText.includes(wantedHost);
      const targetHref = matchesHref(hrefHint);
      if (!hostVisible && !targetHref) continue;

      let score = 300; // heading link is the primary thing a person clicks.
      if (hostVisible) score += 220;
      if (targetHref) score += 160;
      if (hrefHint) {
        try {
          const url = new URL(hrefHint);
          if (url.pathname.replace(/\/+$/, '') !== '') score += 100;
        } catch { /* no-op */ }
      }
      if (title.toLowerCase() !== wantedHost) score += 40;

      seen.add(anchor);
      candidates.push({ anchor, heading, title: title.slice(0, 300), hrefHint, score });
    }

    // Fallback for mobile layouts where the hostname is rendered separately and
    // the title does not use an h3. Find the hostname marker, then pick the best
    // nearby anchor that has substantial, non-host text.
    if (!candidates.length) {
      const markers = Array.from(root.querySelectorAll<HTMLElement>('cite, span, div, p'))
        .filter((element) => textOf(element).toLowerCase().includes(wantedHost));

      for (const marker of markers) {
        if (isSponsored(marker)) continue;
        let node: Element | null = marker;
        for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
          if (isSponsored(node)) continue;
          const anchors = Array.from(node.querySelectorAll<HTMLAnchorElement>('a[href]'));
          for (const anchor of anchors) {
            if (seen.has(anchor) || isSponsored(anchor)) continue;
            const title = textOf(anchor);
            if (title.length < 8 || title.toLowerCase() === wantedHost) continue;
            const hrefHint = resolveHref(anchor.getAttribute('href') ?? anchor.href ?? '');
            let score = 100;
            if (matchesHref(hrefHint)) score += 150;
            if (anchor.querySelector('[role="heading"], h3')) score += 120;
            candidates.push({ anchor, heading: anchor, title: title.slice(0, 300), hrefHint, score });
            seen.add(anchor);
          }
          if (candidates.length) break;
          if (node === root) break;
        }
        if (candidates.length) break;
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) return undefined;

    // Force the normal result click into the same tab so WorkspaceManager can
    // observe the final URL and attach Keep Alive to the same Playwright page.
    best.anchor.removeAttribute('target');
    best.anchor.scrollIntoView({ block: 'center', behavior: 'auto' });
    best.anchor.click();

    return {
      clicked: true,
      title: best.title,
      hrefHint: best.hrefHint
    };
  }, targetHost);
}

/**
 * Wait for a clicked Google result to resolve to the requested target. The final
 * browser URL, not the pre-click Google href, is returned as the canonical match.
 */
export async function waitForTargetLanding(
  page: PwPage,
  targetHost: string,
  hrefHint?: string,
  timeoutMs = 12000
): Promise<string | undefined> {
  const started = Date.now();
  let rootLanding: string | undefined;

  while (Date.now() - started < timeoutMs) {
    if (page.isClosed()) return undefined;
    const current = unwrapGoogleResultUrl(page.url());
    if (hostMatchesTarget(current, targetHost)) {
      if (!isRootPage(current)) return current;
      rootLanding = current;
      // Do not immediately accept a homepage. Google can briefly expose a root
      // URL while a click/redirect chain is still settling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const resolvedHint = hrefHint ? unwrapGoogleResultUrl(hrefHint) : undefined;
  if (resolvedHint && hostMatchesTarget(resolvedHint, targetHost) && !isRootPage(resolvedHint)) {
    try {
      await page.goto(resolvedHint, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const finalUrl = unwrapGoogleResultUrl(page.url());
      if (hostMatchesTarget(finalUrl, targetHost)) return finalUrl;
    } catch {
      // Caller will treat the match as unresolved and continue searching.
    }
  }

  return rootLanding && resolvedHint && isRootPage(resolvedHint) ? rootLanding : undefined;
}

/**
 * URL-only fallback retained for unusual layouts where no clickable title can be
 * identified. Unlike the old implementation, a root-domain URL is not preferred
 * over a deeper target URL merely because it appears earlier in the DOM.
 */
export async function findAnyTargetLink(page: PwPage, targetHost: string): Promise<OrganicResult | undefined> {
  return page.evaluate((wantedHostRaw: string) => {
    const wantedHost = wantedHostRaw.toLowerCase().replace(/^www\./i, '').replace(/\.$/, '');
    const normalizeHost = (value: string): string => value.toLowerCase().replace(/^www\./i, '').replace(/\.$/, '');
    const root = document.querySelector('#search') ?? document.querySelector('main') ?? document.body;

    const decodeMany = (value: string): string => {
      let current = value;
      for (let index = 0; index < 4; index += 1) {
        try {
          const decoded = decodeURIComponent(current);
          if (decoded === current) break;
          current = decoded;
        } catch { break; }
      }
      return current.replace(/&amp;/gi, '&');
    };

    const resolve = (raw: string): string | undefined => {
      try {
        const url = new URL(decodeMany(raw), location.href);
        const host = normalizeHost(url.hostname);
        if (host === 'google.com' || host.endsWith('.google.com')) {
          for (const key of ['q', 'url', 'imgurl', 'target', 'dest', 'destination']) {
            const value = url.searchParams.get(key);
            if (!value) continue;
            const decoded = decodeMany(value);
            if (/^https?:\/\//i.test(decoded)) {
              try { return new URL(decoded).toString(); } catch { /* try next */ }
            }
          }
        }
        return url.toString();
      } catch { return undefined; }
    };

    const matches = (href: string): boolean => {
      try {
        const host = normalizeHost(new URL(href).hostname);
        return host === wantedHost || host.endsWith(`.${wantedHost}`);
      } catch { return false; }
    };

    const isRoot = (href: string): boolean => {
      try {
        const url = new URL(href);
        return url.pathname.replace(/\/+$/, '') === '' && !url.search && !url.hash;
      } catch { return true; }
    };

    const candidates: Array<{ href: string; title: string; score: number }> = [];
    const seen = new Set<string>();
    for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      if (anchor.closest('[data-text-ad], [data-ad], [aria-label*="Sponsored" i], [aria-label*="Ads" i]')) continue;
      const href = resolve(anchor.getAttribute('href') ?? anchor.href ?? '');
      if (!href || !matches(href) || seen.has(href)) continue;
      seen.add(href);
      const heading = anchor.querySelector('h3, [role="heading"]');
      const title = (heading?.textContent ?? anchor.textContent ?? wantedHost).replace(/\s+/g, ' ').trim().slice(0, 300);
      let score = isRoot(href) ? 0 : 200;
      if (heading) score += 100;
      if (title.toLowerCase() !== wantedHost) score += 20;
      candidates.push({ href, title, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    return best ? { href: best.href, title: best.title } : undefined;
  }, targetHost);
}

/** Backward-compatible alias retained for older imports/tests. */
export async function findTargetLinkFallback(page: PwPage, targetHost: string): Promise<OrganicResult | undefined> {
  return findAnyTargetLink(page, targetHost);
}
