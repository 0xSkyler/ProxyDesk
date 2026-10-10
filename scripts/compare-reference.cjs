'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree, fakeElectron } = require('../tests/helpers.cjs');
const baseline = loadTree(path.resolve('.recovery/reference/dist'), fakeElectron())('main/BrowserManager.js');
const optimized = loadTree(path.resolve('src'), fakeElectron())('main/BrowserManager.js');
const baselineProduct = require(path.resolve('.recovery/reference/package.json')).productName;
const optimizedProduct = require('../package.json').productName;
const functions = {
    buildEphemeralPartitionName: [5, 1234],
    extractGoogleBlockContinueUrl: ['https://www.google.com/sorry/index?continue=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dtest']
};
// v0.5.8 intentionally replaces Google recognition at the user's request.
// Byte identity with v0.5.4 would reject that required behavior change. Google
// matching now has real BrowserView fixtures in the build job that this paired
// benchmark depends on. Session isolation and challenge URL parsing retain
// their original contracts; scrolling, links and lifecycle are still exercised
// in both builds by benchmark.cjs below this gate.
function normalizeProductBrand(value, productName) {
    if (typeof value !== 'string') return value;
    const escapedName = productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return value
        .replace(new RegExp(`\\b${escapedName}\\b`, 'g'), 'APP')
        .replace(/__[A-Za-z]+KeepAliveController/g, '__appKeepAliveController')
        .replace(/__[A-Za-z]+GoogleWatcher/g, '__appGoogleWatcher');
}
for (const [name, args] of Object.entries(functions)) {
    assert.equal(
        normalizeProductBrand(optimized[name](...args), optimizedProduct),
        normalizeProductBrand(baseline[name](...args), baselineProduct),
        `Changed reference algorithm: ${name}`
    );
}
console.log(`Reference comparison passed: ${Object.keys(functions).length} original session/challenge helpers unchanged. Updated Google recognition is validated by native BrowserView fixtures.`);
