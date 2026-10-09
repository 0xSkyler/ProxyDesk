import { CentralControlPanel } from './CentralControlPanel';
import { WorkspaceCards } from './WorkspaceCards';

export function BrowserGrid() {
  return <main className="content">
    <CentralControlPanel />
    <div className="section-label browser-wall-heading">
      <div><h2>In-app browser wall</h2><p>All active engines run off-screen and their live mobile viewports appear here. Scroll the app to monitor every browser without separate windows popping up.</p></div>
    </div>
    <WorkspaceCards />
  </main>;
}
