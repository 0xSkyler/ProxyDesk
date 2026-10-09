import { useMemo, useState } from 'react';
import { useAppStore } from '../stores/appStore';

export function ProxyManagerPage() {
  const proxies = useAppStore((s) => s.proxies);
  const workspaces = useAppStore((s) => s.workspaces);
  const validation = useAppStore((s) => s.validationProgress);
  const lastImport = useAppStore((s) => s.lastImport);
  const importFile = useAppStore((s) => s.importFile);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [busy, setBusy] = useState('');
  const assigned = useMemo(() => new Map(workspaces.filter((w) => w.proxy).map((w) => [w.proxy!.id, w.id])), [workspaces]);
  const shown = proxies.filter((proxy) => `${proxy.host}:${proxy.port} ${proxy.protocol} ${proxy.source}`.toLowerCase().includes(query.toLowerCase()) && (status === 'all' || proxy.status === status));
  const percent = validation.total > 0 ? Math.round((validation.completed / validation.total) * 100) : 0;

  const runValidation = async () => {
    setBusy('validate');
    try { await window.proxydesk.proxy.validate(); } finally { setBusy(''); }
  };

  return <main className="content">
    <section className="page-intro">
      <div><span className="eyebrow">MEMORY ONLY · LIVE PIPELINE</span><h1>Proxy validation</h1><p>Every endpoint is checked independently. A working proxy can be assigned to a waiting browser immediately while the rest of the pool continues validating.</p></div>
      <div className="action-row">
        <button className="primary" disabled={Boolean(busy)} onClick={async () => { setBusy('import'); try { await importFile(); } finally { setBusy(''); } }}>{busy === 'import' ? 'Loading…' : 'Replace pool from proxy.txt'}</button>
        {!validation.active
          ? <button disabled={Boolean(busy) || !proxies.length} onClick={() => void runValidation()}>{busy === 'validate' ? 'Validating…' : 'Start live validation'}</button>
          : <button className="danger-ghost" onClick={() => void window.proxydesk.proxy.cancelValidation()}>Stop validation</button>}
        <button className="danger-ghost" disabled={!proxies.length} onClick={() => void window.proxydesk.proxy.clear()}>Clear memory</button>
      </div>
    </section>

    {lastImport && <div className="notice">Last upload: {lastImport.valid} valid · {lastImport.invalid} invalid · {lastImport.duplicates} duplicates. {validation.active ? 'Live validation is running in the background.' : ''}</div>}

    <section className="validation-dashboard">
      <article className="panel validation-stat"><span>Progress</span><strong>{validation.completed}/{validation.total || proxies.length}</strong><small>{validation.active ? `${percent}% · running` : validation.cancelled ? 'cancelled' : validation.total ? 'complete' : 'idle'}</small></article>
      <article className="panel validation-stat"><span>Checking now</span><strong>{validation.checking}</strong><small>Concurrent internet tests</small></article>
      <article className="panel validation-stat validation-good"><span>Working</span><strong>{validation.working}</strong><small>Passed current rules</small></article>
      <article className="panel validation-stat validation-bad"><span>Dead</span><strong>{validation.dead}</strong><small>Failed / timed out</small></article>
      <article className="panel validation-stat"><span>Live assigned</span><strong>{validation.assigned}</strong><small>Handed to browsers immediately</small></article>
    </section>

    {validation.total > 0 && <section className="panel validation-live-strip">
      <div className="validation-progress-track"><div className="validation-progress-fill" style={{ width: `${percent}%` }} /></div>
      <div className="validation-latest"><strong>{validation.active ? 'LIVE' : 'LAST'}:</strong> <span className="mono">{validation.latestEndpoint ?? 'Waiting for a result…'}</span> {validation.latestStatus && <span className={`pill ${validation.latestStatus}`}>{validation.latestStatus}</span>} {validation.latestLatencyMs !== undefined && <span>{validation.latestLatencyMs} ms</span>} {validation.latestError && <span className="tiny-error inline-error">{validation.latestError}</span>}</div>
    </section>}

    <section className="panel">
      <div className="table-toolbar"><input placeholder="Search host or protocol…" value={query} onChange={(e) => setQuery(e.target.value)} /><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">All statuses</option><option value="unverified">Unverified</option><option value="checking">Checking</option><option value="working">Working</option><option value="dead">Dead</option></select></div>
      <div className="table-wrap"><table><thead><tr><th>Endpoint</th><th>Protocol</th><th>Status</th><th>Latency</th><th>Assigned</th><th>Last check</th></tr></thead><tbody>{shown.map((proxy) => <tr key={proxy.id}><td className="mono">{proxy.host}:{proxy.port}</td><td>{proxy.protocol.toUpperCase()}</td><td><span className={`pill ${proxy.status}`}>{proxy.status}</span>{proxy.lastError && <div className="tiny-error">{proxy.lastError}</div>}</td><td>{proxy.latencyMs !== undefined ? `${proxy.latencyMs} ms` : '—'}</td><td>{assigned.has(proxy.id) ? `Browser ${assigned.get(proxy.id)}` : '—'}</td><td>{proxy.lastCheckedAt ? new Date(proxy.lastCheckedAt).toLocaleTimeString() : '—'}</td></tr>)}</tbody></table>{!shown.length && <div className="empty-state">Upload proxy.txt to start a new in-memory proxy session.</div>}</div>
    </section>
  </main>;
}
