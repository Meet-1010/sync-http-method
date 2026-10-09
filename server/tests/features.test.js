'use strict';

const http = require('http');
const { syncHandler, createMemoryStore } = require('../src/package');
const { createSyncClient, syncFetch, SyncError } = require('../../client/src/index');
const { resetTransportCache } = require('../../client/src/fetch-client');
const { parseMultipartResults } = require('../../client/src/multipart');
const { applyResult } = require('../../client/src/apply');

const SECRET = 'test-secret-'.repeat(4);

async function serve(store, options = {}) {
  const handle = syncHandler({ store, ...options });
  const server = http.createServer((req, res) => handle(req, res, () => { res.statusCode = 404; res.end(); }));
  const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  return { url: `http://127.0.0.1:${port}/sync`, base: `http://127.0.0.1:${port}`, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}

async function query(url, payload, headers = {}) {
  const res = await fetch(url, {
    method: 'QUERY',
    headers: { 'Content-Type': 'application/sync-baseline+json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes };
}
const json = r => JSON.parse(Buffer.from(r.bytes).toString('utf8'));

beforeEach(() => resetTransportCache());

const lines = n => Array.from({ length: n }, (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog.`).join('\n') + '\n';

// ─── Versions as sets ────────────────────────────────────────────────────────

describe('Versions as sets of identifiers', () => {
  let srv, store;
  beforeAll(async () => {
    store = createMemoryStore();
    store.addVersion('/doc', 'a1', { a: 1, pad: 'x'.repeat(100) });
    store.addVersion('/doc', ['a2', 'b1'], { a: 2, b: 1, pad: 'x'.repeat(100) }); // a merge
    store.addVersion('/doc', 'c1', { a: 3, b: 1, pad: 'x'.repeat(100) });
    srv = await serve(store);
  });
  afterAll(() => srv.close());

  test('A set baseline is recognized regardless of order, and from is canonical', async () => {
    const r = json(await query(srv.url, { baselines: { '/doc': ['b1', 'a2'] } }));
    expect(r.results['/doc']).toMatchObject({ status: 200, from: ['a2', 'b1'], to: 'c1', format: 'application/json-patch+json' });
  });

  test('A single identifier and a one-element array are the same version', async () => {
    expect((await query(srv.url, { baselines: { '/doc': ['c1'] } })).status).toBe(204);
    expect((await query(srv.url, { baselines: { '/doc': 'c1' } })).status).toBe(204);
  });

  test.each([[[]], [['a', 'a']], [[1]], [''], [{}], [['ok', '']]])('baseline %j is rejected with 422', async b => {
    expect((await query(srv.url, { baselines: { '/doc': b } })).status).toBe(422);
  });

  test('A client holding a merged version applies the patch correctly', async () => {
    const r = json(await query(srv.url, { baselines: { '/doc': ['a2', 'b1'] } }));
    const next = applyResult({ a: 2, b: 1, pad: 'x'.repeat(100) }, ['b1', 'a2'], r.results['/doc']);
    expect(next).toEqual({ a: 3, b: 1, pad: 'x'.repeat(100) });
  });
});

// ─── Any media type ──────────────────────────────────────────────────────────

describe('Representations of any media type', () => {
  let srv, store;
  const bin1 = new Uint8Array(4000).map((_, i) => (i * 7) % 256);
  const bin2 = (() => { const b = bin1.slice(); b[1234] = 1; b[1235] = 2; return b; })();
  beforeAll(async () => {
    store = createMemoryStore();
    store.addVersion('/notes.md', 'm1', `# Notes\n${lines(80)}`, 'text/markdown; charset=utf-8');
    store.addVersion('/notes.md', 'm2', `# Notes ✏️\n${lines(80).replace('Line 40', 'Line forty, édité 😀')}`, 'text/markdown; charset=utf-8');
    store.addVersion('/blob', 'b1', bin1, 'application/octet-stream');
    store.addVersion('/blob', 'b2', bin2, 'application/octet-stream');
    store.addVersion('/page', 'p1', '<p>hello</p>', 'text/plain');
    store.addVersion('/page', 'p2', '<p>hello</p>', 'text/html');
    store.addVersion('/feed.xml', 'x1', `<feed>${lines(40)}</feed>`, 'application/atom+xml');
    store.addVersion('/feed.xml', 'x2', `<feed>${lines(40).replace('Line 3:', 'Line three:')}</feed>`, 'application/atom+xml');
    srv = await serve(store);
  });
  afterAll(() => srv.close());

  test('Text changes travel as a code-point splice that reproduces the new text exactly', async () => {
    const r = json(await query(srv.url, { baselines: { '/notes.md': 'm1' } })).results['/notes.md'];
    expect(r).toMatchObject({ status: 200, from: 'm1', to: 'm2', format: 'application/sync-splice+json' });
    expect(r.data.unit).toBe('codepoint');
    const next = applyResult(store.getVersion('/notes.md', 'm1').data, 'm1', r);
    expect(next).toBe(store.getVersion('/notes.md', 'm2').data);
    expect(JSON.stringify(r).length).toBeLessThan(store.getVersion('/notes.md', 'm2').data.length / 5);
  });

  test('Binary changes travel as a byte splice', async () => {
    const r = json(await query(srv.url, { baselines: { '/blob': 'b1' } })).results['/blob'];
    expect(r).toMatchObject({ format: 'application/sync-splice+json', data: { unit: 'byte' } });
    expect(Buffer.from(applyResult(bin1, 'b1', r)).equals(Buffer.from(bin2))).toBe(true);
  });

  test('Full text representations are strings; full binary ones are base64 in the JSON format', async () => {
    const r = json(await query(srv.url, { baselines: { '/notes.md': null, '/blob': null } })).results;
    expect(r['/notes.md']).toMatchObject({ type: 'text/markdown; charset=utf-8', from: null });
    expect(typeof r['/notes.md'].data).toBe('string');
    expect(r['/blob']).toMatchObject({ type: 'application/octet-stream', encoding: 'base64' });
    expect(Buffer.from(applyResult(undefined, null, r['/blob'])).equals(Buffer.from(bin2))).toBe(true);
  });

  test('A change of media type always sends the full representation', async () => {
    const r = json(await query(srv.url, { baselines: { '/page': 'p1' } })).results['/page'];
    expect(r).toEqual({ status: 200, from: null, to: 'p2', type: 'text/html', data: '<p>hello</p>' });
  });

  test('+xml types are text', async () => {
    const r = json(await query(srv.url, { baselines: { '/feed.xml': 'x1' } })).results['/feed.xml'];
    expect(r).toMatchObject({ format: 'application/sync-splice+json', data: { unit: 'codepoint' } });
  });

  test('The client keeps text as strings and binary as bytes, and persists both', async () => {
    const client = createSyncClient(srv.url);
    const first = await client.sync(['/notes.md', '/blob']);
    expect(typeof first.values['/notes.md']).toBe('string');
    expect(first.values['/blob']).toBeInstanceOf(Uint8Array);
    const restored = createSyncClient(srv.url, { state: JSON.parse(JSON.stringify(client)) });
    expect(Buffer.from(restored.get('/blob')).equals(Buffer.from(bin2))).toBe(true);
    expect(restored.get('/notes.md')).toBe(store.getCurrent('/notes.md').data);
  });
});

// ─── Multipart result format and negotiation ─────────────────────────────────

describe('multipart/mixed results', () => {
  let srv, store;
  const bin = new Uint8Array(300).map((_, i) => (i * 13) % 256);
  beforeAll(async () => {
    store = createMemoryStore();
    store.addVersion('/a', 'a1', { n: 1, pad: 'y'.repeat(200) });
    store.addVersion('/a', 'a2', { n: 2, pad: 'y'.repeat(200) });
    store.addVersion('/t', 't1', lines(30), 'text/plain');
    store.addVersion('/bin', 'b1', bin, 'image/x-test');
    store.addVersion('/same', 's1', { ok: true });
    srv = await serve(store);
  });
  afterAll(() => srv.close());

  const baselines = { '/a': 'a1', '/t': null, '/bin': null, '/same': 's1', '/missing': null };

  test('Each resource is one part; full binary content is carried raw', async () => {
    const r = await query(srv.url, { baselines }, { Accept: 'multipart/mixed' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^multipart\/mixed; boundary="sync-/);
    const raw = Buffer.from(r.bytes);
    expect(raw.includes(Buffer.from(bin))).toBe(true);
    const { results } = parseMultipartResults(r.bytes, r.headers.get('content-type'));
    expect(results['/a']).toMatchObject({ status: 200, from: 'a1', to: 'a2', format: 'application/json-patch+json' });
    expect(results['/t']).toMatchObject({ status: 200, from: null, to: 't1', type: 'text/plain', value: lines(30) });
    expect(Buffer.from(results['/bin'].value).equals(Buffer.from(bin))).toBe(true);
    expect(results['/same']).toEqual({ status: 304, to: 's1' });
    expect(results['/missing']).toEqual({ status: 404 });
  });

  test('Both formats describe the same results', async () => {
    const viaJson = json(await query(srv.url, { baselines })).results;
    const m = await query(srv.url, { baselines }, { Accept: 'multipart/mixed' });
    const viaMultipart = parseMultipartResults(m.bytes, m.headers.get('content-type')).results;
    for (const name of Object.keys(baselines)) {
      const held = name === '/a' ? store.getVersion('/a', 'a1').data : undefined;
      const version = baselines[name];
      if (viaJson[name].status === 200) {
        expect(applyResult(held, version, viaMultipart[name])).toEqual(applyResult(held, version, viaJson[name]));
      } else {
        expect(viaMultipart[name]).toEqual(viaJson[name]);
      }
    }
  });

  test.each([
    ['application/sync-result+json;q=0.5, multipart/mixed', 'multipart'],
    ['multipart/*', 'multipart'],
    ['*/*', 'json'],
    ['application/sync-result+json, multipart/mixed', 'json'],
    [undefined, 'json'],
  ])('Accept %p selects %s', async (accept, expected) => {
    const r = await query(srv.url, { baselines: { '/a': 'a1' } }, accept ? { Accept: accept } : {});
    expect(r.headers.get('content-type').startsWith(expected === 'json' ? 'application/sync-result+json' : 'multipart/mixed')).toBe(true);
    expect(r.headers.get('vary')).toMatch(/Accept/);
  });

  test('406 with problem details when no result format is acceptable', async () => {
    const r = await query(srv.url, { baselines: { '/a': 'a1' } }, { Accept: 'text/html' });
    expect(r.status).toBe(406);
    expect(r.headers.get('content-type')).toBe('application/problem+json');
    expect(json(r)).toMatchObject({ status: 406, title: 'Not Acceptable' });
  });

  test('The client can ask for multipart and gets the same values', async () => {
    const a = await createSyncClient(srv.url).sync(Object.keys(baselines));
    const b = await createSyncClient(srv.url, { result: 'multipart' }).sync(Object.keys(baselines));
    expect(Buffer.from(b.values['/bin']).equals(Buffer.from(a.values['/bin']))).toBe(true);
    expect(b.values['/t']).toBe(a.values['/t']);
    expect(b.values['/a']).toEqual(a.values['/a']);
  });
});

// ─── Problem details ─────────────────────────────────────────────────────────

describe('Errors use RFC 9457 problem details', () => {
  let srv;
  beforeAll(async () => { srv = await serve(createMemoryStore()); });
  afterAll(() => srv.close());

  test.each([['{ not json', 400], ['{"baselines":[]}', 422], ['{"baselines":{"/a":null},"links":"yes"}', 422]])('%s -> %i', async (body, status) => {
    const r = await query(srv.url, body);
    expect(r.status).toBe(status);
    expect(r.headers.get('content-type')).toBe('application/problem+json');
    expect(json(r)).toMatchObject({ status, title: expect.any(String), detail: expect.any(String) });
  });

  test('A store returning a malformed version is a 500, not a crash', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const bad = await serve({ getCurrent: () => ({ id: 'v1', data: {} }), getVersion: () => null });
    const r = await query(bad.url, { baselines: { '/x': null } });
    await bad.close();
    quiet.mockRestore();
    expect(r.status).toBe(500);
    expect(json(r).status).toBe(500);
  });
});

// ─── Consistency across resources ────────────────────────────────────────────

// A store whose reads take time, so that a write can land between two reads of
// the same request, as with a remote database.
function slowStore(inner, delays) {
  const wait = r => new Promise(res => setTimeout(res, delays[r] || 0));
  const wrap = view => ({
    getCurrent: async r => { await wait(r); return view.getCurrent(r); },
    getVersion: async (r, v) => { await wait(r); return view.getVersion(r, v); },
  });
  return { ...wrap(inner), snapshot: () => wrap(inner.snapshot()) };
}

describe('Consistent snapshots across resources', () => {
  let srv, store;
  beforeEach(async () => {
    store = createMemoryStore();
    store.commit([
      { resource: '/users', version: 'u1', data: { ids: [1] } },
      { resource: '/posts', version: 'p1', data: [{ author: 1 }] },
    ]);
    srv = await serve(slowStore(store, { '/posts': 60 }));
  });
  afterEach(() => srv.close());

  // The writer adds user 2 and a post by user 2 in one transaction, between the
  // reads of /users (immediate) and /posts (after 60 ms).
  const writeDuring = () => setTimeout(() => store.commit([
    { resource: '/users', version: 'u2', data: { ids: [1, 2] } },
    { resource: '/posts', version: 'p2', data: [{ author: 1 }, { author: 2 }] },
  ]), 20);

  const invariantHolds = r => {
    const ids = r['/users'].data.ids;
    return r['/posts'].data.every(p => ids.includes(p.author));
  };

  test('Without consistent, a concurrent transaction can produce a torn read', async () => {
    writeDuring();
    const r = json(await query(srv.url, { baselines: { '/users': null, '/posts': null } })).results;
    expect([r['/users'].to, r['/posts'].to]).toEqual(['u1', 'p2']);
    expect(invariantHolds(r)).toBe(false);
  });

  test('With consistent, every resource comes from one instant', async () => {
    writeDuring();
    const res = await query(srv.url, { baselines: { '/users': null, '/posts': null }, consistent: true });
    const r = json(res).results;
    expect(res.headers.get('sync-consistent')).toBe('?1');
    expect([r['/users'].to, r['/posts'].to]).toEqual(['u1', 'p1']);
    expect(invariantHolds(r)).toBe(true);
  });

  test('A store without snapshots answers Sync-Consistent: ?0, and the client refuses it', async () => {
    const noSnap = await serve({ getCurrent: r => store.getCurrent(r), getVersion: (r, v) => store.getVersion(r, v) });
    const res = await query(noSnap.url, { baselines: { '/users': null }, consistent: true });
    expect(res.headers.get('sync-consistent')).toBe('?0');
    await expect(createSyncClient(noSnap.url, { consistent: true }).sync(['/users'])).rejects.toBeInstanceOf(SyncError);
    await noSnap.close();
  });
});

// ─── Links to cacheable updates ──────────────────────────────────────────────

describe('Links to immutable, cacheable updates', () => {
  let srv, store, calls;
  // Each version rewrites one item's text: the patch (~150 bytes) is above minBytes but far below the document (~8 KB).
  const big = n => ({ items: Array.from({ length: 200 }, (_, i) => ({ i, text: i === 7 ? 'Q'.repeat(100 + n) : 'z'.repeat(20) })) });
  beforeAll(async () => {
    store = createMemoryStore({ maxVersions: 3 });
    store.addVersion('/big', 'g1', big(1));
    store.addVersion('/big', 'g2', big(2));
    store.addVersion('/small', 's1', { a: 1 });
    store.addVersion('/small', 's2', { a: 2 });
    store.addVersion('/private', 'x1', big(1));
    store.addVersion('/private', 'x2', big(2));
    calls = 0;
    const guarded = {
      getCurrent: (r, ctx) => (r === '/private' && ctx.headers.authorization !== 'Bearer ok' ? null : store.getCurrent(r)),
      getVersion: (r, v, ctx) => { calls++; return r === '/private' && ctx.headers.authorization !== 'Bearer ok' ? null : store.getVersion(r, v); },
    };
    srv = await serve(guarded, { links: { secret: SECRET, path: '/sync/u', minBytes: 64, cacheControl: 'public, max-age=31536000, immutable' } });
  });
  afterAll(() => srv.close());

  const fullOf = r => json(r).results;

  test('Large updates become links; small ones stay inline', async () => {
    const r = fullOf(await query(srv.url, { baselines: { '/big': null, '/small': 's1' }, links: true }));
    expect(r['/big']).toMatchObject({ status: 200, from: null, to: 'g2', type: 'application/json' });
    expect(r['/big'].href).toMatch(/^\/sync\/u\/[A-Za-z0-9_-]+$/);
    expect(r['/big']).not.toHaveProperty('data');
    expect(r['/small']).toMatchObject({ status: 200, data: expect.anything() });
  });

  test('Links are only used when the client asks for them', async () => {
    const r = fullOf(await query(srv.url, { baselines: { '/big': null } }));
    expect(r['/big']).not.toHaveProperty('href');
  });

  test('The link is immutable and cacheable, and the same for every client at the same baseline', async () => {
    const a = fullOf(await query(srv.url, { baselines: { '/big': 'g1' }, links: true }))['/big'];
    const b = fullOf(await query(srv.url, { baselines: { '/big': 'g1' }, links: true }))['/big'];
    expect(a.href).toBe(b.href);
    expect(a.href).not.toMatch(/big|g1|g2/);
    const res = await fetch(srv.base + a.href);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json-patch+json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{22}"$/);
    const patch = await res.json();
    expect(applyResult(big(1), 'g1', { ...a, data: patch })).toEqual(big(2));
    const again = await fetch(srv.base + a.href, { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    const head = await fetch(srv.base + a.href, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  test('Altered or foreign links are 404', async () => {
    const a = fullOf(await query(srv.url, { baselines: { '/big': 'g1' }, links: true }))['/big'];
    const last = a.href.slice(-1);
    const tampered = a.href.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect((await fetch(srv.base + tampered)).status).toBe(404);
    expect((await fetch(`${srv.base}/sync/u/not-a-link`)).status).toBe(404);
  });

  test('Link GETs are authorized like the query itself', async () => {
    const r = fullOf(await query(srv.url, { baselines: { '/private': 'x1' }, links: true }, { Authorization: 'Bearer ok' }))['/private'];
    expect(r.href).toBeDefined();
    expect((await fetch(srv.base + r.href)).status).toBe(404);
    expect((await fetch(srv.base + r.href, { headers: { Authorization: 'Bearer ok' } })).status).toBe(200);
  });

  test('The client follows links and reproduces the server state', async () => {
    const client = createSyncClient(srv.url, { links: true });
    expect((await client.sync(['/big', '/small'])).values['/big']).toEqual(big(2));
  });

  test('If a link has expired the client asks again inline and still converges', async () => {
    const client = createSyncClient(srv.url, { links: true, state: { '/big': { version: 'g1', value: big(1) } } });
    const fetchSpy = async (u, init) => {
      if (String(u).includes('/sync/u/')) return new Response(null, { status: 404 });
      return fetch(u, init);
    };
    client.options.fetch = fetchSpy;
    expect((await client.sync(['/big'])).values['/big']).toEqual(big(2));
  });

  test('A bit-flipping attack on the encrypted link is rejected by its authentication', () => {
    // AES-CTR is malleable: knowing the plaintext layout, an attacker can flip exactly
    // the bits that turn version "g1" into "g2". Only the HMAC check stops this.
    const { createLinkCodec } = require('../src/links');
    const codec = createLinkCodec(SECRET);
    const payload = { r: '/big', f: ['g1'], t: ['g2'], fmt: 'application/json-patch+json' };
    const raw = Buffer.from(codec.encode(payload), 'base64url');
    const from = Buffer.from(JSON.stringify(payload));
    const to = Buffer.from(JSON.stringify({ ...payload, f: ['g2'] }));
    expect(to.length).toBe(from.length);
    for (let i = 0; i < from.length; i++) raw[16 + i] ^= from[i] ^ to[i];
    expect(codec.decode(raw.toString('base64url'))).toBeNull();
  });

  test('Configuration is validated', () => {
    expect(() => syncHandler({ links: { secret: 'short', path: '/u' } })).toThrow(/32/);
    expect(() => syncHandler({ links: { secret: SECRET, path: 'relative' } })).toThrow(/absolute path/);
    expect(() => syncHandler({ links: { secret: SECRET, path: '/u/' } })).toThrow(/absolute path/);
  });

  test('syncFetch resolves links for low-level callers too', async () => {
    const res = await syncFetch(srv.url, { '/big': 'g1' }, { links: true });
    expect(res.body.results['/big']).toMatchObject({ from: 'g1', format: 'application/json-patch+json', data: expect.any(Array) });
    expect(calls).toBeGreaterThan(0);
  });
});

// ─── Reuse of identical updates ──────────────────────────────────────────────

describe('Identical catch-ups compute each update once', () => {
  test('100 clients at the same baseline cost one diff', async () => {
    const { stats } = require('../src/sync-core');
    const store = createMemoryStore();
    store.addVersion('/doc', 'd1', { n: 1, pad: 'p'.repeat(500) });
    store.addVersion('/doc', 'd2', { n: 2, pad: 'p'.repeat(500) });
    const srv = await serve(store);
    const before = { ...stats };
    const all = await Promise.all(Array.from({ length: 100 }, () => query(srv.url, { baselines: { '/doc': 'd1' } })));
    await srv.close();
    expect(all.every(r => r.status === 200)).toBe(true);
    expect(stats.computed - before.computed).toBe(1);
    expect(stats.reused - before.reused).toBe(99);
  });

  test('Different stores never share entries', async () => {
    const { stats } = require('../src/sync-core');
    const make = n => { const s = createMemoryStore(); s.addVersion('/doc', 'd1', { n: 0, pad: 'q'.repeat(300) }); s.addVersion('/doc', 'd2', { n, pad: 'q'.repeat(300) }); return s; };
    const a = await serve(make(1));
    const b = await serve(make(2));
    const before = stats.computed;
    const ra = json(await query(a.url, { baselines: { '/doc': 'd1' } })).results['/doc'];
    const rb = json(await query(b.url, { baselines: { '/doc': 'd1' } })).results['/doc'];
    await a.close(); await b.close();
    expect(stats.computed - before).toBe(2);
    expect(ra.data).not.toEqual(rb.data);
  });
});
