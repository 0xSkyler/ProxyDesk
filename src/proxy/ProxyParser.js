"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyParser = exports.ProxyParseError = void 0;
exports.buildProxyId = buildProxyId;
exports.toProxyRecord = toProxyRecord;
exports.parseBulkText = parseBulkText;
exports.dedupeProxies = dedupeProxies;
const PROTOCOLS = ['http', 'https', 'socks4', 'socks5'];
/** Loose IPv4/hostname check — deliberately permissive about hostnames
 * (proxies are sometimes given as domain names) but rejects obvious junk. */
const HOST_RE = /^[a-zA-Z0-9.-]+$/;
class ProxyParseError extends Error {
    line;
    constructor(line, message) {
        super(message);
        this.line = line;
        this.name = 'ProxyParseError';
    }
}
exports.ProxyParseError = ProxyParseError;
/**
 * Parses proxies from the formats the Import Proxy dialog accepts:
 *   - http://host:port
 *   - http://user:pass@host:port
 *   - socks5://host:port
 *   - host:port
 *   - host:port:username:password
 * Never throws on malformed input from bulk imports — callers should use
 * `tryParseLine` and collect failures; `parseLine` (throwing) is for
 * single-proxy form fields where an immediate error message is wanted.
 */
class ProxyParser {
    static tryParseLine(rawLine) {
        try {
            return ProxyParser.parseLine(rawLine);
        }
        catch {
            return null;
        }
    }
    static parseLine(rawLine) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            throw new ProxyParseError(rawLine, 'Empty or comment line');
        }
        if (line.includes('://')) {
            return ProxyParser.parseUrlForm(line);
        }
        return ProxyParser.parseColonForm(line);
    }
    static parseUrlForm(line) {
        let url;
        try {
            url = new URL(line);
        }
        catch {
            throw new ProxyParseError(line, 'Not a valid proxy URL');
        }
        const protocol = url.protocol.replace(':', '').toLowerCase();
        if (!PROTOCOLS.includes(protocol)) {
            throw new ProxyParseError(line, `Unsupported protocol "${protocol}"`);
        }
        const host = decodeURIComponent(url.hostname);
        if (!host || !HOST_RE.test(host)) {
            throw new ProxyParseError(line, 'Invalid host');
        }
        const port = url.port ? Number(url.port) : defaultPortFor(protocol);
        validatePort(port, line);
        const username = url.username ? decodeURIComponent(url.username) : undefined;
        const password = url.password ? decodeURIComponent(url.password) : undefined;
        return { host, port, protocol, username, password };
    }
    static parseColonForm(line) {
        const parts = line.split(':').map((p) => p.trim());
        if (parts.length === 2) {
            const [host, portStr] = parts;
            const port = Number(portStr);
            validateHost(host, line);
            validatePort(port, line);
            return { host, port, protocol: 'http' };
        }
        if (parts.length === 4) {
            const [host, portStr, username, password] = parts;
            const port = Number(portStr);
            validateHost(host, line);
            validatePort(port, line);
            return { host, port, protocol: 'http', username, password };
        }
        throw new ProxyParseError(line, 'Unrecognized proxy format');
    }
}
exports.ProxyParser = ProxyParser;
function validateHost(host, line) {
    if (!host || !HOST_RE.test(host)) {
        throw new ProxyParseError(line, 'Invalid host');
    }
}
function validatePort(port, line) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new ProxyParseError(line, 'Invalid port');
    }
}
function defaultPortFor(protocol) {
    switch (protocol) {
        case 'https':
            return 443;
        case 'socks4':
        case 'socks5':
            return 1080;
        case 'http':
        default:
            return 8080;
    }
}
/** Deterministic identity for dedup: protocol + host + port. */
function buildProxyId(input) {
    return `${input.protocol}://${input.host.toLowerCase()}:${input.port}`;
}
function toProxyRecord(input, source, extra = {}) {
    return {
        id: buildProxyId(input),
        host: input.host,
        port: input.port,
        protocol: input.protocol,
        username: input.username,
        password: input.password,
        countryCode: extra.countryCode,
        country: extra.country,
        countryVerified: extra.countryVerified ?? false,
        sources: [source],
        status: 'unknown',
        score: 0,
        successCount: 0,
        failureCount: 0,
        googleStatus: 'unknown',
        ...extra
    };
}
/** Parses a multi-line block (e.g. an imported .txt file), never throwing. */
function parseBulkText(text, source) {
    const proxies = [];
    const invalidLines = [];
    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        try {
            const parsed = ProxyParser.parseLine(line);
            proxies.push(toProxyRecord(parsed, source));
        }
        catch {
            invalidLines.push(line);
        }
    }
    return { proxies, invalidLines };
}
/** Merges duplicate proxies (same protocol+host+port), combining source lists. */
function dedupeProxies(proxies) {
    const byId = new Map();
    for (const proxy of proxies) {
        const existing = byId.get(proxy.id);
        if (!existing) {
            byId.set(proxy.id, { ...proxy, sources: [...proxy.sources] });
            continue;
        }
        const mergedSources = Array.from(new Set([...existing.sources, ...proxy.sources]));
        byId.set(proxy.id, {
            ...existing,
            sources: mergedSources,
            // Prefer whichever record has verified country metadata.
            countryCode: existing.countryVerified ? existing.countryCode : proxy.countryCode ?? existing.countryCode,
            country: existing.countryVerified ? existing.country : proxy.country ?? existing.country,
            countryVerified: existing.countryVerified || proxy.countryVerified,
            username: existing.username ?? proxy.username,
            password: existing.password ?? proxy.password
        });
    }
    return Array.from(byId.values());
}
//# sourceMappingURL=ProxyParser.js.map