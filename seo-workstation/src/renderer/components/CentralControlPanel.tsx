import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { BrowserEngine } from '../../shared/types/browser';
import type { WorkspaceState } from '../../shared/types/workspace';
import { parseBrowserSelection } from '../../shared/browserSelection';
import { distributeSavedUrls, parseSavedUrlPool } from '../../shared/urlPool';
import { useAppStore } from '../stores/appStore';

type RouteRow = { key: number; browsers: string; url: string };

export function CentralControlPanel() {
  const workspaces = useAppStore((s) => s.workspaces);
  const engines = useAppStore((s) => s.engines);
  const proxies = useAppStore((s) => s.proxies);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [targets, setTargets] = useState<Record<number, string>>({});
  const [rotations, setRotations] = useState<Record<number, string>>({});
  const [search, setSearch] = useState('');
  const [bulkUrl, setBulkUrl] = useState('');
  const [urlPoolText, setUrlPoolText] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [routes, setRoutes] = useState<RouteRow[]>([
    { key: 1, browsers: '1', url: '' },
    { key: 2, browsers: '2', url: '' }
  ]);
  const [routeKey, setRouteKey] = useState(3);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    setTargets(Object.fromEntries(workspaces.map((w) => [w.id, w.targetUrl])));
    setRotations(Object.fromEntries(workspaces.map((w) => [w.id, String(w.rotationSeconds)])));
  }, [workspaces.length]);

  useEffect(() => {
    setSelected(new Set(workspaces.map((w) => w.id)));
  }, [workspaces.length]);

  useEffect(() => {
    if (settings) setUrlPoolText(settings.savedUrlPool.join('\n'));
  }, [settings?.savedUrlPool]);

  const engineMap = useMemo(() => new Map(engines.map((engine) => [engine.engine, engine])), [engines]);
  const validIds = useMemo(() => workspaces.map((workspace) => workspace.id), [workspaces]);
  const urlPoolStats = useMemo(() => {
    const lines = urlPoolText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const seen = new Set<string>();
    let valid = 0;
    let invalid = 0;
    let duplicates = 0;

    for (const line of lines) {
      try {
        const [normalized] = parseSavedUrlPool(line);
        if (!normalized) continue;
        if (seen.has(normalized)) duplicates += 1;
        else {
          seen.add(normalized);
          valid += 1;
        }
      } catch {
        invalid += 1;
      }
    }

    return { lines: lines.length, valid, invalid, duplicates };
  }, [urlPoolText]);

  const toggleSelected = (id: number, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(validIds));
  const selectNone = () => setSelected(new Set());

  const applyAll = async () => {
    setBusy('apply');
    setMessage('');
    try {
      await window.proxydesk.central.applyTargets(workspaces.map((w) => ({ id: w.id, url: targets[w.id] ?? w.targetUrl })));
      setMessage(`Applied ${workspaces.length} browser target${workspaces.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };

  const openBulkUrl = async (event: FormEvent) => {
    event.preventDefault();
    if (!bulkUrl.trim() || selected.size === 0) return;
    setBusy('bulk');
    setMessage('');
    const ids = [...selected].sort((a, b) => a - b);
    try {
      await window.proxydesk.central.applyTargets(ids.map((id) => ({ id, url: bulkUrl.trim() })));
      setTargets((current) => {
        const next = { ...current };
        for (const id of ids) next[id] = bulkUrl.trim();
        return next;
      });
      setMessage(`Opened the URL in ${ids.length} selected browser${ids.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };

  const submitSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (!search.trim()) return;
    setBusy('search');
    setMessage('');
    try {
      const url = `https://www.google.com/search?q=${encodeURIComponent(search.trim())}`;
      await window.proxydesk.central.googleSearch(search, [...selected]);
      setTargets((current) => {
        const next = { ...current };
        for (const id of selected) next[id] = url;
        return next;
      });
      setMessage(`Google search sent to ${selected.size} browser${selected.size === 1 ? '' : 's'}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };


  const saveUrlPool = async (): Promise<string[]> => {
    const urls = parseSavedUrlPool(urlPoolText);
    if (!urls.length) throw new Error('Paste at least one website link before saving.');
    await updateSettings({ savedUrlPool: urls });
    setUrlPoolText(urls.join('\n'));
    return urls;
  };

  const clearUrlPool = async () => {
    setBusy('pool-clear');
    setMessage('');
    try {
      await updateSettings({ savedUrlPool: [] });
      setUrlPoolText('');
      setMessage('Saved website link pool cleared.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };

  const randomizeUrlPool = async () => {
    if (selected.size === 0) return;
    setBusy('pool-random');
    setMessage('');
    try {
      const urls = await saveUrlPool();
      const assignments = distributeSavedUrls([...selected], urls);
      await window.proxydesk.central.applyTargets(assignments);
      setTargets((current) => {
        const next = { ...current };
        for (const assignment of assignments) next[assignment.id] = assignment.url;
        return next;
      });
      const perUrl = new Map<string, number>();
      for (const assignment of assignments) perUrl.set(assignment.url, (perUrl.get(assignment.url) ?? 0) + 1);
      const summary = [...perUrl.values()].sort((a, b) => b - a).join('/');
      setMessage(`Randomly distributed ${urls.length} saved link${urls.length === 1 ? '' : 's'} across ${assignments.length} browser${assignments.length === 1 ? '' : 's'}${summary ? ` (${summary} browser assignments per link)` : ''}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };

  const persistUrlPoolOnly = async () => {
    setBusy('pool-save');
    setMessage('');
    try {
      const urls = await saveUrlPool();
      setMessage(`Saved ${urls.length} website link${urls.length === 1 ? '' : 's'} for random distribution.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };

  const addRoute = () => {
    setRoutes((current) => [...current, { key: routeKey, browsers: '', url: '' }]);
    setRouteKey((current) => current + 1);
  };

  const updateRoute = (key: number, patch: Partial<RouteRow>) => {
    setRoutes((current) => current.map((route) => route.key === key ? { ...route, ...patch } : route));
  };

  const removeRoute = (key: number) => setRoutes((current) => current.filter((route) => route.key !== key));

  const dispatchRoutes = async () => {
    setBusy('routes');
    setMessage('');
    try {
      const entries: Array<{ id: number; url: string }> = [];
      const claimed = new Map<number, number>();
      for (const route of routes) {
        if (!route.url.trim() || !route.browsers.trim()) continue;
        const ids = parseBrowserSelection(route.browsers, validIds);
        if (!ids.length) throw new Error(`Route ${route.key} does not contain any active browser IDs.`);
        for (const id of ids) {
          const previous = claimed.get(id);
          if (previous !== undefined) throw new Error(`Browser ${id} is assigned to both Route ${previous} and Route ${route.key}. Each browser can receive only one URL in the same dispatch.`);
          claimed.set(id, route.key);
          entries.push({ id, url: route.url.trim() });
        }
      }
      if (!entries.length) throw new Error('Add at least one route with a URL and browser selection.');
      await window.proxydesk.central.applyTargets(entries);
      setTargets((current) => {
        const next = { ...current };
        for (const entry of entries) next[entry.id] = entry.url;
        return next;
      });
      const activeRouteCount = routes.filter((route) => route.url.trim() && route.browsers.trim()).length;
      setMessage(`Dispatched ${new Set(entries.map((entry) => entry.id)).size} browsers across ${activeRouteCount} URL route${activeRouteCount === 1 ? '' : 's'}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(''); }
  };

  return <>
    <section className="panel control-hero central-dispatcher">
      <div className="control-hero-copy">
        <span className="eyebrow">CENTRAL URL CONTROL</span>
        <h1>{workspaces.length} browsers. One navigation center.</h1>
        <p>Send one URL to every selected browser, or route different browser groups to different URLs. Browser selections automatically follow the active 1–100 browser fleet.</p>
      </div>
      <div className="central-tools">
        <form className="central-tool" onSubmit={openBulkUrl}>
          <label>Open one URL in selected browsers</label>
          <div className="search-row"><input value={bulkUrl} onChange={(e) => setBulkUrl(e.target.value)} placeholder="https://example.com/article" /><button className="primary" disabled={Boolean(busy) || selected.size === 0 || !bulkUrl.trim()}>{busy === 'bulk' ? 'Opening…' : `Open in ${selected.size}`}</button></div>
        </form>
        <form className="central-tool" onSubmit={submitSearch}>
          <label>Google central search</label>
          <div className="search-row"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search selected browsers…" /><button disabled={Boolean(busy) || selected.size === 0 || !search.trim()}>{busy === 'search' ? 'Searching…' : `Search ${selected.size}`}</button></div>
        </form>
      </div>
      <div className="central-selector-block">
        <div className="selector-head"><strong>Selected browsers</strong><div className="action-row"><button type="button" onClick={selectAll}>All</button><button type="button" onClick={selectNone}>None</button></div></div>
        <div className="browser-selector central-browser-selector">{workspaces.map((w) => <label key={w.id}><input type="checkbox" checked={selected.has(w.id)} onChange={(e) => toggleSelected(w.id, e.target.checked)} />{w.id}</label>)}</div>
      </div>
      {message && <div className="central-message">{message}</div>}
    </section>


    <section className="panel url-pool-panel">
      <div className="control-table-head">
        <div><h2>Saved random website pool</h2><p>Paste one website link per line and save it. Random distribution uses the browser selection above. If browsers outnumber links, ProxyDesk repeats the saved links only after every link has been used once in that distribution cycle.</p></div>
        <div className="action-row"><button disabled={Boolean(busy)} onClick={() => void persistUrlPoolOnly()}>{busy === 'pool-save' ? 'Saving…' : 'Save links'}</button><button className="primary" disabled={Boolean(busy) || selected.size === 0 || !urlPoolText.trim()} onClick={() => void randomizeUrlPool()}>{busy === 'pool-random' ? 'Distributing…' : `Random distribute to ${selected.size}`}</button><button className="danger-ghost" disabled={Boolean(busy) || (!urlPoolText.trim() && !(settings?.savedUrlPool.length))} onClick={() => void clearUrlPool()}>Clear saved</button></div>
      </div>
      <div className="url-pool-grid">
        <label className="url-pool-input">
          <span>Website URL Pool</span>
          <small>Paste one complete URL per line. Long URLs stay on one horizontal line and can be scrolled sideways.</small>
          <textarea
            className="url-pool-textarea"
            rows={7}
            wrap="off"
            spellCheck={false}
            value={urlPoolText}
            onChange={(e) => setUrlPoolText(e.target.value)}
            placeholder={'https://example.com/article-a\nhttps://example.com/article-b'}
          />
          <div className="url-pool-entry-meta">
            <span>{urlPoolStats.lines} entered line{urlPoolStats.lines === 1 ? '' : 's'}</span>
            <span className="ok-text">{urlPoolStats.valid} valid unique URL{urlPoolStats.valid === 1 ? '' : 's'}</span>
            {urlPoolStats.duplicates > 0 && <span>{urlPoolStats.duplicates} duplicate{urlPoolStats.duplicates === 1 ? '' : 's'}</span>}
            {urlPoolStats.invalid > 0 && <span className="error-text">{urlPoolStats.invalid} invalid line{urlPoolStats.invalid === 1 ? '' : 's'}</span>}
          </div>
        </label>
        <div className="url-pool-info">
          <strong>{settings?.savedUrlPool.length ?? 0} saved link{(settings?.savedUrlPool.length ?? 0) === 1 ? '' : 's'}</strong>
          <p>Example: 5 selected browsers + 2 saved links → all 5 browsers receive a URL; the two links are shuffled and repeated across the remaining browsers.</p>
          <small>The saved URL pool is application configuration and persists across app restarts. It does not save browser cookies, cache or proxy data.</small>
        </div>
      </div>
    </section>

    <section className="panel route-planner-panel">
      <div className="control-table-head">
        <div><h2>Multi-URL router</h2><p>Assign a different URL to each browser group. Browser syntax accepts ranges such as <span className="mono">1-5,8,10</span>.</p></div>
        <div className="action-row"><button onClick={addRoute}>+ Add route</button><button className="primary" disabled={Boolean(busy)} onClick={() => void dispatchRoutes()}>{busy === 'routes' ? 'Dispatching…' : 'Run all routes'}</button></div>
      </div>
      <div className="route-list">
        {routes.map((route, index) => {
          const parsed = parseBrowserSelection(route.browsers, validIds);
          return <div className="route-row" key={route.key}>
            <div className="route-number">{index + 1}</div>
            <label><span>Browsers</span><input value={route.browsers} onChange={(e) => updateRoute(route.key, { browsers: e.target.value })} placeholder="1-5,8,10" /><small>{parsed.length ? `${parsed.length} selected` : 'No active browsers selected'}</small></label>
            <label className="route-url"><span>URL</span><input value={route.url} onChange={(e) => updateRoute(route.key, { url: e.target.value })} placeholder="https://example.com/page" /></label>
            <button className="danger-ghost route-remove" disabled={routes.length === 1} onClick={() => removeRoute(route.key)}>Remove</button>
          </div>;
        })}
      </div>
    </section>

    <section className="panel control-table-panel">
      <div className="control-table-head"><div><h2>Per-browser targets & automation</h2><p>Fine-tune individual URLs here. Rotation values are seconds; set 0 to disable rotation.</p></div><div className="action-row"><button onClick={() => void window.proxydesk.workspace.launchAll()}>Launch all</button><button onClick={() => void window.proxydesk.workspace.stopAll()}>Stop all</button><button className="primary" onClick={() => void window.proxydesk.workspace.setKeepAliveAll(true)}>Keep Alive all</button><button onClick={() => void window.proxydesk.workspace.setKeepAliveAll(false)}>Stop Keep Alive</button><button disabled={Boolean(busy)} onClick={() => void applyAll()}>{busy === 'apply' ? 'Applying…' : 'Apply all row URLs'}</button></div></div>
      <div className="control-table-wrap"><table className="control-table">
        <thead><tr><th>#</th><th>Browser engine</th><th>Website target</th><th>Proxy</th><th>Rotate (sec)</th><th>Keep alive</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>{workspaces.map((w) => <ControlRow key={w.id} workspace={w} engineMap={engineMap} proxies={proxies} target={targets[w.id] ?? w.targetUrl} rotation={rotations[w.id] ?? String(w.rotationSeconds)} onTarget={(value) => setTargets((current) => ({ ...current, [w.id]: value }))} onRotation={(value) => setRotations((current) => ({ ...current, [w.id]: value }))} />)}</tbody>
      </table></div>
    </section>
  </>;
}

function ControlRow({ workspace, engineMap, proxies, target, rotation, onTarget, onRotation }: {
  workspace: WorkspaceState;
  engineMap: Map<BrowserEngine, { label: string; available: boolean }>;
  proxies: Array<{ id: string; host: string; port: number; protocol: string; status: string }>;
  target: string;
  rotation: string;
  onTarget(value: string): void;
  onRotation(value: string): void;
}) {
  const saveTarget = async () => window.proxydesk.workspace.setTarget(workspace.id, target);
  const saveRotation = async () => {
    const seconds = Math.max(0, Math.floor(Number(rotation) || 0));
    onRotation(String(seconds));
    await window.proxydesk.workspace.setRotationSeconds(workspace.id, seconds);
  };
  return <tr>
    <td><strong>{workspace.id}</strong></td>
    <td><select className="engine-select" value={workspace.engine} onChange={(e) => void window.proxydesk.workspace.setEngine(workspace.id, e.target.value as BrowserEngine)}>
      {(['chromium', 'firefox', 'webkit', 'edge', 'opera'] as BrowserEngine[]).map((engine) => { const info = engineMap.get(engine); return <option key={engine} value={engine}>{info?.label ?? engine}{info && !info.available ? ' — unavailable' : ''}</option>; })}
    </select></td>
    <td><div className="target-cell"><input value={target} onChange={(e) => onTarget(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveTarget(); }} /><button onClick={() => void saveTarget()}>Go</button></div></td>
    <td><select className="proxy-select" value={workspace.proxy?.id ?? ''} onChange={(e) => void window.proxydesk.proxy.assignOne(workspace.id, e.target.value || undefined)}><option value="">Direct / none</option>{proxies.map((proxy) => <option key={proxy.id} value={proxy.id}>{proxy.protocol.toUpperCase()} · {proxy.host}:{proxy.port}{proxy.status === 'dead' ? ' · dead' : ''}</option>)}</select></td>
    <td><input className="rotation-input" type="number" min={0} step={1} value={rotation} onChange={(e) => onRotation(e.target.value)} onBlur={() => void saveRotation()} onKeyDown={(e) => { if (e.key === 'Enter') void saveRotation(); }} /></td>
    <td><label className="switch-inline"><input type="checkbox" checked={workspace.keepAlive} onChange={(e) => void window.proxydesk.workspace.setKeepAlive(workspace.id, e.target.checked)} /><span>{workspace.keepAlive ? 'On' : 'Off'}</span></label></td>
    <td><span className={`pill ${workspace.status}`}>{workspace.status}</span></td>
    <td><div className="mini-actions"><button disabled={!workspace.engineAvailable} onClick={() => void window.proxydesk.workspace.launch(workspace.id)}>Launch</button><button onClick={() => void window.proxydesk.workspace.rotateProxy(workspace.id)}>Rotate now</button><button className="danger-ghost" onClick={() => void window.proxydesk.workspace.clearData([workspace.id])}>Clear data</button></div></td>
  </tr>;
}
