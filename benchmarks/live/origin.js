'use strict';

// Origin for the live-updates benchmark, in its own process so its CPU time can be
// measured. One HTTP server serves:
//   QUERY /sync          SYNC watch streams (syncHandler); links under /sync/u/
//   GET   /braid/r/<i>   braid-http subscriptions (with Parents, updates since then)
// Controlled over IPC: { commit: r } applies round r of the dataset as one
// transaction and replies with the time it was applied; 'stats' returns counters
// and CPU time.

const http = require('http');
const { braidify } = require('braid-http');
const { syncHandler, createMemoryStore } = require('../../server/src/package');
const { stats: syncStats } = require('../../server/src/sync-core');
const { buildHistories } = require('../lib/dataset');
const { braidUpdate } = require('../lib/braid');

const N = Number(process.env.N);
const SECRET = process.env.LINK_SECRET;
const now = () => performance.timeOrigin + performance.now();

const history = buildHistories(N);
const current = history.map(h => h[0]);
const store = createMemoryStore();
for (let i = 0; i < N; i++) store.addVersion(`/r/${i}`, current[i].token, current[i].data);

const counters = { requests: 0, sync: 0, braid: 0, braidUpdates: 0, linkGets: 0 };
const subscribers = Array.from({ length: N }, () => new Set());

const sync = syncHandler({
  store,
  links: { secret: SECRET, path: '/sync/u', minBytes: 256, cacheControl: 'public, max-age=31536000, immutable' },
});

const braid = braidify((req, res) => {
  if (req.is_multiplexer) return;
  counters.braid++;
  const i = Number(req.url.split('/')[3]);
  const cur = current[i];
  const parent = req.parents?.[0];
  res.setHeader('Current-Version', `"${cur.token}"`);
  res.setHeader('X-Accel-Buffering', 'no');
  if (!req.subscribe) { res.statusCode = 400; return res.end(); }
  res.startSubscription({ onClose() { subscribers[i].delete(res); } });
  subscribers[i].add(res);
  if (parent !== cur.token) {
    const base = history[i].find(e => e.token === parent);
    res.sendUpdate({ version: [cur.token], parents: [parent], ...braidUpdate(base, cur) });
    counters.braidUpdates++;
  }
});

const server = http.createServer((req, res) => {
  counters.requests++;
  // Braid subscriptions, and braid-http's multiplexer (created with a POST to
  // /.well-known/multiplexer/<id>, or the MULTIPLEX method).
  if (req.url.startsWith('/braid/') || req.url.startsWith('/.well-known/multiplexer/') || req.method === 'MULTIPLEX') return braid(req, res);
  if (req.url.startsWith('/sync')) {
    if (req.url.startsWith('/sync/u/')) counters.linkGets++; else counters.sync++;
    return sync(req, res, () => { res.statusCode = 404; res.end(); });
  }
  res.statusCode = 404;
  res.end();
});
server.keepAliveTimeout = 60000;

// Applies round r as one transaction: SYNC watchers are notified by the store,
// Braid subscribers receive one update per changed resource.
function commit(r) {
  const changed = [];
  for (let i = 0; i < N; i++) {
    const e = history[i].find(x => x.round === r);
    if (e) changed.push(i);
  }
  const at = now();
  store.commit(changed.map(i => {
    const e = history[i].find(x => x.round === r);
    return { resource: `/r/${i}`, version: e.token, data: e.data };
  }));
  for (const i of changed) {
    const prev = current[i];
    const next = history[i].find(x => x.round === r);
    current[i] = next;
    const update = { version: [next.token], parents: [prev.token], ...braidUpdate(prev, next) };
    for (const res of subscribers[i]) { res.sendUpdate(update); counters.braidUpdates++; }
  }
  return { at, changed };
}

server.listen(0, '0.0.0.0', () => process.send({ port: server.address().port }));

process.on('message', m => {
  if (m === 'stats') {
    const cpu = process.cpuUsage();
    process.send({ stats: { ...counters, syncComputed: syncStats.computed, cpuMs: (cpu.user + cpu.system) / 1000 } });
  } else if (m && m.commit !== undefined) {
    process.send({ committed: m.commit, ...commit(m.commit) });
  }
});
