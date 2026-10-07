# Continued Linux reliability validation

The `v0.5.4-linux.1` native release remains unchanged. The follow-up preserves
the recovered renderer bytes, browser count/concurrency, proxy assignment,
keyword order, cycle timing and task restart behavior.

## Demonstrated defects and fixes

Five HTTP 503 fixture responses whose bodies never ended left five live unread
requests after the caller had already reported the status errors. The proxy API
provider now cancels an unused error-response body before throwing the same
HTTP status error. Local streaming-server tests verify that repeated failures
leave zero unfinished error responses and that cancellation failure still
preserves the HTTP error message. The 15-second request timeout and successful
response parsing are unchanged.

Electron 31.2.1 bundles Node 20.15.0. With 100 no-match monitors, the cycle's
AbortSignal had 100 expected sleeping workers and emitted a
MaxListenersExceededWarning at 11 listeners. Stop removed all 100. Current
build-host Node versions may use a different AbortSignal warning default, so
host-only tests can miss this. The cycle signal now has a finite, local allowance
equal to the existing 100-workspace maximum. Tests exercise all 100 monitors,
rotation and Stop, verify every timeout/listener is released, and also run
inside Electron's actual Node runtime. Global warning limits are unchanged.

The desktop launcher previously imported only present environment variables and
called `systemctl start`. It failed a scripted service test with a prior
start-limit-hit state. It now clears absent display variables and resets the
failed unit before an explicit new launch. This retains the five-attempt crash
restart limit and uses the same ProxyDesk task defaults after reopening. See the
upstream [systemctl reset-failed documentation](https://github.com/systemd/systemd/blob/main/man/systemctl.xml).
The service-command test does not substitute for reconnecting a real VPS desktop.
It also covers a never-loaded unit on first launch and propagation of start errors.

The soak harness previously waited for exactly cycle 2 after its manual Rotate
click. A long run could already reach cycle 2 automatically and accept that
earlier completion. It now observes the current settled cycle and waits for a
further cycle. Runs at least 15 seconds longer than the configured interval
assert that automatic rotation completed. Main snapshot, renderer frame and
automation IPC probes have deadlines, so stalled calls report failure. A failed
report is saved in the same JSON output location.

## Reproducible extended comparison

Use a separate test checkout on Ubuntu 24.04 with Node 20 and Xvfb/runtime
libraries as listed in `.github/workflows/build-ubuntu.yml`. The harness creates
temporary instrumented copies and separate profiles. It does not modify the
installed application. After building, recover the unchanged reference once:

```sh
npm ci
npm test
npm run package:linux
npm run recover
node scripts/compare-reference.cjs
mkdir -p .measurements/extended
xvfb-run -a node scripts/benchmark.cjs release-linux/linux-unpacked .recovery/reference .measurements/extended/baseline.json 630 10
xvfb-run -a node scripts/benchmark.cjs release-linux/linux-unpacked . .measurements/extended/optimized.json 630 10
node scripts/compare-benchmarks.cjs .measurements/extended/baseline.json .measurements/extended/optimized.json .measurements/extended/comparison.md
```

630 active seconds exercises the default 600-second timer without changing
application timing. Both processes also exercise manual rotation, Stop and three
pool shrink/recreate rounds. Use 86400 seconds per application for an uninterrupted
24-hour fixture window on a suitably provisioned VPS. A paired run takes over
48 hours. GitHub's current comparison job has a 180-minute ceiling and cannot
complete that duration; use the VPS for that test. Keep the test display running.

The page/proxy fixtures replace external search discovery. They do not validate
live Google results/challenges, real proxy quality, hardware acceleration,
Wayland, desktop reconnection or real site memory use. The 100-monitor test uses
simulated browser calls and is not a claim about 100 native Chromium renderers.
RSS includes caches and can count shared pages in multiple processes. Short
memory growth is not sufficient to establish a leak. When the host's /proc
PID view is inconsistent, renderer/full-process metrics and orphan checks are
explicitly unavailable rather than treated as zero.
