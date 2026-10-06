# Ubuntu baseline comparison

Same Electron 31.2.1, Xvfb/software rendering, explicit CI-only no-sandbox flag, isolated temporary profiles, local proxy/page fixtures. Search discovery is substituted in both test apps; public Google interaction is not tested. Reports include probe instrumentation overhead. RSS sums can count shared Chromium pages multiple times. FPS is requestAnimationFrame cadence, not a compositor trace. Listener count covers known owned emitters; timer count covers main-process JS timers, not Chromium internal timers.

| Metric | Original | Optimized | Change |
| --- | ---: | ---: | ---: |
| Startup (ms) | 654.87 | 688.52 | 33.65 |
| Idle main RSS (MiB) | 199.21 | 197.95 | -1.26 |
| Idle UI renderer RSS (MiB) | unavailable | unavailable | unavailable |
| Idle shell RSS sum (MiB) | unavailable | unavailable | unavailable |
| Active full app RSS sum (MiB) | unavailable | unavailable | unavailable |
| Idle summed CPU (%) | unavailable | unavailable | unavailable |
| Active summed CPU (%) | unavailable | unavailable | unavailable |
| Idle main CPU (%) | 1.55 | 1.83 | 0.28 |
| Active main CPU (%) | 6.45 | 8.20 | 1.75 |
| UI rAF cadence under active load (fps) | 61.13 | 61.17 | 0.03 |
| Main event-loop p99 under active load (ms) | 23.97 | 24.64 | 0.67 |
| Active IPC messages/sec | 4.99 | 3.75 | -1.25 |
| Active timers (mean) | 14.75 | 12.25 | -2.50 |
| Active known listeners (mean) | 288.00 | 288.00 | 0.00 |
| Active child processes (mean) | 13.00 | 13.00 | 0.00 |
| Active file descriptors (mean) | unavailable | unavailable | unavailable |
| Main file descriptors (mean) | 270.25 | 268.25 | -2.00 |
| Main RSS change over active window (MiB) | 0.49 | 0.74 | 0.25 |
| Full app RSS change over active window (MiB) | unavailable | unavailable | unavailable |
| Contents after pool recreation | 11.00 | 11.00 | 0.00 |
| Shutdown (ms) | 111.43 | 120.59 | 9.16 |
| Surviving child processes | unavailable | unavailable | unavailable |

Unavailable process metrics mean /proc PID visibility is incomplete or inconsistent; zero-valued inaccessible metrics are not interpreted as memory or CPU savings. Orphan checks validate executable ownership and are unavailable when the PID namespace cannot be observed reliably.

Active duration: baseline 15s, optimized 15s. Browser count: 10. Short runtime checks do not establish 24/7 stability or prove absence of leaks. Longer soak tests and real VPS X11/Wayland graphics validation remain necessary.
