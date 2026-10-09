import { useEffect } from 'react';
import { useAppStore } from './stores/appStore';
import { TopBar } from './components/TopBar';
import { BrowserGrid } from './components/BrowserGrid';
import { ProxyManagerPage } from './components/ProxyManagerPage';
import { SettingsPage } from './components/SettingsPage';
import { SeoTrackerPage } from './components/SeoTrackerPage';

export default function App() {
  const ready = useAppStore((s) => s.ready);
  const error = useAppStore((s) => s.error);
  const page = useAppStore((s) => s.page);
  const settings = useAppStore((s) => s.settings);
  const bootstrap = useAppStore((s) => s.bootstrap);

  useEffect(() => { void bootstrap(); }, [bootstrap]);
  useEffect(() => {
    if (!settings) return;
    const theme = settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : settings.theme;
    document.documentElement.dataset.theme = theme;
  }, [settings]);

  if (!ready) return <div className="splash"><div className="spinner" /><h1>ProxyDesk SEO Multi-Engine</h1><p>Preparing browsers, proxies and SEO tracking…</p></div>;
  if (error) return <div className="splash error-screen"><h1>Startup error</h1><p>{error}</p></div>;

  return <div className="app-shell"><TopBar />{page === 'workspaces' && <BrowserGrid />}<div hidden={page !== 'seo'}><SeoTrackerPage /></div>{page === 'proxies' && <ProxyManagerPage />}{page === 'settings' && <SettingsPage />}</div>;
}
