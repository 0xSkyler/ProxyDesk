'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const runtime = require('electron');
const tests = fs.readdirSync(path.join(root, 'tests')).filter((name) => name.endsWith('.test.cjs'))
    .map((name) => path.join(root, 'tests', name));
const result = spawnSync(runtime, ['--test', '--test-reporter=tap', ...tests], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) throw result.error;
assert.equal(result.status, 0, `Bundled Node exited with status ${result.status}`);
// Electron's Windows GUI executable may exit zero despite node:test failures.
// Enforce the runner's TAP summary as well as its actual process exit status.
const summary = (key) => Number(result.stdout.match(new RegExp(`^# ${key} (\\d+)\\r?$`, 'm'))?.[1] ?? NaN);
assert.ok(summary('tests') > 0 && summary('pass') > 0, 'Bundled runtime executed no tests');
assert.equal(summary('fail'), 0, 'Bundled runtime reported failed tests');
assert.equal(summary('cancelled'), 0, 'Bundled runtime reported cancelled tests');
