'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { BoundedLogWriter } = require('../src/main/BoundedLogWriter');
test('logger flushes lines and rotates bounded history', async () => {
    const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'proxydesk-logs-'));
    try {
        const file = path.join(dir, 'application.log');
        const writer = new BoundedLogWriter(file, { maxBytes: 128, backups: 3 });
        for (let i = 0; i < 20; i++) { writer.write(`entry ${i} ${'x'.repeat(70)}\n`); await writer.work; }
        await writer.close();
        assert.equal((await fs.readdir(dir)).length, 4);
        assert.match(await fs.readFile(file, 'utf8'), /entry 19/);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('logger handles disk errors without unhandled rejection or a growing queue', async () => {
    const writer = new BoundedLogWriter('/nonexistent-proxydesk-path/application.log');
    writer.write('hello\n'); await writer.close();
    assert.equal(writer.failed, true); assert.equal(writer.queuedBytes, 0);
    writer.write('ignored\n'); assert.equal(writer.queue.length, 0);
});
test('logger bounds queued bytes under backpressure', async () => {
    const writer = new BoundedLogWriter('/nonexistent-proxydesk-path/browser.log', { queueBytes: 100 });
    for (let i = 0; i < 1000; i++) writer.write('1234567890\n');
    assert.ok(writer.queuedBytes <= 100); assert.ok(writer.dropped > 0);
    await writer.close();
});
