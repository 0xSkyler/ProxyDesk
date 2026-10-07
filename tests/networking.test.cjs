'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { loadTree } = require('./helpers.cjs');

test('repeated streamed HTTP errors release unused response bodies and preserve status errors', async () => {
    let unfinishedResponses = 0;
    const server = http.createServer((_request, response) => {
        unfinishedResponses++;
        response.once('close', () => unfinishedResponses--);
        response.writeHead(503, { 'Content-Type': 'text/plain' });
        response.write('temporarily unavailable'); // Deliberately never end.
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const { fetchAllWorkingProxyText } = loadTree(path.resolve(__dirname, '../src'), {}, {
        fetch: (_url, options) => fetch(url, options)
    })('proxy/AllWorkingProxyProvider.js');
    try {
        for (let i = 0; i < 5; i++) {
            await assert.rejects(fetchAllWorkingProxyText(), { message: 'Proxy API returned HTTP 503.' });
        }
        const deadline = Date.now() + 2000;
        while (unfinishedResponses && Date.now() < deadline) await pause(10);
        assert.equal(unfinishedResponses, 0, 'Error responses still have a live unread body');
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('error-body cancellation failure retains the original HTTP status error', async () => {
    const { fetchAllWorkingProxyText } = loadTree(path.resolve(__dirname, '../src'), {}, {
        fetch: async () => ({ ok: false, status: 502, body: { cancel: async () => { throw new Error('already closed'); } } })
    })('proxy/AllWorkingProxyProvider.js');
    await assert.rejects(fetchAllWorkingProxyText(), { message: 'Proxy API returned HTTP 502.' });
});
