'use strict';

// Writes benchmark: concurrent writers over a 40 ms round trip.
//
// 1. Transfers. W writers each move one unit between two of ACCOUNTS accounts,
//    T times, while readers keep reading all accounts. Every committed state has
//    the same total.
//    - HTTP: GET both accounts, then PUT each with If-Match; if the second PUT
//      fails, the first is undone (another conditional PUT) and the transfer retried.
//      Readers GET every account (in parallel).
//    - SYNC: one atomic write of both accounts from the versions held; retried on
//      409 after catching up. Readers send one consistent request.
//    Measured: completed transfers per second, retries, the final total, and reads
//    whose total is wrong (states that never existed).
//
// 2. Edits to one text document. W writers each make E edits: each replaces a few
//    characters at a random place with a unique marker.
//    - HTTP, If-Match: GET, edit, PUT the whole document; on 412, start again.
//    - HTTP, last writer wins: GET, edit, PUT without a condition.
//    - SYNC, merge: the client sends a splice from the version it holds; the server
//      rebases it onto newer versions unless it overlaps another edit (then the
//      client catches up and edits again).
//    Measured: edits per second, retries, bytes, and acknowledged edits missing
//    from the final document (lost updates).

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { syncHandler, createMemoryStore } = require('../server/src/package');
const { createSyncClient, SyncError } = require('../client/src/index');
const { startProxy } = require('./lib/proxy');
const { rng } = require('./lib/dataset');

const RTT_MS = 40;
const W = Number(process.env.W || 10);
const T = Number(process.env.T || 20);
const E = Number(process.env.E || 20);
const READERS = 5;
const ACCOUNTS = 20;
const START = 1000;
const accountNames = prefix => Array.from({ length: ACCOUNTS }, (_, i) => `${prefix}${i}`);
const pickPair = random => {
  const a = Math.floor(random() * ACCOUNTS);
  let b = Math.floor(random() * (ACCOUNTS - 1));
  if (b >= a) b++;
  return [a, b];
};

let versionCounter = 0;
const newVersion = () => `w${++versionCounter}`;

// ── Origin: SYNC and plain HTTP (GET/PUT with ETag and If-Match) on one store ──

function startOrigin() {
  const store = createMemoryStore({ maxVersions: 50 });
  const sync = syncHandler({ store, newVersion });
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/sync')) return sync(req, res, () => { res.statusCode = 404; res.end(); });
    // Plain HTTP: the resource name is the path; the version is the ETag.
    const name = req.url;
    if (req.method === 'GET') {
      const cur = store.getCurrent(name);
      if (!cur) { res.statusCode = 404; return res.end(); }
      res.setHeader('ETag', `"${cur.version}"`);
      res.setHeader('Content-Type', cur.type);
      return res.end(cur.type === 'application/json' ? JSON.stringify(cur.data) : cur.data);
    }
    if (req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const cur = store.getCurrent(name);
      const ifMatch = req.headers['if-match'];
      if (ifMatch && (!cur || ifMatch !== `"${cur.version}"`)) { res.statusCode = 412; return res.end(); }
      const type = req.headers['content-type'];
      const version = newVersion();
      const out = store.write([{ resource: name, expect: cur ? cur.version : null, version, type, data: type === 'application/json' ? JSON.parse(body) : body }]);
      if (!out.ok) { res.statusCode = 412; return res.end(); }
      res.statusCode = 204;
      res.setHeader('ETag', `"${version}"`);
      return res.end();
    }
    res.statusCode = 405;
    res.end();
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ store, port: server.address().port, close: () => { server.closeAllConnections(); server.close(); } })));
}

const agentFor = () => new http.Agent({ keepAlive: true, maxSockets: 6 });

function request(port, agent, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent, headers: { ...headers, ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, etag: res.headers.etag, text: d }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const fetchVia = port => (u, init) => {
  const url = new URL(u);
  url.host = `127.0.0.1:${port}`;
  return fetch(url, init);
};

// ── 1. Transfers ─────────────────────────────────────────────────────────────

async function transfersHttp(origin, proxy) {
  const { store } = origin;
  const names = accountNames('/http/acct');
  for (const n of names) store.addVersion(n, newVersion(), { balance: START });
  let retries = 0;
  let undos = 0;
  let stop = false;
  let reads = 0;
  let torn = 0;
  const readers = Array.from({ length: READERS }, async () => {
    const agent = agentFor();
    while (!stop) {
      const all = await Promise.all(names.map(n => request(proxy.port, agent, 'GET', n)));
      reads++;
      if (all.reduce((sum, r) => sum + JSON.parse(r.text).balance, 0) !== ACCOUNTS * START) torn++;
    }
    agent.destroy();
  });
  const t0 = performance.now();
  await Promise.all(Array.from({ length: W }, async (_, w) => {
    const agent = agentFor();
    const random = rng(1000 + w);
    for (let t = 0; t < T; t++) {
      const [i, j] = pickPair(random);
      const [from, to] = [names[i], names[j]];
      const put = (n, etag, balance) => request(proxy.port, agent, 'PUT', n, { headers: { 'If-Match': etag, 'Content-Type': 'application/json' }, body: JSON.stringify({ balance }) });
      for (;;) {
        const [src, dst] = await Promise.all([from, to].map(n => request(proxy.port, agent, 'GET', n)));
        const first = await put(from, src.etag, JSON.parse(src.text).balance - 1);
        if (first.status === 412) { retries++; continue; }
        const second = await put(to, dst.etag, JSON.parse(dst.text).balance + 1);
        if (second.status === 412) {
          // Undo the debit, which may itself have to be retried.
          retries++;
          undos++;
          for (;;) {
            const cur = await request(proxy.port, agent, 'GET', from);
            const undo = await put(from, cur.etag, JSON.parse(cur.text).balance + 1);
            if (undo.status !== 412) break;
          }
          continue;
        }
        break;
      }
    }
    agent.destroy();
  }));
  const seconds = (performance.now() - t0) / 1000;
  stop = true;
  await Promise.all(readers);
  const total = names.reduce((sum, n) => sum + store.getCurrent(n).data.balance, 0);
  return { label: 'HTTP: two PUTs with If-Match, undo on failure', perSecond: (W * T) / seconds, retries, undos, total, reads, torn };
}

async function transfersSync(origin, proxy) {
  const { store } = origin;
  const names = accountNames('/acct');
  store.commit(names.map(n => ({ resource: n, version: newVersion(), data: { balance: START } })));
  const url = `http://sync.example/sync`;
  let retries = 0;
  let stop = false;
  let reads = 0;
  let torn = 0;
  const readers = Array.from({ length: READERS }, async () => {
    const client = createSyncClient(url, { fetch: fetchVia(proxy.port), transport: 'query' });
    while (!stop) {
      const { values } = await client.sync(names, { consistent: true });
      reads++;
      if (names.reduce((sum, n) => sum + values[n].balance, 0) !== ACCOUNTS * START) torn++;
    }
  });
  const t0 = performance.now();
  await Promise.all(Array.from({ length: W }, async (_, w) => {
    const client = createSyncClient(url, { fetch: fetchVia(proxy.port), transport: 'query' });
    const random = rng(1000 + w);
    for (let t = 0; t < T; t++) {
      const [i, j] = pickPair(random);
      const [from, to] = [names[i], names[j]];
      await client.sync([from, to]);
      for (;;) {
        try {
          await client.write({
            [from]: { value: { balance: client.get(from).balance - 1 } },
            [to]: { value: { balance: client.get(to).balance + 1 } },
          });
          break;
        } catch (e) {
          if (!(e instanceof SyncError) || e.status !== 409) throw e;
          retries++;
          await client.sync([from, to]);
        }
      }
    }
  }));
  const seconds = (performance.now() - t0) / 1000;
  stop = true;
  await Promise.all(readers);
  const total = names.reduce((sum, n) => sum + store.getCurrent(n).data.balance, 0);
  return { label: 'SYNC: one atomic write of both accounts', perSecond: (W * T) / seconds, retries, undos: 0, total, reads, torn };
}

// ── 2. Edits to one text document ────────────────────────────────────────────

const initialText = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: the quick brown fox jumps over the lazy dog.`).join('\n') + '\n';

// Replaces 0 to 3 characters of the original text at a random place with a unique
// marker. Earlier markers are never touched, so every marker an acknowledged edit
// wrote must be in the final document: one that is missing was overwritten.
const MARKER = /<\d+\.\d+>/g;
function edit(text, marker, random) {
  const cps = Array.from(text);
  const taken = [];
  let pos = 0;
  let m;
  const ranges = [];
  MARKER.lastIndex = 0;
  while ((m = MARKER.exec(text))) ranges.push([m.index, m.index + m[0].length]);
  // Code-point positions of the markers (all markers are ASCII, but the text before them may not be).
  for (const [s, e] of ranges) {
    const start = Array.from(text.slice(0, s)).length;
    taken.push([start, start + (e - s)]);
  }
  for (;;) {
    const at = Math.floor(random() * (cps.length + 1));
    const del = Math.min(Math.floor(random() * 4), cps.length - at);
    if (taken.some(([s, e]) => at < e && at + del > s) || taken.some(([s, e]) => at > s && at < e)) continue;
    pos = at;
    cps.splice(pos, del, ...Array.from(marker));
    return cps.join('');
  }
}

async function editsHttp(origin, proxy, ifMatch) {
  const { store } = origin;
  const name = ifMatch ? '/http/doc-ifmatch' : '/http/doc-lww';
  store.addVersion(name, newVersion(), initialText, 'text/plain');
  let retries = 0;
  const acknowledged = [];
  const t0 = performance.now();
  await Promise.all(Array.from({ length: W }, async (_, w) => {
    const agent = agentFor();
    const random = rng(2000 + w);
    for (let e = 0; e < E; e++) {
      const marker = `<${w}.${e}>`;
      for (;;) {
        const cur = await request(proxy.port, agent, 'GET', name);
        const next = edit(cur.text, marker, random);
        const put = await request(proxy.port, agent, 'PUT', name, { headers: { 'Content-Type': 'text/plain', ...(ifMatch ? { 'If-Match': cur.etag } : {}) }, body: next });
        if (put.status === 412) { retries++; continue; }
        acknowledged.push(marker);
        break;
      }
    }
    agent.destroy();
  }));
  const seconds = (performance.now() - t0) / 1000;
  const final = store.getCurrent(name).data;
  const lost = acknowledged.filter(m => !final.includes(m)).length;
  return { label: ifMatch ? 'HTTP: PUT the whole document with If-Match, retry on 412' : 'HTTP: PUT the whole document, last writer wins', perSecond: (W * E) / seconds, retries, lost, acknowledged: acknowledged.length };
}

async function editsSync(origin, proxy) {
  const { store } = origin;
  store.addVersion('/doc', newVersion(), initialText, 'text/plain');
  const url = `http://sync.example/sync`;
  let retries = 0;
  const acknowledged = [];
  const t0 = performance.now();
  await Promise.all(Array.from({ length: W }, async (_, w) => {
    const client = createSyncClient(url, { fetch: fetchVia(proxy.port), transport: 'query' });
    const random = rng(2000 + w);
    await client.sync(['/doc']);
    for (let e = 0; e < E; e++) {
      const marker = `<${w}.${e}>`;
      for (;;) {
        try {
          await client.write({ '/doc': { value: edit(client.get('/doc'), marker, random) } }, { merge: true });
          acknowledged.push(marker);
          break;
        } catch (err) {
          if (!(err instanceof SyncError) || err.status !== 409) throw err;
          retries++;
          await client.sync(['/doc']);
        }
      }
    }
  }));
  const seconds = (performance.now() - t0) / 1000;
  const final = store.getCurrent('/doc').data;
  const lost = acknowledged.filter(m => !final.includes(m)).length;
  return { label: 'SYNC: splice from the version held, merged by the server', perSecond: (W * E) / seconds, retries, lost, acknowledged: acknowledged.length };
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function measure(fn, ...args) {
  const origin = await startOrigin();
  const proxy = await startProxy(origin.port, RTT_MS / 2);
  const row = await fn(origin, proxy, ...args);
  row.bytes = proxy.stats.up + proxy.stats.down;
  await proxy.close();
  origin.close();
  console.log(JSON.stringify(row));
  return row;
}

async function main() {
  const transfers = [await measure(transfersHttp), await measure(transfersSync)];
  const edits = [await measure(editsHttp, true), await measure(editsHttp, false), await measure(editsSync)];
  return { transfers, edits };
}

function report({ transfers, edits }) {
  const kb = n => (n / 1024).toFixed(0);
  let md = `# Concurrent writes\n\n**Run at:** ${new Date().toISOString()} on Node ${process.version}\n\n`;
  md += `All clients reach the server over a ${RTT_MS} ms round trip.\n\n`;
  md += `## Transfers between accounts\n\n${W} writers each make ${T} transfers of one unit between two of ${ACCOUNTS} accounts (chosen at random) that start at ${START} each, while ${READERS} readers keep reading every account. Every committed state totals ${ACCOUNTS * START}.\n\n`;
  md += `| Approach | Transfers per second | Retries | Undone debits | Final total | Reads with a wrong total | Bytes (KB) |\n|---|---|---|---|---|---|---|\n`;
  for (const r of transfers) md += `| ${r.label} | ${r.perSecond.toFixed(1)} | ${r.retries} | ${r.undos} | ${r.total} | ${r.torn} of ${r.reads} (${((r.torn / r.reads) * 100).toFixed(1)}%) | ${kb(r.bytes)} |\n`;
  md += `\n## Edits to one text document\n\n${W} writers each make ${E} edits to one document of about ${(initialText.length / 1024).toFixed(1)} KB: each replaces up to 3 characters of the original text at a random place with a unique marker. Edits never touch earlier markers, so an acknowledged edit whose marker is missing from the final document was overwritten.\n\n`;
  md += `| Approach | Edits per second | Retries | Acknowledged edits lost | Bytes (KB) |\n|---|---|---|---|---|\n`;
  for (const r of edits) md += `| ${r.label} | ${r.perSecond.toFixed(1)} | ${r.retries} | ${r.lost} of ${r.acknowledged} | ${kb(r.bytes)} |\n`;
  md += `\n## How to read this\n\n`;
  md += `- **Transfers**: with separate requests, readers can see one account debited and the other not yet credited, and when the second write fails the first has to be undone by yet another request. An atomic write changes both or neither, and consistent reads see only committed states.\n`;
  md += `- **Edits**: a conditional PUT of the whole document fails whenever another writer got in first, and the whole document travels each time; without a condition, concurrent edits overwrite each other. SYNC sends only the edit and the server merges edits to different places; only edits that overlap are retried.\n`;
  md += `- Braid's merge types (for example braid-text) also merge concurrent text edits without retries; this benchmark compares SYNC with plain HTTP.\n`;
  return md;
}

main().then(out => {
  fs.writeFileSync(path.join(__dirname, 'writes-results.json'), JSON.stringify({ W, T, E, ...out }, null, 2));
  const md = report(out);
  fs.writeFileSync(path.join(__dirname, 'writes-results.md'), md);
  console.log(md);
  for (const r of out.transfers) assert.strictEqual(r.total, ACCOUNTS * START, `${r.label}: money created or destroyed`);
  process.exit(0);
}).catch(err => { console.error(err); process.exit(1); });
