# Ubuntu baseline comparison

Same Electron 31.2.1, Xvfb/software rendering, explicit CI-only no-sandbox flag, isolated temporary profiles, local proxy/page fixtures. Search discovery is substituted in both test apps; public Google interaction is not tested. Reports include probe instrumentation overhead. RSS sums can count shared Chromium pages multiple times. FPS is requestAnimationFrame cadence, not a compositor trace. Listener count covers known owned emitters; timer count covers main-process JS timers, not Chromium internal timers.

| Metric | Original | Optimized | Change |
| --- | ---: | ---: | ---: |
| Startup (ms) | 567.23 | 540.07 | -27.16 |
| Idle main RSS (MiB) | 199.05 | 169.02 | -30.03 |
| Idle UI renderer RSS (MiB) | unavailable | unavailable | unavailable |
| Idle shell RSS sum (MiB) | unavailable | unavailable | unavailable |
| Active full app RSS sum (MiB) | unavailable | unavailable | unavailable |
| Idle summed CPU (%) | unavailable | unavailable | unavailable |
| Active summed CPU (%) | unavailable | unavailable | unavailable |
| Idle main CPU (%) | 0.98 | 1.25 | 0.27 |
| Active main CPU (%) | 3.69 | 3.69 | 0.00 |
| UI rAF cadence under active load (fps) | 61.49 | 61.47 | -0.01 |
| Main event-loop p99 under active load (ms) | 20.93 | 20.84 | -0.09 |
| Active IPC messages/sec | 7.93 | 6.03 | -1.90 |
| Active timers (mean) | 15.77 | 10.25 | -5.53 |
| Active known listeners (mean) | 288.00 | 288.66 | 0.66 |
| Active child processes (mean) | 13.00 | 13.00 | 0.00 |
| Active file descriptors (mean) | unavailable | unavailable | unavailable |
| Main file descriptors (mean) | 290.91 | 287.93 | -2.97 |
| Main RSS change over active window (MiB) | 7.50 | 7.13 | -0.37 |
| Full app RSS change over active window (MiB) | unavailable | unavailable | unavailable |
| Contents after pool recreation | 11.00 | 11.00 | 0.00 |
| Shutdown (ms) | 99.08 | 93.05 | -6.03 |
| Surviving child processes | unavailable | unavailable | unavailable |

Unavailable process metrics mean /proc PID visibility is incomplete or inconsistent; zero-valued inaccessible metrics are not interpreted as memory or CPU savings. Orphan checks validate executable ownership and are unavailable when the PID namespace cannot be observed reliably.

Active duration: baseline 630s, optimized 630s. Browser count: 10. Short runtime checks do not establish 24/7 stability or prove absence of leaks. Longer soak tests and real VPS X11/Wayland graphics validation remain necessary.
