'use strict';

// Consistency benchmark: can a client that reads several related resources end
// up with a combination that never existed on the server (a "torn read")?
//
// A writer commits one transaction every WRITE_EVERY_MS. Each transaction adds a
// user, adds a post by that user, and updates a counter, atomically, and drops
// the oldest user together with their post. In every committed state:
//   (1) every post's author is a current user, and
//   (2) the counter's `last` equals the newest user id and the newest post id.
// Clients repeatedly read /users, /posts and /counts and check both invariants.
// The store's reads take READ_LATENCY_MS, as for a database round trip, and every
// client talks to its server through a proxy that adds an RTT_MS round trip.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { braidify, fetch: braidFetch } = require('braid-http');

const { syncHandler, createMemoryStore } = require('../server/src/package');
const { syncRequest } = require('../client/src/sync-client');
const { startProxy } = require('./lib/proxy');

const WRITE_EVERY_MS = 5;
const KEEP = 50;
const RUNS = 300;
const RTT_MS = 40;
const RESOURCES = ['/users', '/posts', '/counts'];

// Idealized: fixed delays, the case most favourable to separate requests, since
// they then reach the server at the same instant. Realistic: network and database
// timing vary (seeded, so runs are reproducible).
const SCENARIOS = [
  { name: 'idealized (fixed delays)', jitterMs: 0, readMs: [2, 2] },
  { name: 'realistic (network jitter up to 10 ms, store reads 1 to 8 ms)', jitterMs: 10, readMs: [1, 8] },
];

function rng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let readMs = [2, 2];
let readRandom = rng(1);
const readDelay = () => sleep(readMs[0] + readRandom() * (readMs[1] - readMs[0]));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Data ─────────────────────────────────────────────────────────────────────

function stateAt(k) {
  const ids = Array.from({ length: KEEP }, (_, i) => k - KEEP + 1 + i);
  return {
    '/users': { ids },
    '/posts': ids.map(id => ({ id, author: id })),
    '/counts': { last: k },
  };
}

function violates(values) {
  const users = new Set(values['/users'].ids);
  if (!values['/posts'].every(p => users.has(p.author))) return true;
  const last = values['/counts'].last;
  return last !== Math.max(...values['/users'].ids) || last !== Math.max(...values['/posts'].map(p => p.id));
}

function startWriter(store) {
  let k = KEEP;
  const commit = () => {
    const s = stateAt(k);
    store.commit(RESOURCES.map(r => ({ resource: r, version: `${r.slice(1, 2)}${k}`, data: s[r] })));
  };
  commit();
  const timer = setInterval(() => { k++; commit(); }, WRITE_EVERY_MS);
  return { stop: () => clearInterval(timer), commits: () => k - KEEP + 1 };
}

// Every read takes readDelay(), including reads inside a snapshot.
function slowStore(inner) {
  const wrap = view => ({
    getCurrent: async r => { await readDelay(); return view.getCurrent(r); },
    getVersion: async (r, v) => { await readDelay(); return view.getVersion(r, v); },
  });
  return { ...wrap(inner), snapshot: () => wrap(inner.snapshot()) };
}

// ── Servers ──────────────────────────────────────────────────────────────────

function getServer(store) {
  return http.createServer(async (req, res) => {
    await readDelay();
    const cur = store.getCurrent(req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(cur.data));
  });
}

function braidServer(store) {
  return http.createServer(braidify(async (req, res) => {
    await readDelay();
    const cur = store.getCurrent(req.url);
    res.statusCode = 200;
    res.sendUpdate({ version: [cur.version], body: JSON.stringify(cur.data) });
    res.end();
  }));
}

function syncServer(store) {
  const handle = syncHandler({ store: slowStore(store) });
  return http.createServer((req, res) => handle(req, res, () => { res.statusCode = 404; res.end(); }));
}

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// ── Clients: each returns { '/users': ..., '/posts': ..., '/counts': ... } ──────

function getJson(agent, port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, agent }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

const APPROACHES = [
  ['GET, parallel', 'get', async (port, agent) => {
    const values = await Promise.all(RESOURCES.map(r => getJson(agent, port, r)));
    return Object.fromEntries(RESOURCES.map((r, i) => [r, values[i]]));
  }],
  ['GET, sequential', 'get', async (port, agent) => {
    const out = {};
    for (const r of RESOURCES) out[r] = await getJson(agent, port, r);
    return out;
  }],
  ['Braid (braid-http), parallel', 'braid', async port => {
    const values = await Promise.all(RESOURCES.map(async r => {
      const res = await braidFetch(`http://127.0.0.1:${port}${r}`);
      const update = await res.update();
      return JSON.parse(update.body_text ?? Buffer.from(update.body).toString('utf8'));
    }));
    return Object.fromEntries(RESOURCES.map((r, i) => [r, values[i]]));
  }],
  ['SYNC', 'sync', async (port, agent) => {
    const res = await syncRequest(`http://127.0.0.1:${port}/sync`, Object.fromEntries(RESOURCES.map(r => [r, null])), { transport: 'query', agent });
    return Object.fromEntries(RESOURCES.map(r => [r, res.body.results[r].data]));
  }],
  ['SYNC, consistent', 'sync', async (port, agent) => {
    const res = await syncRequest(`http://127.0.0.1:${port}/sync`, Object.fromEntries(RESOURCES.map(r => [r, null])), { transport: 'query', consistent: true, agent });
    if (res.headers['sync-consistent'] !== '?1') throw new Error('server did not confirm a consistent snapshot');
    return Object.fromEntries(RESOURCES.map(r => [r, res.body.results[r].data]));
  }],
];

// Wilson score interval for a binomial proportion.
function wilson(k, n, z = 1.96) {
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

async function main() {
  const out = [];
  for (const [si, scenario] of SCENARIOS.entries()) {
    readMs = scenario.readMs;
    readRandom = rng(100 + si);
    const netRandom = rng(200 + si);
    const store = createMemoryStore({ maxVersions: 200 });
    const writer = startWriter(store);
    const servers = { get: getServer(store), braid: braidServer(store), sync: syncServer(store) };
    const ports = {};
    for (const [k, s] of Object.entries(servers)) ports[k] = await listen(s);

    const rows = [];
    for (const [label, kind, read] of APPROACHES) {
      const proxy = await startProxy(ports[kind], RTT_MS / 2, '127.0.0.1', { jitterMs: scenario.jitterMs, random: netRandom });
      const agent = new http.Agent({ keepAlive: true, maxSockets: 6 });
      let torn = 0;
      const ms = [];
      for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        const values = await read(proxy.port, agent);
        ms.push(performance.now() - t0);
        if (violates(values)) torn++;
      }
      agent.destroy();
      await proxy.close();
      ms.sort((a, b) => a - b);
      const [lo, hi] = wilson(torn, RUNS);
      rows.push({ label, runs: RUNS, torn, rate: torn / RUNS, ci: [lo, hi], medianMs: ms[Math.floor(ms.length / 2)] });
      console.log(`${scenario.name} | ${label}: ${torn}/${RUNS} torn`);
    }
    writer.stop();
    for (const s of Object.values(servers)) { s.closeAllConnections?.(); s.close(); }
    out.push({ scenario: scenario.name, rows, commits: writer.commits() });
  }
  return out;
}

function report(scenarios) {
  const pct = x => `${(x * 100).toFixed(1)}%`;
  let md = `# Consistency across resources: torn-read benchmark\n\n`;
  md += `**Run at:** ${new Date().toISOString()} on Node ${process.version}\n\n`;
  md += `A writer commits one transaction every ${WRITE_EVERY_MS} ms. Each transaction adds a user, a post by that user, and updates a counter, atomically, and drops the oldest user with their post. In every committed state every post's author is a current user, and the counter's \`last\` equals the newest user id and the newest post id.\n\n`;
  md += `Each approach reads \`/users\`, \`/posts\` and \`/counts\` ${RUNS} times through a proxy adding a ${RTT_MS} ms round trip, and checks both invariants. A read that violates either invariant is a combination of resources that never existed on the server.\n\n`;
  for (const sc of scenarios) {
    md += `## ${sc.scenario}\n\n${sc.commits} transactions were committed during this scenario.\n\n`;
    md += `| Approach | Torn reads | Rate | 95% CI (Wilson) | Median time |\n|---|---|---|---|---|\n`;
    for (const r of sc.rows) md += `| ${r.label} | ${r.torn} / ${r.runs} | ${pct(r.rate)} | ${pct(r.ci[0])} to ${pct(r.ci[1])} | ${Math.round(r.medianMs)} ms |\n`;
    md += '\n';
  }
  md += `## Notes\n\n`;
  md += `- "SYNC, consistent" sends \`"consistent": true\`; the server reads every resource from one snapshot of the store and confirms it with \`Sync-Consistent: ?1\`. It is the only approach here whose result cannot be torn, whatever the timing.\n`;
  md += `- In the idealized scenario all delays are fixed, so parallel requests reach the server and read the store at almost the same instant; this is the most favourable case for separate requests. With realistic variation in network and database timing, reads made separately drift apart and commits land between them.\n`;
  md += `- Plain SYNC (without \`consistent\`) reads the resources concurrently but not atomically, so it can also be torn.\n`;
  md += `- Separate requests could avoid torn reads only with an additional mechanism, for example a version to read "as of"; HTTP and Braid-HTTP do not define one across resources.\n`;
  md += `- Every approach reuses its connections (HTTP keep-alive), so times compare like with like.\n`;
  md += `- The rates depend on the write rate, store latency and network; the comparison shows which approaches can produce a state that never existed, not universal percentages.\n`;
  return md;
}

main().then(out => {
  fs.writeFileSync(path.join(__dirname, 'consistency-results.json'), JSON.stringify(out, null, 2));
  const md = report(out);
  fs.writeFileSync(path.join(__dirname, 'consistency-results.md'), md);
  console.log(md);
  process.exit(0);
}).catch(err => { console.error(err); process.exit(1); });
