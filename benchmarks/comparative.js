'use strict';

// Catch-up benchmark: a client holding N stale resources resynchronizes after
// L rounds of server-side change. Every protocol runs over real loopback
// sockets, behind a TCP proxy that counts wire bytes and adds a fixed RTT.
// Each client's reconstructed state is verified against the server's.

const http = require('http');
const http2 = require('http2');
const net = require('net');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const jsonpatch = require('fast-json-patch');

const { startServer, stopServer, server: syncNetServer } = require('../server/src/index');
const { addVersion } = require('../server/src/version-store');
const { buildUpdate, JSON_PATCH } = require('../server/src/delta-engine');
const { syncRequest } = require('../client/src/sync-client');
const { applyResult } = require('../client/src/apply');

const ITEMS = 100;
const MAX_ROUNDS = 25;
const CHANGE_FRACTION = 0.2;
const ITEMS_PER_CHANGE = 3;
const RTT_MS = 40;
const REPS = 3;
const NS = [1, 10, 50, 100];
const LS = [1, 5, 25];
const H1_POOL = 6;

const PROFILES = {
  lab: {
    title: 'Lab: minimal request headers, no compression',
    headers: {},
    gzip: false,
  },
  realistic: {
    title: 'Realistic: bearer token + cookie + browser-style headers, gzip',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Authorization': `Bearer ${'x'.repeat(240)}`,
      'Cookie': `session=${'a'.repeat(110)}`,
    },
    gzip: true,
  },
};

const PROTOCOLS = [
  ['GET (full)', 'getFull'],
  ['GET + ETag', 'getEtag'],
  ['Braid-style H1', 'braidH1'],
  ['Braid-style H2', 'braidH2'],
  ['Mercure-style', 'mercure'],
  ['SYNC', 'sync'],
];

// ── Dataset ──────────────────────────────────────────────────────────────────

function rng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ('account update message report session product design review budget meeting deploy server client '
  + 'network cache release feature planning customer invoice payment shipping order status archive profile settings '
  + 'notification schedule calendar document template workflow analytics dashboard export import backup restore '
  + 'security audit policy token request response latency throughput queue worker cluster region storage index '
  + 'search filter sort render layout theme font image video audio stream upload download share comment reply '
  + 'mention thread channel project task sprint ticket issue branch merge commit build test pipeline monitor alert').split(' ');

// Seeded text so bodies have realistic (not trivially compressible) entropy.
function makeBody(id, rev) {
  const r = rng(id * 7919 + rev * 104729 + 17);
  return Array.from({ length: 14 }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
}

const makeItem = (id, rev) => ({
  id,
  title: `Post ${id}: ${makeBody(id, rev).split(' ').slice(0, 3).join(' ')}`,
  body: makeBody(id, rev),
  likes: rev * 3 + (id % 7),
  updated: `2026-10-05T10:${String(rev % 60).padStart(2, '0')}:00Z`,
});

const clone = v => JSON.parse(JSON.stringify(v));

// history[i] = [{ round, token, data }, ...]; a resource only gets a new entry in rounds where it changed.
function buildHistories(N) {
  const rand = rng(1000 + N);
  const history = [];
  for (let i = 0; i < N; i++) {
    const data = {};
    for (let id = 1; id <= ITEMS; id++) data[id] = makeItem(id, 0);
    history.push([{ round: 0, token: 'v0', data }]);
  }
  for (let r = 1; r <= MAX_ROUNDS; r++) {
    for (let i = 0; i < N; i++) {
      if (i !== r % N && rand() >= CHANGE_FRACTION) continue;
      const last = history[i][history[i].length - 1];
      const data = clone(last.data);
      const picked = new Set();
      while (picked.size < ITEMS_PER_CHANGE) picked.add(1 + Math.floor(rand() * ITEMS));
      for (const id of picked) data[id] = makeItem(id, r);
      history[i].push({ round: r, token: `v${history[i].length}`, data });
    }
  }
  return history;
}

const entryAt = (h, L) => h.filter(e => e.round <= L).pop();

// ── Latency + byte-counting TCP proxy ────────────────────────────────────────

function startProxy(targetPort, oneWayMs) {
  const stats = { up: 0, down: 0 };
  const sockets = new Set();

  // Strict FIFO per direction: independent timers with equal deadlines may fire out of order.
  function pipe(from, to, key, handshake) {
    const queue = [];
    let last = 0;
    let first = true;
    let timer = null;

    const pump = () => {
      if (timer || !queue.length) return;
      timer = setTimeout(() => {
        timer = null;
        queue.shift().fn();
        pump();
      }, Math.max(0, queue[0].at - performance.now()));
    };
    const schedule = fn => {
      let at = performance.now() + oneWayMs + (first && handshake ? 2 * oneWayMs : 0);
      first = false;
      if (at < last) at = last;
      last = at;
      queue.push({ at, fn });
      pump();
    };
    from.on('data', c => { stats[key] += c.length; schedule(() => { if (!to.destroyed) to.write(c); }); });
    from.on('end', () => schedule(() => { if (!to.destroyed) to.end(); }));
    from.on('error', () => to.destroy());
  }

  const srv = net.createServer(client => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    sockets.add(client); sockets.add(upstream);
    pipe(client, upstream, 'up', true);
    pipe(upstream, client, 'down', false);
  });

  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({
    port: srv.address().port,
    stats,
    close: () => new Promise(res => { for (const s of sockets) s.destroy(); srv.close(res); }),
  })));
}

// ── Servers ──────────────────────────────────────────────────────────────────

function respond(res, profile, req, status, headers, bodyObj) {
  if (bodyObj === undefined) { res.writeHead(status, headers); return res.end(); }
  let buf = Buffer.from(JSON.stringify(bodyObj));
  const h = { ...headers };
  if (profile.gzip && buf.length >= 1024 && /gzip/.test(req.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf);
    h['Content-Encoding'] = 'gzip';
    h['Vary'] = 'Accept-Encoding';
  }
  h['Content-Length'] = buf.length;
  res.writeHead(status, h);
  res.end(buf);
}

function makeHandler(ctx) {
  const { history, N, L, profile } = ctx;
  const current = i => entryAt(history[i], L);

  const events = [];
  for (let r = 1; r <= L; r++) {
    for (let i = 0; i < N; i++) {
      const idx = history[i].findIndex(e => e.round === r);
      if (idx < 1) continue;
      const u = buildUpdate(history[i][idx - 1].data, history[i][idx].data, [JSON_PATCH]);
      events.push({ topic: i, format: u.format, data: u.data });
    }
  }

  return (req, res) => {
    const url = new URL(req.url, 'http://x');
    const [, kind, idxStr] = url.pathname.split('/');
    const i = Number(idxStr);

    if (kind === 'full') {
      return respond(res, profile, req, 200, { 'Content-Type': 'application/json' }, current(i).data);
    }
    if (kind === 'etag') {
      const cur = current(i);
      const etag = `"${cur.token}"`;
      if (req.headers['if-none-match'] === etag) return respond(res, profile, req, 304, { ETag: etag });
      return respond(res, profile, req, 200, { 'Content-Type': 'application/json', ETag: etag }, cur.data);
    }
    if (kind === 'braid') {
      const cur = current(i);
      const parents = (req.headers['parents'] || '').replace(/"/g, '');
      if (parents === cur.token) return respond(res, profile, req, 304, { 'Current-Version': `"${cur.token}"` });
      const base = history[i].find(e => e.token === parents);
      const u = buildUpdate(base.data, cur.data, [JSON_PATCH]);
      return respond(res, profile, req, 200, {
        'Content-Type': u.format,
        'Version': `"${cur.token}"`,
        'Parents': `"${parents}"`,
        'Current-Version': `"${cur.token}"`,
      }, u.data);
    }
    if (kind === 'mercure') {
      const cursor = Number((req.headers['last-event-id'] || 'e0').slice(1));
      const topics = new Set(url.searchParams.getAll('match').map(t => Number(t.split('/')[2])));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Mercure-Last-Event-ID': `e${cursor}` });
      events.forEach((ev, n) => {
        if (n + 1 > cursor && topics.has(ev.topic)) {
          res.write(`id: e${n + 1}\ndata: ${JSON.stringify({ topic: `/r/${ev.topic}`, format: ev.format, data: ev.data })}\n\n`);
        }
      });
      return res.end();
    }
    res.writeHead(404); res.end();
  };
}

const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const close = (srv) => new Promise(r => srv.close(r));

// ── Clients ──────────────────────────────────────────────────────────────────

function clientHeaders(profile) {
  const h = { ...profile.headers };
  if (profile.gzip) h['Accept-Encoding'] = 'gzip';
  return h;
}

function h1Request(agent, port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', agent, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let raw = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') raw = zlib.gunzipSync(raw);
        resolve({ status: res.statusCode, headers: res.headers, text: raw.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function h2Request(session, p, headers) {
  return new Promise((resolve, reject) => {
    const req = session.request({ ':path': p, ...headers });
    let status;
    let resHeaders;
    const chunks = [];
    req.on('response', h => { status = h[':status']; resHeaders = h; });
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let raw = Buffer.concat(chunks);
      if (resHeaders['content-encoding'] === 'gzip') raw = zlib.gunzipSync(raw);
      resolve({ status, headers: resHeaders, text: raw.toString('utf8') });
    });
    req.on('error', reject);
    req.end();
  });
}

const baselineState = (history) => history.map(h => clone(h[0].data));

const RUNNERS = {
  async getFull(ctx, port) {
    const local = baselineState(ctx.history);
    const agent = new http.Agent({ keepAlive: true, maxSockets: H1_POOL });
    const hdrs = clientHeaders(ctx.profile);
    await Promise.all(local.map(async (_, i) => {
      local[i] = JSON.parse((await h1Request(agent, port, `/full/${i}`, hdrs)).text);
    }));
    agent.destroy();
    return { local, requests: ctx.N };
  },

  async getEtag(ctx, port) {
    const local = baselineState(ctx.history);
    const agent = new http.Agent({ keepAlive: true, maxSockets: H1_POOL });
    await Promise.all(local.map(async (_, i) => {
      const r = await h1Request(agent, port, `/etag/${i}`, { ...clientHeaders(ctx.profile), 'If-None-Match': '"v0"' });
      if (r.status === 200) local[i] = JSON.parse(r.text);
    }));
    agent.destroy();
    return { local, requests: ctx.N };
  },

  async braidH1(ctx, port) {
    const local = baselineState(ctx.history);
    const agent = new http.Agent({ keepAlive: true, maxSockets: H1_POOL });
    await Promise.all(local.map(async (_, i) => {
      const r = await h1Request(agent, port, `/braid/${i}`, { ...clientHeaders(ctx.profile), Parents: '"v0"' });
      if (r.status === 200) local[i] = applyResult(local[i], 'v0', { status: 200, format: r.headers['content-type'], from: 'v0', data: JSON.parse(r.text) });
    }));
    agent.destroy();
    return { local, requests: ctx.N };
  },

  async braidH2(ctx, port) {
    const local = baselineState(ctx.history);
    const session = http2.connect(`http://127.0.0.1:${port}`);
    await Promise.all(local.map(async (_, i) => {
      const r = await h2Request(session, `/braid/${i}`, { ...clientHeaders(ctx.profile), parents: '"v0"' });
      if (r.status === 200) local[i] = applyResult(local[i], 'v0', { status: 200, format: r.headers['content-type'], from: 'v0', data: JSON.parse(r.text) });
    }));
    await new Promise(r => session.close(r));
    return { local, requests: ctx.N };
  },

  async mercure(ctx, port) {
    const local = baselineState(ctx.history);
    const query = Array.from({ length: ctx.N }, (_, i) => `match=${encodeURIComponent(`/r/${i}`)}`).join('&');
    const text = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: `/mercure?${query}`, method: 'GET', agent: false,
        headers: { ...clientHeaders({ ...ctx.profile, gzip: false }), 'Last-Event-ID': 'e0' },
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.end();
    });
    for (const block of text.split('\n\n').filter(Boolean)) {
      const line = block.split('\n').find(l => l.startsWith('data: '));
      const ev = JSON.parse(line.slice(6));
      const i = Number(ev.topic.split('/')[2]);
      local[i] = applyResult(local[i], null, { status: 200, format: ev.format, from: null, data: ev.data });
    }
    return { local, requests: 1 };
  },

  async sync(ctx, port) {
    const local = baselineState(ctx.history);
    const baselines = {};
    for (let i = 0; i < ctx.N; i++) baselines[ctx.syncName(i)] = 'v0';
    const res = await syncRequest(`http://127.0.0.1:${port}/api/users`, baselines, { headers: ctx.profile.headers, gzip: ctx.profile.gzip });
    if (res.status === 200) {
      for (let i = 0; i < ctx.N; i++) {
        const result = res.body.results[ctx.syncName(i)];
        local[i] = applyResult(local[i], 'v0', result);
      }
    } else {
      assert.strictEqual(res.status, 204);
    }
    return { local, requests: 1 };
  },
};

// ── Orchestration ────────────────────────────────────────────────────────────

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function runOnce(key, ctx, ports) {
  const target = key === 'braidH2' ? ports.h2 : key === 'sync' ? ports.sync : ports.h1;
  const proxy = await startProxy(target, RTT_MS / 2);
  const t0 = performance.now();
  const out = await RUNNERS[key](ctx, proxy.port);
  const ms = performance.now() - t0;
  await new Promise(r => setTimeout(r, RTT_MS)); // let connection-teardown bytes pass through the proxy
  const { up, down } = proxy.stats;
  await proxy.close();

  out.local.forEach((state, i) => assert.deepStrictEqual(state, entryAt(ctx.history[i], ctx.L).data, `${key}: resource ${i} diverged`));
  return { up, down, ms, requests: out.requests };
}

async function main() {
  await new Promise(r => startServer(0, r));
  const syncPort = syncNetServer.address().port;
  const results = [];

  for (const [profileKey, profile] of Object.entries(PROFILES)) {
    for (const N of NS) {
      const history = buildHistories(N);
      for (const L of LS) {
        const syncName = i => `/b/${profileKey}/${N}/${L}/${i}`;
        for (let i = 0; i < N; i++) for (const e of history[i]) if (e.round <= L) addVersion(syncName(i), e.token, e.data);

        const ctx = { history, N, L, profile, syncName };
        const handler = makeHandler(ctx);
        const h1 = http.createServer(handler);
        const h2 = http2.createServer(handler);
        const ports = { h1: await listen(h1), h2: await listen(h2), sync: syncPort };

        const row = { profile: profileKey, N, L, changed: history.filter(h => entryAt(h, L).round > 0).length, protocols: {} };
        for (const [label, key] of PROTOCOLS) {
          if (profileKey === Object.keys(PROFILES)[0] && N === NS[0] && L === LS[0]) await runOnce(key, ctx, ports); // warm-up
          const runs = [];
          for (let k = 0; k < REPS; k++) runs.push(await runOnce(key, ctx, ports));
          row.protocols[label] = { up: runs[0].up, down: runs[0].down, requests: runs[0].requests, ms: median(runs.map(r => r.ms)) };
        }
        results.push(row);
        console.log(`done ${profileKey} N=${N} L=${L}`);
        await close(h1); await close(h2);
      }
    }
  }

  await new Promise(r => stopServer(r));
  return results;
}

// ── Report ───────────────────────────────────────────────────────────────────

const kb = n => `${(n / 1024).toFixed(1)}`;

function report(results) {
  const labels = PROTOCOLS.map(p => p[0]);
  let md = `# SYNC vs GET, Braid-style, and Mercure-style: catch-up benchmark\n\n`;
  md += `**Run at:** ${new Date().toISOString()} on Node ${process.version}\n\n`;
  md += `## What is measured\n\n`;
  md += `A client holds N resources (100 items each, about 20 KB as JSON) at round 0. The server has advanced L rounds. Each round, about ${CHANGE_FRACTION * 100}% of resources change (at least one), and each changed resource has ${ITEMS_PER_CHANGE} of its 100 items modified. The client must bring all N resources current and its reconstructed state is checked against the server's (any mismatch aborts the run).\n\n`;
  md += `- **Bytes** are measured at a TCP proxy between client and server and include HTTP/2 framing and all headers, both directions. TLS is not modelled.\n`;
  md += `- **Time** is wall clock with the proxy adding a ${RTT_MS} ms RTT and one RTT for each new TCP connection. It models latency, not bandwidth or server load. Median of ${REPS} runs. Connections are cold, as when an app resumes.\n`;
  md += `- All delta protocols use the same JSON Patch generator and the same "snapshot if smaller" rule, so differences come from protocol framing, request count, and coalescing, not from the diff algorithm.\n\n`;
  md += `## Protocols\n\n`;
  md += `- **GET (full)**: N plain GETs, HTTP/1.1, pool of ${H1_POOL} keep-alive connections.\n`;
  md += `- **GET + ETag**: as above with \`If-None-Match\`; unchanged resources return 304.\n`;
  md += `- **Braid-style H1 / H2**: per-resource \`GET\` with \`Parents\`, server returns a JSON Patch (or 304). Modelled on draft-toomim-httpbis-braid-http-04 Section 2.4/3.2, not the Braid reference implementation. H2 is cleartext HTTP/2 with all N requests multiplexed on one connection.\n`;
  md += `- **Mercure-style**: one SSE request with N topic matchers and \`Last-Event-ID\`, hub replays every event after the cursor as it occurred (one JSON Patch event per resource per round). Modelled on draft-dunglas-mercure-08, not the Mercure hub. The stream is closed after replay (a real subscriber would keep it open) and responses are not compressed.\n`;
  md += `- **SYNC**: the reference server and client in this repository: one request, N baselines.\n\n`;
  md += `## Caveats\n\n`;
  md += `- The Braid-style and Mercure-style servers are minimal re-implementations written for this benchmark, not the projects' own software.\n`;
  md += `- The SYNC server closes the connection after each response (no keep-alive), so SYNC pays a TCP handshake per request. This hurts it in the time columns for repeated polling; every run here is a single cold exchange so it does not distort these numbers.\n`;
  md += `- Only the catch-up exchange is measured. Braid and Mercure also provide live push, which SYNC does not.\n`;
  md += `- Mercure's replay is history, not state: the client receives every intermediate patch. That is a feature when history matters and a cost when it does not.\n\n`;

  for (const [profileKey, profile] of Object.entries(PROFILES)) {
    const rows = results.filter(r => r.profile === profileKey);
    md += `## ${profile.title}\n\n### Total wire bytes (KB, both directions)\n\n`;
    md += `| N | L | changed | ${labels.join(' | ')} |\n|${'---|'.repeat(labels.length + 3)}\n`;
    for (const r of rows) {
      md += `| ${r.N} | ${r.L} | ${r.changed} | ${labels.map(l => kb(r.protocols[l].up + r.protocols[l].down)).join(' | ')} |\n`;
    }
    md += `\n### Bytes as a fraction of GET (full)\n\n| N | L | ${labels.slice(1).join(' | ')} |\n|${'---|'.repeat(labels.length + 1)}\n`;
    for (const r of rows) {
      const base = r.protocols[labels[0]].up + r.protocols[labels[0]].down;
      md += `| ${r.N} | ${r.L} | ${labels.slice(1).map(l => `${(((r.protocols[l].up + r.protocols[l].down) / base) * 100).toFixed(1)}%`).join(' | ')} |\n`;
    }
    md += `\n### Wall time (ms, simulated ${RTT_MS} ms RTT)\n\n| N | L | ${labels.join(' | ')} |\n|${'---|'.repeat(labels.length + 2)}\n`;
    for (const r of rows) {
      md += `| ${r.N} | ${r.L} | ${labels.map(l => Math.round(r.protocols[l].ms)).join(' | ')} |\n`;
    }
    md += `\n### Requests made\n\n| N | ${labels.join(' | ')} |\n|${'---|'.repeat(labels.length + 1)}\n`;
    for (const r of rows.filter(x => x.L === LS[0])) {
      md += `| ${r.N} | ${labels.map(l => r.protocols[l].requests).join(' | ')} |\n`;
    }
    md += '\n';
  }
  return md;
}

main().then(results => {
  const dir = __dirname;
  fs.writeFileSync(path.join(dir, 'comparative-results.json'), JSON.stringify(results, null, 2));
  const md = report(results);
  fs.writeFileSync(path.join(dir, 'comparative-results.md'), md);
  console.log(md);
  process.exit(0);
}).catch(err => { console.error(err); process.exit(1); });
