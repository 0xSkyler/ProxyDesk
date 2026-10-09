import type { SeoRunSummary } from './types/seo';

export function buildSeoHistoryCsv(runs: SeoRunSummary[]): string {
  const quote = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [[
    'run_id', 'keyword', 'target_host', 'workspace', 'engine', 'proxy', 'status',
    'position', 'google_page', 'page_position', 'matched_title', 'matched_url', 'searched_at'
  ].map(quote).join(',')];
  for (const run of runs) {
    for (const result of run.results) {
      rows.push([
        run.id, result.keyword, run.targetHost, result.workspaceId, result.engineLabel, result.proxyLabel ?? '', result.status,
        result.position ?? '', result.resultPage ?? '', result.pagePosition ?? '', result.matchedTitle ?? '', result.matchedUrl ?? '', result.searchedAt
      ].map(quote).join(','));
    }
  }
  return `${rows.join('\n')}\n`;
}
