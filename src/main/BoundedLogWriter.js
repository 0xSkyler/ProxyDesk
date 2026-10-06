"use strict";
const fs = require('node:fs/promises');

// Bounded memory under a stalled/full disk, bounded disk usage under 24/7 load.
// Normal messages are kept verbatim. Overflow is reported, never silently lost.
class BoundedLogWriter {
    constructor(path, { maxBytes = 5 * 1024 * 1024, backups = 3, queueBytes = 1024 * 1024 } = {}) {
        this.path = path;
        this.maxBytes = maxBytes;
        this.backups = backups;
        this.queueBytes = queueBytes;
        this.queue = [];
        this.queuedBytes = 0;
        this.work = null;
        this.closed = false;
        this.failed = false;
        this.size = null;
        this.dropped = 0;
    }
    write(line) {
        if (this.closed || this.failed) return;
        const bytes = Buffer.byteLength(line);
        if (this.queuedBytes + bytes > this.queueBytes || bytes > this.maxBytes || this.queue.length >= 4096) {
            this.dropped += 1;
            return;
        }
        this.queue.push(line);
        this.queuedBytes += bytes;
        this.schedule();
    }
    schedule() {
        if (!this.work) {
            this.work = new Promise((resolve) => setImmediate(resolve))
                .then(() => this.drain())
                .catch((error) => {
                    this.failed = true;
                    this.queue = [];
                    this.queuedBytes = 0;
                    console.error(`ProxyDesk file logging disabled for ${this.path}: ${error.message}`);
                }).finally(() => {
                    this.work = null;
                    // A producer may enqueue after drain's last await but before
                    // this continuation. Do not strand those entries on close.
                    if (this.queue.length && !this.failed) this.schedule();
                });
        }
    }
    async rotate() {
        await fs.rm(`${this.path}.${this.backups}`, { force: true });
        for (let i = this.backups - 1; i >= 1; i--) {
            await fs.rename(`${this.path}.${i}`, `${this.path}.${i + 1}`).catch((error) => {
                if (error.code !== 'ENOENT') throw error;
            });
        }
        await fs.rename(this.path, `${this.path}.1`).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
        });
        this.size = 0;
    }
    async drain() {
        if (this.size === null) {
            this.size = await fs.stat(this.path).then((stat) => stat.size, (error) => {
                if (error.code === 'ENOENT') return 0;
                throw error;
            });
        }
        while (this.queue.length) {
            let batch = '';
            let batchBytes = 0;
            while (this.queue.length && batchBytes < Math.min(64 * 1024, this.maxBytes)) {
                if (batchBytes && batchBytes + Buffer.byteLength(this.queue[0]) > this.maxBytes) break;
                const line = this.queue.shift();
                batch += line;
                const bytes = Buffer.byteLength(line);
                batchBytes += bytes;
                this.queuedBytes -= bytes;
            }
            if (this.size && this.size + batchBytes > this.maxBytes) await this.rotate();
            await fs.appendFile(this.path, batch);
            this.size += batchBytes;
            if (this.dropped) {
                console.warn(`ProxyDesk log backpressure: ${this.dropped} file entries omitted for ${this.path}; console logging continued.`);
                this.dropped = 0;
            }
        }
    }
    async close() {
        this.closed = true;
        while (this.work) await this.work;
    }
}
module.exports = { BoundedLogWriter };
