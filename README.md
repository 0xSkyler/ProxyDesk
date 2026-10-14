# DOM v0.5.20

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
labels, accessible/mobile links, Google redirects (including `/goto`), encoded
destinations and AMP links. Results outside `#rso` and links styled with `display:contents` remain
eligible. Verified target links can also supply a descriptive title without a
heading/citation structure, and target result modules beside named search roots
are considered. Friendly publisher names can use their `data-dtld` metadata.
`aria-hidden` affects accessibility and does not reject a visually rendered title;
CSS-hidden content remains excluded. Combined publisher/breadcrumb/title links are read by the visible title text and typography even without heading tags. Ad checks stay inside the result module, so unrelated Sponsored labels above it do not suppress an organic title. Links whose href is supplied during activation require a verified publisher and title. Keyword overlap ranks candidates rather than requiring every query
word in the title. Ads, hidden results, lookalike domains and domain mentions in
another site's snippet are excluded.

A verified publisher label lets DOM activate its own Google title when the
destination resolves on click. The actual landing domain must match the target
before Keep Alive starts; DOM never constructs an article URL from a label.
Google `/goto` links decode a valid HTTP(S) destination from `q` or `url`; opaque
routes activate their own verified title and let Google resolve the destination.
DOM opens results through their title links. If a click is ignored or does not
reach the target, DOM reports the failure and retries the page; it does not load
the captured article URL directly as a fallback. If Google replaces a detected
title, DOM activates the replacement element.
Visible publisher/title text holds the current page while its link hydrates.

A positive match clicks immediately. Before declaring the target absent, DOM
allows at least six seconds after initial results, requires two seconds without
result changes and checks for rendered pagination or a full result set. Busy,
unrecognized or incomplete pages are retried without advancing. These negative
checks do not wait for full network loading or delay a visible match.
Unfinished observations keep their document and live observer, then resume within
250 ms instead of sleeping for 30 seconds and reloading. This also preserves
publisher/title text while its anchor arrives after the initial observation.
Scan errors are reported in SEO results instead of silently leaving a browser
at Waiting/Scanning. Unmatched scans report counts of target links rejected as invisible, navigation/disabled, missing titles or sponsored in the SEO results Status message.
Recognition uses DOM text and links without adding an OCR model.

The main process requests scanner state after navigation and retries once per
second while monitoring. Repeated requests preserve the existing observer and
replay a fresh match rather than rebuilding it. Main-frame messages use Electron's
native process/routing identity, with navigation, query and run-token checks still
required. This recovers a lost startup handshake or final match report without
waiting for Ready or reloading the current results. Hover over a clipped SEO
results Status cell to read its complete diagnostic message.

Native Electron fixtures cover 76 layouts and 23 successful opening/pagination
cases, including targets appended after DOMContentLoaded, click-resolved destinations,
replaced links, visible accessibility copies, headingless titles, results/anchors
arriving after 13 seconds, loads that never complete, target responses whose first
byte arrives after five seconds, offscreen links and cancellation.
An ignored-click case must report failure without direct-URL navigation. Run
`node scripts/smoke-google-recognition.cjs` from a graphical desktop (or under
Xvfb). The same check also opens targets in 50 concurrent browsers mixing direct,
`/url` and `/goto` title links with two keywords, drops every startup handshake
and keeps all Google responses unfinished.
Pass a packaged executable to validate the shipped preload and recognizer.

A publisher and title could be recognized without selecting their linked heading
when Google nested the title inside a separate module. The publisher-first pass
now nominates that heading through the normal URL, visibility, ad and click checks.
Separate decorative modules can join only inside one explicit owning result,
with one visible linked title and no conflicting publisher. Hidden auxiliary
headings and dotted breadcrumb filenames cannot displace the real title.

DOM 0.5.13 rejected a visible, associated title with the diagnostic
`Title link: unsupported-route (a, /goto)`. DOM 0.5.14 added support for that Google
result route, decoding supported `q`/`url` destinations and clicking opaque title
links through their own Google activation handler. DOM 0.5.13 reproduces this
exact rejection in a native fixture. The repaired tests follow the actual `/goto`
redirect or handler and open the target while Google parsing and the AI Overview
remain unfinished. Ready, full load and another observation cycle are not required.
An ignored click remains a reported click failure instead of becoming a direct
article visit. If an associated title remains unusable, its reason, element tag
and route appear in the Status diagnostic.

DOM 0.5.14 could label an actual title click as failed when the target committed
between its last URL poll and deadline, or needed more than 3.5 seconds to commit.
DOM 0.5.15 allows up to 8.5 seconds to verify the target landing and checks the
URL again before reporting failure. This extends confirmation after the click;
the first click still starts immediately when the result appears, and neither
Ready nor full-page loading is required. The delayed-first-byte native case
verifies that a five-second target response opens successfully. An ignored click
still fails without direct-URL navigation.

The native result click is observed through its navigation-start event. If the
article is already loading but its URL has not committed, the preload fallback
does not activate the title a second time. A missing or ignored native activation
still uses the existing preload path, and target landing is verified before Keep Alive.

## Google prompts and per-cycle cache cleanup

Each browser automatically clicks Google’s **Accept all** button when its cookie
consent dialog or separate consent page appears. It also clicks **Continue** on
Google’s request-verification screen once the control is enabled, including link-style
Continue controls. Native mouse clicks support trusted-event handlers; if an enabled
prompt remains visible, DOM retries until it dismisses or navigation starts. Disabled buttons
remain untouched until enabled; CAPTCHA controls and unrelated website buttons
remain available for manual interaction. Both handlers run in each browser’s
preload while the page is still loading. The same search resumes after dismissal,
and its matching result is opened through the actual result-title click.

Before each proxy cycle, DOM stops outgoing browser work, releases its page through
a local blank document, and clears every selected browser’s HTTP cache, renderer
memory cache and Cache Storage. Healthy proxy routing remains assigned throughout.
Cleanup runs two browsers at a time, finishes before proxy fetching/searching starts, and retains cookies so
Google’s accepted consent choice survives. A failed cleanup reports an error
instead of starting searches with a cache that could be cleared late. Stop cancels
the wait immediately.

`node scripts/smoke-google-prompts.cjs` exercises late cookie overlays, delayed
Continue buttons and links, trusted mouse events, late handlers, slow redirects,
sequential prompts, a separate consent redirect, independent
browser sessions, and native HTTP/Cache Storage cleanup. It also checks that
Reject all, unrelated Continue buttons, and CAPTCHA controls are not activated.
Pass a packaged executable to run against the installed application’s code.

## Keep Alive scrolling

Keep Alive spends forty seconds on each article, scrolling from the top to the
bottom and back to the top, then clicking an internal article link. The same
sequence repeats on the next article. Brief holds at both ends let native smooth
scrolling cover the whole page. Its height is refreshed to include lazy content.

Actions run in bounded ten-second chunks that retain the page clock and resume
promptly, keeping Stop, cancellation and the watchdog responsive. Each new
article starts a new forty-second interval. Google result-title clicks remain immediate.

Run `node scripts/smoke-keep-alive-reading.cjs` from a graphical desktop, optionally
passing a packaged executable. The native check verifies two forty-second page
visits, downward and upward scrolling to both ends, actual internal link clicks,
and cancellation on the next page.

## Browser startup

Proxy-metadata updates preserve edited tracker inputs. They do not restore the
previous run's browser count, keywords or timing just before Start.

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
The first cycle distributes keywords across the browser fleet in order and runs
them simultaneously. Each subsequent cycle moves every browser to the next keyword
and wraps at the end of the list. For example, three browsers with `first, second`
run `first, second, first`, then `second, first, second`.

A proxy that reached Google and had no connection failure during the outgoing cycle
stays assigned to its browser. Only failed or unproven connections receive fresh
proxies. Retained endpoints cannot be assigned to another browser, including under
another proxy protocol, and the just-failed endpoints are excluded from replacements.
Google consent/challenge responses prove reachability; a challenge is not classified
as a dead transport connection. No separate Google validation request is added.

All selected browsers still clear their caches before each cycle and start a fresh
search for their next keyword. Healthy browsers keep their native proxy routing and
do not wait for the replacement API. An all-healthy cycle skips the API request.
The status bar shows **Kept** and **New** counts. `node scripts/smoke-proxy-rotation.cjs`
checks three native cycles, a failed slot, unchanged healthy routing/connections,
keyword rotation, all-healthy API skipping and per-cycle cache cleanup.

## Proxy sources

Choose **All Working API** or **ProxyScrape Free API** before starting. DOM shows
the selected provider's URL in an editable field, so a replacement endpoint can
be pasted without rebuilding the app. ProxyScrape Free is the default. Changing
the provider is disabled while a run is active; stop the tracker first.

Public lists can contain dead proxies. DOM no longer marks an assigned proxy as
Ready merely because `about:blank` loaded. The card stays at **Proxy assigned**
until a real page reaches DOM readiness, and failed or timed-out Google navigation
is reported as **Proxy failed**. When replacements are needed, a manual or scheduled cycle advances through the
provider list while reserving retained endpoints and excluding just-failed ones.

## Build and run

### Windows download

[Download DOM v0.5.20 for Windows (x64 installer)](https://github.com/0xSkyler/ProxyDesk/releases/download/v0.5.20/DOM-v0.5.20-Windows-x64-Setup.exe)

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

Output: `release-windows/DOM-v0.5.20-Windows-x64-Setup.exe`.

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
chmod +x DOM-v0.5.20-linux-x86_64.AppImage
./DOM-v0.5.20-linux-x86_64.AppImage
```

On a machine without FUSE:

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ./DOM-v0.5.20-linux-x86_64.AppImage
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
DOM_SOFTWARE_RENDERING=1 ./DOM-v0.5.20-linux-x86_64.AppImage
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
curl --fail --location --retry 3 https://raw.githubusercontent.com/0xSkyler/ProxyDesk/v0.5.20-linux.1/deploy/install-ubuntu.sh -o /tmp/dom-install.sh && bash /tmp/dom-install.sh --software-rendering
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

Main-branch or `v0.5.20` tag CI publishes the immutable `v0.5.20-linux.1` release
only after native build, packaged smoke tests and original/optimized fixture
comparison succeed. Windows and Ubuntu tag workflows publish the same tested
application source using their workflow tokens.
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
packages will not make 100 real pages inexpensive. Browser caches clear before
each proxy cycle, while cookies retain Google’s consent choice. Scheduled task
restart, browser pooling or concurrency reduction is not added.

The shipped reference has no persistent settings / Save Settings control.
This optimization preserves its defaults and React input behavior; it does not
add a new settings workflow.
