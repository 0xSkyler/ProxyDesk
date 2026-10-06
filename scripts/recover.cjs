'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const asar = require('@electron/asar');
const manifest = require('../docs/recovery-manifest.json');
const root = path.resolve(__dirname, '..');
const destination = path.resolve(process.argv[2] || path.join(root, '.recovery/reference'));
if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite ${destination}`);
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const installer = path.join(root, manifest.installer);
if (hash(installer) !== manifest.installerSha256) throw new Error('Reference installer hash mismatch');
const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'proxydesk-recovery-'));
const seven = require('7zip-bin').path7za;
fs.chmodSync(seven, 0o755);
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
try {
    execFileSync(seven, ['x', installer, `-o${temporary}/installer`, '-y'], { stdio: 'pipe' });
    let archive = files(`${temporary}/installer`).find((file) => path.basename(file) === 'app.asar');
    if (!archive) {
        const nested = files(`${temporary}/installer`).filter((file) => path.basename(file) === 'app-64.7z');
        if (nested.length !== 1) throw new Error('Expected exactly one app-64.7z');
        execFileSync(seven, ['x', nested[0], `-o${temporary}/unpacked`, '-y'], { stdio: 'pipe' });
        archive = files(`${temporary}/unpacked`).find((file) => path.basename(file) === 'app.asar');
    }
    if (!archive) throw new Error('Missing app.asar');
    asar.extractAll(archive, destination);
    const metadata = JSON.parse(fs.readFileSync(path.join(destination, 'package.json')));
    if (metadata.version !== '0.5.4' || metadata.main !== 'dist/main/main.js') throw new Error('Unexpected reference metadata');
    for (const [file, expected] of Object.entries(manifest.files)) {
        if (hash(path.join(destination, file)) !== expected) throw new Error(`Reference hash mismatch: ${file}`);
    }
    console.log(`Verified ${Object.keys(manifest.files).length} reference files in ${destination}`);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
