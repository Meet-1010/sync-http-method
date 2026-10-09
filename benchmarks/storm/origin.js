'use strict';

// Origin for the reconnect-storm benchmark, in its own process so its CPU time can
// be measured. One HTTP server serves:
//   GET  /get/r/<i>      the current resource (cacheable by shared caches)
//   GET  /braid/r/<i>    braid-http: with Parents, the updates since that version
//                        (cacheable, Vary: Parents)
//   QUERY /sync          SYNC (syncHandler); links and shared results under /sync/u/
// Controlled over IPC: 'stats' returns counters and CPU time.

const http = require('http');
const { braidify } = require('braid-http');
const { syncHandler, createMemoryStore } = require('../../server/src/package');
const { stats: syncStats } = require('../../server/src/sync-core');
const { buildHistories, entryAt } = require('../lib/dataset');
const { braidUpdate } = require('../lib/braid');

const N = Number(process.env.N);
const L = Number(process.env.L);
const SECRET = process.env.LINK_SECRET;
const SHARED = 'public, max-age=600';

const history = buildHistories(N);
const store = createMemoryStore();
for (let i = 0; i < N; i++) for (const e of history[i]) if (e.round <= L) store.addVersion(`/r/${i}`, e.token, e.data);

const counters = { requests: 0, get: 0, braid: 0, braidDiffs: 0, sync: 0, linkGets: 0 };

const sync = syncHandler({
  store,
  cacheControl: 'no-store',
  links: { secret: SECRET, path: '/sync/u', minBytes: 256, cacheControl: 'public, max-age=31536000, immutable' },
});

const braid = braidify((req, res) => {
  counters.braid++;
  const i = Number(req.url.split('/')[3]);
  const cur = entryAt(history[i], L);
  const parent = req.parents?.[0];
  res.setHeader('Cache-Control', SHARED);
  res.setHeader('Vary', 'Parents');
  res.setHeader('Current-Version', `"${cur.token}"`);
  if (parent === cur.token) { res.statusCode = 304; return res.end(); }
  const base = history[i].find(e => e.token === parent);
  counters.braidDiffs++;
  res.statusCode = 200;
  res.sendUpdate({ version: [cur.token], parents: [parent], ...braidUpdate(base, cur) });
  res.end();
});

const server = http.createServer((req, res) => {
  counters.requests++;
  if (req.url.startsWith('/get/')) {
    counters.get++;
    const i = Number(req.url.split('/')[3]);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', SHARED);
    return res.end(JSON.stringify(entryAt(history[i], L).data));
  }
  if (req.url.startsWith('/braid/')) return braid(req, res);
  if (req.url.startsWith('/sync')) {
    if (req.url.startsWith('/sync/u/')) counters.linkGets++; else counters.sync++;
    return sync(req, res, () => { res.statusCode = 404; res.end(); });
  }
  res.statusCode = 404;
  res.end();
});

server.listen(0, '0.0.0.0', () => process.send({ port: server.address().port }));

process.on('message', m => {
  if (m === 'stats') {
    const cpu = process.cpuUsage();
    process.send({ stats: { ...counters, syncComputed: syncStats.computed, syncReused: syncStats.reused, cpuMs: (cpu.user + cpu.system) / 1000 } });
  }
});
