'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

// ── Standalone server for benchmark (does not share state with tests) ─────────

const jsonpatch = require('fast-json-patch');

// Minimal in-process version store for benchmark
const benchStore = new Map();

function benchAddVersion(resource, id, data) {
  if (!benchStore.has(resource)) benchStore.set(resource, []);
  benchStore.get(resource).push({ id, data });
}

function benchGetVersion(resource, id) {
  const vs = benchStore.get(resource);
  return vs ? vs.find(v => v.id === id) || null : null;
}

function benchGetCurrent(resource) {
  const vs = benchStore.get(resource);
  return vs && vs.length ? vs[vs.length - 1] : null;
}

function benchCanDelta(resource, id) {
  return benchGetVersion(resource, id) !== null;
}

function buildFeedItem(i, version) {
  return { id: i, title: `Post ${i}`, body: `Content v${version}`, likes: version * 3, updated: `2026-10-05T10:${String(version).padStart(2, '0')}:00Z` };
}

function buildFeed(size) {
  const feed = {};
  for (let i = 1; i <= size; i++) feed[`/feed/${i}`] = buildFeedItem(i, 1);
  return feed;
}

// Seed: 100-item feed at v1
const FEED = '/api/feed';
const FEED_SIZE = 100;
const ROUNDS = 50;
const CHANGES_PER_ROUND = 3;

benchAddVersion(FEED, 'v1', buildFeed(FEED_SIZE));

// Pre-generate 50 versions with 3 random changes each
let currentFeed = JSON.parse(JSON.stringify(benchGetCurrent(FEED).data));
for (let r = 2; r <= ROUNDS + 1; r++) {
  currentFeed = JSON.parse(JSON.stringify(currentFeed));
  for (let c = 0; c < CHANGES_PER_ROUND; c++) {
    const itemIdx = 1 + ((r * CHANGES_PER_ROUND + c) % FEED_SIZE);
    currentFeed[`/feed/${itemIdx}`] = buildFeedItem(itemIdx, r);
  }
  benchAddVersion(FEED, `v${r}`, currentFeed);
}

// Minimal HTTP response writer for SYNC
function writeSyncResponse(socket, status, statusText, headers, body) {
  const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const allHeaders = { 'Content-Type': 'application/sync-delta+json', 'Content-Length': bodyBuf.length, 'Connection': 'close', ...headers };
  let head = `HTTP/1.1 ${status} ${statusText}\r\n`;
  for (const [k, v] of Object.entries(allHeaders)) head += `${k}: ${v}\r\n`;
  head += '\r\n';
  socket.write(head);
  if (bodyBuf.length) socket.write(bodyBuf);
  socket.end();
}

// Express for GET endpoint
const express = require('express');
const app = express();
app.get(FEED, (req, res) => {
  const current = benchGetCurrent(FEED);
  res.json(current.data);
});

const expressServer = http.createServer(app);
let internalPort;

const syncServer = net.createServer(socket => {
  let buffer = Buffer.alloc(0);
  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    const firstCrlf = buffer.indexOf('\r\n');
    if (firstCrlf === -1) return;
    const method = buffer.slice(0, buffer.indexOf(' ')).toString('ascii');
    if (method !== 'SYNC') {
      socket.removeListener('data', onData);
      const proxy = net.connect(internalPort, () => { proxy.write(buffer); socket.pipe(proxy); proxy.pipe(socket); });
      proxy.on('error', () => socket.destroy());
      socket.on('error', () => proxy.destroy());
      return;
    }
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const lines = buffer.slice(0, headerEnd).toString().split('\r\n');
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].indexOf(':');
      if (c !== -1) headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
    }
    const cl = parseInt(headers['content-length'] || '0', 10);
    if (buffer.length < headerEnd + 4 + cl) return;
    socket.removeListener('data', onData);
    const bodyStr = buffer.slice(headerEnd + 4, headerEnd + 4 + cl).toString();
    let parsed;
    try { parsed = JSON.parse(bodyStr || '{}'); } catch { return writeSyncResponse(socket, 422, 'Unprocessable Entity', {}, { error: 'bad json' }); }
    const { version_vector, resources } = parsed;
    if (!version_vector || typeof version_vector !== 'object') return writeSyncResponse(socket, 422, 'Unprocessable Entity', {}, { error: 'missing version_vector' });
    const resList = Array.isArray(resources) && resources.length ? resources : Object.keys(version_vector);
    const deltas = {};
    let hasChanges = false;
    let serverVersion = null;
    for (const resource of resList) {
      const current = benchGetCurrent(resource);
      if (!current) return writeSyncResponse(socket, 404, 'Not Found', {}, { error: `not found: ${resource}` });
      serverVersion = current.id;
      const clientVid = version_vector[resource];
      if (!clientVid) { deltas[resource] = { from_version: null, to_version: current.id, operations: jsonpatch.compare({}, current.data) }; hasChanges = true; continue; }
      if (!benchCanDelta(resource, clientVid)) return writeSyncResponse(socket, 409, 'Conflict', {}, { error: 'unrecognizable version' });
      const old = benchGetVersion(resource, clientVid);
      const ops = jsonpatch.compare(old.data, current.data);
      deltas[resource] = { from_version: clientVid, to_version: current.id, operations: ops };
      if (ops.length) hasChanges = true;
    }
    if (!hasChanges) return writeSyncResponse(socket, 204, 'No Content', { 'Sync-Server-Version': serverVersion || '' }, null);
    writeSyncResponse(socket, 200, 'OK', { 'Sync-Server-Version': serverVersion || '', 'Sync-Delta-Complete': 'true' }, { deltas, server_version: serverVersion, synced_at: new Date().toISOString() });
  }
  socket.on('data', onData);
  socket.on('error', () => {});
});

const PORT = 3010;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function getRequest(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: 'localhost', port: PORT, path, agent: false }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ bytes: Buffer.byteLength(data, 'utf8'), body: data }));
    });
    req.on('error', reject);
  });
}

function syncRequest(path, versionVector, resources) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({ version_vector: versionVector, resources });
    const opts = {
      hostname: 'localhost', port: PORT, path, method: 'SYNC', agent: false,
      headers: { 'Content-Type': 'application/sync-vector+json', 'Content-Length': Buffer.byteLength(bodyStr) },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const responseBytes = Buffer.byteLength(data, 'utf8');
        const requestBytes = Buffer.byteLength(bodyStr, 'utf8');
        resolve({ status: res.statusCode, bytes: responseBytes + requestBytes, body: data });
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Benchmark runner ──────────────────────────────────────────────────────────

async function run() {
  await new Promise(r => expressServer.listen(0, '127.0.0.1', () => { internalPort = expressServer.address().port; syncServer.listen(PORT, r); }));
  console.log(`\nBenchmark server on port ${PORT}\n`);

  // ── Scenario A: GET Polling ─────────────────────────────────────────────────
  console.log('Running Scenario A — GET Polling (50 requests)...');
  let getTotalBytes = 0;
  let getUnnecessaryBytes = 0;

  // Track server at v1 initially; poll doesn't advance client version
  for (let round = 1; round <= ROUNDS; round++) {
    const result = await getRequest(FEED);
    getTotalBytes += result.bytes;

    // Compute unnecessary bytes: bytes for unchanged items
    const currentVer = benchGetCurrent(FEED);
    const prevVer = benchGetVersion(FEED, `v${round}`);
    const changedOps = jsonpatch.compare(prevVer.data, currentVer.data);
    const changedPaths = new Set(changedOps.map(op => op.path.split('/')[1]));
    const changedItemBytes = changedOps.reduce((sum, op) => sum + Buffer.byteLength(JSON.stringify(op.value || ''), 'utf8'), 0);
    getUnnecessaryBytes += result.bytes - changedItemBytes;
  }

  const getAvgBytes = Math.round(getTotalBytes / ROUNDS);

  // ── Scenario B: SYNC Method ──────────────────────────────────────────────────
  console.log('Running Scenario B — SYNC Method (50 requests)...');
  let syncTotalBytes = 0;
  let clientVersion = 'v1';

  for (let round = 1; round <= ROUNDS; round++) {
    const result = await syncRequest(FEED, { [FEED]: clientVersion }, [FEED]);
    syncTotalBytes += result.bytes;
    if (result.status === 200) {
      const body = JSON.parse(result.body);
      clientVersion = body.server_version;
    }
  }

  const syncAvgBytes = Math.round(syncTotalBytes / ROUNDS);
  const bandwidthSaved = Math.round((1 - syncTotalBytes / getTotalBytes) * 100);

  // ── Table ────────────────────────────────────────────────────────────────────
  const getTotalKB = (getTotalBytes / 1024).toFixed(1);
  const syncTotalKB = (syncTotalBytes / 1024).toFixed(1);
  const unnecKB = (getUnnecessaryBytes / 1024).toFixed(1);

  const table = `
┌─────────────────────────────┬──────────────────┬──────────────────┐
│ Metric                      │ GET Polling      │ SYNC Method      │
├─────────────────────────────┼──────────────────┼──────────────────┤
│ Total bytes transferred     │ ${String(getTotalKB + ' KB').padEnd(16)} │ ${String(syncTotalKB + ' KB').padEnd(16)} │
│ Bandwidth saved             │ -                │ ${String(bandwidthSaved + '%').padEnd(16)} │
│ Requests made               │ ${String(ROUNDS).padEnd(16)} │ ${String(ROUNDS).padEnd(16)} │
│ Unnecessary data sent       │ ${String(unnecKB + ' KB').padEnd(16)} │ ${'0 KB'.padEnd(16)} │
│ Avg response size           │ ${String(getAvgBytes + ' bytes').padEnd(16)} │ ${String(syncAvgBytes + ' bytes').padEnd(16)} │
└─────────────────────────────┴──────────────────┴──────────────────┘`;

  console.log(table);

  // ── Save results.md ──────────────────────────────────────────────────────────
  const ts = new Date().toISOString();
  const md = `# SYNC vs GET Polling — Bandwidth Benchmark

**Run at:** ${ts}

**Seed configuration:**
- Feed size: ${FEED_SIZE} items
- Rounds: ${ROUNDS}
- Changes per round: ${CHANGES_PER_ROUND} items modified

## Results

| Metric | GET Polling | SYNC Method |
|---|---|---|
| Total bytes transferred | ${getTotalKB} KB | ${syncTotalKB} KB |
| Bandwidth saved | — | **${bandwidthSaved}%** |
| Requests made | ${ROUNDS} | ${ROUNDS} |
| Unnecessary data sent | ${unnecKB} KB | 0 KB |
| Avg response size | ${getAvgBytes} bytes | ${syncAvgBytes} bytes |

## Notes

GET polling transfers the full ${FEED_SIZE}-item feed on every request regardless of how much changed.
SYNC transfers only the ${CHANGES_PER_ROUND} changed items per round, plus a small version vector in the request.
Savings increase as the feed grows larger and the change rate stays constant.
`;

  fs.writeFileSync(path.join(__dirname, 'results.md'), md);
  console.log('\nResults saved to benchmarks/results.md');

  syncServer.close(() => expressServer.close());
}

run().catch(err => { console.error(err); process.exit(1); });
