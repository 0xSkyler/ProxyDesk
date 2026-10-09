import { useState } from 'react';
import { useAppStore, type AppPage } from '../stores/appStore';

const pages: Array<{ id: AppPage; label: string }> = [
  { id: 'workspaces', label: 'Control Center' },
  { id: 'seo', label: 'SEO Tracker' },
  { id: 'proxies', label: 'Proxy Session' },
  { id: 'settings', label: 'Settings' }
];

export function TopBar() {
  const page = useAppStore((s) => s.page);
  const workspaces = useAppStore((s) => s.workspaces);
  const setPage = useAppStore((s) => s.setPage);
  const importFile = useAppStore((s) => s.importFile);
  const assign = useAppStore((s) => s.assign);
  const proxies = useAppStore((s) => s.proxies);
  const validation = useAppStore((s) => s.validationProgress);
  const [busy, setBusy] = useState('');

  return <header className="topbar">
    <div className="brand"><div className="brand-mark">PD</div><div><strong>ProxyDesk SEO Multi-Engine</strong><small>{workspaces.length} mobile browsers + SEO rank tracking</small></div></div>
    <nav className="tabs">{pages.map((item) => <button key={item.id} className={page === item.id ? 'tab active' : 'tab'} onClick={() => setPage(item.id)}>{item.label}</button>)}</nav>
    <div className="top-actions">
      <span className="memory-pill">{proxies.length ? `${proxies.length} proxies · ${validation.working} live${validation.active ? ' · validating' : ''}` : 'No proxy.txt loaded'}</span>
      <button className="primary" disabled={Boolean(busy)} onClick={async () => { setBusy('import'); try { await importFile(); } finally { setBusy(''); } }}>{busy === 'import' ? 'Loading…' : 'Upload proxy.txt'}</button>
      <button className="secondary" disabled={Boolean(busy) || proxies.length === 0} onClick={async () => { setBusy('assign'); try { await assign(); } finally { setBusy(''); } }}>{busy === 'assign' ? 'Assigning…' : 'Assign proxies'}</button>
    </div>
  </header>;
}
