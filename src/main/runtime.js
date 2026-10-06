"use strict";

// A Promise.race leaves the losing timeout alive. Always release it when the
// operation settles; this does not change the caller's timeout or result.
function withTimeout(operation, ms, onTimeout) {
    let timer;
    return Promise.race([
        operation,
        new Promise((resolve, reject) => {
            timer = setTimeout(() => {
                try { resolve(onTimeout()); } catch (error) { reject(error); }
            }, ms);
        })
    ]).finally(() => clearTimeout(timer));
}

// Cancellation wakes the worker so its existing generation check can end it.
function cancellableDelay(ms, signal) {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });
}

module.exports = { withTimeout, cancellableDelay };
