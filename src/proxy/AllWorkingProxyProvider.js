"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALL_WORKING_PROXY_URL = void 0;
exports.fetchAllWorkingProxyText = fetchAllWorkingProxyText;
exports.ALL_WORKING_PROXY_URL = 'http://169.58.35.69/data/all-working.txt';
const REQUEST_TIMEOUT_MS = 15_000;
async function fetchAllWorkingProxyText(signal) {
    if (signal?.aborted) throw new Error('Proxy API request cancelled.');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(exports.ALL_WORKING_PROXY_URL, {
            method: 'GET',
            headers: {
                Accept: 'text/plain',
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache'
            },
            signal: controller.signal
        });
        if (!response.ok) {
            // fetch does not release an unread body merely because we throw.
            // Cancel streamed error responses so repeated API failures cannot
            // retain a connection/body indefinitely between rotation attempts.
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`Proxy API returned HTTP ${response.status}.`);
        }
        const text = await response.text();
        if (!text.trim())
            throw new Error('Proxy API returned an empty response.');
        return text;
    }
    catch (err) {
        if (signal?.aborted)
            throw new Error('Proxy API request cancelled.');
        if (controller.signal.aborted) {
            throw new Error(`Proxy API request timed out after ${REQUEST_TIMEOUT_MS} ms.`);
        }
        throw err;
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}
//# sourceMappingURL=AllWorkingProxyProvider.js.map
