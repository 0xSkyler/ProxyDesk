# DOM v0.5.9

Native Electron application with the recovered v0.5.4 UI and task workflow.
The main/preload/shared code is readable recovered JavaScript. The existing
React renderer is a committed production bundle; original JSX/TS and source maps
were not present in the installer. This is a deterministic recovered application
tree, not a claim that the original development sources were recovered.

## Progressive result recognition

DOM watches Google result mutations from a sandboxed preload at document start.
It opens a detected target while HTML, images or other requests are still loading;
full-page completion and the **Ready** label are not prerequisites. Browser cards
show **Waiting for results**, **Scanning results** and **Opening target**.

One shared recognizer checks title links inside or around headings, plain domain
labels, accessible/mobile links, Google redirects, encoded destinations and AMP
links. Results outside `#rso` and links styled with `display:contents` remain
eligible. Keyword overlap ranks candidates rather than requiring every query
word in the title. Ads, hidden results, lookalike domains and domain mentions in
another site's snippet are excluded.

A verified publisher label lets DOM activate its own Google title when the
destination resolves on click. The actual landing domain must match the target
before Keep Alive starts; DOM never constructs an article URL from a label.
If Google replaces a detected title, DOM activates the replacement element.
Visible publisher/title text holds the current page while its link hydrates.

A positive match clicks immediately. Before declaring the target absent, DOM
allows at least six seconds after initial results, requires two seconds without
result changes and checks for rendered pagination or a full result set. Busy,
unrecognized or incomplete pages are retried without advancing. These negative
checks do not wait for full network loading or delay a visible match.
Recognition uses DOM text and links without adding an OCR model.

Native Electron fixtures cover 32 layouts and nine opening/pagination cases,
including targets appended after DOMContentLoaded, click-resolved destinations,
replaced links, loads that never complete, offscreen links and cancellation. Run
`node scripts/smoke-google-recognition.cjs` from a graphical desktop (or under
Xvfb). Pass a packaged executable to validate the shipped preload and recognizer.

## Browser startup

Increasing the browser count now prepares new workspaces two at a time rather
than starting every Chromium renderer and storage context together. The dashboard
shows **Preparing browsers: 12 / 20**, and **Stop SEO Tracker** cancels preparation.
Native initialization has a 15-second deadline per browser and a 60-second deadline
for the whole preparation. A failed startup reports the cause and allows another
Start instead of remaining at **Starting** indefinitely.

Each new workspace starts with an empty memory partition. Recreated IDs reuse a
partition only after its cleanup succeeds, keeping memory use bounded during
normal resizing. DOM skips nonexistent legacy storage and bounds any migration
cleanup. The two-worker limit applies only to preparation; all selected browsers
still run their page monitoring, target clicks and Keep Alive concurrently.

## Simultaneous keywords

Enter comma-separated keywords and select at least one browser for each keyword.
Every cycle assigns the keywords across the existing browser fleet in order and
runs them at the same time. For example, three browsers with `first, second`
run `first`, `second`, and `first`. Rotation keeps the same assignment and only
refreshes the proxies and browser sessions. Google challenge handling, Keep Alive,
proxy fetching and browser controls retain the recovered workflow.

## Proxy sources

Choose **All Working API** or **ProxyScrape Free API** before starting. DOM shows
the selected provider's URL in an editable field, so a replacement endpoint can
be pasted without rebuilding the app. ProxyScrape Free is the default. Changing
the provider is disabled while a run is active; stop the tracker first.

Public lists can contain dead proxies. DOM no longer marks an assigned proxy as
Ready merely because `about:blank` loaded. The card stays at **Proxy assigned**
until a real page reaches DOM readiness, and failed or timed-out Google navigation
is reported as **Proxy failed**. Each manual or scheduled rotation advances to a
new portion of a stable provider list instead of reusing its first entries.

## Build and run

### Windows download

[Download DOM v0.5.9 for Windows (x64 installer)](https://github.com/0xSkyler/ProxyDesk/releases/download/v0.5.9/DOM-v0.5.9-Windows-x64-Setup.exe)

The Windows workflow builds this installer on a native GitHub Windows runner,
installs it silently into a clean directory, opens both the unpacked and installed
applications, verifies growth from 10 to 20 browsers, shrink/regrowth, startup
cancellation and recovery, result recognition and opening before page completion,
the DOM UI and input validation, and publishes a SHA-256
checksum with the release. The installer is not Authenticode-signed, so Windows
SmartScreen may ask for confirmation on first launch.

Build locally on Windows with Node 20:

```powershell
npm ci
npm test
npm run package:windows
```

Output: `release-windows/DOM-v0.5.9-Windows-x64-Setup.exe`.

### Linux build

Ubuntu 24.04 x64, Node 20:

```sh
npm ci
npm test
npm run check
npm start
npm run package:linux
```

Builds use tracked `src/` and the lockfile. Output: `release-linux/*.AppImage` and
`*.tar.gz`. No Windows installer extraction occurs in normal builds. All npm
packages are development tools; the runtime import graph uses only Electron and
Node built-ins. React/React DOM/Zustand are already in the existing renderer.
Their license files are retained in `third-party/`.

AppImage:

```sh
chmod +x DOM-v0.5.9-linux-x86_64.AppImage
./DOM-v0.5.9-linux-x86_64.AppImage
```

On a machine without FUSE:

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ./DOM-v0.5.9-linux-x86_64.AppImage
```

Run as a regular desktop user in an existing graphical session. X11/Wayland,
GTK, NSS, ALSA and GBM libraries are required. The app is graphical; disconnecting
SSH is different from ending its display session. A VPS needs a persistent
logged-in desktop or a separately managed X server. Do not run production as root
or permanently disable Chromium sandboxing. Ubuntu user-namespace/AppArmor
configuration differs by host: configure the distribution's supported sandbox
method, or use an extracted installation with appropriately installed Chromium
sandbox helper. CI's `--no-sandbox` flag is isolated to test runners.

If a VPS graphics driver fails, opt into software rendering:

```sh
DOM_SOFTWARE_RENDERING=1 ./DOM-v0.5.9-linux-x86_64.AppImage
```

Default rendering and all controls are unchanged. Do not blanket-disable GPU,
site isolation, web security, sandboxing, or background throttling to chase a
benchmark score. Only new workspace preparation is batched; there is no visit queue.
`NODE_ENV=development` explicitly selects the optional localhost:5173 dev server;
ordinary source runs load the committed renderer assets directly.

## Install the verified release on a VPS

Use Ubuntu 24.04 x64 with a persistent desktop session. Open a terminal inside
that desktop (for example through RustDesk), as its regular user with sudo:

```sh
sudo apt-get update && sudo apt-get install -y curl
curl --fail --location --retry 3 https://raw.githubusercontent.com/0xSkyler/ProxyDesk/v0.5.9-linux.1/deploy/install-ubuntu.sh -o /tmp/dom-install.sh && bash /tmp/dom-install.sh --software-rendering
```

The installer verifies the release SHA-256, installs the tar distribution under
root-owned `/opt/dom`, configures its sandbox helper and Ubuntu AppArmor
namespace permission, then launches a systemd user service. The service owns the
whole process group, allows 15 seconds for shutdown and restarts failed launches.
Desktop login starts the service; closing its window normally stops it. It does
not require Node/npm, FUSE or a permanent SSH connection. Software rendering is
selected for this VPS command; omit that option to use normal GPU rendering.
Reopening through the desktop launcher imports the current display credentials,
clears absent old display variables and resets a failed start limit before retrying.
The crash restart rate remains bounded while an unavailable display stays unavailable.

Enter the existing settings/keywords and click Start in the application. Keep the
desktop session active. App restarts preserve the reference behavior: tasks do
not restart automatically, and its input settings return to the original defaults.

```sh
systemctl --user status dom
journalctl --user -u dom -n 50 --no-pager
systemctl --user stop dom
```

Main-branch CI publishes the immutable `v0.5.9-linux.1` release only after native
build, packaged smoke tests and original/optimized fixture comparison succeed.
The original Windows release is retained. The installer checks host prerequisites;
the target VPS's display, sandbox configuration and live proxy/search behavior
still need validation there.

## Reliability changes

- Wait for owned work during quit, close views before session cleanup, and bound
  shutdown to 10 seconds. SIGTERM/SIGINT use the same cleanup path.
- Dispose the global login listener, IPC handlers/listeners and Keep Alive driver.
- Invalidate stale Start completions and wake cancelled monitor sleeps.
- Cancel in-page Keep Alive timers/animation frames and the Google live observer
  on Stop/rotation/disposal; preserve scroll durations and link-selection rules.
- Release the losing timeout in successful DOM races.
- Cancel unread proxy API error responses so streamed failures release their
  requests while preserving the same HTTP error messages and timeout.
- Close pooled session connections when proxy routing changes.
- Coalesce only bounds updates per animation frame and skip identical native
  geometry/state writes. Status channels, payloads and renderer UI remain intact.
- Rotate each log at 5 MiB with three backups; flush during normal shutdown. The
  pending log queue is bounded to 1 MiB / 4096 entries. Disk failures fall back to
  existing console output. Under sustained disk backpressure, omitted file
  entries are reported; normal log messages and secret redaction are preserved.

## Baseline and validation

See `docs/BASELINE.md` for the behavior/ownership checklist and measurement gaps.
`docs/recovery-manifest.json` records the original installer and source hashes.
The original installer remains unchanged. `npm run recover` verifies it and
extracts a separate `.recovery/reference` tree; it refuses to overwrite a tree.

The CI workflow is prepared to build and check the production archive, open the actual packaged renderer,
exercises Start/Stop/rotation, recreates the workspace pool and checks child
process exit. A separate comparison job measures original and optimized code
with the same Electron runtime and local HTTP proxy/page fixtures. Original
search discovery is replaced only inside the test process to avoid public search
traffic; the Google selectors/click/challenge workflow still needs an authorized
real-world regression check. Software rendering results do not establish real
GPU/Wayland performance. Test instrumentation is never shipped in the app.

Manual workflow inputs accept a longer active soak (e.g. 3600 seconds) and 1–100
fixture browsers. Both benchmarks execute sequentially, so allow twice the input
duration plus build/cleanup overhead; the comparison job has a 180-minute ceiling.
Repeat on the intended VPS with its RAM/vCPU/display/proxy characteristics.
A short run cannot establish leak-free 24/7 operation.
The harness checks automatic rotation when a run exceeds the configured interval,
then checks a further manual rotation. Probe/IPC calls have deadlines so a frozen
renderer produces a failed report. See [sustained testing](docs/SUSTAINED_TESTING.md).

## Remaining constraints

Electron 31.2.1 remains pinned to the existing Linux behavioral baseline. It is an
old runtime: upgrading Electron/Chromium should be a separate compatibility task
with proxy, BrowserView, rendering and long-session regression evidence. BrowserView
is retained to avoid an unverified UI/runtime migration. Chromium browser content
is the dominant cost at high concurrency; eliminating bundled duplicate npm
packages will not make 100 real pages inexpensive. No scheduled cookie/cache
purge, scheduled task restart, browser pooling or concurrency reduction is added.

The shipped reference has no persistent settings / Save Settings control.
This optimization preserves its defaults and React input behavior; it does not
add a new settings workflow.
