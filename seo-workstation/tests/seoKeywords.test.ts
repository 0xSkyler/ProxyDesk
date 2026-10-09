import { describe, expect, it } from 'vitest';
import { allocateSeoKeywords, parseSeoKeywords } from '../src/shared/seoKeywords';
import { createLaunchLimiter } from '../src/main/seo/LaunchLimiter';
import { buildSeoHistoryCsv } from '../src/shared/seoCsv';
import type { SeoRunSummary } from '../src/shared/types/seo';

describe('parallel keyword allocation', () => {
  it('removes duplicate and blank lines while retaining complete phrases and literal commas', () => {
    expect(parseSeoKeywords(' cotton, linen prices \r\nFabric  quality\n\nCOTTON, LINEN PRICES\n'))
      .toEqual(['cotton, linen prices', 'Fabric quality']);
  });
  it('supports both legacy text and explicit keyword lists', () => {
    expect(parseSeoKeywords('one complete phrase')).toEqual(['one complete phrase']);
    expect(parseSeoKeywords([' a ', 'B', 'A', ''])).toEqual(['a', 'B']);
  });
  it('rejects non-text keyword entries', () => {
    expect(() => parseSeoKeywords([12] as unknown as string[])).toThrow('text');
  });
  it('shares ten workspaces across three keywords without multiplying the fleet', () => {
    const assigned = allocateSeoKeywords(['a', 'b', 'c'], Array.from({ length: 10 }, (_, i) => i + 1));
    expect(assigned).toHaveLength(10);
    expect(new Set(assigned.map((entry) => entry.workspaceId)).size).toBe(10);
    expect(['a', 'b', 'c'].map((keyword) => assigned.filter((entry) => entry.keyword === keyword).length)).toEqual([4, 3, 3]);
  });
  it('supports 100 independent keyword slots and sparse selections', () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(new Set(allocateSeoKeywords(ids.map(String), ids).map((entry) => entry.keyword)).size).toBe(100);
    expect(allocateSeoKeywords(['a', 'b'], [2, 7, 9]).map((entry) => entry.workspaceId)).toEqual([2, 7, 9]);
  });
  it('requires a browser for every keyword, rather than silently skipping keywords', () => {
    expect(() => allocateSeoKeywords(['a', 'b'], [1])).toThrow('at least 2');
    expect(() => allocateSeoKeywords([], [1])).toThrow('keyword');
    expect(() => allocateSeoKeywords(['a'], [])).toThrow('browser');
  });
});

describe('startup pressure', () => {
  it('limits simultaneous launches and releases a slot after a failed launch', async () => {
    const limited = createLaunchLimiter(3);
    let active = 0, peak = 0;
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => limited(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (index === 1) throw new Error('Fixture launch failed');
      return index;
    })));
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(11);
  });
});

describe('keyword-specific CSV', () => {
  it('exports each observation with its own keyword and retains old single-keyword history', () => {
    const run = {
      id: 'multi', keyword: 'a · b', keywords: ['a', 'b'], targetHost: 'example.com',
      results: [
        { keyword: 'a', workspaceId: 1, engineLabel: 'Chromium', status: 'found', matchedTitle: 'An "article"' },
        { keyword: 'b', workspaceId: 2, engineLabel: 'Firefox', status: 'challenge' }
      ]
    } as SeoRunSummary;
    const legacy = { ...run, id: 'legacy', keyword: 'old query', keywords: undefined, results: [{ ...run.results[0]!, keyword: 'old query' }] };
    const rows = buildSeoHistoryCsv([run, legacy]).trimEnd().split('\n');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toContain('"multi","a","example.com","1"');
    expect(rows[2]).toContain('"multi","b","example.com","2"');
    expect(rows[3]).toContain('"legacy","old query"');
    expect(rows[1]).toContain('"An ""article"""');
  });
});
