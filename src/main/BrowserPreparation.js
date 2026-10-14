"use strict";
const { BROWSER_IDS } = require('../shared/types/browser');
const { normalizeBrowserCount } = require('../shared/types/automation');
const { cancellableDelay, waitForPreparation, preparationCancelled } = require('./runtime');

// Limit only workspace creation, not the number of browsing/Keep Alive tasks.
// Starting dozens of Chromium renderers and storage contexts in one turn can
// starve the dashboard on a small PC. Two workers leave room for UI and Stop.
class BrowserPreparation {
    queue = Promise.resolve();
    constructor(browserManager, { concurrency = 2, pauseMs = 50 } = {}) {
        this.browserManager = browserManager;
        this.concurrency = concurrency;
        this.pauseMs = pauseMs;
    }
    ensure(count, options = {}) {
        const work = this.queue.catch(() => {}).then(() => this.prepare(count, options));
        this.queue = work;
        return work;
    }
    async prepare(count, { signal, onProgress } = {}) {
        const assertActive = () => {
            if (signal?.aborted || this.browserManager.disposed) throw preparationCancelled();
        };
        assertActive();
        const desired = BROWSER_IDS.slice(0, normalizeBrowserCount(count));
        const desiredSet = new Set(desired);
        const ready = new Set(this.browserManager.getAll().map((browser) => browser.id));
        const report = () => onProgress?.(desired.filter((id) => ready.has(id)));
        report();
        for (const id of ready) {
            assertActive();
            if (!desiredSet.has(id)) {
                await waitForPreparation(this.browserManager.destroyBrowser(id), 5_000, signal,
                    `Browser ${id} cleanup timed out. Stop and retry with fewer browsers.`);
                ready.delete(id);
            }
        }
        const pending = desired.filter((id) => !ready.has(id));
        let next = 0, failure;
        const worker = async () => {
            while (next < pending.length && !failure) {
                assertActive();
                const id = pending[next++];
                try {
                    await this.browserManager.createBrowser(id, {
                        persistSessions: false, startPage: 'about:blank', userAgent: '', signal
                    });
                    assertActive();
                    ready.add(id);
                    report();
                    await cancellableDelay(this.pauseMs, signal);
                } catch (error) {
                    failure ??= error;
                    throw error;
                }
            }
        };
        // Wait for both workers to settle before another resize can reuse IDs.
        const results = await Promise.allSettled(Array.from({ length: Math.min(this.concurrency, pending.length) }, worker));
        if (failure) throw failure;
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        assertActive();
        report();
        return desired;
    }
}

module.exports = { BrowserPreparation };
