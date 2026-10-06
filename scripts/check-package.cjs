'use strict';
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const path = require('node:path');
const archive = path.resolve(__dirname, '../release-linux/linux-unpacked/resources/app.asar');
const files = asar.listPackage(archive);
for (const file of files) {
    assert.ok(!file.includes('node_modules'), `Unexpected production dependency: ${file}`);
    assert.ok(!/\/tests\/|\/scripts\/|\/docs\/|ProxyValidator|ProxyScorer|ProxyScrapeProvider|\.exe$|\.node$/.test(file), `Unexpected packaged file: ${file}`);
    if (/\.(?:js|css|html)$/.test(file)) {
        const local = path.resolve(__dirname, '..', file.slice(1));
        assert.deepEqual(asar.extractFile(archive, file.slice(1)), require('node:fs').readFileSync(local), `Stale packaged source: ${file}`);
    }
}
for (const expected of ['/src/main/main.js', '/src/preload/preload.js', '/src/renderer/index.html']) assert.ok(files.includes(expected), `Missing ${expected}`);
console.log(`Production archive verified: ${files.length} entries, no npm dependency tree or legacy validator.`);
