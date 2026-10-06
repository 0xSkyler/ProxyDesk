'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const directory = path.resolve(__dirname, '../release-linux');
const artifact = fs.readdirSync(directory).find((file) => file.endsWith('.AppImage'));
if (!artifact) throw new Error('Missing AppImage');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'proxydesk-appimage-'));
fs.mkdirSync('.measurements', { recursive: true });
const log = fs.createWriteStream('.measurements/appimage-smoke.log');
const child = spawn('xvfb-run', ['-a', path.join(directory, artifact), '--disable-gpu', '--no-sandbox', `--user-data-dir=${profile}`], { env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' }, detached: true });
let ready = false, stopped = false, failed = false;
// Kill this test's process group only; never broad pkill or killall.
const stop = (signal) => { try { process.kill(-child.pid, signal); } catch {} };
const deadline = setTimeout(() => { failed = true; stop('SIGTERM'); }, 45000);
const forced = setTimeout(() => { failed = true; stop('SIGKILL'); }, 55000);
for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
    log.write(data); process.stdout.write(data);
    if (!ready && data.toString().includes('ProxyDesk SEO Tracker Lite ready')) {
        ready = true;
        setTimeout(() => { stopped = true; stop('SIGTERM'); }, 2000);
    }
});
child.on('error', (error) => { console.error(error); failed = true; });
child.on('close', () => {
    clearTimeout(deadline); clearTimeout(forced); log.end(); fs.rmSync(profile, { recursive: true, force: true });
    if (!ready || !stopped || failed) process.exitCode = 1;
});
