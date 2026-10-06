"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerIpc = registerIpc;
const electron_1 = require("electron");
const ipc_1 = require("../../shared/types/ipc");
/**
 * Minimal renderer trust boundary for the SEO Tracker Lite build.
 * No arbitrary navigation, manual proxy import/export, diagnostics, settings,
 * cache controls, or Google-trust tools are exposed.
 */
function registerIpc(deps) {
    const { browserManager, automationManager } = deps;
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.browserGetAll, () => browserManager.getAll());
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.browserSetBounds, (_event, id, bounds) => browserManager.setBounds(id, bounds));
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.browserSetKeepAlive, (_event, id, enabled) => browserManager.setBrowserKeepAlive(id, enabled, enabled));
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.browserSetKeepAliveAll, (_event, enabled) => browserManager.setKeepAliveAll(enabled, enabled));
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.automationGetState, () => automationManager.getState());
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.automationStart, (_event, config) => automationManager.start(config));
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.automationStop, () => automationManager.stop());
    electron_1.ipcMain.handle(ipc_1.IPC_CHANNELS.automationRunNow, () => automationManager.runNow());
    const listeners = [
        [browserManager, 'stateChanged', ipc_1.IPC_CHANNELS.browserStateChanged],
        [automationManager, 'stateChanged', ipc_1.IPC_CHANNELS.automationStateChanged],
        [automationManager, 'seoResult', ipc_1.IPC_CHANNELS.automationSeoResult]
    ].map(([emitter, event, channel]) => {
        const listener = (payload) => {
            for (const win of electron_1.BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
            }
        };
        emitter.on(event, listener);
        return [emitter, event, listener];
    });
    return () => {
        for (const [emitter, event, listener] of listeners) emitter.removeListener(event, listener);
        for (const channel of [ipc_1.IPC_CHANNELS.browserGetAll, ipc_1.IPC_CHANNELS.browserSetBounds,
            ipc_1.IPC_CHANNELS.browserSetKeepAlive, ipc_1.IPC_CHANNELS.browserSetKeepAliveAll,
            ipc_1.IPC_CHANNELS.automationGetState, ipc_1.IPC_CHANNELS.automationStart,
            ipc_1.IPC_CHANNELS.automationStop, ipc_1.IPC_CHANNELS.automationRunNow]) electron_1.ipcMain.removeHandler(channel);
    };
}
//# sourceMappingURL=registerIpc.js.map
