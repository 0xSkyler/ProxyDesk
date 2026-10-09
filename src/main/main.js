"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_path_1 = __importDefault(require("node:path"));
const BrowserManager_1 = require("./BrowserManager");
const ProxyManager_1 = require("./ProxyManager");
const SeoAutomationManager_1 = require("./SeoAutomationManager");
const registerIpc_1 = require("./ipc/registerIpc");
const Logger_1 = require("./Logger");
const browser_1 = require("../shared/types/browser");
const automation_1 = require("../shared/types/automation");
// Recovered renderer assets are available in both source and packaged runs.
const isDev = process.env.NODE_ENV === 'development';
if (process.platform === 'linux' && process.env.DOM_SOFTWARE_RENDERING === '1') {
    electron_1.app.disableHardwareAcceleration();
}
let mainWindow = null;
let browserManager;
let proxyManager;
let automationManager;
let activeBrowserCount = 10;
let startupWork = Promise.resolve();
let shuttingDown = false;
let shutdownComplete = false;
let disposeIpc = () => {};
let browserPreparation = Promise.resolve();
async function createWindowShell() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1600,
        height: 1000,
        minWidth: 1050,
        minHeight: 720,
        backgroundColor: '#0f1115',
        title: 'DOM SEO Tracker Lite',
        show: false,
        webPreferences: {
            preload: node_path_1.default.join(__dirname, '../preload/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true
        }
    });
    // Electron's BrowserView adds one closed listener per attached view. Allow
    // the existing 100-workspace maximum plus shell lifecycle listeners without
    // suppressing warnings globally; destroyBrowser still removes each view.
    mainWindow.setMaxListeners(browser_1.BROWSER_IDS.length + 10);
    browserManager.attachWindow(mainWindow);
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    if (process.platform !== 'darwin') mainWindow.on('close', (event) => {
        if (!shutdownComplete) {
            event.preventDefault();
            electron_1.app.quit();
        }
    });
}
async function loadRenderer() {
    if (!mainWindow)
        throw new Error('Main window is not available.');
    if (isDev) {
        await mainWindow.loadURL('http://localhost:5173');
    }
    else {
        await mainWindow.loadFile(node_path_1.default.join(__dirname, '../renderer/index.html'));
    }
    mainWindow.show();
}
async function ensureBrowserCount(count) {
    // Serialize workspace mutations only, never the concurrent browser tasks.
    const previous = browserPreparation;
    const work = previous.catch(() => {}).then(() => prepareBrowserCount(count));
    browserPreparation = work;
    return work;
}
async function prepareBrowserCount(count) {
    if (shuttingDown) return [];
    const normalized = (0, automation_1.normalizeBrowserCount)(count);
    const desired = new Set(browser_1.BROWSER_IDS.slice(0, normalized));
    const existing = new Set(browserManager.getAll().map((browser) => browser.id));
    for (const id of Array.from(existing)) {
        if (!desired.has(id))
            await browserManager.destroyBrowser(id);
    }
    await Promise.all(Array.from(desired)
        .filter((id) => !existing.has(id))
        .map((id) => browserManager.createBrowser(id, {
        persistSessions: false,
        startPage: 'about:blank',
        userAgent: ''
    })));
    activeBrowserCount = normalized;
    return browser_1.BROWSER_IDS.slice(0, activeBrowserCount);
}
async function bootstrap() {
    proxyManager = new ProxyManager_1.ProxyManager();
    await proxyManager.init();
    browserManager = new BrowserManager_1.BrowserManager();
    activeBrowserCount = 10;
    automationManager = new SeoAutomationManager_1.SeoAutomationManager(proxyManager, browserManager, ensureBrowserCount);
    // Register IPC before the renderer loads. The previous order allowed the
    // React app to call automation:getState before a handler existed.
    disposeIpc = (0, registerIpc_1.registerIpc)({
        browserManager,
        automationManager
    });
    // Build the native shell first, create blank isolated browser sessions,
    // and only then show React. This removes the startup race where the user
    // could click Start while browser creation was still in flight.
    await createWindowShell();
    await ensureBrowserCount(activeBrowserCount);
    if (shuttingDown) return;
    // Keep Alive is automatic after a matched Google result.
    browserManager.configureKeepAlive(60_000, 1, false);
    await loadRenderer();
    Logger_1.logger.info('application', 'DOM SEO Tracker Lite ready.');
}
electron_1.app.whenReady().then(() => {
    electron_1.session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    startupWork = bootstrap().catch((err) => {
        Logger_1.logger.error('application', `Fatal startup error: ${err.stack ?? err}`);
        electron_1.app.quit();
    });
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            void (async () => {
                await createWindowShell();
                await loadRenderer();
            })();
        }
    });
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin')
        electron_1.app.quit();
});
electron_1.app.on('before-quit', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    automationManager?.stop();
    // A hung Chromium storage operation must not prevent shutdown forever.
    const deadline = setTimeout(() => electron_1.app.exit(0), 10_000);
    deadline.unref();
    void (async () => {
        await startupWork;
        await browserPreparation.catch(() => {});
        automationManager?.stop();
        disposeIpc();
        await browserManager?.destroyAll();
        await Logger_1.logger.close();
    })().catch((err) => {
        console.error('DOM shutdown failed:', err);
    }).finally(() => {
        clearTimeout(deadline);
        shutdownComplete = true;
        electron_1.app.quit();
    });
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => electron_1.app.quit());
process.on('uncaughtException', (err) => {
    Logger_1.logger.error('application', `Uncaught exception: ${err.stack ?? err.message}`);
});
process.on('unhandledRejection', (reason) => {
    Logger_1.logger.error('application', `Unhandled rejection: ${String(reason)}`);
});
//# sourceMappingURL=main.js.map
