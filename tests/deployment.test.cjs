'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('desktop relaunch clears the failed start limit and stale display credentials', () => {
    const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'proxydesk-launch-test-'));
    try {
        const installer = fs.readFileSync(path.join(__dirname, '../deploy/install-ubuntu.sh'), 'utf8');
        const launcher = installer.split("<<'LAUNCH'\n")[1].split('\nLAUNCH')[0];
        fs.writeFileSync(path.join(temporary, 'launcher'), launcher);
        fs.writeFileSync(path.join(temporary, 'failed'), 'start-limit-hit');
        fs.writeFileSync(path.join(temporary, 'systemctl'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$LAUNCH_TEST_DIR/calls"
case "$2" in
  reset-failed) rm -f "$LAUNCH_TEST_DIR/failed" ;;
  start) test ! -f "$LAUNCH_TEST_DIR/failed" ;;
esac
`, { mode: 0o755 });
        const env = { ...process.env, PATH: `${temporary}:${process.env.PATH}`, LAUNCH_TEST_DIR: temporary, DISPLAY: ':7', XAUTHORITY: '/tmp/new-session-auth' };
        delete env.WAYLAND_DISPLAY;
        const result = spawnSync('bash', [path.join(temporary, 'launcher')], { env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const calls = fs.readFileSync(path.join(temporary, 'calls'), 'utf8').trim().split('\n');
        assert.ok(calls.includes('--user import-environment DISPLAY'));
        assert.ok(calls.includes('--user import-environment XAUTHORITY'));
        assert.ok(calls.includes('--user unset-environment WAYLAND_DISPLAY'));
        assert.ok(calls.indexOf('--user reset-failed proxydesk.service') < calls.indexOf('--user start proxydesk.service'));
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
