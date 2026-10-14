"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
// Keep this runtime object self-contained because the preload runs sandboxed.
const IPC_CHANNELS = {
    browserGetAll: 'browser:getAll',
    browserSetBounds: 'browser:setBounds',
    browserSetKeepAlive: 'browser:setKeepAlive',
    browserSetKeepAliveAll: 'browser:setKeepAliveAll',
    browserStateChanged: 'browser:stateChanged',
    automationGetState: 'automation:getState',
    automationConfigureProxy: 'automation:configureProxy',
    automationStart: 'automation:start',
    automationStop: 'automation:stop',
    automationRunNow: 'automation:runNow',
    automationStateChanged: 'automation:stateChanged',
    automationSeoResult: 'automation:seoResult'
};
// Browser cards all receive scroll/resize events. Keep the last geometry for
// each card in this frame while preserving the existing Promise API.
const pendingBounds = new Map();
let boundsFrame = null;
function setBounds(id, bounds) {
    let entry = pendingBounds.get(id);
    if (!entry) {
        entry = {};
        entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
        pendingBounds.set(id, entry);
    }
    entry.bounds = bounds;
    if (boundsFrame === null) {
        boundsFrame = requestAnimationFrame(() => {
            boundsFrame = null;
            const entries = Array.from(pendingBounds);
            pendingBounds.clear();
            for (const [browserId, pending] of entries) {
                electron_1.ipcRenderer.invoke(IPC_CHANNELS.browserSetBounds, browserId, pending.bounds).then(
                    pending.resolve, pending.reject);
            }
        });
    }
    return entry.promise;
}
const api = {
    browser: {
        getAll: () => electron_1.ipcRenderer.invoke(IPC_CHANNELS.browserGetAll),
        setBounds,
        setKeepAlive: (id, enabled) => electron_1.ipcRenderer.invoke(IPC_CHANNELS.browserSetKeepAlive, id, enabled),
        setKeepAliveAll: (enabled) => electron_1.ipcRenderer.invoke(IPC_CHANNELS.browserSetKeepAliveAll, enabled),
        onStateChanged: (cb) => {
            const listener = (_event, state) => cb(state);
            electron_1.ipcRenderer.on(IPC_CHANNELS.browserStateChanged, listener);
            return () => electron_1.ipcRenderer.removeListener(IPC_CHANNELS.browserStateChanged, listener);
        }
    },
    automation: {
        getState: () => electron_1.ipcRenderer.invoke(IPC_CHANNELS.automationGetState),
        configureProxy: (config) => electron_1.ipcRenderer.invoke(IPC_CHANNELS.automationConfigureProxy, config),
        start: (config) => electron_1.ipcRenderer.invoke(IPC_CHANNELS.automationStart, config),
        stop: () => electron_1.ipcRenderer.invoke(IPC_CHANNELS.automationStop),
        runNow: () => electron_1.ipcRenderer.invoke(IPC_CHANNELS.automationRunNow),
        onStateChanged: (cb) => {
            const listener = (_event, state) => cb(state);
            electron_1.ipcRenderer.on(IPC_CHANNELS.automationStateChanged, listener);
            return () => electron_1.ipcRenderer.removeListener(IPC_CHANNELS.automationStateChanged, listener);
        },
        onSeoResult: (cb) => {
            const listener = (_event, payload) => cb(payload);
            electron_1.ipcRenderer.on(IPC_CHANNELS.automationSeoResult, listener);
            return () => electron_1.ipcRenderer.removeListener(IPC_CHANNELS.automationSeoResult, listener);
        }
    }
};
electron_1.contextBridge.exposeInMainWorld('app', api);
//# sourceMappingURL=preload.js.map
