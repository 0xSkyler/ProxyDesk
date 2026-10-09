import type { BrowserEngine } from './browser';

export type SeoCheckStatus = 'found' | 'not-found' | 'challenge' | 'error' | 'unavailable';

export interface SeoRunRequest {
  /** Legacy single-keyword callers remain supported. */
  keyword?: string;
  keywords?: string[];
  target: string;
  workspaceIds?: number[];
  maxPages?: number;
  autoOpenMatch?: boolean;
}

export interface SeoBrowserResult {
  id: string;
  runId: string;
  workspaceId: number;
  keyword: string;
  targetHost: string;
  engine: BrowserEngine;
  engineLabel: string;
  proxyLabel?: string;
  searchedAt: string;
  status: SeoCheckStatus;
  queryUrl: string;
  resultPage?: number;
  position?: number;
  pagePosition?: number;
  matchedUrl?: string;
  matchedTitle?: string;
  openedMatch: boolean;
  error?: string;
}

export interface SeoRunSummary {
  id: string;
  keyword: string;
  /** Optional so existing saved history remains readable. */
  keywords?: string[];
  target: string;
  targetHost: string;
  startedAt: string;
  completedAt: string;
  maxPages: number;
  autoOpenMatch: boolean;
  results: SeoBrowserResult[];
}
