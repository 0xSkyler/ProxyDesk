import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { SeoRunSummary } from '../../shared/types/seo';

const MAX_RUNS = 250;

export class SeoHistoryStore {
  private readonly filePath = path.join(app.getPath('userData'), 'seo-history.json');
  private runs: SeoRunSummary[] = [];

  constructor() { this.load(); }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
      if (Array.isArray(parsed)) this.runs = parsed.slice(0, MAX_RUNS) as SeoRunSummary[];
    } catch { this.runs = []; }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.runs, null, 2), 'utf8');
  }

  add(run: SeoRunSummary): void {
    this.runs = [structuredClone(run), ...this.runs.filter((item) => item.id !== run.id)].slice(0, MAX_RUNS);
    this.save();
  }

  list(): SeoRunSummary[] { return structuredClone(this.runs); }

  clear(): void {
    this.runs = [];
    try { if (fs.existsSync(this.filePath)) fs.rmSync(this.filePath, { force: true }); } catch { /* best effort */ }
  }
}
