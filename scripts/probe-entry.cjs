'use strict';
// Test-only entry. Never included in production packaging.
const { app, webContents, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const meta = require('./package.json');
const started = performance.now();
const originalSetTimeout = global.setTimeout, originalClearTimeout = global.clearTimeout;
const originalSetInterval = global.setInterval, originalClearInterval = global.clearInterval;
const timers = new Set(), intervals = new Set();
global.setTimeout = (fn, ms, ...args) => {
    const handle = originalSetTimeout((...values) => { timers.delete(handle); fn(...values); }, ms, ...args);
    timers.add(handle); return handle;
};
global.clearTimeout = (handle) => { timers.delete(handle); return originalClearTimeout(handle); };
global.setInterval = (...args) => { const handle = originalSetInterval(...args); intervals.add(handle); return handle; };
global.clearInterval = (handle) => { intervals.delete(handle); return originalClearInterval(handle); };
const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
const ipc = { received: {}, sent: {} };
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, (...args) => {
    ipc.received[channel] = (ipc.received[channel] || 0) + 1;
    return handler(...args);
});
app.on('web-contents-created', (_event, wc) => {
    const send = wc.send.bind(wc);
    wc.send = (channel, ...args) => { ipc.sent[channel] = (ipc.sent[channel] || 0) + 1; return send(channel, ...args); };
});
const probe = global.__probe = { started, ipc };
let lastCpu = process.cpuUsage(), lastCpuAt = performance.now();
probe.resetCpu = () => { lastCpu = process.cpuUsage(); lastCpuAt = performance.now(); };
const mainDir = path.dirname(path.resolve(__dirname, meta.probeOriginalMain));
for (const [file, exported, field] of [['BrowserManager.js', 'BrowserManager', 'browser'], ['SeoAutomationManager.js', 'SeoAutomationManager', 'automation']]) {
    const module = require(path.join(mainDir, file));
    const Original = module[exported];
    module[exported] = class extends Original { constructor(...args) { super(...args); probe[field] = this; } };
}
// Fixture substitutes only external search discovery. Production search, click,
// challenge and selector code is never modified by this harness.
if (process.env.PROXYDESK_FIXTURE_API) {
    const nativeFetch = global.fetch;
    global.fetch = (url, options) => nativeFetch(url === 'http://169.58.35.69/data/all-working.txt' ? process.env.PROXYDESK_FIXTURE_API : url, options);
    const module = require(path.join(mainDir, 'BrowserManager.js'));
    module.BrowserManager.prototype.broadcastSearch = async function (id, query) {
        const url = `${process.env.PROXYDESK_FIXTURE_SITE}/article/${encodeURIComponent(query)}`;
        await this.get(id).view.webContents.loadURL(url);
        return { browserId: id, status: 'matched', interactionStatus: 'opened', matchedUrl: url, ranAt: new Date().toISOString() };
    };
}
function descriptors(pid) { try { return fs.readdirSync(`/proc/${pid}/fd`).length; } catch { return null; } }
probe.snapshot = async () => {
    const cpuAt = performance.now(), cpu = process.cpuUsage();
    const mainCpuPercent = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / ((cpuAt - lastCpuAt) * 1000) * 100;
    lastCpu = cpu; lastCpuAt = cpuAt;
    const procSelfPid = Number(fs.readFileSync('/proc/self/stat', 'utf8').split(' ')[0]);
    const contents = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed());
    const records = contents.map((wc) => ({ id: wc.id, type: wc.getType(), pid: wc.getOSProcessId(), listeners: wc.eventNames().reduce((n, event) => n + wc.listenerCount(event), 0) }));
    const metrics = app.getAppMetrics();
    for (const record of records) record.memory = metrics.find((metric) => metric.pid === record.pid)?.memory ?? null;
    const sumListeners = (emitter) => emitter ? emitter.eventNames().reduce((n, event) => n + emitter.listenerCount(event), 0) : 0;
    const result = {
        uptimeMs: performance.now() - started,
        mainMemory: process.memoryUsage(),
        mainCpuPercent,
        mainFileDescriptors: fs.readdirSync('/proc/self/fd').length,
        processPid: process.pid,
        procSelfPid,
        pidNamespaceConsistent: procSelfPid === process.pid,
        metrics: metrics.map((metric) => ({ ...metric, fdCount: descriptors(metric.pid) })),
        contents: records,
        activeTimers: timers.size + intervals.size,
        timeoutCount: timers.size,
        intervalCount: intervals.size,
        listeners: { app: sumListeners(app), ipcMain: sumListeners(ipcMain), browserManager: sumListeners(probe.browser), automationManager: sumListeners(probe.automation), contents: records.reduce((n, wc) => n + wc.listeners, 0) },
        ipc: JSON.parse(JSON.stringify(ipc)),
        eventLoopDelayMs: { mean: delay.mean / 1e6, max: delay.max / 1e6, p99: delay.percentile(99) / 1e6 },
        workspaceCount: probe.browser?.getAll().length,
        state: probe.automation?.getState()
    };
    delay.reset(); return result;
};
require(path.resolve(__dirname, meta.probeOriginalMain));
