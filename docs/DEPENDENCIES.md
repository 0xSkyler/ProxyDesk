# Dependency audit

The source checker traverses the runtime import graph from main and preload.
It rejects external production imports and missing local modules. Packaging has
an explicit source/asset allowlist; the archive checker rejects dependency trees,
installer binaries, tests, scripts and unreachable proxy validation modules.

| Shipped reference dependency | Reachability | Decision |
| --- | --- | --- |
| react ^18.3.1 | Already bundled in renderer | Keep bundle and license; no duplicate node_modules |
| react-dom ^18.3.1 | Already bundled in renderer | Keep bundle and license; no duplicate node_modules |
| zustand ^4.5.4 | Already bundled in renderer | Keep bundle and license; no duplicate node_modules |
| https-proxy-agent ^7.0.5 | Only legacy ProxyValidator imports it | No production dependency; legacy code retained in source but excluded from build |
| socks-proxy-agent ^8.0.4 | Only legacy ProxyValidator imports it | No production dependency; legacy code retained in source but excluded from build |
| scheduler, use-sync-external-store | Renderer bundle includes relevant code | License retained; no duplicate dependency tree |
| agent-base, debug, ms, socks, ip-address, smart-buffer, jsbn and nested copies | Transitive unused proxy agents | No production dependency |

Development tools are exact pinned, with package-lock.json and npm ci. The runtime
Electron binary, locales and Chromium resources are retained; deleting platform
resources or changing engine versions is not justified by this audit. Old toolchain
transitive deprecation notices are not disguised as new production dependencies.

Measured size of the final asar is recorded after packaging in the optimization
report. This primarily reduces dependency duplication and build variability;
startup/runtime RSS gains must be measured separately.
