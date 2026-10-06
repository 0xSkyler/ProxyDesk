"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeAutomationIntervalSeconds = normalizeAutomationIntervalSeconds;
exports.normalizeBrowserCount = normalizeBrowserCount;
exports.normalizeSeoMaxPages = normalizeSeoMaxPages;
function normalizeAutomationIntervalSeconds(value) {
    if (!Number.isFinite(value))
        return 600;
    return Math.max(30, Math.min(86_400, Math.floor(value)));
}
function normalizeBrowserCount(value) {
    if (!Number.isFinite(value))
        return 10;
    return Math.max(1, Math.min(100, Math.floor(value)));
}
function normalizeSeoMaxPages(value) {
    if (!Number.isFinite(value))
        return 20;
    return Math.max(1, Math.min(100, Math.floor(value)));
}
//# sourceMappingURL=automation.js.map