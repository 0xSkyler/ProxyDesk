# ProxyDesk v0.5.4 for Linux

Native Electron application with the recovered v0.5.4 UI and task workflow.
The main/preload/shared code is readable recovered JavaScript. The existing
React renderer is a committed production bundle; original JSX/TS and source maps
were not present in the installer. This is a deterministic recovered application
tree, not a claim that the original development sources were recovered.

## Build and run

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
chmod +x ProxyDesk-v0.5.4-linux-x86_64.AppImage
./ProxyDesk-v0.5.4-linux-x86_64.AppImage
```

On a machine without FUSE:

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ./ProxyDesk-v0.5.4-linux-x86_64.AppImage
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
PROXYDESK_SOFTWARE_RENDERING=1 ./ProxyDesk-v0.5.4-linux-x86_64.AppImage
```

Default rendering and all controls are unchanged. Do not blanket-disable GPU,
site isolation, web security, sandboxing, or background throttling to chase a
benchmark score. No Chromium concurrency limit or visit queue is introduced.
`NODE_ENV=development` explicitly selects the optional localhost:5173 dev server;
ordinary source runs load the committed renderer assets directly.

## Install the verified release on a VPS

Use Ubuntu 24.04 x64 with a persistent desktop session. Open a terminal inside
that desktop (for example through RustDesk), as its regular user with sudo:

```sh
sudo apt-get update && sudo apt-get install -y curl
curl --fail --location --retry 3 https://raw.githubusercontent.com/0xSkyler/ProxyDesk/v0.5.4-linux.2/deploy/install-ubuntu.sh -o /tmp/proxydesk-install.sh && bash /tmp/proxydesk-install.sh --software-rendering
```

The installer verifies the release SHA-256, installs the tar distribution under
root-owned `/opt/proxydesk`, configures its sandbox helper and Ubuntu AppArmor
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
systemctl --user status proxydesk
journalctl --user -u proxydesk -n 50 --no-pager
systemctl --user stop proxydesk
```

Main-branch CI publishes the immutable `v0.5.4-linux.2` release only after native
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

## Supplied ProxyDesk SEO 4.x workstation

The user-supplied TypeScript/React workstation with simultaneous multi-keyword tracking is in [`seo-workstation/`](seo-workstation/README.md). Its Windows build is separate from this v0.5.4 Linux application. Run its commands from that folder.
