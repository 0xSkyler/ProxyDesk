'use strict';
const { performance } = require('node:perf_hooks');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withinDeadline(operation, timeoutMs, label) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function waitForAutomation(page, predicate, expected, { timeoutMs = 30_000, pollMs = 50 } = {}) {
    const deadline = performance.now() + timeoutMs;
    let state;
    do {
        // Resolve the IPC Promise before testing its value. A Promise itself is
        // truthy even when the eventual condition is false.
        state = await withinDeadline(page.evaluate(() => window.app.automation.getState()),
            Math.max(1, deadline - performance.now()), 'Automation IPC');
        if (predicate(state, expected)) return state;
        await pause(Math.min(pollMs, Math.max(0, deadline - performance.now())));
    } while (performance.now() < deadline);
    throw new Error(`Automation state did not settle: ${JSON.stringify(state)}`);
}

async function waitForRenderer(application, { timeoutMs = 30_000, pollMs = 50 } = {}) {
    const deadline = performance.now() + timeoutMs;
    let pages;
    do {
        pages = application.windows();
        // Playwright also exposes attached BrowserViews as pages. The first
        // page event can belong to a blank workspace while the hidden dashboard
        // is waiting for preparation. Match its actual renderer file instead.
        const renderer = pages.find((page) => /^file:.*\/renderer\/index\.html(?:[?#]|$)/.test(page.url()));
        if (renderer) return renderer;
        await pause(Math.min(pollMs, Math.max(0, deadline - performance.now())));
    } while (performance.now() < deadline);
    throw new Error(`Desktop renderer did not load: ${JSON.stringify(pages.map((page) => page.url()))}`);
}

module.exports = { withinDeadline, waitForAutomation, waitForRenderer };
