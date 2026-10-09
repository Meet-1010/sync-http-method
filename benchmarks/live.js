'use strict';

// Live-updates benchmark. K clients hold the current versions of N resources and
// keep them current while the server commits R transactions, one every
// COMMIT_EVERY_MS; each transaction changes several resources together.
// Measured at the origin (past a shared cache, as a CDN edge): requests, bytes and
// CPU time. Measured at the clients: bytes, requests, and for every transaction
// the time until each client holds all of it. After every update a client
// applies, its view is checked: a view that matches no committed state (some
// resources of a transaction applied, others not) is torn. Every client's final
// state is checked against the server's.
//
// Requires Docker (nginx:1.27-alpine, and dunglas/mercure for the Mercure rows;
// see benchmarks/README.md).

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { fork, spawn, execFileSync } = require('child_process');
const undici = require('undici');

// braid-http keeps its multiplexers and subscription counts in module state, per
// origin. Each simulated client loads its own copy of the library, as each browser
// would have its own, so that clients do not share one multiplexer.
function freshBraidFetch() {
  const dir = `${path.sep}braid-http${path.sep}`;
  for (const k of Object.keys(require.cache)) if (k.includes(dir)) delete require.cache[k];
  return require('braid-http').fetch;
}

const { createSyncClient } = require('../client/src/index');
const { startProxyProcess } = require('./lib/proxy-process');
const edge = require('./lib/edge');
const { buildHistories, clone, rng } = require('./lib/dataset');
const { applyBraid } = require('./lib/braid');
const { delta, applyUpdate, FORMATS } = require('./lib/updates');
const { MERCURE_URL, MERCURE_PUBLISHER_KEY, mercureToken, mercureAvailable } = require('./lib/mercure');

const K = Number(process.env.K || 100);
const N = 50;
const R = 10;
const COMMIT_EVERY_MS = 300;
const RTT_MS = 40;
const POOL = 6;
const EDGE_PORT = 3491;
const ARRIVAL_WINDOW_MS = Number(process.env.WINDOW_MS || 1000);
const SETTLE_TIMEOUT_MS = 20000;
const LINK_SECRET = 'live-benchmark-link-secret-0123456789';
const CONF = path.join(__dirname, 'live', 'varnish.generated.vcl');
const IDENTITY = { 'Accept-Encoding': 'identity' };
const now = () => performance.timeOrigin + performance.now();

const history = buildHistories(N);
// The rounds 1..R in which each resource changes, and the validity of each version.
const changedIn = Array.from({ length: R + 1 }, (_, r) => history.flatMap((h, i) => (h.some(e => e.round === r) ? [i] : [])));
const validity = history.map(h => {
  const m = new Map();
  const rel = h.filter(e => e.round <= R);
  rel.forEach((e, k) => m.set(e.token, [e.round, k + 1 < rel.length ? rel[k + 1].round - 1 : R]));
  return m;
});
const finalState = history.map(h => h.filter(e => e.round <= R).pop());

// ── A client's view: what it holds, whether that ever existed, when it caught up ──

// `watched`: the indices of the resources this client keeps current. Views are
// checked, and transactions timed, on those resources only; a transaction that
// changes none of them does not concern this client.
function makeView(watched) {
  const concerns = Array.from({ length: R + 1 }, (_, c) => changedIn[c].filter(i => watched.includes(i)));
  const view = {
    watched,
    held: history.map(h => h[0].token),
    local: history.map(h => clone(h[0].data)),
    observations: 0,
    torn: 0,
    concerns,
    reached: new Array(R + 1).fill(null),
    record() {
      view.observations++;
      let start = 0;
      let end = R;
      for (const i of watched) {
        const [s, e] = validity[i].get(view.held[i]);
        if (s > start) start = s;
        if (e < end) end = e;
      }
      if (start > end) view.torn++;
      const t = now();
      for (let c = 1; c <= R; c++) {
        if (view.reached[c] !== null || !concerns[c].length) continue;
        if (concerns[c].every(i => validity[i].get(view.held[i])[0] >= c)) view.reached[c] = t;
      }
    },
  };
  return view;
}

// ── Clients: each returns { view, requests: () => n, ready, close } ──────────

const counting = dispatcher => {
  const box = { n: 0 };
  box.fetch = (u, init) => { box.n++; return undici.fetch(u, { ...init, dispatcher }); };
  return box;
};

function syncWatcher(links) {
  return async (port, watched) => {
    const dispatcher = new undici.Agent({ connections: POOL });
    const f = counting(dispatcher);
    const view = makeView(watched);
    let markReady;
    const ready = new Promise(r => { markReady = r; });
    // The client already holds round 0; the watch's first event confirms it.
    const state = Object.fromEntries(watched.map(i => [`/r/${i}`, { version: history[i][0].token, value: clone(history[i][0].data) }]));
    const fetchImpl = async (u, init) => {
      const res = await f.fetch(u, init);
      if (/event-stream/.test(res.headers.get('content-type') || '')) markReady();
      return res;
    };
    const client = createSyncClient(`http://127.0.0.1:${port}/sync`, { fetch: fetchImpl, accept: FORMATS, links, headers: IDENTITY, state });
    const handle = client.watch(Object.keys(state), {
      consistent: true,
      retryMs: 200,
      onChange: ({ changed }) => {
        for (const r of changed) {
          const i = Number(r.split('/')[2]);
          view.held[i] = client.entries.get(r).version;
          view.local[i] = client.entries.get(r).value;
        }
        view.record();
      },
    });
    return { view, requests: () => f.n, ready, close: async () => { handle.close(); await handle.closed.catch(() => {}); await dispatcher.close(); } };
  };
}

async function braidSubscriber(port, watched) {
  const braidFetch = freshBraidFetch();
  const dispatcher = new undici.Agent({ connections: POOL });
  const view = makeView(watched);
  const ac = new AbortController();
  let requests = 0;
  await Promise.all(watched.map(async i => {
    requests++;
    const s = await braidFetch(`http://127.0.0.1:${port}/braid/r/${i}`, { parents: [history[i][0].token], subscribe: true, multiplex: true, signal: ac.signal, dispatcher, headers: IDENTITY });
    s.subscribe(update => {
      view.local[i] = applyBraid(view.local[i], update);
      view.held[i] = update.version[0];
      view.record();
    }, () => {});
  }));
  // Cancelling sends DELETEs that the library retries; the process exits after measuring.
  return { view, requests: () => requests + 1, ready: Promise.resolve(), close: async () => { ac.abort(); } };
}

function mercureSubscriber(ctx) {
  return async (port, watched) => {
    const view = makeView(watched);
    const query = watched.map(i => `match=${encodeURIComponent(ctx.topic(i))}`).join('&');
    let req;
    const ready = new Promise((resolve, reject) => {
      req = http.request({ host: '127.0.0.1', port, path: `/.well-known/mercure?${query}`, agent: false }, res => {
        if (res.statusCode !== 200) return reject(new Error(`Mercure ${res.statusCode}`));
        resolve();
        let buf = '';
        res.on('data', c => {
          buf += c;
          let k;
          while ((k = buf.indexOf('\n\n')) !== -1) {
            const line = buf.slice(0, k).split('\n').find(l => l.startsWith('data: '));
            buf = buf.slice(k + 2);
            if (!line) continue;
            const ev = JSON.parse(line.slice(6));
            // A transaction's event carries all its changes; this client keeps only the ones it watches.
            for (const c of ev.changes) {
              if (!watched.includes(c.i)) continue;
              view.local[c.i] = applyUpdate(view.local[c.i], c.format, c.data);
              view.held[c.i] = c.token;
            }
            view.record();
          }
        });
      });
      req.on('error', e => { if (!req.destroyed) reject(e); });
      req.end();
    });
    return { view, requests: () => 1, ready, close: async () => { req.destroy(); } };
  };
}

// ── Mercure publishing ───────────────────────────────────────────────────────

async function publish(topics, data) {
  const body = new URLSearchParams();
  for (const t of topics) body.append('topic', t);
  body.append('data', data);
  const res = await fetch(`${MERCURE_URL}/.well-known/mercure`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mercureToken('publish', `${MERCURE_URL}/.well-known/mercure`, MERCURE_PUBLISHER_KEY)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (res.status !== 200) throw new Error(`Mercure publish failed: ${res.status}`);
  await res.text();
}

const changeOf = (i, r) => {
  const idx = history[i].findIndex(e => e.round === r);
  const u = delta(history[i][idx - 1].data, history[i][idx].data);
  return { i, token: history[i][idx].token, format: u.format, data: u.data };
};

// Per resource: one event per changed resource (the topic is the resource), as
// Mercure is usually used. Per commit: one event carrying the whole transaction,
// published to the topics of every resource it changes.
const mercureCommit = (ctx, bundled) => async r => {
  const at = now();
  if (bundled) await publish(changedIn[r].map(ctx.topic), JSON.stringify({ changes: changedIn[r].map(i => changeOf(i, r)) }));
  else for (const i of changedIn[r]) await publish([ctx.topic(i)], JSON.stringify({ changes: [changeOf(i, r)] }));
  return at;
};

const hubCpuMs = () => {
  try {
    const stat = execFileSync('docker', ['exec', 'sync-bench-mercure', 'cat', '/sys/fs/cgroup/cpu.stat'], { encoding: 'utf8' });
    return Number(/usage_usec (\d+)/.exec(stat)[1]) / 1000;
  } catch {
    return null;
  }
};

// Each approach is deployed the way it would be: only SYNC with links uses the
// shared cache (it is what makes links pay off); the others reach the origin
// directly (streams have nothing to cache). Every path has the same round trip.
const all = history.map((_, i) => i);
const SCENARIOS = [
  { key: 'all', name: `Every client watches all ${N} resources`, watched: () => all },
  {
    key: 'subset',
    name: `Each client watches ${N / 5} of the ${N} resources (chosen at random)`,
    watched: k => {
      const random = rng(500 + k);
      const pool = all.slice();
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      return pool.slice(0, N / 5).sort((a, b) => a - b);
    },
  },
];

const VARIANTS = [
  ['SYNC watch', 'syncWatch', 'origin'],
  ['SYNC watch, links via shared cache', 'syncWatchLinks', 'edge'],
  ['Braid subscriptions (braid-http, multiplexed)', 'braid', 'origin'],
  ['Mercure, one event per resource', 'mercure', 'hub'],
  ['Mercure, one event per transaction', 'mercureBundled', 'hub'],
];

// ── One variant (in its own process) ─────────────────────────────────────────

function startOrigin() {
  const child = fork(path.join(__dirname, 'live', 'origin.js'), [], { env: { ...process.env, N: String(N), LINK_SECRET } });
  process.on('exit', () => child.kill());
  const waiting = [];
  child.on('message', m => { if (!m.port) waiting.shift()(m); });
  const ask = msg => new Promise(r => { waiting.push(r); child.send(msg); });
  return new Promise(resolve => child.once('message', m => resolve({
    port: m.port,
    stats: async () => (await ask('stats')).stats,
    commit: async r => (await ask({ commit: r })).at,
    stop: () => child.kill(),
  })));
}

const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);

async function runVariant([label, key, via], scenario) {
  const ctx = { topic: i => `/live/${process.env.LIVE_RUN}/r/${i}` };
  const origin = via !== 'hub' ? await startOrigin() : null;
  const originMeter = origin ? await startProxyProcess(origin.port, 0, '127.0.0.1') : null;
  if (via === 'edge') await edge.startEdge({ template: path.join(__dirname, 'live', 'varnish.vcl.template'), conf: CONF, originPort: originMeter.port, port: EDGE_PORT });
  const target = via === 'edge' ? EDGE_PORT : via === 'origin' ? originMeter.port : Number(new URL(MERCURE_URL).port);
  const clientSide = await startProxyProcess(target, RTT_MS / 2);

  const make = {
    syncWatch: syncWatcher(false),
    syncWatchLinks: syncWatcher(true),
    braid: braidSubscriber,
    mercure: mercureSubscriber(ctx),
    mercureBundled: mercureSubscriber(ctx),
  }[key];

  // Clients connect within the arrival window and must all be ready before the first commit.
  const arrival = rng(7);
  const clients = await Promise.all(Array.from({ length: K }, async (_, k) => {
    await new Promise(r => setTimeout(r, arrival() * ARRIVAL_WINDOW_MS));
    const c = await make(clientSide.port, scenario.watched(k));
    await c.ready;
    return c;
  }));
  await new Promise(r => setTimeout(r, 500));

  const before = origin ? await origin.stats() : null;
  const cpuBefore = via === 'hub' ? hubCpuMs() : null;
  const clientBefore = await clientSide.stats();
  const originBefore = originMeter ? await originMeter.stats() : null;
  const requestsBefore = clients.reduce((n, c) => n + c.requests(), 0);

  const commitAt = new Array(R + 1).fill(null);
  const commit = origin ? origin.commit : mercureCommit(ctx, key === 'mercureBundled');
  for (let r = 1; r <= R; r++) {
    commitAt[r] = await commit(r);
    await new Promise(res => setTimeout(res, COMMIT_EVERY_MS));
  }
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  const caughtUp = c => c.view.concerns.every((changes, r) => r === 0 || !changes.length || c.view.reached[r] !== null);
  while (Date.now() < deadline && !clients.every(caughtUp)) await new Promise(res => setTimeout(res, 50));
  await new Promise(res => setTimeout(res, RTT_MS * 2));

  const after = origin ? await origin.stats() : null;
  const cpuAfter = via === 'hub' ? hubCpuMs() : null;
  const clientAfter = await clientSide.stats();
  const originAfter = originMeter ? await originMeter.stats() : null;

  for (const c of clients) for (const i of c.view.watched) assert.deepStrictEqual(c.view.local[i], finalState[i].data, `${label}: resource ${i} diverged`);

  const latencies = [];
  for (const c of clients) for (let r = 1; r <= R; r++) if (c.view.concerns[r].length) latencies.push(c.view.reached[r] - commitAt[r]);
  latencies.sort((a, b) => a - b);
  const observations = clients.reduce((n, c) => n + c.view.observations, 0);
  const torn = clients.reduce((n, c) => n + c.view.torn, 0);

  const row = {
    label,
    originBytes: originMeter ? originAfter.down - originBefore.down : clientAfter.down - clientBefore.down,
    originRequests: after ? after.requests - before.requests : null,
    originCpuMs: after ? after.cpuMs - before.cpuMs : (cpuBefore !== null && cpuAfter !== null ? cpuAfter - cpuBefore : null),
    clientBytes: (clientAfter.up + clientAfter.down) - (clientBefore.up + clientBefore.down),
    clientRequests: clients.reduce((n, c) => n + c.requests(), 0) - requestsBefore,
    p50: pct(latencies, 50),
    p95: pct(latencies, 95),
    observations,
    torn,
  };
  console.log(`${label}: origin ${(row.originBytes / 1024).toFixed(0)} KB, ${row.originRequests ?? '-'} requests, ${row.originCpuMs === null ? '-' : Math.round(row.originCpuMs)} ms CPU; latency p50 ${Math.round(row.p50)} ms p95 ${Math.round(row.p95)} ms; torn ${torn}/${observations}`);

  await Promise.all(clients.map(c => c.close()));
  await clientSide.close();
  if (originMeter) await originMeter.close();
  if (via === 'edge') edge.stopEdge();
  if (origin) origin.stop();
  return row;
}

// ── Runner ───────────────────────────────────────────────────────────────────

function runVariantProcess(variant, scenario, run) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename], { env: { ...process.env, LIVE_VARIANT: variant[1], LIVE_SCENARIO: scenario.key, LIVE_RUN: run }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.on('exit', code => {
      const line = out.split('\n').find(l => l.startsWith('ROW '));
      process.stdout.write(out.split('\n').filter(l => l && !l.startsWith('ROW ')).map(l => `${l}\n`).join(''));
      if (code !== 0 || !line) return reject(new Error(`${variant[0]} failed (exit ${code})`));
      resolve(JSON.parse(line.slice(4)));
    });
  });
}

async function main() {
  const hub = await mercureAvailable();
  if (!hub) console.warn(`Mercure hub not reachable at ${MERCURE_URL}; skipping the Mercure rows.`);
  const scenarios = [];
  for (const scenario of SCENARIOS) {
    if (process.env.SCENARIO && process.env.SCENARIO !== scenario.key) continue;
    const rows = [];
    for (const variant of VARIANTS) {
      if (variant[2] === 'hub' && !hub) continue;
      if (process.env.ONLY && !process.env.ONLY.split(',').includes(variant[1])) continue;
      await edge.waitForPorts();
      console.log(`${scenario.key} |`);
      rows.push(await runVariantProcess(variant, scenario, `${Date.now().toString(36)}-${scenario.key}-${variant[1]}`));
    }
    scenarios.push({ scenario: scenario.key, name: scenario.name, rows });
  }
  fs.rmSync(CONF, { force: true });
  return scenarios;
}

function report(scenarios) {
  const kb = n => (n / 1024).toFixed(0);
  const pctOf = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '0%');
  const perCommit = changedIn.slice(1).reduce((n, c) => n + c.length, 0) / R;
  let md = `# Live updates for many clients\n\n`;
  md += `**Run at:** ${new Date().toISOString()} on Node ${process.version}\n\n`;
  md += `${K} clients hold the current versions of ${N} resources (about 20 KB each) and keep them current while the server commits ${R} transactions, one every ${COMMIT_EVERY_MS} ms, each changing about ${perCommit.toFixed(1)} resources together. Every client reaches the server over a ${RTT_MS} ms round trip. With links, SYNC clients go through Varnish 7.6 acting as a shared cache (streams pass through; immutable updates are cached, and concurrent requests for one are coalesced); the other approaches have nothing to cache and reach the server directly. Every variant runs in a fresh client process with a fresh origin. After every update a client applies, its view is checked against the committed states; every client's final state is checked against the server's.\n\n`;
  for (const sc of scenarios) {
    md += `## ${sc.name}\n\n`;
    md += `| Approach | Origin bytes (KB) | Origin requests | Origin CPU (ms) | Client bytes (KB) | Client requests | Time until a client holds a whole transaction, p50 / p95 (ms) | Torn views |\n|---|---|---|---|---|---|---|---|\n`;
    for (const r of sc.rows) {
      md += `| ${r.label} | ${kb(r.originBytes)} | ${r.originRequests ?? 'n/a'} | ${r.originCpuMs === null ? 'n/a' : Math.round(r.originCpuMs)} | ${kb(r.clientBytes)} | ${r.clientRequests} | ${Math.round(r.p50)} / ${Math.round(r.p95)} | ${r.torn} of ${r.observations} (${pctOf(r.torn, r.observations)}) |\n`;
    }
    md += '\n';
  }
  md += `## How to read this\n\n`;
  md += `- Everything is measured from the moment all clients are connected and current until every client holds the last transaction; setting up subscriptions is not included.\n`;
  md += `- **Origin** is what the origin sent (past the shared cache, for SYNC with links; for Mercure, what the hub sent). Mercure's CPU time is that of the hub's container.\n`;
  md += `- **Torn views**: after each update a client applies, its view either equals a state the server committed, or mixes resources from different transactions. A torn view is what an application would render between the parts of a transaction.\n`;
  md += `- **SYNC watch**: one QUERY with \`"watch": true\` and \`"consistent": true\` per client; every event is the net change from one snapshot of all requested resources, so transactions arrive whole. With links, each update is an immutable GET that the cache serves to all clients; events carry only the links.\n`;
  md += `- **Braid**: one subscription per resource (braid-http, multiplexed over one stream per client), each sending its resource's updates as range patches.\n`;
  md += `- **Mercure**: the hub, with one topic per resource. Usually one event is published per changed resource; publishing one event per transaction (to the topics of every resource it changes) keeps transactions whole, at the cost of sending every subscriber of any of those topics the whole transaction, including changes to resources it does not watch (and might not be allowed to read). The second scenario shows that cost.\n`;
  md += `- With a subset, views are checked, and transactions timed, on the resources a client watches.\n`;
  md += `- Updates: SYNC sends the smaller of a JSON Patch and a JSON Merge Patch; Mercure events carry the same updates; Braid uses its own range patches. Nothing is compressed. Bytes exclude TCP and TLS handshakes.\n`;
  md += `- The edge, the origin, the hub and the clients share one machine, so times reflect the relative cost of each approach, not production latency.\n`;
  return md;
}

if (process.env.LIVE_VARIANT) {
  const variant = VARIANTS.find(v => v[1] === process.env.LIVE_VARIANT);
  const scenario = SCENARIOS.find(sc => sc.key === process.env.LIVE_SCENARIO);
  runVariant(variant, scenario).then(row => { console.log(`ROW ${JSON.stringify(row)}`); process.exit(0); })
    .catch(err => { console.error(err); edge.stopEdge(); process.exit(1); });
} else {
  const OUT = path.join(__dirname, `live-results${K === 100 ? '' : `-k${K}`}`);
  main().then(scenarios => {
    fs.writeFileSync(`${OUT}.json`, JSON.stringify({ K, N, R, scenarios }, null, 2));
    const md = report(scenarios);
    fs.writeFileSync(`${OUT}.md`, md);
    console.log(md);
    process.exit(0);
  }).catch(err => { console.error(err); edge.stopEdge(); process.exit(1); });
}
