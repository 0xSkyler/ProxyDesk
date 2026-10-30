'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withinDeadline, waitForAutomation, waitForRenderer } = require('../scripts/benchmark-state.cjs');

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

test('desktop smoke ignores early BrowserView pages until the dashboard loads', async () => {
    const blank = { url: () => 'about:blank' };
    const renderer = { url: () => 'file:///C:/DOM/resources/app.asar/src/renderer/index.html' };
    let reads = 0;
    const app = { windows: () => ++reads < 3 ? [blank] : [blank, renderer] };
    assert.equal(await waitForRenderer(app, { pollMs: 1 }), renderer);
    assert.equal(reads, 3);
});

test('missing desktop renderer fails with the observed page URLs', async () => {
    const app = { windows: () => [{ url: () => 'about:blank' }] };
    await assert.rejects(waitForRenderer(app, { timeoutMs: 5, pollMs: 1 }), /Desktop renderer did not load.*about:blank/);
});
