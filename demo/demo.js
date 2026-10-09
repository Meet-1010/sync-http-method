'use strict';

const { startServer, stopServer } = require('../server/src/index');
const { getVersion } = require('../server/src/version-store');
const { syncRequest } = require('../client/src/sync-client');
const { BaselineMap } = require('../client/src/baseline-map');
const { applyResult, MERGE_PATCH, JSON_PATCH } = require('../client/src/apply');

const PORT = 3002;
const BASE = `http://localhost:${PORT}/api/users`;

function log(label, obj) {
  console.log(`\n${'─'.repeat(60)}\n  ${label}\n${'─'.repeat(60)}`);
  if (obj !== undefined) console.log(JSON.stringify(obj, null, 2));
}

async function run() {
  await new Promise(r => startServer(PORT, r));
  console.log(`\nSYNC demo server on port ${PORT}`);

  // The client holds old copies of three resources, plus a stale token for a fourth.
  const baselines = new BaselineMap({ '/users': 'v1', '/posts': 'v1', '/config': 'v1', '/ghost': 'v7' });
  const local = {
    '/users': getVersion('/users', 'v1').data,
    '/posts': getVersion('/posts', 'v1').data,
    '/config': getVersion('/config', 'v1').data,
  };
  log('CLIENT BASELINES', baselines.toJSON());

  log('SYNC #1 — four resources in one request, one of them unknown to the server');
  const first = await syncRequest(BASE, baselines.toJSON(), { accept: [MERGE_PATCH, JSON_PATCH] });
  console.log(`  → HTTP ${first.status}`);
  log('PER-RESOURCE RESULTS', first.body.results);

  for (const [resource, result] of Object.entries(first.body.results)) {
    if (result.status === 200) local[resource] = applyResult(local[resource], baselines.get(resource), result);
  }
  baselines.applyResults(first.body);
  log('CLIENT STATE AFTER APPLYING (resources that succeeded)', baselines.toJSON());

  log('SYNC #2 — everything the client tracks is now current');
  const current = Object.fromEntries(Object.entries(baselines.toJSON()).filter(([r]) => r !== '/ghost'));
  const second = await syncRequest(BASE, current);
  console.log(`  → HTTP ${second.status}${second.status === 204 ? ' No Content: nothing to transfer' : ''}`);

  log('DEMO COMPLETE');
  stopServer(() => {});
}

run().catch(err => { console.error(err); process.exit(1); });
