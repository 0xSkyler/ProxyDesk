import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { SeoBrowserResult, SeoRunSummary } from '../../shared/types/seo';
import { allocateSeoKeywords, parseSeoKeywords } from '../../shared/seoKeywords';
import { useAppStore } from '../stores/appStore';

function resultClass(status: SeoBrowserResult['status']): string {
  if (status === 'found') return 'working';
  if (status === 'challenge' || status === 'error' || status === 'unavailable') return 'dead';
  return 'unverified';
}

export function SeoTrackerPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const [keyword, setKeyword] = useState('');
  const [keywordFilter, setKeywordFilter] = useState('');
  const [target, setTarget] = useState('');
  const [maxPages, setMaxPages] = useState(3);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<SeoBrowserResult[]>([]);
  const [history, setHistory] = useState<SeoRunSummary[]>([]);
  const [running, setRunning] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void window.proxydesk.seo.history().then(setHistory);
    return window.proxydesk.onSeoResult((result) => {
      setResults((current) => {
        const next = current.filter((item) => item.workspaceId !== result.workspaceId || item.runId !== result.runId);
        return [...next, result].sort((a, b) => a.workspaceId - b.workspaceId);
      });
    });
  }, []);

  const workspaceIdKey = workspaces.map((workspace) => workspace.id).join(',');
  useEffect(() => {
    setSelected(new Set(workspaceIdKey.split(',').filter(Boolean).map(Number)));
  }, [workspaceIdKey]);

  const keywords = useMemo(() => parseSeoKeywords(keyword), [keyword]);
  const selectedWorkspaces = workspaces.filter((workspace) => selected.has(workspace.id));
  const availableIds = selectedWorkspaces.filter((workspace) => workspace.engineAvailable).map((workspace) => workspace.id).sort((a, b) => a - b);
  const unavailableIds = selectedWorkspaces.filter((workspace) => !workspace.engineAvailable).map((workspace) => workspace.id).sort((a, b) => a - b);
  const assignments = keywords.length && keywords.length <= selected.size
    ? allocateSeoKeywords(keywords, [...availableIds, ...unavailableIds]) : [];
  const allocationError = keywords.length > 1 && keywords.length > availableIds.length
    ? `Select at least ${keywords.length} available browsers for ${keywords.length} simultaneous keywords. ${availableIds.length} available selected.` : '';
  const filteredResults = keywordFilter ? results.filter((result) => result.keyword === keywordFilter) : results;
  const historyRows = history.flatMap((run) => (run.keywords ?? [run.keyword]).map((query) => ({
    run, keyword: query, results: run.results.filter((result) => result.keyword === query)
  })));

  const stats = useMemo(() => ({
    found: results.filter((item) => item.status === 'found').length,
    notFound: results.filter((item) => item.status === 'not-found').length,
    challenged: results.filter((item) => item.status === 'challenge').length,
    best: results.filter((item) => item.position).reduce<number | undefined>((best, item) => best === undefined ? item.position : Math.min(best, item.position ?? best), undefined)
  }), [results]);

  const clearSelected = async () => {
    if (selected.size === 0 || running || clearing) return;
    setClearing(true);
    setMessage(`Clearing cookies, cache, storage and previous session data from ${selected.size} selected browser${selected.size === 1 ? '' : 's'}…`);
    try {
      const cleared = await window.proxydesk.workspace.clearData([...selected]);
      setMessage(`Cleared all browser profile data from Browser ${cleared.join(', ')}. Proxy assignments and engine choices were kept.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setClearing(false);
    }
  };

  const run = async (event: FormEvent) => {
    event.preventDefault();
    if (!keywords.length || !target.trim() || selected.size === 0 || running || clearing || allocationError) return;
    setRunning(true);
    setResults([]);
    setKeywordFilter('');
    setMessage(`Clearing ${selected.size} selected browsers, then starting ${keywords.length} keyword${keywords.length === 1 ? '' : 's'} in parallel…`);
    try {
      const summary = await window.proxydesk.seo.run({
        keywords,
        target: target.trim(),
        workspaceIds: [...selected],
        maxPages,
        autoOpenMatch: true
      });
      setResults(summary.results);
      setHistory(await window.proxydesk.seo.history());
      const found = summary.results.filter((item) => item.status === 'found').length;
      setMessage(`Finished ${summary.keywords?.length ?? 1} keyword(s). ${found}/${summary.results.length} browsers found ${summary.targetHost}. Matched browsers opened the target link immediately and Keep Alive remains enabled continuously.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  return <main className="content seo-page">
    <section className="panel seo-hero">
      <div>
        <span className="eyebrow">SEO TRACKER</span>
        <h1>Track multiple keywords, together.</h1>
        <p>Split your selected browsers across keywords and watch each keyword's results arrive independently. Every SEO run first clears all selected browser profile data, then opens Google in a fresh session. Strict target mode scans usable results for your target domain or subdomains; the first match is opened and Keep Alive is forced ON.</p>
      </div>
      <form className="seo-form" onSubmit={run}>
        <label>Keywords (one per line)<textarea rows={4} disabled={running || clearing} value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={'garment sourcing Bangladesh\nfabric quality control\napparel production planning'} /><small>One complete search phrase per line. Duplicate lines are removed.</small></label>
        <label>Target website<input disabled={running || clearing} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="e.g. example.com" /></label>
        <div className="seo-form-row">
          <label>Google pages<select disabled={running || clearing} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))}>{[1,2,3,4,5].map((n) => <option key={n} value={n}>{n} page{n > 1 ? 's' : ''} · up to ~{n * 10} organic results</option>)}</select></label>
          <div className="seo-check"><span><strong>Fresh-session + strict target action</strong><small>Before SEO begins, selected browsers are fully cleared. If a usable Google result resolves to the target domain or subdomain, ProxyDesk opens it, saves the landed article URL, and starts continuous Keep Alive.</small></span></div>
        </div>
        <div className="browser-selector seo-browser-selector">{workspaces.map((w) => <label key={w.id}><input type="checkbox" aria-label={`Browser ${w.id}${w.engineAvailable ? '' : ' (unavailable)'}`} disabled={running || clearing} checked={selected.has(w.id)} onChange={(e) => setSelected((previous) => { const next = new Set(previous); if (e.target.checked) next.add(w.id); else next.delete(w.id); return next; })} />{w.id}</label>)}</div>
        <p className="seo-allocation-note">{keywords.length} unique keyword{keywords.length === 1 ? '' : 's'} · {selected.size} selected browser{selected.size === 1 ? '' : 's'} · {availableIds.length} available. Your browser fleet is shared across keywords.</p>
        {allocationError && <div className="notice seo-allocation-error" role="alert">{allocationError}</div>}
        <div className="seo-submit-row"><button type="button" disabled={running || clearing} onClick={() => setSelected(new Set(workspaces.map((w) => w.id)))}>All</button><button type="button" disabled={running || clearing} onClick={() => setSelected(new Set())}>None</button><button type="button" className="danger-ghost" disabled={running || clearing || selected.size === 0} onClick={() => void clearSelected()}>{clearing ? 'Clearing…' : `Clear selected (${selected.size})`}</button><button className="primary" disabled={running || clearing || !keywords.length || !target.trim() || selected.size === 0 || Boolean(allocationError)}>{running ? 'Checking…' : `Track ${keywords.length} keyword${keywords.length === 1 ? '' : 's'} in ${selected.size} browser${selected.size === 1 ? '' : 's'}`}</button></div>
      </form>
    </section>

    {assignments.length > 0 && !allocationError && <section className="seo-keyword-grid" aria-label="Keyword browser allocation">{keywords.map((query) => {
      const browserIds = assignments.filter((assignment) => assignment.keyword === query).map((assignment) => assignment.workspaceId);
      const observations = results.filter((result) => result.keyword === query);
      const found = observations.filter((result) => result.status === 'found').length;
      return <article className="panel seo-keyword-card" key={query}>
        <span className="eyebrow">{browserIds.length} browser{browserIds.length === 1 ? '' : 's'}</span>
        <h2>{query}</h2><p>Browsers {browserIds.join(', ')}</p>
        <progress aria-label={`${query} progress`} value={observations.length} max={browserIds.length} />
        <small>{observations.length}/{browserIds.length} checked · {found} found</small>
      </article>;
    })}</section>}

    <section className="seo-stat-grid">
      <article className="panel seo-stat"><span>Found</span><strong>{stats.found}</strong></article>
      <article className="panel seo-stat"><span>Not found</span><strong>{stats.notFound}</strong></article>
      <article className="panel seo-stat"><span>Challenges</span><strong>{stats.challenged}</strong></article>
      <article className="panel seo-stat"><span>Best observed position</span><strong>{stats.best ?? '—'}</strong></article>
    </section>

    {message && <div className="notice seo-message">{message}</div>}

    <section className="panel seo-results-panel">
      <div className="control-table-head"><div><h2>Current run</h2><p>{results.length}/{selected.size} observations received. Position is the organic-link order in that browser session.</p></div><label className="seo-filter">Filter results by keyword<select aria-label="Filter results by keyword" value={keywordFilter} onChange={(event) => setKeywordFilter(event.target.value)}><option value="">All keywords</option>{[...new Set(results.map((result) => result.keyword))].map((query) => <option key={query} value={query}>{query}</option>)}</select></label></div>
      <div className="table-wrap"><table className="seo-results-table">
        <thead><tr><th>Browser</th><th>Keyword</th><th>Engine</th><th>Proxy</th><th>Status</th><th>Position</th><th>Google page</th><th>Matched title</th><th>Matched URL</th><th>Action</th></tr></thead>
        <tbody>{filteredResults.length === 0 ? <tr><td colSpan={10} className="empty-state">Run a keyword check to populate SEO observations.</td></tr> : filteredResults.map((result) => <tr key={result.id}>
          <td><strong>{result.workspaceId}</strong></td><td className="seo-keyword-cell">{result.keyword}</td><td>{result.engineLabel}</td><td className="mono">{result.proxyLabel ?? 'Direct'}</td><td><span className={`pill ${resultClass(result.status)}`}>{result.status}</span>{result.error && <div className="tiny-error">{result.error}</div>}</td><td><strong>{result.position ?? '—'}</strong>{result.pagePosition && <small className="seo-subvalue">#{result.pagePosition} on page</small>}</td><td>{result.resultPage ?? '—'}</td><td>{result.matchedTitle ?? '—'}</td><td className="seo-url-cell" title={result.matchedUrl}>{result.matchedUrl ?? '—'}</td><td>{result.matchedUrl ? <button onClick={() => void window.proxydesk.workspace.navigate(result.workspaceId, result.matchedUrl!)}>Open</button> : '—'}</td>
        </tr>)}</tbody>
      </table></div>
    </section>

    <section className="panel seo-history-panel">
      <div className="control-table-head"><div><h2>SEO history</h2><p>SEO observations are saved locally for trend comparison. Proxy lists and proxy assignments remain memory-only.</p></div><div className="action-row"><button disabled={!history.length} onClick={() => void window.proxydesk.seo.exportCsv().then((path) => path && setMessage(`CSV exported to ${path}`))}>Export CSV</button><button className="danger-ghost" disabled={!history.length} onClick={async () => { await window.proxydesk.seo.clearHistory(); setHistory([]); }}>Clear history</button></div></div>
      <div className="table-wrap seo-history-wrap"><table>
        <thead><tr><th>Time</th><th>Keyword</th><th>Target</th><th>Browsers</th><th>Found</th><th>Best position</th><th>Challenges</th></tr></thead>
        <tbody>{history.length === 0 ? <tr><td colSpan={7} className="empty-state">No saved SEO runs yet.</td></tr> : historyRows.slice(0, 100).map(({ run, keyword: query, results: observations }) => {
          const found = observations.filter((item) => item.status === 'found');
          const best = found.reduce<number | undefined>((value, item) => value === undefined ? item.position : Math.min(value, item.position ?? value), undefined);
          return <tr key={`${run.id}:${query}`}><td>{new Date(run.completedAt).toLocaleString()}</td><td><strong>{query}</strong></td><td className="mono">{run.targetHost}</td><td>{observations.length}</td><td>{found.length}</td><td>{best ?? '—'}</td><td>{observations.filter((item) => item.status === 'challenge').length}</td></tr>;
        })}</tbody>
      </table></div>
    </section>

    <div className="warning-box seo-warning"><strong>Google search note</strong><p>Automated rank checking can trigger Google's unusual-traffic protections. ProxyDesk records a challenge and stops that browser's check; it does not solve or bypass CAPTCHA. Use modest run frequency and comply with Google's applicable terms and machine-readable instructions.</p></div>
  </main>;
}
