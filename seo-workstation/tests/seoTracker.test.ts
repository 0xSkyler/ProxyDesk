import { describe, expect, it } from 'vitest';
import {
  buildGoogleSearchUrl,
  hostMatchesTarget,
  isRootPage,
  normalizeTargetHost,
  unwrapGoogleResultUrl,
  waitForTargetLanding
} from '../src/main/seo/SeoTracker';
import type { PwPage } from '../src/main/browser/PlaywrightRuntime';

describe('SEO tracker target matching', () => {
  it('normalizes domains and full URLs', () => {
    expect(normalizeTargetHost('Example.com')).toBe('example.com');
    expect(normalizeTargetHost('https://www.example.com/articles/one')).toBe('example.com');
  });

  it('matches the target host and subdomains without matching lookalikes', () => {
    expect(hostMatchesTarget('https://example.com/article', 'example.com')).toBe(true);
    expect(hostMatchesTarget('https://blog.example.com/article', 'example.com')).toBe(true);
    expect(hostMatchesTarget('https://example.com.evil.test/article', 'example.com')).toBe(false);
    expect(hostMatchesTarget('https://notexample.com/article', 'example.com')).toBe(false);
  });

  it('unwraps Google redirect result URLs', () => {
    expect(unwrapGoogleResultUrl('https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Farticle&sa=U')).toBe('https://example.com/article');
    expect(unwrapGoogleResultUrl('https://www.google.com/url?url=https%3A%2F%2Fblog.example.com%2Fdeep-dive')).toBe('https://blog.example.com/deep-dive');
    expect(unwrapGoogleResultUrl('https://www.google.com/url?url=https%253A%252F%252Fexample.com%252Fdouble-encoded')).toBe('https://example.com/double-encoded');
  });

  it('distinguishes a site homepage from a deep article URL', () => {
    expect(isRootPage('https://appareldiary.com/')).toBe(true);
    expect(isRootPage('https://appareldiary.com')).toBe(true);
    expect(isRootPage('https://appareldiary.com/rmg-cutting-process')).toBe(false);
  });

  it('preserves deep target article URLs instead of collapsing them to the host', () => {
    expect(unwrapGoogleResultUrl('https://www.google.com/url?q=https%3A%2F%2Fappareldiary.com%2Frmg-cutting-process')).toBe('https://appareldiary.com/rmg-cutting-process');
    expect(hostMatchesTarget('https://appareldiary.com/rmg-cutting-process', 'appareldiary.com')).toBe(true);
  });

  it('waits through a temporary root landing and returns the final article URL', async () => {
    const urls = [
      'https://www.google.com/search?q=rmg+cutting',
      'https://appareldiary.com/',
      'https://appareldiary.com/rmg-cutting-process-a-stage-by-stage-control-guide'
    ];
    let index = 0;
    const page = {
      url: () => urls[Math.min(index++, urls.length - 1)] ?? urls[urls.length - 1]!,
      isClosed: () => false,
      goto: async () => undefined,
      evaluate: async () => undefined
    } as unknown as PwPage;

    const landed = await waitForTargetLanding(page, 'appareldiary.com', undefined, 1200);
    expect(landed).toBe('https://appareldiary.com/rmg-cutting-process-a-stage-by-stage-control-guide');
  });

  it('uses a deep title-link hint when a click cannot resolve on its own', async () => {
    let current = 'https://www.google.com/search?q=rmg+cutting';
    const page = {
      url: () => current,
      isClosed: () => false,
      goto: async (url: string) => { current = url; },
      evaluate: async () => undefined
    } as unknown as PwPage;

    const landed = await waitForTargetLanding(
      page,
      'appareldiary.com',
      'https://appareldiary.com/rmg-cutting-process-a-stage-by-stage-control-guide',
      50
    );
    expect(landed).toBe('https://appareldiary.com/rmg-cutting-process-a-stage-by-stage-control-guide');
  });

  it('builds paged Google queries', () => {
    expect(buildGoogleSearchUrl('garment sourcing Bangladesh', 0)).toContain('q=garment+sourcing+Bangladesh');
    expect(buildGoogleSearchUrl('garment sourcing Bangladesh', 1)).toContain('start=10');
    expect(buildGoogleSearchUrl('garment sourcing Bangladesh', 4)).toContain('start=40');
  });
});
