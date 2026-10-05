'use strict';

const { startServer, stopServer } = require('../server/src/index');
const { syncRequest } = require('../client/src/sync-client');
const { VersionVector } = require('../client/src/version-vector');

const PORT = 3002;
const BASE = `http://localhost:${PORT}`;

function log(label, obj) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(60));
  if (obj !== undefined) console.log(JSON.stringify(obj, null, 2));
}

async function run() {
  await new Promise(r => startServer(PORT, r));
  console.log(`\nSYNC Demo Server started on port ${PORT}`);

  // Client starts at v1 for all resources
  const vv = new VersionVector({
    '/users': 'v1',
    '/posts': 'v1',
    '/config': 'v1',
  });

  log('CLIENT INITIAL VERSION VECTOR', vv.toJSON());

  // ── First SYNC: client is behind ─────────────────────────────────────────
  log('SYNC REQUEST #1 — client at v1 for all resources');
  const result1 = await syncRequest(
    `${BASE}/api/users`,
    vv.toJSON(),
    ['/users', '/posts', '/config']
  );

  if (result1 === null) {
    console.log('  → 204 No Content: already up to date');
  } else {
    console.log(`  → ${result1.status} received`);
    log('DELTA RESPONSE', result1.body);

    vv.applyDelta(result1.body);
    log('CLIENT VERSION VECTOR AFTER APPLYING DELTA', vv.toJSON());
  }

  // ── Second SYNC: client is now up to date ─────────────────────────────────
  log('SYNC REQUEST #2 — client now at latest version');
  const result2 = await syncRequest(
    `${BASE}/api/users`,
    vv.toJSON(),
    ['/users', '/posts', '/config']
  );

  if (result2 === null) {
    console.log('  → 204 No Content: already up to date ✓');
  } else {
    console.log(`  → ${result2.status}`);
    log('UNEXPECTED DELTA', result2.body);
  }

  log('DEMO COMPLETE');
  stopServer(() => {});
}

run().catch(err => { console.error(err); process.exit(1); });
