'use strict';
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const fs = require('node:fs');
const path = require('node:path');
const archive = path.resolve(process.argv[2] || path.join(__dirname, '../release-linux/linux-unpacked/resources/app.asar'));
assert.ok(fs.existsSync(archive), `Missing production archive: ${archive}`);
const files = asar.listPackage(archive);
for (const file of files) {
    assert.ok(!file.includes('node_modules'), `Unexpected production dependency: ${file}`);
    assert.ok(!/\/tests\/|\/scripts\/|\/docs\/|ProxyValidator|ProxyScorer|ProxyScrapeProvider|\.exe$|\.node$/.test(file), `Unexpected packaged file: ${file}`);
    if (/\.(?:js|css|html)$/.test(file)) {
        const local = path.resolve(__dirname, '..', file.slice(1));
        assert.deepEqual(asar.extractFile(archive, file.slice(1)), fs.readFileSync(local), `Stale packaged source: ${file}`);
    }
}
for (const expected of ['/src/main/main.js', '/src/preload/preload.js', '/src/renderer/index.html']) assert.ok(files.includes(expected), `Missing ${expected}`);
const metadata = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.deepEqual(
    { name: metadata.name, productName: metadata.productName, version: metadata.version },
    { name: 'dom', productName: 'DOM', version: '0.5.5' },
    'Packaged identity is not DOM v0.5.5'
);
console.log(`Production archive verified: ${files.length} entries, DOM v${metadata.version}, no npm dependency tree or legacy validator.`);
