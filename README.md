# ProxyDesk

This repository contains the two Windows builds migrated from the previous working project:

- `desktop/` — ProxyDesk Desktop v0.5.4
- `mobile/` — PocketSEO Mobile v1.0.0

Both use the configured All Working proxy source:

`http://169.58.35.69/data/all-working.txt`

The Desktop package preserves the final v0.5.4 runtime with multi-keyword rotation. The Mobile package preserves the final PocketSEO Mobile runtime.

The migration/build workflow expands the exact packaged runtimes recovered from the final installers, packages both Windows installers, and publishes them together in a GitHub Release.
