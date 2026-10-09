# ProxyDesk 3.7.0 migration notes

- Live browser cards are now interactive: click, pointer move/down/up, wheel scroll, keyboard typing, paste, Tab/Enter/Backspace/arrows and shortcuts are relayed to the real Playwright page.
- Click a viewport to enter interaction mode; **Esc** or blur releases input so ProxyDesk itself can scroll normally.
- Added an editable per-browser address bar with **Go**.
- Preview screenshots now use Playwright CSS-pixel scale and `object-fit: contain` so pointer coordinates map correctly to the 390×844 mobile viewport.
- The active card refreshes at ~450 ms while passive visible cards keep the lower-frequency preview polling.
- New popup/tab pages opened by user clicks are adopted as the active workspace page.
- Added shared coordinate/keyboard mapping tests.
- No new npm dependencies.

# ProxyDesk 3.6.1 migration notes

- Added a persistent saved website-link pool to Control Center.
- Added random distribution to selected browsers. Each link is used once per random cycle before repeats are needed.
- Random distribution works with the dynamic 1–100 browser fleet and uses the same central navigation pipeline as manual routing.
- Increased Keep Alive maximum article hops from 100 to 1000; range is now 0–1000.
- No new npm dependencies.

# ProxyDesk 3.5.1

- Fixed browser-wall cards that could stay on **Connecting live view…** even while the workspace was READY and Keep Alive was running.
- Added an immediate preview request independent of IntersectionObserver.
- Added 5-second screenshot timeouts and PNG fallback capture.
- **Refresh view** now forces a capture immediately.
- Live-preview failures are logged and surfaced in the card.
- No dependency changes from 3.5.0.

# ProxyDesk 3.5.0 — In-App Browser Wall

## What changed

- Browser processes no longer open as separate native windows during normal operation.
- Chromium, Firefox, WebKit, Edge and Opera-class workspaces now run off-screen through Playwright and expose a live viewport preview inside ProxyDesk.
- Control Center includes an **In-app browser wall** with exactly **3 browser cards per row** on wide screens, automatically falling back to 2/1 columns on smaller windows.
- Only browser cards near the visible scroll area request screenshots, which keeps large 1–100 fleets from continuously transferring previews for off-screen workspaces.
- Added **Keep Alive all** and **Stop Keep Alive** global actions.
- Each browser card has Launch/Stop, Reload, Keep Alive toggle and Refresh View controls.

## Why the implementation uses live previews

Electron cannot natively embed Firefox or WebKit as `WebContentsView` surfaces. ProxyDesk preserves the real mixed-engine architecture by running those Playwright engines off-screen and showing their actual rendered viewport inside the Electron control window. This prevents popup windows while keeping the browser engine real rather than replacing everything with Chromium.

## Performance

Live previews poll only while a card is near the visible viewport. With very large fleets, CPU/RAM use is still dominated by the browser engines themselves; running 100 simultaneously can require substantial hardware.

## 3.6.1 — URL Pool Entry Fix

- Long URLs in the Saved random website pool no longer visually wrap onto a second row.
- The URL textarea now keeps one complete URL on one horizontal line and provides horizontal scrolling.
- Added live counts for entered lines, valid unique URLs, duplicates, and invalid lines.
- No new dependencies.
