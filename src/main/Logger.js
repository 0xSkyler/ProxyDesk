"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const { BoundedLogWriter } = require("./BoundedLogWriter");
const node_path_1 = __importDefault(require("node:path"));
const SECRET_PATTERNS = [
    /\/\/[^@/\s]+@/g, // user:pass@ in URLs
    /"password"\s*:\s*"[^"]*"/gi,
    /"apiKey"\s*:\s*"[^"]*"/gi
];
function redact(message) {
    let out = message;
    for (const pattern of SECRET_PATTERNS) {
        out = out.replace(pattern, (m) => (m.includes('@') ? '//***@' : m.split(':')[0] + '":"***"'));
    }
    return out;
}
/**
 * Structured, append-only logger writing to logs/<channel>.log under
 * userData. Never logs passwords or API keys (see redact()). Falls back to
 * console-only logging if the log directory can't be created (e.g. in unit
 * tests where `app` isn't ready), so tests never depend on filesystem state.
 */
class Logger {
    closed = false;
    streams = {};
    logsDir = null;
    ensureDir() {
        if (this.logsDir)
            return this.logsDir;
        try {
            const dir = node_path_1.default.join(electron_1.app.getPath('userData'), 'logs');
            if (!(0, node_fs_1.existsSync)(dir))
                (0, node_fs_1.mkdirSync)(dir, { recursive: true });
            this.logsDir = dir;
            return dir;
        }
        catch {
            return null;
        }
    }
    streamFor(channel) {
        if (this.streams[channel])
            return this.streams[channel];
        const dir = this.ensureDir();
        if (!dir)
            return null;
        const stream = new BoundedLogWriter(node_path_1.default.join(dir, `${channel}.log`));
        this.streams[channel] = stream;
        return stream;
    }
    write(channel, level, message) {
        if (this.closed) return;
        const safe = redact(message);
        const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${channel}] ${safe}`;
        const stream = this.streamFor(channel);
        if (stream)
            stream.write(line + '\n');
        // eslint-disable-next-line no-console
        (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
    }
    info(channel, message) {
        this.write(channel, 'info', message);
    }
    warn(channel, message) {
        this.write(channel, 'warn', message);
    }
    error(channel, message) {
        this.write(channel, 'error', message);
    }
    async close() {
        this.closed = true;
        await Promise.allSettled(Object.values(this.streams).map((stream) => stream.close()));
        this.streams = {};
    }
    logsFolderPath() {
        return this.ensureDir() ?? node_path_1.default.join(electron_1.app.getPath('userData'), 'logs');
    }
}
exports.logger = new Logger();
//# sourceMappingURL=Logger.js.map