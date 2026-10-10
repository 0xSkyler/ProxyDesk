'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const directory = path.resolve(__dirname, '../release-linux');
const artifact = fs.readdirSync(directory).find((file) => file.endsWith('.AppImage'));
if (!artifact) throw new Error('Missing AppImage');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-appimage-'));
fs.mkdirSync('.measurements', { recursive: true });
const log = fs.createWriteStream('.measurements/appimage-smoke.log');
const child = spawn('xvfb-run', ['-a', path.join(directory, artifact), '--disable-gpu', '--no-sandbox', `--user-data-dir=${profile}`], { env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' }, detached: true });
let ready = false, stopped = false, failed = false;
// xvfb-run and the AppImage launcher are wrappers. Signal only their owned
// Electron main process: killing Xvfb first prevents Chromium's normal shutdown.
function mainPid(pid) {
    let children;
    try {
        const executable = fs.readlinkSync(`/proc/${pid}/exe`);
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        if (path.basename(executable) === 'dom' && !args.some((arg) => arg.startsWith('--type='))) return pid;
        children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
    } catch { return null; }
    for (const descendant of children) { const found = mainPid(descendant); if (found) return found; }
    return null;
}
// Kill this test's process group only; never broad pkill or killall.
const stop = (signal) => { try { process.kill(-child.pid, signal); } catch {} };
const deadline = setTimeout(() => { failed = true; stop('SIGTERM'); }, 45000);
const forced = setTimeout(() => { failed = true; stop('SIGKILL'); }, 55000);
for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
    log.write(data); process.stdout.write(data);
    if (data.toString().includes('FATAL:')) failed = true;
    if (!ready && data.toString().includes('DOM SEO Tracker Lite ready')) {
        ready = true;
        setTimeout(() => {
            const pid = mainPid(child.pid);
            if (!pid) { failed = true; console.error('Cannot locate this test\'s Electron main process'); stop('SIGTERM'); return; }
            stopped = true;
            process.kill(pid, 'SIGTERM');
        }, 2000);
    }
});
child.on('error', (error) => { console.error(error); failed = true; });
child.on('close', (code) => {
    clearTimeout(deadline); clearTimeout(forced); log.end(); fs.rmSync(profile, { recursive: true, force: true });
    if (!ready || !stopped || failed || code !== 0) process.exitCode = 1;
});
