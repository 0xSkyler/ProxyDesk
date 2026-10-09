import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';

export function SettingsPage() {
  const settings = useAppStore((s) => s.settings);
  const diagnostics = useAppStore((s) => s.diagnostics);
  const engines = useAppStore((s) => s.engines);
  const update = useAppStore((s) => s.updateSettings);
  const refreshEngines = useAppStore((s) => s.refreshEngines);
  const [operaPath, setOperaPath] = useState(settings?.operaExecutablePath ?? '');
  const [browserCount, setBrowserCount] = useState(settings?.browserCount ?? 10);
  useEffect(() => { if (settings) setBrowserCount(settings.browserCount); }, [settings?.browserCount]);
  if (!settings) return null;

  return <main className="content settings-page">
    <section className="page-intro"><div><span className="eyebrow">CONFIGURATION</span><h1>Settings</h1><p>Proxy data is never persisted here. Only behavior rules, browser preferences and automation settings are saved.</p></div></section>
    <div className="settings-grid">
      <section className="panel setting-section"><h2>Browser fleet</h2>
        <label>Active browser workspaces<input type="number" min={1} max={100} step={1} value={browserCount} onChange={(e) => setBrowserCount(Math.min(100, Math.max(1, Math.floor(Number(e.target.value) || 1))))} /></label>
        <div className="action-row"><button className="primary" disabled={browserCount === settings.browserCount} onClick={() => void update({ browserCount })}>Apply browser count</button></div>
        <small>Range: 1–100. Increasing creates new isolated workspaces immediately. Decreasing closes and removes the highest-numbered workspaces. Large headed-browser fleets can consume substantial RAM and CPU.</small>
      </section>
      <section className="panel setting-section"><h2>Proxy rotation & assignment</h2>
        <label>Default rotation interval (seconds)<input type="number" min={0} step={1} value={settings.defaultRotationSeconds} onChange={(e) => void update({ defaultRotationSeconds: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /><small>0 disables rotation for new workspace preferences. Every browser can override this from Control Center.</small></label>
        <Toggle checked={settings.autoAssignOnImport} label="Auto-assign after proxy.txt upload" help="The newly uploaded in-memory pool is assigned across the currently active browser workspaces immediately." onChange={(value) => void update({ autoAssignOnImport: value })} />
        <Toggle checked={settings.allowProxyReuse} label="Reuse after full pool cycle" help="One proxy is never shared simultaneously. When enabled, released live proxies become eligible again only after every live proxy has been used once." onChange={(value) => void update({ allowProxyReuse: value })} />
        <div className="info-box"><strong>No proxy cache</strong><p>Proxy endpoints, credentials and assignments are memory-only. Legacy proxy cache files are deleted during startup.</p></div>
      </section>

      <section className="panel setting-section"><h2>Proxy validation rules</h2>
        <Toggle checked={settings.validation.autoStartOnImport} label="Start live validation after proxy.txt upload" help="Begins checking the in-memory pool immediately after every upload and streams results to Proxy Session." onChange={(value) => void update({ validation: { ...settings.validation, autoStartOnImport: value } })} />
        <Toggle checked={settings.validation.assignWorkingImmediately} label="Assign working proxies immediately" help="As soon as one endpoint passes the internet test, give it to the next browser that does not already have a working proxy. Validation continues in the background." onChange={(value) => void update({ validation: { ...settings.validation, assignWorkingImmediately: value } })} />
        <Toggle checked={settings.validation.validateBeforeAssign} label="Require a working validation result for manual assignment" help="When on, manual assignment/rotation only uses proxies that passed the configured test. When off, you can still manually assign unverified endpoints." onChange={(value) => void update({ validation: { ...settings.validation, validateBeforeAssign: value } })} />
        <label>Validation test URL<input value={settings.validation.testUrl} onChange={(e) => void update({ validation: { ...settings.validation, testUrl: e.target.value } })} /></label>
        <label>Timeout (seconds)<input type="number" min={1} max={120} value={settings.validation.timeoutSeconds} onChange={(e) => void update({ validation: { ...settings.validation, timeoutSeconds: Number(e.target.value) } })} /></label>
        <label>Attempts per proxy<input type="number" min={1} max={5} value={settings.validation.attempts} onChange={(e) => void update({ validation: { ...settings.validation, attempts: Number(e.target.value) } })} /></label>
        <label>Concurrent checks<input type="number" min={1} max={16} value={settings.validation.concurrency} onChange={(e) => void update({ validation: { ...settings.validation, concurrency: Number(e.target.value) } })} /></label>
        <label>Maximum accepted latency (ms)<input type="number" min={0} value={settings.validation.maxLatencyMs} onChange={(e) => void update({ validation: { ...settings.validation, maxLatencyMs: Number(e.target.value) } })} /><small>0 disables the latency limit.</small></label>
        <label>IP check URL<input value={settings.ipCheckUrl} onChange={(e) => void update({ ipCheckUrl: e.target.value })} /></label>
      </section>

      <section className="panel setting-section"><h2>Keep alive reading behavior</h2>
        <label>Minimum action interval (seconds)<input type="number" min={3} value={settings.keepAlive.minActionSeconds} onChange={(e) => void update({ keepAlive: { ...settings.keepAlive, minActionSeconds: Number(e.target.value) } })} /></label>
        <label>Maximum action interval (seconds)<input type="number" min={3} value={settings.keepAlive.maxActionSeconds} onChange={(e) => void update({ keepAlive: { ...settings.keepAlive, maxActionSeconds: Number(e.target.value) } })} /></label>
        <label>Chance of following an article link (%)<input type="number" min={0} max={100} value={settings.keepAlive.followLinkChancePercent} onChange={(e) => void update({ keepAlive: { ...settings.keepAlive, followLinkChancePercent: Number(e.target.value) } })} /></label>
        <label>Maximum article hops per launch<input type="number" min={0} max={1000} value={settings.keepAlive.maxArticleHops} onChange={(e) => void update({ keepAlive: { ...settings.keepAlive, maxArticleHops: Number(e.target.value) } })} /></label>
        <small>Range: 0–1000. Set 0 to disable link hopping while leaving scroll activity available.</small>
        <Toggle checked={settings.keepAlive.sameOriginOnly} label="Follow same-site links only" help="Recommended. Keep alive looks only inside article/main content and excludes account, cart, download and sponsored links." onChange={(value) => void update({ keepAlive: { ...settings.keepAlive, sameOriginOnly: value } })} />
      </section>

      <section className="panel setting-section"><div className="section-head-row"><h2>Browser engines</h2><button onClick={() => void refreshEngines()}>Re-detect</button></div>
        <div className="engine-list">{engines.map((engine) => <div className="engine-row" key={engine.engine}><span className={`engine-light ${engine.available ? 'ok' : 'bad'}`} /><div><strong>{engine.label}</strong><small>{engine.detail}</small></div><span className="engine-kind">{engine.bundled ? 'Bundled' : 'System'}</span></div>)}</div>
        <label>Opera executable path<input value={operaPath} placeholder="C:\\Users\\...\\Opera\\opera.exe" onChange={(e) => setOperaPath(e.target.value)} onBlur={async () => { await update({ operaExecutablePath: operaPath }); await refreshEngines(); }} /></label>
        <div className="warning-box"><strong>Safari on Windows</strong><p>The Safari slots use Playwright WebKit. That is the WebKit rendering engine, not Apple’s Safari application. Edge is a supported branded Playwright channel. Opera control uses its installed Chromium executable on a best-effort basis.</p></div>
      </section>

      <section className="panel setting-section"><h2>Application</h2>
        <label>Theme<select value={settings.theme} onChange={(e) => void update({ theme: e.target.value as 'dark' | 'light' | 'system' })}><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></select></label>
        {diagnostics && <div className="diagnostics"><div><span>App</span><b>{diagnostics.appVersion}</b></div><div><span>Electron control UI</span><b>{diagnostics.electronVersion}</b></div><div><span>Playwright</span><b>{diagnostics.playwrightVersion ?? 'Unavailable'}</b></div><div><span>Node</span><b>{diagnostics.nodeVersion}</b></div><div><span>Platform</span><b>{diagnostics.platform} / {diagnostics.arch}</b></div></div>}
      </section>
    </div>
  </main>;
}

function Toggle({ checked, label, help, onChange }: { checked: boolean; label: string; help: string; onChange(value: boolean): void }) {
  return <label className="toggle-row"><span><strong>{label}</strong><small>{help}</small></span><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /></label>;
}
