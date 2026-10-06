"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_BROWSER_COUNT = exports.DEFAULT_PROXY_TIMEOUT_MS = exports.MAX_PROXY_TIMEOUT_MS = exports.MIN_PROXY_TIMEOUT_MS = exports.EPHEMERAL_PARTITION_PREFIX = exports.PARTITION_PREFIX = exports.APP_ID = exports.APP_NAME = void 0;
__exportStar(require("./countries"), exports);
exports.APP_NAME = 'ProxyDesk';
exports.APP_ID = 'com.proxydesk.desktop';
/** Partition name prefix for each browser workspace's isolated session. */
exports.PARTITION_PREFIX = 'persist:browser-';
/** Partition prefix used when "Persist browser sessions" is OFF (in-memory, per-run isolation). */
exports.EPHEMERAL_PARTITION_PREFIX = 'browser-ephemeral-';
exports.MIN_PROXY_TIMEOUT_MS = 1000;
exports.MAX_PROXY_TIMEOUT_MS = 60000;
exports.DEFAULT_PROXY_TIMEOUT_MS = 8000;
/** Upper bound on how many browser workspaces can be configured at once.
 * Each one is a genuinely separate Chromium renderer process + isolated
 * session, so this is a real RAM/CPU ceiling, not an arbitrary UI limit —
 * chosen generously above the old fixed 10 so "sometimes I need more than
 * 10" is possible, without letting the count field accept something that
 * would just crash the machine. */
exports.MAX_BROWSER_COUNT = 100;
//# sourceMappingURL=index.js.map