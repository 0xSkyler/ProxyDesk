import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { ProxyAssignment, ProxyImportResult, ProxyRecord, ProxyValidationProgress } from '../shared/types/proxy';
import { parseProxyText } from '../proxy/ProxyParser';
import { ProxyValidator } from './ProxyValidator';
import { SettingsManager } from './SettingsManager';

export class ProxyManager extends EventEmitter {
  private readonly validator = new ProxyValidator();
  private proxies: ProxyRecord[] = [];
  private assignments: ProxyAssignment[] = [];
  private usedThisCycle = new Set<string>();
  private lastImportedIds: string[] = [];
  private validationGeneration = 0;
  private validationProgress: ProxyValidationProgress = this.emptyProgress();

  constructor(private readonly settings: SettingsManager) {
    super();
    this.removeLegacyProxyCache();
  }

  private emptyProgress(): ProxyValidationProgress {
    return {
      runId: '',
      active: false,
      cancelled: false,
      total: 0,
      completed: 0,
      checking: 0,
      working: 0,
      dead: 0,
      assigned: 0
    };
  }

  private removeLegacyProxyCache(): void {
    const userData = app.getPath('userData');
    for (const file of ['proxies.json', 'assignments.json', 'proxy-credentials.json']) {
      try { fs.rmSync(path.join(userData, file), { force: true }); } catch { /* best effort migration cleanup */ }
    }
  }

  private emitChanged(): void { this.emit('changed', this.getPublicList()); }
  private emitValidationProgress(): void { this.emit('validation-progress', this.getValidationProgress()); }

  getAll(): ProxyRecord[] { return this.proxies.map((proxy) => ({ ...proxy })); }
  getPublicList(): ProxyRecord[] {
    return this.proxies.map((proxy) => {
      const safe = { ...proxy };
      delete safe.password;
      return safe;
    });
  }
  getAssignments(): ProxyAssignment[] { return this.assignments.map((assignment) => ({ ...assignment })); }
  getLastImportedIds(): string[] { return [...this.lastImportedIds]; }
  getValidationProgress(): ProxyValidationProgress { return structuredClone(this.validationProgress); }

  private assignedProxyIds(excludeWorkspaceId?: number): Set<string> {
    return new Set(this.assignments
      .filter((assignment) => assignment.workspaceId !== excludeWorkspaceId && assignment.proxyId)
      .map((assignment) => assignment.proxyId as string));
  }

  private eligiblePool(): ProxyRecord[] {
    const settings = this.settings.get();
    return settings.validation.validateBeforeAssign
      ? this.proxies.filter((proxy) => proxy.status === 'working')
      : this.proxies.filter((proxy) => proxy.status !== 'checking');
  }

  private markUsed(proxyId?: string): void {
    if (proxyId) this.usedThisCycle.add(proxyId);
  }

  private beginNextProxyCycle(): void {
    // Proxies that are still actively leased count as already used in the new
    // cycle. This prevents a just-released endpoint from jumping ahead of all
    // other endpoints that have not yet been used in this cycle.
    this.usedThisCycle = this.assignedProxyIds();
  }

  private resetProxyCycle(): void {
    this.usedThisCycle.clear();
  }

  getAssignedProxy(workspaceId: number): ProxyRecord | undefined {
    const proxyId = this.assignments.find((item) => item.workspaceId === workspaceId)?.proxyId;
    const proxy = proxyId ? this.proxies.find((item) => item.id === proxyId) : undefined;
    return proxy ? { ...proxy } : undefined;
  }

  async importText(text: string): Promise<ProxyImportResult> {
    this.cancelValidation();
    this.resetProxyCycle();
    const parsed = parseProxyText(text, 'proxy.txt');
    const existing = new Map(this.proxies.map((proxy) => [`${proxy.protocol}|${proxy.host.toLowerCase()}|${proxy.port}`, proxy]));
    let existingDuplicates = 0;
    const touchedIds: string[] = [];
    for (const proxy of parsed.proxies) {
      const key = `${proxy.protocol}|${proxy.host.toLowerCase()}|${proxy.port}`;
      const previous = existing.get(key);
      if (previous) {
        existingDuplicates += 1;
        previous.username = proxy.username ?? previous.username;
        previous.password = proxy.password ?? previous.password;
        previous.status = 'unverified';
        previous.latencyMs = undefined;
        previous.lastCheckedAt = undefined;
        previous.lastError = undefined;
        touchedIds.push(previous.id);
        continue;
      }
      this.proxies.push(proxy);
      existing.set(key, proxy);
      touchedIds.push(proxy.id);
    }
    this.lastImportedIds = [...new Set(touchedIds)];
    this.validationProgress = this.emptyProgress();
    this.emitValidationProgress();
    this.emitChanged();
    return {
      imported: parsed.proxies.length + parsed.errors.length + parsed.duplicates,
      valid: parsed.proxies.length - existingDuplicates,
      invalid: parsed.errors.length,
      duplicates: parsed.duplicates + existingDuplicates,
      assigned: 0,
      errors: parsed.errors
    };
  }

  /**
   * Validate proxies concurrently and publish every state transition to the UI.
   * A working endpoint can be handed to onWorking immediately; callers do not
   * need to wait for the rest of the pool to finish.
   */
  async validateStreaming(
    proxyIds?: string[],
    onWorking?: (proxy: ProxyRecord) => void | Promise<void>
  ): Promise<ProxyRecord[]> {
    const generation = ++this.validationGeneration;
    const rules = this.settings.get().validation;
    const ids = proxyIds?.length ? new Set(proxyIds) : undefined;
    const targets = this.proxies.filter((proxy) => !ids || ids.has(proxy.id));
    const runId = randomUUID();
    this.validationProgress = {
      runId,
      active: true,
      cancelled: false,
      total: targets.length,
      completed: 0,
      checking: 0,
      working: 0,
      dead: 0,
      assigned: 0,
      startedAt: new Date().toISOString()
    };
    this.emitValidationProgress();

    let index = 0;
    const workerCount = Math.min(rules.concurrency, Math.max(1, targets.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (generation === this.validationGeneration) {
        const current = targets[index++];
        if (!current) break;
        const atStart = this.proxies.findIndex((proxy) => proxy.id === current.id);
        if (atStart < 0) continue;

        this.proxies[atStart] = {
          ...this.proxies[atStart]!,
          status: 'checking',
          latencyMs: undefined,
          lastError: undefined
        };
        this.validationProgress.checking += 1;
        this.validationProgress.latestProxyId = current.id;
        this.validationProgress.latestEndpoint = `${current.host}:${current.port}`;
        this.validationProgress.latestStatus = 'checking';
        this.validationProgress.latestLatencyMs = undefined;
        this.validationProgress.latestError = undefined;
        this.emitChanged();
        this.emitValidationProgress();

        let result: ProxyRecord = current;
        for (let attempt = 0; attempt < rules.attempts && generation === this.validationGeneration; attempt += 1) {
          result = await this.validator.validate(current, rules.testUrl, rules.timeoutSeconds * 1000);
          if (result.status === 'working') break;
        }
        if (generation !== this.validationGeneration) break;

        if (result.status === 'working' && rules.maxLatencyMs > 0 && (result.latencyMs ?? 0) > rules.maxLatencyMs) {
          result = { ...result, status: 'dead', lastError: `Latency ${result.latencyMs}ms exceeds ${rules.maxLatencyMs}ms limit` };
        }
        const at = this.proxies.findIndex((proxy) => proxy.id === current.id);
        if (at >= 0) this.proxies[at] = result;

        this.validationProgress.checking = Math.max(0, this.validationProgress.checking - 1);
        this.validationProgress.completed += 1;
        if (result.status === 'working') this.validationProgress.working += 1;
        else this.validationProgress.dead += 1;
        this.validationProgress.latestProxyId = result.id;
        this.validationProgress.latestEndpoint = `${result.host}:${result.port}`;
        this.validationProgress.latestStatus = result.status;
        this.validationProgress.latestLatencyMs = result.latencyMs;
        this.validationProgress.latestError = result.lastError;
        this.emitChanged();
        this.emitValidationProgress();

        if (result.status === 'working' && onWorking) {
          try { await onWorking({ ...result }); } catch { /* a browser relaunch failure must not stop validation */ }
        }
      }
    });

    await Promise.all(workers);
    if (generation === this.validationGeneration) {
      this.validationProgress.active = false;
      this.validationProgress.checking = 0;
      this.validationProgress.finishedAt = new Date().toISOString();
      this.emitValidationProgress();
    }
    return this.getPublicList();
  }

  async validate(proxyIds?: string[]): Promise<ProxyRecord[]> {
    return this.validateStreaming(proxyIds);
  }

  cancelValidation(): void {
    if (!this.validationProgress.active) return;
    this.validationGeneration += 1;
    this.validationProgress = {
      ...this.validationProgress,
      active: false,
      cancelled: true,
      checking: 0,
      finishedAt: new Date().toISOString()
    };
    for (const proxy of this.proxies) {
      if (proxy.status === 'checking') proxy.status = 'unverified';
    }
    this.emitChanged();
    this.emitValidationProgress();
  }

  /** Assign a newly validated endpoint to the next workspace that does not yet
   * have a working proxy. Leases are always exclusive: one endpoint can never
   * belong to two browsers at the same time. */
  assignWorkingProxyImmediately(proxyId: string): ProxyAssignment | undefined {
    const proxy = this.proxies.find((item) => item.id === proxyId);
    if (!proxy || proxy.status !== 'working') return undefined;
    const settings = this.settings.get();
    const usedBy = this.assignments.find((item) => item.proxyId === proxyId)?.workspaceId;
    if (usedBy) return { workspaceId: usedBy, proxyId };

    for (let workspaceId = 1; workspaceId <= settings.browserCount; workspaceId += 1) {
      const current = this.getAssignedProxy(workspaceId);
      if (current?.status === 'working') continue;
      if (this.assignedProxyIds(workspaceId).has(proxyId)) continue;
      this.setAssignment(workspaceId, proxyId);
      this.markUsed(proxyId);
      this.validationProgress.assigned = this.assignments.filter((assignment) => {
        const assignedProxy = assignment.proxyId ? this.proxies.find((item) => item.id === assignment.proxyId) : undefined;
        return assignedProxy?.status === 'working';
      }).length;
      this.emitValidationProgress();
      this.emit('assignment-live', { workspaceId, proxyId } satisfies ProxyAssignment);
      return { workspaceId, proxyId };
    }
    return undefined;
  }

  async buildAssignments(preferredIds: string[] = []): Promise<ProxyAssignment[]> {
    const settings = this.settings.get();
    if (settings.validation.validateBeforeAssign) {
      const hasWorking = this.proxies.some((proxy) => proxy.status === 'working');
      if (!hasWorking) await this.validateStreaming(preferredIds.length ? preferredIds : undefined);
    }

    const preferred = new Set(preferredIds);
    const basePool = this.eligiblePool();
    const ordered = preferred.size
      ? [...basePool.filter((proxy) => preferred.has(proxy.id)), ...basePool.filter((proxy) => !preferred.has(proxy.id))]
      : basePool;

    // Initial/bulk assignment is always exclusive. Reuse means an endpoint may
    // return in a later pool cycle, never that two browsers share it at once.
    this.assignments = Array.from({ length: settings.browserCount }, (_, index) => ({
      workspaceId: index + 1,
      proxyId: ordered[index]?.id
    }));
    this.resetProxyCycle();
    for (const assignment of this.assignments) this.markUsed(assignment.proxyId);
    return this.getAssignments();
  }

  setAssignment(workspaceId: number, proxyId?: string): void {
    if (proxyId) {
      const owner = this.assignments.find((item) => item.workspaceId !== workspaceId && item.proxyId === proxyId);
      if (owner) throw new Error(`Proxy is already leased to Browser ${owner.workspaceId}.`);
    }
    const existing = this.assignments.find((item) => item.workspaceId === workspaceId);
    if (existing) existing.proxyId = proxyId;
    else this.assignments.push({ workspaceId, proxyId });
    this.markUsed(proxyId);
  }

  chooseReplacement(workspaceId: number): ProxyRecord | undefined {
    const settings = this.settings.get();
    const currentId = this.assignments.find((item) => item.workspaceId === workspaceId)?.proxyId;
    const leasedElsewhere = this.assignedProxyIds(workspaceId);
    const eligible = this.eligiblePool().filter((proxy) => proxy.id !== currentId && !leasedElsewhere.has(proxy.id));

    // First preference: a live endpoint that has not yet been used during this
    // cycle. This enforces "use every live proxy before reusing one".
    let candidate = eligible.find((proxy) => !this.usedThisCycle.has(proxy.id));

    if (!candidate && settings.allowProxyReuse) {
      const fullPool = this.eligiblePool();
      const everyLiveProxyUsed = fullPool.length > 0 && fullPool.every((proxy) => this.usedThisCycle.has(proxy.id));
      if (everyLiveProxyUsed) {
        this.beginNextProxyCycle();
        candidate = eligible.find((proxy) => !this.usedThisCycle.has(proxy.id));
      }
    }

    if (candidate) this.setAssignment(workspaceId, candidate.id);
    return candidate ? { ...candidate } : undefined;
  }

  syncBrowserCount(count: number): void {
    const target = Math.min(100, Math.max(1, Math.floor(Number(count) || 10)));
    this.assignments = this.assignments.filter((assignment) => assignment.workspaceId <= target);
  }

  clear(): void {
    this.cancelValidation();
    this.proxies = [];
    this.assignments = [];
    this.lastImportedIds = [];
    this.resetProxyCycle();
    this.validationProgress = this.emptyProgress();
    this.emitChanged();
    this.emitValidationProgress();
  }
}
