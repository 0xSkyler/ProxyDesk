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

function preparationCancelled() {
    const error = new Error('Browser preparation cancelled.');
    error.name = 'AbortError';
    return error;
}

// Native Chromium operations do not all accept AbortSignal. Bound their wait,
// consume late settlements, and always detach the cancellation listener/timer.
function waitForPreparation(operation, ms, signal, message) {
    return new Promise((resolve, reject) => {
        let timer;
        const finish = (error, value) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(value);
        };
        const abort = () => finish(preparationCancelled());
        Promise.resolve(operation).then((value) => finish(null, value), (error) => finish(error));
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(new Error(message)), ms);
    });
}

module.exports = { withTimeout, cancellableDelay, waitForPreparation, preparationCancelled };
