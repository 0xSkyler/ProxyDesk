# Linux optimization review

Published for review in [PR #3](https://github.com/0xSkyler/ProxyDesk/pull/3) after
explicit authorization to push and deploy. Main-branch CI publishes a separate
`v0.5.4-linux.1` Linux release after all required jobs pass; the existing Windows
release is retained. See the README for the checksum-verified VPS installer.

## Changes

The Windows installer remains an unchanged behavioral reference. Normal Linux
builds now use tracked recovered JavaScript and the original renderer bundle,
exact tool versions, npm ci and an explicit package allowlist. The original
TypeScript/JSX sources and source maps were absent; this is a deterministic
recovered tree. The source graph has 17 reachable modules and no external
production npm dependencies. Duplicated React and unused proxy-agent dependency
trees are excluded; renderer licenses are retained.

Lifecycle fixes cover Stop during preparation, cancellation of pending monitor
sleeps and renderer animations, releasing timeout race timers, closing old proxy
connections, ordered routing updates within each browser, explicit BrowserView
closure, timer/login/IPC disposal, graceful SIGTERM/SIGINT, awaited/bounded quit,
log rotation/backpressure/error handling, and coalesced native bounds updates.

No task concurrency limit, task queue, selector rewrite, keyword change, proxy
validation, extra persistent settings, or new UI workflow is introduced. The
renderer HTML/CSS/JS is byte-identical to the reference. Software rendering is an
opt-in launch environment setting; normal GPU behavior is retained.

## Verification

- 22 regression tests passed, including lifecycle races and stalled storage.
- Eight original session/Google helper outputs match the recovered reference.
- Native AppImage and tar.gz packaging passed.
- Production archive check passed: no dependency tree, legacy validator, tests,
  scripts, installer, or stale application code. Each packaged JS/CSS/HTML file
  matches its current source bytes.
- Both the unmodified production AppImage and unpacked executable loaded the
  renderer, created 10 workspaces, validated blank inputs and closed cleanly.
- Paired original/optimized runs use 10 local HTTP proxy fixtures and 15 seconds
  of active page work plus startup, stop/rotation and pool recreation checks.
  See [comparison.md](measurements/comparison.md) and its raw JSON reports.
- Artifact byte sizes and SHA-256 hashes are in
  [artifacts.json](measurements/artifacts.json).

The application asar fell from 5,914,061 bytes to 342,390 bytes, a 94.2% reduction
in application archive size. This is not a 94.2% reduction in the whole Electron
installation or its runtime RAM. Chromium remains the dominant cost. Main RSS
was similar in short runs; no dramatic memory improvement is claimed.

## Limits and remaining checks

The committed local measurement files use the initial schema-1 harness. Ubuntu
CI exposed that its Promise-returning state predicates could complete before the
IPC state condition was true. Schema 2 explicitly awaits and polls each state
transition, including full proxy assignment before Stop/recreation. Use the
release's paired schema-2 JSON and comparison for final validation; the initial
local reports remain historical exploratory measurements.

The fixture harness replaces external search discovery inside both test apps.
Actual Google detection/click/challenge operation was not exercised against live
search. Its eight exported helpers are unchanged and original browser interaction
logic is retained apart from timer ownership/cancellation.

The local /proc PID view is inconsistent with Chromium process IDs. Renderer and
full-tree RSS/CPU/FD metrics and orphan observations are explicitly unavailable;
they are not treated as zero or as evidence of improvement. The prepared Ubuntu
CI comparison runs outside this particular sandbox and can fill those gaps.

Short software-rendered Xvfb runs do not establish 24/7 stability, prove no leaks,
validate hardware acceleration or validate every Ubuntu VPS desktop/Wayland
configuration. Manual workflow inputs support longer fixture soaks and 1–100
browsers. Before replacing a production build, run that comparison and a longer
soak on the intended VPS, including minimize/display reconnect, crashes,
unreachable proxies and disk-pressure scenarios.

Electron 31.2.1 is retained for behavioral compatibility. Its age is a material
runtime limitation; a supported Electron upgrade needs separate compatibility
validation. Save Settings and persistent settings are absent from the supplied
reference; preserving it does not add them.
