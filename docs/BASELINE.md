# v0.5.4 baseline, captured before source edits

Reference commit: 32194fdd8236a0486209b61f734f52530800c73a.
Installer SHA-256: 01f888ad8fd8d5f9e299504ba579d31c58fb9fd43d6b6efa2cd87ea5c81cdbc1.
`recovery-manifest.json` records every original application file hash.
The installer is a portable archive in this checkout: extraction directly yields
resources/app.asar. Recovery must also accept the app-64.7z layout described in
older CI. There are no original TS/JSX sources or source maps in that archive.

## Behavioral checklist and owners

| Check | Reference behavior | Owner | Verification |
| --- | --- | --- | --- |
| Startup | Create shell, initialize 10 isolated blank BrowserViews, register IPC before React, show window | main/main.js | Source inspected; runtime CI |
| UI load | Existing React bundle, styles, controls, 1600x1000 shell | renderer + main | Original bundle retained; runtime CI |
| Settings load/save | Defaults: 10 browsers, 600s rotation, 20 pages. Input fields live in React state. No Save Settings control, file store or localStorage persistence exists | renderer | Source inspected; preserve absence of persistence |
| Start | Validate input, immediately publish running state, prepare 1–100 workspaces, start interval and first cycle | SeoAutomationManager | Regression tests |
| Stop | Invalidate generation, abort proxy fetch, cancel measurement, disable Keep Alive; retain workspaces and visible pages | SeoAutomationManager + BrowserManager | Regression tests |
| Tasks | One monitor per assigned browser, concurrent, no visit queue | SeoAutomationManager | Source inspection; fixture tests |
| Spawn | Chromium children owned by Electron BrowserViews; no child_process spawn or external browser binary | BrowserManager | Source inspection; runtime CI |
| Terminate | Browser count decrease clears session, detaches view, attempts optional undocumented destroy; quit starts asynchronous cleanup without awaiting it | BrowserManager + main | Defect tests; runtime CI |
| Cycles | Keywords split on comma, one keyword per cycle in order; fresh API fetch, endpoint dedup, exclusive assignment; fewer proxies leave slots unassigned | automation + ProxyManager | Fixture tests |
| Timers | Cycle interval 30–86400s; one 500ms Keep Alive driver; observation/retry sleeps; renderer DOM observer interval | automation + BrowserManager + renderer | Instrumented runtime CI |
| Proxy | Fixed all-working.txt endpoint; GET timeout 15s; no validation/scoring; setProxy and reload | networking + BrowserManager | Fixture tests |
| Status | Full snapshots through existing IPC channels; last result per browser in Zustand | main IPC + preload + renderer | Fixture tests + runtime CI |
| Logs | Append-only application/browser/proxy logs, secret redaction, console mirror; no rotation, backpressure handling, error handler or flush | Logger | Regression tests |
| Errors | Main-frame load failures update status; crash reload up to 3 attempts; challenges pause; Keep Alive timeout/watchdog retries | BrowserManager | Preserve navigation/interaction algorithms |
| Close | window-all-closed quits on Linux; before-quit fires stop and unawaited destroyAll | main | Runtime CI and lifecycle tests |
| Restart | Fresh ephemeral browser sessions; settings return to defaults | main + session + renderer | Runtime CI |

## Measurements before edits

Recovered application JS/CSS/HTML tree: 420 KiB (filesystem allocation).
Recovered node_modules: 6.1 MiB (filesystem allocation).
Runtime imports reachable from main and preload: Electron and Node built-ins only.
React, React DOM and Zustand are already bundled in the renderer. Proxy agent
packages are imported only by an unreachable legacy validator.
Startup allocates 10 blank browser workspaces. Keep Alive driver starts even idle.
Login handler has no disposer. destroyAll does not clear its interval.

Initial attempts could not initialize X11: the sandbox denies Unix display
sockets. A TCP Xvfb display and locally extracted runtime libraries subsequently
allowed both applications to run without changing execution permissions.

`measurements/baseline.json`, `measurements/optimized.json`, and
`measurements/comparison.md` contain a short, paired 10-browser fixture run.
Startup, main RSS/CPU, frame cadence, event-loop delay, IPC rate, timer/listener
counts, and main file descriptors are collected. Chromium process RSS/CPU,
full-tree file descriptors and orphan observations are unavailable if /proc
visibility is inconsistent; the probe explicitly detects this. Raw zero values
from inaccessible process metrics are not improvements. Long-term memory growth
and 24/7 stability remain unverified. The original app is hash-verified, untouched
v0.5.4; measurements are of that reference, even when collected after source edits.

The CI benchmark runs the same comparison on an ordinary Ubuntu runner, using
local fixtures rather than public search traffic. No original defaults, task
concurrency, keyword order, or selector algorithms are altered by the build.
