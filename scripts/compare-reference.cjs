'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree, fakeElectron } = require('../tests/helpers.cjs');
const baseline = loadTree(path.resolve('.recovery/reference/dist'), fakeElectron())('main/BrowserManager.js');
const optimized = loadTree(path.resolve('src'), fakeElectron())('main/BrowserManager.js');
const functions = {
    buildEphemeralPartitionName: [5, 1234],
    extractGoogleBlockContinueUrl: ['https://www.google.com/sorry/index?continue=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dtest'],
    buildInstallGoogleLiveTargetObserverScript: ['fixture.local', 'first keyword'],
    buildReadGoogleLiveTargetObserverScript: [],
    buildClickGoogleLiveTargetObserverScript: [],
    buildStopGoogleLiveTargetObserverScript: [],
    buildGoogleResultScanScript: ['fixture.local', 'first keyword'],
    buildClickGoogleTargetResultScript: ['fixture.local', 'first keyword']
};
for (const [name, args] of Object.entries(functions)) assert.equal(optimized[name](...args), baseline[name](...args), `Changed reference algorithm: ${name}`);
console.log(`Reference comparison passed: ${Object.keys(functions).length} original session/Google algorithms unchanged.`);
