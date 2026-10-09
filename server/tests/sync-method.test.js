'use strict';

const http = require('http');
const zlib = require('zlib');
const { startServer, stopServer } = require('../src/index');
const { addVersion, getVersion, getCurrentVersion } = require('../src/version-store');
const { applyResult, JSON_PATCH, MERGE_PATCH, SNAPSHOT } = require('../../client/src/apply');

const PORT = 3001;

beforeAll(done => {
  addVersion('/tiny', 'v1', { a: 1 });
  addVersion('/tiny', 'v2', { a: 2 });
  addVersion('/nulls', 'v1', { a: { b: 1, c: 'x'.repeat(200) } });
  addVersion('/nulls', 'v2', { a: { b: null, c: 'x'.repeat(200) } });
  addVersion('/doc', 'v1', { title: 'T', body: 'y'.repeat(300), tags: ['a'] });
  addVersion('/doc', 'v2', { title: 'T2', body: 'y'.repeat(300), tags: ['a'], extra: { k: 1 } });
  const big = {};
  for (let i = 0; i < 200; i++) big[i] = { id: i, text: `item ${i} `.repeat(5) };
  addVersion('/big', 'v1', big);
  startServer(PORT, done);
});
afterAll(done => { stopServer(done); });

function rawSync({ body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const hdrs = { 'Accept': 'application/sync-result+json', ...headers };
    if (body !== undefined) {
      hdrs['Content-Type'] = 'application/sync-baseline+json';
      hdrs['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ hostname: 'localhost', port: PORT, path: '/api/users', method: 'SYNC', agent: false, headers: hdrs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let raw = Buffer.concat(chunks);
        const encoded = res.headers['content-encoding'];
        if (encoded === 'gzip') raw = zlib.gunzipSync(raw);
        const data = raw.toString('utf8');
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sync = (payload, headers) => rawSync({ body: JSON.stringify(payload), headers });

function plain(method, path, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null;
    const req = http.request({
      hostname: 'localhost', port: PORT, path, method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Basic ───────────────────────────────────────────────────────────────────

describe('Basic', () => {
  test('Server accepts SYNC method without 405', async () => {
    const res = await sync({ baselines: { '/users': 'v1' } });
    expect([200, 204]).toContain(res.status);
  });

  test('Returns 200 with per-resource results when client is behind', async () => {
    const res = await sync({ baselines: { '/users': 'v1' } });
    expect(res.status).toBe(200);
    expect(res.body.results['/users']).toMatchObject({ status: 200, from: 'v1', to: 'v3' });
  });

  test('Returns 204 when every resource is at its current version', async () => {
    const res = await sync({ baselines: { '/users': 'v3', '/posts': 'v2' } });
    expect(res.status).toBe(204);
  });

  test('Unchanged resources report 304 inside a mixed response', async () => {
    const res = await sync({ baselines: { '/users': 'v3', '/posts': 'v1' } });
    expect(res.status).toBe(200);
    expect(res.body.results['/users']).toEqual({ status: 304, to: 'v3' });
    expect(res.body.results['/posts'].status).toBe(200);
  });
});

// ─── Per-resource failure isolation ──────────────────────────────────────────

describe('Per-resource failure isolation', () => {
  test('Unrecognized baseline recovers with a snapshot while other resources still get deltas', async () => {
    const res = await sync({ baselines: { '/users': 'v999', '/posts': 'v1' } });
    expect(res.status).toBe(200);
    expect(res.body.results['/users']).toMatchObject({
      status: 200, format: SNAPSHOT, from: null, to: 'v3', baseline: 'unrecognized',
    });
    expect(res.body.results['/users'].data).toEqual(getCurrentVersion('/users').data);
    expect(res.body.results['/posts']).toMatchObject({ status: 200, from: 'v1', to: 'v2' });
  });

  test('recover:false reports 409 for only the stale resource', async () => {
    const res = await sync({ baselines: { '/users': 'v999', '/posts': 'v1' }, recover: false });
    expect(res.status).toBe(200);
    expect(res.body.results['/users']).toEqual({ status: 409 });
    expect(res.body.results['/posts'].status).toBe(200);
  });

  test('Missing resource reports 404 for only that resource', async () => {
    const res = await sync({ baselines: { '/nonexistent': 'v1', '/posts': 'v1' } });
    expect(res.status).toBe(200);
    expect(res.body.results['/nonexistent']).toEqual({ status: 404 });
    expect(res.body.results['/posts'].status).toBe(200);
  });

  test('A lone missing resource is still reported, not swallowed as 204', async () => {
    const res = await sync({ baselines: { '/nonexistent': 'v1' } });
    expect(res.status).toBe(200);
    expect(res.body.results['/nonexistent']).toEqual({ status: 404 });
  });

  test('A resource named /__proto__ is an ordinary key and pollutes nothing', async () => {
    const res = await rawSync({ body: '{"baselines":{"/__proto__":"v1","/posts":"v1"}}' });
    expect(res.status).toBe(200);
    expect(res.body.results['/__proto__']).toEqual({ status: 404 });
    expect({}.status).toBeUndefined();
  });

  test('A bare __proto__ key is rejected like any non-path name, and pollutes nothing', async () => {
    const res = await rawSync({ body: '{"baselines":{"__proto__":"v1"}}' });
    expect(res.status).toBe(422);
    expect({}.status).toBeUndefined();
  });
});

// ─── Request validation ──────────────────────────────────────────────────────

describe('Request validation', () => {
  test('422 when baselines is missing', async () => {
    expect((await sync({ resources: ['/users'] })).status).toBe(422);
  });

  test('400 when the content is not valid JSON (RFC 10008 Section 2.1)', async () => {
    expect((await rawSync({ body: '{ not json }' })).status).toBe(400);
  });

  test.each(['users', '//evil.example/users', 'https://evil.example/users', '', '/users#frag'])(
    '422 when a resource name is not path-absolute: %p', async name => {
      expect((await sync({ baselines: { [name]: 'v1' } })).status).toBe(422);
    });

  test('422 when a token is not a string or null', async () => {
    expect((await sync({ baselines: { '/users': 3 } })).status).toBe(422);
  });

  test('422 when recover is not a boolean', async () => {
    expect((await sync({ baselines: { '/users': 'v1' }, recover: 'no' })).status).toBe(422);
  });

  test('422 when accept is not an array of strings', async () => {
    expect((await sync({ baselines: { '/users': 'v1' }, accept: 'application/json' })).status).toBe(422);
  });

  test('422 when baselines are sent in both header and body', async () => {
    const res = await sync({ baselines: { '/users': 'v1' } }, { 'Sync-Baseline': '("/users" "v1")' });
    expect(res.status).toBe(422);
  });

  test('Empty baselines returns 204', async () => {
    expect((await sync({ baselines: {} })).status).toBe(204);
  });
});

// ─── Limits (SECURITY-ANALYSIS: amplification) ───────────────────────────────

describe('Limits', () => {
  test('413 when more than 100 resources are requested', async () => {
    const baselines = {};
    for (let i = 0; i < 101; i++) baselines[`/r/${i}`] = null;
    expect((await sync({ baselines })).status).toBe(413);
  });

  test('Exactly 100 resources is accepted', async () => {
    const baselines = {};
    for (let i = 0; i < 100; i++) baselines[`/r/${i}`] = null;
    expect((await sync({ baselines })).status).toBe(200);
  });

  test('413 when the declared body exceeds 64 KB', async () => {
    const res = await rawSync({ body: JSON.stringify({ baselines: { '/users': 'x'.repeat(70000) } }) });
    expect(res.status).toBe(413);
  });
});

// ─── Header-based baselines ──────────────────────────────────────────────────

describe('Sync-Baseline header', () => {
  test('Header form yields the same results as body form', async () => {
    const viaBody = await sync({ baselines: { '/users': 'v1', '/posts': 'v1' } });
    const viaHeader = await rawSync({ headers: { 'Sync-Baseline': '("/users" "v1"), ("/posts" "v1")' } });
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body.results).toEqual(viaBody.body.results);
  });

  test('A single-item inner list means no baseline (snapshot)', async () => {
    const res = await rawSync({ headers: { 'Sync-Baseline': '("/posts")' } });
    expect(res.body.results['/posts']).toMatchObject({ status: 200, format: SNAPSHOT, from: null });
  });

  test('Resource names containing "), (" and quotes survive the header parser', async () => {
    const res = await rawSync({ headers: { 'Sync-Baseline': '("/a), (\\"b" "v1")' } });
    expect(res.status).toBe(200);
    expect(res.body.results['/a), ("b']).toEqual({ status: 404 });
  });

  test('422 on a malformed header', async () => {
    expect((await rawSync({ headers: { 'Sync-Baseline': '/users=v1' } })).status).toBe(422);
  });

  test('Sync-Accept selects the patch format', async () => {
    const res = await rawSync({ headers: { 'Sync-Baseline': '("/doc" "v1")', 'Sync-Accept': MERGE_PATCH } });
    expect(res.body.results['/doc'].format).toBe(MERGE_PATCH);
  });
});

// ─── Patch formats ───────────────────────────────────────────────────────────

describe('Patch formats', () => {
  test('Defaults to JSON Patch (RFC 6902)', async () => {
    const res = await sync({ baselines: { '/doc': 'v1' } });
    const r = res.body.results['/doc'];
    expect(r.format).toBe(JSON_PATCH);
    for (const op of r.data) expect(['add', 'remove', 'replace', 'move', 'copy', 'test']).toContain(op.op);
  });

  test('Honours JSON Merge Patch (RFC 7396) when requested', async () => {
    const res = await sync({ baselines: { '/doc': 'v1' }, accept: [MERGE_PATCH] });
    expect(res.body.results['/doc']).toMatchObject({ format: MERGE_PATCH, data: { title: 'T2', extra: { k: 1 } } });
  });

  test('Falls back to JSON Patch when a change is inexpressible as merge patch (null member)', async () => {
    const res = await sync({ baselines: { '/nulls': 'v1' }, accept: [MERGE_PATCH, JSON_PATCH] });
    expect(res.body.results['/nulls'].format).toBe(JSON_PATCH);
  });

  test('Sends a snapshot when the patch is not smaller than the resource', async () => {
    const res = await sync({ baselines: { '/tiny': 'v1' } });
    expect(res.body.results['/tiny']).toMatchObject({ format: SNAPSHOT, from: 'v1', to: 'v2', data: { a: 2 } });
  });

  test('Unknown formats are skipped; the snapshot is the guaranteed fallback', async () => {
    const res = await sync({ baselines: { '/doc': 'v1' }, accept: ['application/x-bsdiff'] });
    expect(res.body.results['/doc'].format).toBe(SNAPSHOT);
  });

  test('A null baseline yields a full snapshot', async () => {
    const res = await sync({ baselines: { '/posts': null } });
    expect(res.body.results['/posts']).toMatchObject({ status: 200, format: SNAPSHOT, from: null, to: 'v2' });
  });
});

// ─── End-to-end correctness ──────────────────────────────────────────────────

describe('Applying results reproduces server state', () => {
  const cases = [
    ['/users', 'v1', undefined],
    ['/doc', 'v1', [MERGE_PATCH]],
    ['/nulls', 'v1', [MERGE_PATCH, JSON_PATCH]],
    ['/tiny', 'v1', undefined],
  ];

  test.each(cases)('%s from %s', async (resource, token, accept) => {
    const res = await sync({ baselines: { [resource]: token }, ...(accept && { accept }) });
    const local = getVersion(resource, token).data;
    const next = applyResult(local, token, res.body.results[resource]);
    expect(next).toEqual(getCurrentVersion(resource).data);
  });

  test('applyResult rejects a patch whose baseline is not the one the client holds', async () => {
    const res = await sync({ baselines: { '/doc': 'v1' } });
    const stale = getVersion('/doc', 'v2').data;
    expect(() => applyResult(stale, 'v2', res.body.results['/doc'])).toThrow(/baseline/);
  });
});

// ─── Headers ─────────────────────────────────────────────────────────────────

describe('Response headers', () => {
  test('Content-Type is application/sync-result+json', async () => {
    const res = await sync({ baselines: { '/users': 'v1' } });
    expect(res.headers['content-type']).toContain('application/sync-result+json');
  });

  test('Cache-Control: no-store', async () => {
    const res = await sync({ baselines: { '/users': 'v1' } });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('Sync-Delta-Complete is a Structured Field boolean', async () => {
    const res = await sync({ baselines: { '/users': 'v1' } });
    expect(res.headers['sync-delta-complete']).toBe('?1');
  });
});

// ─── Compression ─────────────────────────────────────────────────────────────

describe('Compression', () => {
  test('Large results are gzipped when the client accepts it', async () => {
    const res = await sync({ baselines: { '/big': null } }, { 'Accept-Encoding': 'gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toMatch(/Accept-Encoding/i);
    expect(res.body.results['/big'].data[199]).toMatchObject({ id: 199 });
  });

  test('Results are not compressed when the client does not accept gzip', async () => {
    const res = await sync({ baselines: { '/big': null } });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.results['/big'].status).toBe(200);
  });

  test('Small results are not compressed even if gzip is accepted', async () => {
    const res = await sync({ baselines: { '/tiny': 'v1' } }, { 'Accept-Encoding': 'gzip' });
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});

// ─── Coexistence and idempotency ─────────────────────────────────────────────

describe('Coexistence', () => {
  test('GET to the same endpoint still works', async () => {
    expect((await plain('GET', '/api/users')).status).toBe(200);
  });

  test('POST to the same endpoint still works', async () => {
    expect((await plain('POST', '/api/users', { name: 'Test' })).status).toBe(201);
  });

  test('SYNC is idempotent: same request twice returns the same results', async () => {
    const payload = { baselines: { '/users': 'v1', '/doc': 'v1' } };
    const r1 = await sync(payload);
    const r2 = await sync(payload);
    expect(r1.status).toBe(r2.status);
    expect(r1.body.results).toEqual(r2.body.results);
  });
});
