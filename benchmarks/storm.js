'use strict';

// Reconnect-storm benchmark. K clients reconnect within one second of each other,
// L rounds after the last time they were in sync, and catch up through a shared
// cache (nginx, as a CDN edge). Measured at the origin: requests, bytes, CPU time
// and updates computed; measured at the clients: bytes, requests, time. Every
// client's final state is checked against the server's.
//
// Two scenarios:
//   same state:       every client holds the same versions (the server, or the
//                     connection to it, went down while all clients were current)
//   different states: each client went offline after one of rounds 0..L-1
//
// Requires Docker (nginx:1.27-alpine, and dunglas/mercure for the Mercure rows;
// see benchmarks/README.md).

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { fork, spawn, execFileSync } = require('child_process');
const undici = require('undici');
const { fetch: braidFetch } = require('braid-http');

const { syncRequest } = require('../client/src/sync-client');
const { syncFetch } = require('../client/src/fetch-client');
const { applyResult } = require('../client/src/apply');
const { startProxyProcess } = require('./lib/proxy-process');
const { buildHistories, entryAt, clone, rng } = require('./lib/dataset');
const { applyBraid } = require('./lib/braid');
const { applyUpdate } = require('./lib/updates');
const { MERCURE_URL, mercureAvailable, mercureSetup } = require('./lib/mercure');

const K = Number(process.env.K || 100);
const N = 50;
const L = 5;
const RTT_MS = 40;
const POOL = 6;
const EDGE_PORT = 3490;
// Clients arrive within this window (seeded), as reconnecting clients do with jitter;
// it also keeps connection bursts within the operating system's accept queue (macOS
// caps it at 128), so runs with many more clients need a longer window (WINDOW_MS).
const ARRIVAL_WINDOW_MS = Number(process.env.WINDOW_MS || 1000);
const LINK_SECRET = 'storm-benchmark-link-secret-0123456789';
const CONF = path.join(__dirname, 'storm', 'nginx.generated.conf');
const IDENTITY = { 'Accept-Encoding': 'identity' };

const history = buildHistories(N);
const expected = history.map(h => entryAt(h, L).data);

const SCENARIOS = [
  { key: 'same', name: 'Same state: every client was current at round 0', round: () => 0 },
  { key: 'spread', name: `Different states: each client went offline after one of rounds 0 to ${L - 1}`, round: (() => { const r = rng(11); return () => Math.floor(r() * L); })() },
];

// ── Infrastructure ───────────────────────────────────────────────────────────

// A fresh origin per variant, so no variant benefits from updates another computed.
function startOrigin() {
  const child = fork(path.join(__dirname, 'storm', 'origin.js'), [], { env: { ...process.env, N: String(N), L: String(L), LINK_SECRET } });
  const pending = [];
  child.on('message', m => { if (m.stats) pending.shift()(m.stats); });
  return new Promise(resolve => child.once('message', m => resolve({
    port: m.port,
    stats: () => new Promise(r => { pending.push(r); child.send('stats'); }),
    stop: () => child.kill(),
  })));
}

function startEdge(originPort) {
  const conf = fs.readFileSync(path.join(__dirname, 'storm', 'nginx.conf.template'), 'utf8').replace('__ORIGIN_PORT__', String(originPort));
  fs.writeFileSync(CONF, conf);
  execFileSync('docker', ['rm', '-f', 'sync-storm-edge'], { stdio: 'ignore' });
  execFileSync('docker', ['run', '-d', '--name', 'sync-storm-edge', '-p', `127.0.0.1:${EDGE_PORT}:80`, '-v', `${CONF}:/etc/nginx/nginx.conf:ro`, 'nginx:1.27-alpine'], { stdio: 'ignore' });
  return waitFor(`http://127.0.0.1:${EDGE_PORT}/__ready`);
}

async function waitFor(url) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(url); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error(`not reachable: ${url}`);
}

const stopEdge = () => execFileSync('docker', ['rm', '-f', 'sync-storm-edge'], { stdio: 'ignore' });

// Each client gets its own connection pool of POOL connections, like a browser.
const clientDispatcher = () => new undici.Agent({ connections: POOL });

// ── Clients: each takes the round it last synced at and returns { local, requests } ──

const localAt = g => history.map(h => clone(entryAt(h, g).data));
const baselinesAt = g => Object.fromEntries(history.map((h, i) => [`/r/${i}`, entryAt(h, g).token]));

function applyAll(local, g, results) {
  history.forEach((h, i) => {
    const r = results[`/r/${i}`];
    if (r.status !== 304) local[i] = applyResult(local[i], entryAt(h, g).token, r);
  });
  return local;
}

async function sharedClient(port, g, links) {
  const dispatcher = clientDispatcher();
  let requests = 0;
  // redirect: 'manual' so that syncFetch follows the 303 itself and every request is counted.
  const fetchImpl = (u, init) => { requests++; return undici.fetch(u, { ...init, dispatcher, redirect: 'manual' }); };
  const res = await syncFetch(`http://127.0.0.1:${port}/sync`, baselinesAt(g), { transport: 'query', redirect: true, links, fetch: fetchImpl, headers: IDENTITY });
  await dispatcher.close();
  if (res.status !== 200) throw new Error(`shared result: ${res.status}`);
  failedLinks(res);
  return { local: applyAll(localAt(g), g, res.body.results), requests };
}

// syncFetch reports a link it could not retrieve as status 0.
function failedLinks(res) {
  if (Object.values(res.body.results).some(r => r.status === 0)) throw Object.assign(new Error('link failed'), { retryable: true });
}

const CLIENTS = {
  async getFull(port) {
    const agent = new http.Agent({ keepAlive: true, maxSockets: POOL });
    const local = await Promise.all(history.map((_, i) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/get/r/${i}`, agent }, res => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    })));
    agent.destroy();
    return { local, requests: N };
  },

  async braid(port, ctx, g) {
    const dispatcher = clientDispatcher();
    const local = localAt(g);
    await Promise.all(local.map(async (_, i) => {
      const res = await braidFetch(`http://127.0.0.1:${port}/braid/r/${i}`, { parents: [entryAt(history[i], g).token], dispatcher, headers: IDENTITY });
      if (res.status === 200) local[i] = applyBraid(local[i], await res.update());
      else await res.arrayBuffer();
    }));
    await dispatcher.close();
    return { local, requests: N };
  },

  async syncInline(port, ctx, g) {
    const res = await syncRequest(`http://127.0.0.1:${port}/sync`, baselinesAt(g), { transport: 'query', gzip: false });
    return { local: applyAll(localAt(g), g, res.body.results), requests: 1 };
  },

  async syncLinks(port, ctx, g) {
    const dispatcher = clientDispatcher();
    let requests = 0;
    const fetchImpl = (u, init) => { requests++; return undici.fetch(u, { ...init, dispatcher }); };
    // identity: every variant in this benchmark is measured without content coding
    const res = await syncFetch(`http://127.0.0.1:${port}/sync`, baselinesAt(g), { transport: 'query', links: true, fetch: fetchImpl, headers: IDENTITY });
    await dispatcher.close();
    failedLinks(res);
    return { local: applyAll(localAt(g), g, res.body.results), requests };
  },

  async syncShared(port, ctx, g) { return sharedClient(port, g, false); },
  async syncSharedLinks(port, ctx, g) { return sharedClient(port, g, true); },

  async mercure(port, ctx, g) {
    const { markers, counts, topic } = ctx.mercure;
    const count = counts[g];
    const local = localAt(g);
    const query = Array.from({ length: N }, (_, i) => `match=${encodeURIComponent(topic(i))}`).join('&');
    const events = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: `/.well-known/mercure?${query}`, agent: false, headers: { 'Last-Event-ID': markers[g] } }, res => {
        if (res.statusCode !== 200) return reject(new Error(`Mercure ${res.statusCode}`));
        const evs = [];
        let buf = '';
        res.on('data', c => {
          buf += c;
          let k;
          while ((k = buf.indexOf('\n\n')) !== -1) {
            const line = buf.slice(0, k).split('\n').find(l => l.startsWith('data: '));
            buf = buf.slice(k + 2);
            if (line) evs.push(JSON.parse(line.slice(6)));
            if (evs.length === count) { req.destroy(); return resolve(evs); }
          }
        });
      });
      req.on('error', e => { if (!req.destroyed) reject(e); });
      req.end();
    });
    for (const ev of events) local[ev.topic] = applyUpdate(local[ev.topic], ev.format, ev.data);
    return { local, requests: 1 };
  },
};

const VARIANTS = [
  ['GET (full), via shared cache', 'getFull', 'edge'],
  ['Braid (braid-http), via shared cache', 'braid', 'edge'],
  ['SYNC, inline', 'syncInline', 'edge'],
  ['SYNC, links via shared cache', 'syncLinks', 'edge'],
  ['SYNC, shared result (303) via shared cache', 'syncShared', 'edge'],
  ['SYNC, shared result (303) with links via shared cache', 'syncSharedLinks', 'edge'],
  ['Mercure (hub)', 'mercure', 'hub'],
];

// ── Run ──────────────────────────────────────────────────────────────────────

const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

// A connection failure (for example a full accept queue on this one machine) is not a
// property of any protocol: every approach retries a failed client once, and the
// report counts retries.
const NETWORK_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EADDRNOTAVAIL', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
const isNetworkError = e => NETWORK_ERRORS.has(e.code) || NETWORK_ERRORS.has(e.cause?.code) || e.message === 'socket hang up' || e.retryable;

async function runClient(key, port, ctx, g, row) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await CLIENTS[key](port, ctx, g);
    } catch (e) {
      if (process.env.DEBUG_STORM) console.error(`client failed (attempt ${attempt}): ${e.code || ''} ${e.cause?.code || ''} ${e.message}`);
      if (attempt > 0 || !isNetworkError(e)) throw e;
      row.retries++;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// Closed connections hold their local port for 2 MSL (30 s on macOS, 60 s on Linux),
// and a machine has a limited range of ephemeral ports (about 16000 on macOS). Docker's
// port forwarding also opens connections inside the Docker host (on macOS, a Linux
// VM). Before each variant, wait until earlier variants' connections have released
// their ports on both, so that a large run does not run out.
function timeWaitCounts() {
  const host = execFileSync('netstat', ['-an', '-p', 'tcp'], { encoding: 'utf8' }).split('\n').filter(l => l.includes('TIME_WAIT')).length;
  const sockstat = execFileSync('docker', ['run', '--rm', '--net=host', 'nginx:1.27-alpine', 'cat', '/proc/net/sockstat'], { encoding: 'utf8' });
  const docker = Number((/\btw (\d+)/.exec(sockstat) || [])[1] || 0);
  return { host, docker };
}

async function waitForPorts(limit = 500) {
  for (let i = 0; i < 90; i++) {
    let counts;
    try {
      counts = timeWaitCounts();
    } catch {
      return;
    }
    if (counts.host < limit && counts.docker < limit) return;
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function runVariant([label, key, via], scenario, rounds, ctx) {
  const origin = via === 'edge' ? await startOrigin() : null;
  // Origin-side byte counter (no delay) between the edge and the origin.
  const originMeter = via === 'edge' ? await startProxyProcess(origin.port, 0, '127.0.0.1') : null;
  if (via === 'edge') await startEdge(originMeter.port);
  const target = via === 'edge' ? EDGE_PORT : Number(new URL(MERCURE_URL).port);
  const clientSide = await startProxyProcess(target, RTT_MS / 2);

  const before = origin && await origin.stats();
  const t0 = performance.now();
  const times = [];
  const arrival = rng(7);
  const progress = { retries: 0 };
  const outs = await Promise.all(rounds.map(async g => {
    await new Promise(r => setTimeout(r, arrival() * ARRIVAL_WINDOW_MS));
    const c0 = performance.now();
    const out = await runClient(key, clientSide.port, ctx, g, progress);
    times.push(performance.now() - c0);
    return out;
  }));
  const duration = performance.now() - t0;
  await new Promise(r => setTimeout(r, RTT_MS));
  const after = origin && await origin.stats();
  const clientStats = await clientSide.stats();
  const originStats = originMeter && await originMeter.stats();

  for (const out of outs) out.local.forEach((state, i) => assert.deepStrictEqual(state, expected[i], `${scenario.key} / ${label}: resource ${i} diverged`));
  times.sort((a, b) => a - b);

  const row = {
    label,
    clientRequests: outs.reduce((n, o) => n + o.requests, 0),
    clientBytes: clientStats.up + clientStats.down,
    retries: progress.retries,
    durationMs: duration,
    p50: pct(times, 50),
    p95: pct(times, 95),
  };
  if (via === 'edge') {
    row.originRequests = after.requests - before.requests;
    row.originBytes = originStats.down;
    row.originCpuMs = after.cpuMs - before.cpuMs;
    row.updatesComputed = (after.syncComputed - before.syncComputed) + (after.braidDiffs - before.braidDiffs);
  } else {
    row.originRequests = K;
    row.originBytes = clientStats.down;
    row.originCpuMs = null;
    row.updatesComputed = null;
  }
  console.log(`${scenario.key} | ${label}: origin ${row.originRequests} requests, ${(row.originBytes / 1024).toFixed(0)} KB, ${row.originCpuMs === null ? '-' : Math.round(row.originCpuMs)} ms CPU; clients ${row.clientRequests} requests, ${(row.clientBytes / 1024).toFixed(0)} KB; retries ${row.retries}`);

  await clientSide.close();
  if (originMeter) await originMeter.close();
  if (via === 'edge') stopEdge();
  if (origin) origin.stop();
  return row;
}

// Each variant runs in a fresh client process (as well as with a fresh origin and an
// empty cache), so that no connection pool or library state carries over from one
// variant to the next.
function runVariantProcess(variant, scenario, mercure) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename], {
      env: { ...process.env, STORM_VARIANT: variant[1], STORM_SCENARIO: scenario.key, STORM_MERCURE: mercure ? JSON.stringify(mercure) : '' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.on('exit', code => {
      const line = out.split('\n').find(l => l.startsWith('ROW '));
      process.stdout.write(out.split('\n').filter(l => l && !l.startsWith('ROW ')).map(l => `${l}\n`).join(''));
      if (code !== 0 || !line) return reject(new Error(`${scenario.key} / ${variant[0]} failed (exit ${code})`));
      resolve(JSON.parse(line.slice(4)));
    });
  });
}

async function main() {
  const hub = await mercureAvailable();
  if (!hub) console.warn(`Mercure hub not reachable at ${MERCURE_URL}; skipping the Mercure rows.`);
  const out = [];
  for (const scenario of SCENARIOS) {
    const rounds = Array.from({ length: K }, () => scenario.round());
    let mercure = null;
    if (hub) {
      const prefix = `/storm/${scenario.key}/${Date.now().toString(36)}`;
      const { markers, counts } = await mercureSetup({ history, N, L }, prefix, { markers: true });
      mercure = { prefix, markers, counts };
    }
    const rows = [];
    for (const variant of VARIANTS) {
      if (variant[2] === 'hub' && !hub) continue;
      if (process.env.ONLY && !process.env.ONLY.split(',').includes(variant[1])) continue;
      await waitForPorts();
      rows.push(await runVariantProcess(variant, scenario, mercure));
    }
    out.push({ scenario: scenario.key, name: scenario.name, distinctStates: new Set(rounds).size, rows });
  }
  fs.rmSync(CONF, { force: true });
  return out;
}

// Child process: one variant of one scenario.
async function child() {
  const scenario = SCENARIOS.find(s => s.key === process.env.STORM_SCENARIO);
  const variant = VARIANTS.find(v => v[1] === process.env.STORM_VARIANT);
  const rounds = Array.from({ length: K }, () => scenario.round());
  const ctx = {};
  if (process.env.STORM_MERCURE) {
    const { prefix, markers, counts } = JSON.parse(process.env.STORM_MERCURE);
    ctx.mercure = { markers, counts, topic: i => `${prefix}/r/${i}` };
  }
  return runVariant(variant, scenario, rounds, ctx);
}

function report(scenarios) {
  const kb = n => (n / 1024).toFixed(0);
  let md = `# Reconnect storm through a shared cache\n\n`;
  md += `**Run at:** ${new Date().toISOString()} on Node ${process.version}\n\n`;
  md += `${K} clients hold versions of ${N} resources (about 20 KB each) and reconnect within ${ARRIVAL_WINDOW_MS} ms of each other at round ${L} (${history.filter(h => entryAt(h, L).round > 0).length} of ${N} resources changed since round 0). They reach the origin through nginx 1.27 acting as a shared cache (a CDN edge), over a ${RTT_MS} ms round trip; each client uses at most ${POOL} connections. Every variant runs in a fresh client process, with a fresh origin process and an empty cache. Every client's final state is checked against the server's.\n\n`;
  for (const sc of scenarios) {
    md += `## ${sc.name}\n\n${sc.distinctStates} distinct client state${sc.distinctStates === 1 ? '' : 's'}.\n\n`;
    md += `| Approach | Origin requests | Origin bytes (KB) | Origin CPU (ms) | Updates computed at origin | Client requests | Client bytes (KB) | Storm duration (ms) | Per-client time p50 / p95 (ms) |\n|---|---|---|---|---|---|---|---|---|\n`;
    for (const r of sc.rows) {
      md += `| ${r.label} | ${r.originRequests} | ${kb(r.originBytes)} | ${r.originCpuMs === null ? 'n/a' : Math.round(r.originCpuMs)} | ${r.updatesComputed === null ? 'n/a' : r.updatesComputed} | ${r.clientRequests} | ${kb(r.clientBytes)} | ${Math.round(r.durationMs)} | ${Math.round(r.p50)} / ${Math.round(r.p95)} |\n`;
    }
    md += '\n';
  }
  md += `## How to read this\n\n`;
  md += `- **Origin** columns measure what reaches the origin past the shared cache: requests, response bytes, and CPU time of the origin process (which also runs the HTTP stack).\n`;
  md += `- **SYNC, shared result (303)**: each client sends one QUERY, which the cache passes to the origin (shared caches do not yet store QUERY responses). The origin reads the current version of each resource, computes no update, and answers \`303 (See Other)\` with a URI that identifies the request and the versions the results lead to (RFC 10008 Section 2.5). Clients in the same state receive the same URI; their GETs are served by the cache, so the origin builds each distinct result once.\n`;
  md += `- **SYNC, shared result with links**: as above, and the shared result carries a link in place of each large update, so results for different states share the updates they have in common. It costs each client one request per link.\n`;
  md += `- **SYNC, links**: the same QUERY, answered with the results and a link in place of each large update; the clients fetch the updates through the cache, which keeps them because each link names one immutable update.\n`;
  md += `- **SYNC, inline**: the same QUERY with updates inline. The origin computes each distinct update once (it reuses identical updates) but sends every client its own copy.\n`;
  md += `- **Braid**: per-resource GET with Parents, made cacheable for this benchmark with \`Cache-Control: public\` and \`Vary: Parents\` (nginx keys on the Parents header); unchanged resources are answered 304. With that configuration the cache absorbs Braid's catch-up as well: a shared cache is not unique to SYNC. The difference is the number of requests each client makes.\n`;
  md += `- **GET (full)** is fully cacheable but sends every client the whole of every resource.\n`;
  md += `- **Mercure**: the hub is the origin and replays the history to each subscriber; SSE streams are not shared by caches. Origin CPU is not measured for the hub (it runs in Docker).\n`;
  md += `- All variants are measured without content coding (no gzip). Bytes exclude TCP and TLS handshakes.\n`;
  md += `- The latency proxies run in their own processes. A client whose catch-up fails with a connection error (the machine's accept queue is small) retries once, whatever the approach; retries: ${scenarios.map(sc => sc.rows.filter(r => r.retries).map(r => `${r.label} ${r.retries}`).join(', ')).filter(Boolean).join('; ') || 'none'}.\n`;
  md += `- Durations for the cached variants include nginx's cache lock: while one request fetches an object from the origin, concurrent requests for it wait and nginx re-checks every 500 ms, which keeps the origin from being hit by all of them at once. Without the lock the cached variants finish sooner but more requests reach the origin.\n`;
  md += `- The edge, the origin and the clients share one machine, so durations reflect the relative cost of each approach, not production latency.\n`;
  return md;
}

// The default run writes storm-results.{md,json}; other values of K write storm-results-k<K>.*.
const OUT = path.join(__dirname, `storm-results${K === 100 ? '' : `-k${K}`}`);

if (process.env.STORM_VARIANT) {
  child().then(row => {
    console.log(`ROW ${JSON.stringify(row)}`);
    process.exit(0);
  }).catch(err => { console.error(err); try { stopEdge(); } catch {} process.exit(1); });
} else {
  main().then(scenarios => {
    fs.writeFileSync(`${OUT}.json`, JSON.stringify({ K, N, L, scenarios }, null, 2));
    const md = report(scenarios);
    fs.writeFileSync(`${OUT}.md`, md);
    console.log(md);
    process.exit(0);
  }).catch(err => { console.error(err); try { stopEdge(); } catch {} process.exit(1); });
}
