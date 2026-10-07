'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withinDeadline, waitForAutomation } = require('../scripts/benchmark-state.cjs');

test('benchmark waits for resolved IPC state instead of accepting a truthy Promise', async () => {
    const states = [{ running: false }, { running: true, assigned: 0 }, { running: true, assigned: 20 }];
    let reads = 0;
    const page = { evaluate: async () => states[reads++] };
    const state = await waitForAutomation(page, (value, expected) => value.running && value.assigned === expected, 20, { pollMs: 1 });
    assert.equal(reads, 3);
    assert.equal(state.assigned, 20);
});

test('benchmark records failure when a frozen IPC call never resolves', async () => {
    const page = { evaluate: () => new Promise(() => {}) };
    await assert.rejects(waitForAutomation(page, () => true, undefined, { timeoutMs: 10 }), /Automation IPC timed out/);
    assert.equal(await withinDeadline(Promise.resolve('ready'), 10, 'Probe'), 'ready');
});
