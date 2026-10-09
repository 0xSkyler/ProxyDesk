# ProxyDesk SEO 4.1.0 — simultaneous keywords

This version extends the supplied **ProxyDesk-SEO-4.0.0-FINAL-SOURCE.zip**. The original Google result click/landing helpers, browser engines, proxy workflow, interactive live browser cards and Keep Alive behavior remain in place.

## Start a multi-keyword run

1. Upload `proxy.txt` and use your existing proxy settings/assignment workflow.
2. Set your fleet size in **Settings → Browser fleet**. For a smaller PC, start with a small fleet rather than selecting 100 browsers.
3. Open **SEO Tracker**, enter one full search phrase per line, and enter the target website.
4. Select the browsers to use. The allocation cards show which browser IDs handle each keyword. You need at least one **available** selected browser per keyword.
5. Click **Track**. All selected profiles clear first; then keyword groups run concurrently. Switch to **Control Center** to watch and interact with the real browser cards while the checks continue.
6. Filter the results by keyword or export CSV. Local history records separate observations for each keyword and reads existing single-keyword history.

Three keywords with ten available browsers use groups of **4 / 3 / 3**, for **ten browsers total**. Each browser has one keyword for the run and keeps the existing independent proxy assignment. A matched article stays open with Keep Alive. No extra browser fleet is created for each keyword.

Keywords are separated by **newlines**; commas remain part of a search phrase. Blank and duplicate lines are ignored. If there are fewer available selected browsers than keywords, the app explains the problem before clearing or navigating any browser. Process launches are limited to three at a time; already launched browsers search independently. Stop All also cancels queued SEO launches.

## Development and Windows build

From this folder (`seo-workstation` in the GitHub repository):

```sh
npm ci
npm run dev
```

The lockfile pins the installed dependency graph. `npm run package:win` runs the existing checks plus a real Electron multi-keyword UI test before creating `release/ProxyDesk-SEO-Setup-4.1.0.exe` on Windows. The root workflow `.github/workflows/build-seo-windows.yml` builds this folder on a native Windows runner, checks Chromium/Firefox/WebKit, checks the packaged runtime, and uploads the installer, source ZIP and test evidence.

Desktop fixtures replace external Google/article responses for deterministic testing. They exercise real browsers, the original result-click logic, proxy assignment configuration, the Electron interface, live input and frames, and history/CSV. They do not establish that a public proxy can reach live Google.

The original 4.0 feature documentation follows.


## 3.7.0 interactive in-app browsers

The in-app browser wall is now interactive instead of view-only. Click any live viewport to control that specific Playwright browser without opening a separate native browser window. While a card is active, ProxyDesk forwards mouse/touch-style pointer actions, wheel scrolling, keyboard input, paste text, Tab/Enter/Backspace/arrow keys and keyboard shortcuts to the real browser page. Press **Esc** or click outside the viewport to release control and return the mouse wheel to normal ProxyDesk scrolling.

Each browser card also has its own editable address field and **Go** button. The live screenshot is captured at CSS-pixel scale and displayed with `object-fit: contain`, allowing clicks to be mapped back to the browser's 390×844 mobile viewport accurately. The actively controlled card refreshes more frequently than passive cards so typed text and clicks appear with lower visual latency. Links that open a new tab/window are adopted as that workspace's active page automatically.

Interaction is relayed through a narrow IPC contract; the renderer does not receive Node or Playwright objects directly.

## 3.6.0 saved random website pool

Control Center now includes a saved URL pool. Paste one website per line, save the list, select any active browsers, then choose **Random distribute**. ProxyDesk shuffles browser IDs and the saved links, uses every saved link once before repeating within the same distribution cycle, and immediately navigates the selected browsers through the existing central dispatcher. For example, 5 browsers with 2 saved links produces five assignments with the two links reused across the remaining three browsers. The pool is saved in application settings; browser cache/cookies and proxy data remain separate.

Keep Alive **Maximum article hops per launch** now accepts **0–1000**. A value of 0 disables link hopping while keeping scroll actions available.

## 3.5.1 live-view reliability fix

The in-app browser wall now requests a preview immediately when a workspace becomes runnable instead of waiting for IntersectionObserver first. Visible cards continue polling every ~1.8 seconds. Preview capture is bounded to five seconds and retries once using a simple PNG capture if the optimized JPEG capture fails. The **Refresh view** button now forces a preview request even if visibility tracking is delayed. Preview failures are shown in the card and written to `application.log` instead of leaving the card on an unexplained "Connecting live view…" state forever.


## 3.5.0 in-app browser wall

ProxyDesk now keeps Playwright browser processes off-screen and renders their live mobile viewports inside the Control Center. On wide windows the browser wall uses exactly three cards per row, so you can scroll through the active fleet without dozens of Firefox/Chromium/WebKit/Edge/Opera windows appearing on the desktop. Only cards near the visible scroll area refresh their preview.

The Control Center also adds **Keep Alive all** and **Stop Keep Alive** so the entire active fleet can be toggled with one click. Per-browser Keep Alive controls remain available.

Because Electron can only natively embed Chromium web contents, the mixed Firefox/WebKit engines are represented as live Playwright viewport previews rather than fake Chromium WebViews.



## Central URL Dispatcher

The Control Center now has a dedicated central URL dispatcher for the dynamic 1–100 browser fleet.

- Enter one URL and send it to every currently selected browser.
- Select all browsers or any subset with the central browser selector.
- Use the **Multi-URL router** to send different browser groups to different URLs in one dispatch.
- Browser group syntax supports compact ranges such as `1-5,8,10`.
- The same browser cannot be assigned to two different route rows in the same dispatch; ProxyDesk reports the conflict before navigation begins.
- The existing per-browser target table remains available for one-by-one editing.
- Central dispatch uses bounded concurrency so large 1–100 browser fleets are not launched all at the exact same instant.

Example:

```text
Route 1: browsers 1-5     → https://example.com/article-a
Route 2: browsers 6,8,10  → https://example.org/article-b
Route 3: browsers 11-20   → https://example.net/
```

## Dynamic browser fleet

Set **Settings → Browser fleet → Active browser workspaces** anywhere from **1 to 100**. The change is applied immediately: increasing creates isolated workspaces, while decreasing closes the highest-numbered workspaces. All selectors and bulk actions automatically follow the active count.

> Performance: 100 browser processes can require substantial RAM/CPU even when they are rendered off-screen. ProxyDesk allows the range, but increase gradually based on your PC capacity.


ProxyDesk is a Windows desktop control plane for isolated mobile-sized browser workspaces plus a cross-browser SEO Tracker. Browsing is handled by Playwright browser processes while Electron provides the control UI.

Before **any SEO Tracker run begins**, ProxyDesk now clears every selected browser as a batch. No selected browser starts Google until all selected browser contexts are stopped and their profile folders are deleted.

The SEO Tracker also includes **Clear selected (N)** next to the browser selector. Use the dynamically generated browser checkboxes, choose exactly the workspaces you want, and clear them without starting an SEO run.

A clear removes browser/session data including:

- cookies
- HTTP cache
- localStorage and sessionStorage
- IndexedDB
- service workers and Cache Storage
- previous navigation/profile state
- previous Keep Alive state and detected-IP state

It intentionally preserves the selected browser's engine, rotation interval and current proxy assignment so the browser remains ready for the next SEO search.


## 3.4.0: mandatory pre-SEO cleanup + selected-browser clear control

The SEO tracker no longer treats a hostname/breadcrumb URL as the destination of an article result.

For a search such as:

```text
Keyword: rmg cutting
Target: appareldiary.com
```

when Google visibly shows an ApparelDiary article, the flow is now:

```text
Google results page
      ↓
Find target-domain result card
      ↓
Click that card's actual article/title element
      ↓
Wait for Google's click/redirect chain
      ↓
Read the browser's real final URL
      ↓
Save that article URL as matchedUrl + workspace target
      ↓
Enable Keep Alive continuously
```

This is intentionally different from the 3.1.x approach, which tried to reconstruct the destination URL from Google's markup and could pair an article title with a homepage/breadcrumb URL.

### SEO behavior

- Keyword + target website input
- Select one or more browser workspaces
- Search 1–5 Google result pages
- Detect target domain or subdomain
- Prefer the visible article/title click over hostname/breadcrumb links
- Record observed position when the organic parser can calculate it
- Record the browser's **landed article URL** as the canonical match
- Automatically keep the matched article as that browser's target
- Automatically enable Keep Alive after the article opens
- Record Google CAPTCHA/unusual-traffic pages as `challenge`; no CAPTCHA bypass is implemented

SEO history remains local and can be exported as CSV. Proxy endpoints and credentials remain memory-only.


## Fresh-session privacy

Browser data is disposable by default from 3.4.0 onward. On every application start, ProxyDesk deletes all saved Playwright workspace profiles before any browser launches. This removes previous cookies, HTTP cache, local/session storage, IndexedDB, service workers and browsing state.

Every **Google Central Search** recreates each selected browser before opening Google. For **SEO Tracker**, the current build is stricter: all selected browsers are cleared first as one batch barrier, and only then does the first Google SEO navigation begin. This prevents a previous article, login state or Keep Alive page from leaking into the next search.

ProxyDesk still preserves non-browsing configuration such as engine selection, rotation interval, application settings and SEO history. Previous target URLs and Keep Alive state are intentionally not restored after a restart.

## Browser engines

Default 10-workspace mix:

| Workspace | Browser |
|---|---|
| 1 | Chromium |
| 2 | Firefox |
| 3 | WebKit (Safari-like engine) |
| 4 | Microsoft Edge |
| 5 | Opera |
| 6 | Chromium |
| 7 | Firefox |
| 8 | WebKit (Safari-like engine) |
| 9 | Microsoft Edge |
| 10 | Opera |

Important details:

- Chromium, Firefox and WebKit are bundled through Playwright.
- Edge uses the locally installed Microsoft Edge browser.
- Opera uses a locally installed Opera executable through Playwright's Chromium controller and is best-effort.
- Apple Safari itself does not run on modern Windows; Safari-designated workspaces use Playwright WebKit.

## Proxy support

ProxyDesk starts with an empty proxy pool on every launch. Upload `proxy.txt` manually; the proxy pool, credentials and current assignments are not persisted to disk.

Supported line formats include:

```text
http://1.2.3.4:8080
https://1.2.3.4:8443
socks4://1.2.3.4:1080
socks5://1.2.3.4:1080
1.2.3.4:8080
1.2.3.4:8080:username:password
http://username:password@1.2.3.4:8080
username:password@gateway.example.com:824
```

The last form defaults to HTTP transport and is suitable for authenticated gateway providers.

## Streaming proxy validation

The Proxy Session page validates endpoints as a live pipeline. Proxies move through `unverified`, `checking`, `working` or `dead`. A working proxy can be assigned to a waiting browser immediately while the rest of the file continues validating.

Validation URL, timeout, attempts, concurrency, maximum latency, auto-validation and immediate assignment are configurable in Settings.

## Keep Alive

Keep Alive performs randomized scrolling and can follow visible article/main-content links. It avoids forms, login/account paths, carts/checkouts, downloads and obvious sponsored links. After a successful SEO target match, Keep Alive is enabled automatically for that workspace and continues until the user disables it or closes the browser.

## Central controls

- Separate target URL per workspace
- Custom proxy rotation interval in seconds
- Google central search to selected workspaces
- Manual launch/focus/stop/reload controls
- Per-workspace proxy selection
- SEO Tracker with local history and CSV export

## Requirements

- Windows 10/11
- Node.js 24
- npm
- Internet access during first dependency/browser installation
- Microsoft Edge installed for Edge workspaces
- Opera installed for Opera workspaces

## Clean development install

Extract the repository into a new directory, for example:

```text
C:\Users\Acer\ProxyDesk SEO
```

Then either double-click `START-DEVELOPMENT.cmd`, or run:

```powershell
cd "C:\Users\Acer\ProxyDesk SEO"
npm.cmd install
npm.cmd run dev
```

`START-DEVELOPMENT.cmd` runs `npm install` automatically only when `node_modules` is missing. The first install downloads Playwright Chromium, Firefox and WebKit and is therefore large.

## Build Windows installer

Either double-click `BUILD-WINDOWS.cmd`, or run:

```powershell
npm.cmd run package:win
```

Expected installer:

```text
release\ProxyDesk-SEO-Setup-4.1.0.exe
```

## Quality checks

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
```

## Security model

- Electron `contextIsolation: true`
- `nodeIntegration: false`
- renderer sandbox enabled
- narrow preload IPC API
- no public-proxy scraping
- proxy credentials held in memory only
- no CAPTCHA solving/bypass

## Known limitations

1. WebKit on Windows is not Apple Safari.
2. Edge and Opera are Chromium-family browsers internally.
3. Opera automation is best-effort because Opera is not an official Playwright channel.
4. Firefox mobile emulation differs from Chromium/WebKit.
5. Running many browser engines can consume substantial RAM/CPU even though their native windows are hidden.
6. Google can change SERP markup; 4.0.0 retains the reduced dependence on markup by clicking the visible title and observing the landed URL, but future Google UI changes may still require selector maintenance.
7. Google may show CAPTCHA/unusual-traffic or consent/interstitial pages. ProxyDesk records challenges instead of bypassing them.
8. Search positions are browser-session observations, not an official universal Google ranking.
9. Interactive live view is screenshot/input relay rather than a native embedded Firefox/WebKit surface, so visual feedback has a small capture latency. Native OS dialogs such as file pickers are not rendered inside the browser card.

### URL pool entry behavior

The Saved random website pool keeps each complete URL on one visual line. Long URLs do not wrap; scroll horizontally to inspect the full URL. The panel also reports entered lines, valid unique URLs, duplicates, and invalid lines before saving.


## 4.0 stability hardening

- Adaptive event-driven live-view streaming; hidden cards stop capturing frames.
- Interactive cards map pointer/keyboard/wheel input into the real Playwright page.
- Global screenshot concurrency cap prevents large fleets from flooding the main process.
- Browser watchdog requests a fresh frame after 12 seconds of visible staleness and restarts an unresponsive workspace after 30 seconds.
- Chromium-family workspaces disable background timer/render throttling for more reliable live operation.
- Proxy validation runs through a real Playwright Chromium HTTPS navigation before an endpoint is marked working.
- Browser processes are isolated per workspace; a crash or stall can be recovered without restarting the entire fleet.
- Stop All, Reload All, Check All IPs and Google Central Search use bounded parallelism so 1–100 workspaces do not serialize for minutes.
- Windows installer builds now run typecheck, lint, tests and production build before NSIS packaging.

A successful `npm.cmd run package:win` is the shipping gate. If any validation step fails, the installer command exits with an error instead of producing a release candidate.
