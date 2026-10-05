'use strict';

const http = require('http');
const jsonpatch = require('fast-json-patch');
const { startServer, stopServer } = require('../src/index');

const PORT = 3001;

beforeAll(done => { startServer(PORT, done); });
afterAll(done => { stopServer(done); });

function makeSyncRequest(path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: 'localhost',
      port: PORT,
      path,
      method: 'SYNC',
      agent: false,
      headers: {
        'Content-Type': 'application/sync-vector+json',
        'Accept': 'application/sync-delta+json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function makeGetRequest(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: 'localhost', port: PORT, path }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    }).on('error', reject);
  });
}

function makePostRequest(path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Basic ───────────────────────────────────────────────────────────────────

describe('Basic', () => {
  test('Server accepts SYNC method without 405', async () => {
    const res = await makeSyncRequest('/api/users', {
      version_vector: { '/users': 'v1' },
      resources: ['/users'],
    });
    expect([200, 204]).toContain(res.status);
  });

  test('Returns 200 with delta when client is behind', async () => {
    const res = await makeSyncRequest('/api/users', {
      version_vector: { '/users': 'v1' },
      resources: ['/users'],
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('deltas');
  });

  test('Returns 204 when client is already up to date', async () => {
    const res = await makeSyncRequest('/api/users', {
      version_vector: { '/users': 'v3' },
      resources: ['/users'],
    });
    expect(res.status).toBe(204);
  });

  test('Returns 409 when client version is unrecognizable', async () => {
    const res = await makeSyncRequest('/api/users', {
      version_vector: { '/users': 'v999' },
      resources: ['/users'],
    });
    expect(res.status).toBe(409);
  });
});

// ─── Request Validation ───────────────────────────────────────────────────────

describe('Request Validation', () => {
  test('Returns 422 when version_vector is missing', async () => {
    const res = await makeSyncRequest('/api/users', { resources: ['/users'] });
    expect(res.status).toBe(422);
  });

  test('Returns 422 when version_vector is malformed JSON', async () => {
    return new Promise((resolve, reject) => {
      const bodyStr = '{ not json }';
      const options = {
        hostname: 'localhost', port: PORT, path: '/api/users', method: 'SYNC',
        agent: false,
        headers: { 'Content-Type': 'application/sync-vector+json', 'Content-Length': Buffer.byteLength(bodyStr) },
      };
      const req = http.request(options, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          expect(res.statusCode).toBe(422);
          resolve();
        });
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });
  });

  test('Handles empty version_vector gracefully', async () => {
    const res = await makeSyncRequest('/api/users', { version_vector: {} });
    expect(res.status).toBe(204);
  });
});

// ─── Delta Correctness ────────────────────────────────────────────────────────

describe('Delta Correctness', () => {
  test('Delta contains only changed fields, not unchanged ones', async () => {
    const res = await makeSyncRequest('/api/users', {
      version_vector: { '/users': 'v2' },
      resources: ['/users'],
    });
    expect(res.status).toBe(200);
    const ops = res.body.deltas['/users'].operations;
    // v2→v3: only alice's email changed (JSON Pointer escapes / as ~1)
    const paths = ops.map(o => o.path);
    expect(paths.some(p => p.includes('email'))).toBe(true);
    expect(paths.every(p => !p.includes('~1users~12'))).toBe(true);
  });

  test('Delta operations are valid JSON Patch (RFC 6902)', async () => {
    const res = await makeSyncRequest('/api/users', {
      version_vector: { '/users': 'v1' },
      resources: ['/users'],
    });
    const ops = res.body.deltas['/users'].operations;
    for (const op of ops) {
      expect(['add', 'remove', 'replace', 'move', 'copy', 'test']).toContain(op.op);
      expect(typeof op.path).toBe('string');
    }
  });

  test('Applying delta to old state produces correct new state', async () => {
    const { getVersion, getCurrentVersion } = require('../src/version-store');
    const res = await makeSyncRequest('/api/users', {
      version_vector: { '/users': 'v1' },
      resources: ['/users'],
    });
    const ops = res.body.deltas['/users'].operations;
    const oldData = getVersion('/users', 'v1').data;
    const applied = jsonpatch.applyPatch(JSON.parse(JSON.stringify(oldData)), ops).newDocument;
    const current = getCurrentVersion('/users').data;
    expect(applied).toEqual(current);
  });

  test('Empty resources array returns 204', async () => {
    const res = await makeSyncRequest('/api/users', {
      version_vector: {},
      resources: [],
    });
    expect(res.status).toBe(204);
  });
});

// ─── Multi-resource ───────────────────────────────────────────────────────────

describe('Multi-resource', () => {
  test('SYNC with 3 resources returns delta for each independently', async () => {
    const res = await makeSyncRequest('/api/users', {
      version_vector: { '/users': 'v1', '/posts': 'v1', '/config': 'v1' },
      resources: ['/users', '/posts', '/config'],
    });
    expect(res.status).toBe(200);
    expect(res.body.deltas).toHaveProperty('/users');
    expect(res.body.deltas).toHaveProperty('/posts');
    expect(res.body.deltas).toHaveProperty('/config');
  });

  test('Resources at current version show empty operations array', async () => {
    const res = await makeSyncRequest('/api/users', {
      version_vector: { '/users': 'v3', '/posts': 'v1', '/config': 'v1' },
      resources: ['/users', '/posts', '/config'],
    });
    // /users is at current (v3) so has empty ops, but /posts and /config have changes → 200
    expect(res.status).toBe(200);
    expect(res.body.deltas['/users'].operations).toEqual([]);
  });

  test('Resources behind return correct per-resource delta', async () => {
    const res = await makeSyncRequest('/api/users', {
      version_vector: { '/users': 'v1', '/posts': 'v1', '/config': 'v1' },
      resources: ['/users', '/posts', '/config'],
    });
    expect(res.body.deltas['/users'].operations.length).toBeGreaterThan(0);
    expect(res.body.deltas['/posts'].operations.length).toBeGreaterThan(0);
    expect(res.body.deltas['/config'].operations.length).toBeGreaterThan(0);
  });
});

// ─── Headers ─────────────────────────────────────────────────────────────────

describe('Headers', () => {
  test('Response includes Sync-Server-Version header', async () => {
    const res = await makeSyncRequest('/api/users', {
      version_vector: { '/users': 'v1' },
      resources: ['/users'],
    });
    expect(res.headers['sync-server-version']).toBeTruthy();
  });

  test('Response Content-Type is application/sync-delta+json', async () => {
    const res = await makeSyncRequest('/api/users', {
      version_vector: { '/users': 'v1' },
      resources: ['/users'],
    });
    expect(res.headers['content-type']).toContain('application/sync-delta+json');
  });

  test('Response includes Sync-Delta-Complete header', async () => {
    const res = await makeSyncRequest('/api/users', {
      version_vector: { '/users': 'v1' },
      resources: ['/users'],
    });
    expect(res.headers['sync-delta-complete']).toBe('true');
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe('Edge Cases', () => {
  test('SYNC to non-existent resource returns 404', async () => {
    const res = await makeSyncRequest('/api/users', {
      version_vector: { '/nonexistent': 'v1' },
      resources: ['/nonexistent'],
    });
    expect(res.status).toBe(404);
  });

  test('GET to same endpoint still works (SYNC does not replace GET)', async () => {
    const res = await makeGetRequest('/api/users');
    expect(res.status).toBe(200);
  });

  test('POST to same endpoint still works', async () => {
    const res = await makePostRequest('/api/users', { name: 'Test' });
    expect(res.status).toBe(201);
  });

  test('SYNC is idempotent — same request twice returns same response', async () => {
    const body = { version_vector: { '/users': 'v1' }, resources: ['/users'] };
    const r1 = await makeSyncRequest('/api/users', body);
    const r2 = await makeSyncRequest('/api/users', body);
    expect(r1.status).toBe(r2.status);
    expect(JSON.stringify(r1.body?.deltas)).toBe(JSON.stringify(r2.body?.deltas));
  });
});
