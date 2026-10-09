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
    expect(a.href.length).toBeLessThan(80);
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
    const payload = ['/big', 'g1', 'g2', 'j'];
    const raw = Buffer.from(codec.encode(payload), 'base64url');
    const from = Buffer.from(JSON.stringify(payload));
    const to = Buffer.from(JSON.stringify(['/big', 'g2', 'g2', 'j']));
    expect(to.length).toBe(from.length);
    // Layout: 16-byte IV, then one format byte (0: uncompressed JSON), then the JSON.
    expect(codec.decode(codec.encode(payload))).toEqual(payload);
    for (let i = 0; i < from.length; i++) raw[17 + i] ^= from[i] ^ to[i];
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

  test('A link to an update the query computed is served without computing it again', async () => {
    const { stats } = require('../src/sync-core');
    const store = createMemoryStore();
    store.addVersion('/doc', 'd1', { n: 1, items: Array.from({ length: 50 }, (_, i) => `item ${i}`) });
    store.addVersion('/doc', 'd2', { n: 2, items: Array.from({ length: 50 }, (_, i) => `item ${i}`) });
    const srv = await serve(store, { links: { secret: SECRET, path: '/sync/u', minBytes: 1 } });
    const before = stats.computed;
    const r = json(await query(srv.url, { baselines: { '/doc': 'd1' }, links: true })).results['/doc'];
    const res = await fetch(srv.base + r.href);
    await srv.close();
    expect(res.status).toBe(200);
    expect(stats.computed - before).toBe(1);
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

// ─── Shared results: 303 (See Other) to a cacheable result ───────────────────

describe('Shared results via 303 See Other (RFC 10008 Section 2.5)', () => {
  let srv, store, guarded;
  const doc = n => ({ n, pad: 'p'.repeat(400) });
  const LINKS = { secret: SECRET, path: '/sync/u', minBytes: 64, cacheControl: 'public, max-age=31536000, immutable' };
  beforeEach(async () => {
    store = createMemoryStore({ maxVersions: 2 });
    store.addVersion('/a', 'a1', doc(1));
    store.addVersion('/a', 'a2', doc(2));
    store.addVersion('/b', 'b1', 'text one\n', 'text/plain');
    store.addVersion('/private', 'p1', { secret: 1 });
    guarded = {
      getCurrent: (r, ctx) => (r === '/private' && ctx.headers.authorization !== 'Bearer ok' ? null : store.getCurrent(r)),
      getVersion: (r, v, ctx) => (r === '/private' && ctx.headers.authorization !== 'Bearer ok' ? null : store.getVersion(r, v)),
      snapshot: () => store.snapshot(),
    };
    srv = await serve(guarded, { links: LINKS });
  });
  afterEach(() => srv.close());

  const manual = (payload, headers = {}) => fetch(srv.url, {
    method: 'QUERY',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/sync-baseline+json', ...headers },
    body: JSON.stringify(payload),
  });
  const request = { baselines: { '/a': 'a1', '/b': null, '/missing': null } };

  test('The server answers 303 with a Location under the links path, and GET returns the same results', async () => {
    const res = await manual({ ...request, redirect: true });
    expect(res.status).toBe(303);
    const location = res.headers.get('location');
    expect(location).toMatch(/^\/sync\/u\/[A-Za-z0-9_-]+$/);
    expect(location).not.toMatch(/a1|a2|b1|missing/);
    expect(res.headers.get('accept-query')).toBe('"application/sync-baseline+json"');

    const shared = await fetch(srv.base + location);
    expect(shared.status).toBe(200);
    expect(shared.headers.get('content-type')).toBe('application/sync-result+json');
    expect(shared.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(shared.headers.get('sync-delta-complete')).toBe('?1');
    const direct = json(await query(srv.url, request));
    expect(await shared.json()).toEqual(direct);
  });

  test('Every client in the same state gets the same URI; another state gets another', async () => {
    const one = (await manual({ ...request, redirect: true })).headers.get('location');
    const two = (await manual({ ...request, redirect: true })).headers.get('location');
    expect(two).toBe(one);
    const other = (await manual({ baselines: { '/a': null, '/b': null, '/missing': null }, redirect: true })).headers.get('location');
    expect(other).not.toBe(one);
    store.addVersion('/b', 'b2', 'text two\n', 'text/plain');
    const after = (await manual({ ...request, redirect: true })).headers.get('location');
    expect(after).not.toBe(one);
  });

  test('A shared result never changes: an old URI still returns the old results until its versions are dropped', async () => {
    const location = (await manual({ ...request, redirect: true })).headers.get('location');
    const before = await (await fetch(srv.base + location)).text();
    store.addVersion('/b', 'b2', 'text two\n', 'text/plain');
    expect(await (await fetch(srv.base + location)).text()).toBe(before);
    store.addVersion('/b', 'b3', 'text three\n', 'text/plain'); // maxVersions 2: b1 is dropped
    expect((await fetch(srv.base + location)).status).toBe(404);
  });

  test('Only clients that ask are redirected, and only when anything changed', async () => {
    expect((await manual(request)).status).toBe(200);
    expect((await manual({ baselines: { '/a': 'a2', '/b': 'b1' }, redirect: true })).status).toBe(204);
  });

  test('A server without links answers directly', async () => {
    const plain = await serve(store);
    const res = await fetch(plain.url, { method: 'QUERY', redirect: 'manual', headers: { 'Content-Type': 'application/sync-baseline+json' }, body: JSON.stringify({ ...request, redirect: true }) });
    await plain.close();
    expect(res.status).toBe(200);
  });

  test('A server can turn redirection off, and long URIs are not used', async () => {
    const off = await serve(store, { links: { ...LINKS, redirect: false } });
    const short = await serve(store, { links: { ...LINKS, maxUriLength: 40 } });
    const ask = s => fetch(s.url, { method: 'QUERY', redirect: 'manual', headers: { 'Content-Type': 'application/sync-baseline+json' }, body: JSON.stringify({ ...request, redirect: true }) });
    const [a, b] = await Promise.all([ask(off), ask(short)]);
    await off.close(); await short.close();
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  test('redirect must be a boolean', async () => {
    expect((await query(srv.url, { ...request, redirect: 'yes' })).status).toBe(422);
  });

  test('GET of a shared result is authorized for its requester', async () => {
    const auth = { Authorization: 'Bearer ok' };
    const res = await manual({ baselines: { '/private': null }, redirect: true }, auth);
    expect(res.status).toBe(303);
    const location = res.headers.get('location');
    expect((await fetch(srv.base + location)).status).toBe(404);
    const ok = await fetch(srv.base + location, { headers: auth });
    expect(ok.status).toBe(200);
    expect((await ok.json()).results['/private']).toMatchObject({ status: 200, data: { secret: 1 } });
  });

  test('Unchanged entries are authorized too: they reveal the current version', async () => {
    const auth = { Authorization: 'Bearer ok' };
    const res = await manual({ baselines: { '/private': 'p1', '/a': 'a1' }, redirect: true }, auth);
    expect(res.status).toBe(303);
    const location = res.headers.get('location');
    expect((await (await fetch(srv.base + location, { headers: auth })).json()).results['/private']).toEqual({ status: 304, to: 'p1' });
    expect((await fetch(srv.base + location)).status).toBe(404);
  });

  test('A resource the requester could not read stays 404 in the shared result for everyone', async () => {
    const location = (await manual({ baselines: { '/private': null, '/a': null }, redirect: true })).headers.get('location');
    const body = await (await fetch(srv.base + location, { headers: { Authorization: 'Bearer ok' } })).json();
    expect(body.results['/private']).toEqual({ status: 404 });
  });

  test('With links, the shared result is exactly the direct response: large updates become links', async () => {
    const withLinks = { baselines: { '/a': null, '/b': null }, links: true };
    const location = (await manual({ ...withLinks, redirect: true })).headers.get('location');
    const shared = await (await fetch(srv.base + location)).json();
    expect(shared).toEqual(json(await query(srv.url, withLinks)));
    expect(shared.results['/a'].href).toMatch(/^\/sync\/u\//);
    expect(shared.results['/b'].data).toBe('text one\n');
    const client = createSyncClient(srv.url, { redirect: true, links: true });
    expect((await client.sync(['/a', '/b'])).values).toEqual({ '/a': doc(2), '/b': 'text one\n' });
  });

  test('Consistent snapshots carry over to the shared result', async () => {
    const location = (await manual({ ...request, consistent: true, redirect: true })).headers.get('location');
    const res = await fetch(srv.base + location);
    expect(res.headers.get('sync-consistent')).toBe('?1');
  });

  test('The result format is part of the URI; multipart results are byte-for-byte stable', async () => {
    const accept = { Accept: 'multipart/mixed' };
    const mp = (await manual({ ...request, redirect: true }, accept)).headers.get('location');
    const js = (await manual({ ...request, redirect: true })).headers.get('location');
    expect(mp).not.toBe(js);
    const first = await fetch(srv.base + mp);
    const second = await fetch(srv.base + mp);
    expect(first.headers.get('content-type')).toMatch(/^multipart\/mixed; boundary="sync-[A-Za-z0-9_-]+"$/);
    expect(first.headers.get('content-type')).toBe(second.headers.get('content-type'));
    const bytes = new Uint8Array(await first.arrayBuffer());
    expect(Buffer.from(bytes).equals(Buffer.from(await second.arrayBuffer()))).toBe(true);
    const parsed = parseMultipartResults(bytes, first.headers.get('content-type'));
    expect(parsed.results['/b']).toMatchObject({ status: 200, type: 'text/plain', value: 'text one\n' });
  });

  test('Shared results are validated with ETag and If-None-Match', async () => {
    const location = (await manual({ ...request, redirect: true })).headers.get('location');
    const res = await fetch(srv.base + location, { headers: { 'Accept-Encoding': 'identity' } });
    const etag = res.headers.get('etag');
    const again = await fetch(srv.base + location, { headers: { 'If-None-Match': `W/${etag}`, 'Accept-Encoding': 'identity' } });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
  });

  test('Altered URIs are 404', async () => {
    const location = (await manual({ ...request, redirect: true })).headers.get('location');
    const last = location.slice(-1);
    expect((await fetch(srv.base + location.slice(0, -1) + (last === 'A' ? 'B' : 'A'))).status).toBe(404);
  });

  test('A request naming 100 resources still fits in a short URI', async () => {
    const many = {};
    for (let i = 0; i < 100; i++) {
      many[`/projects/1234/tasks/${i}?status=open`] = null;
      store.addVersion(`/projects/1234/tasks/${i}?status=open`, `v-${i}-0f3a9c`, { i });
    }
    const res = await manual({ baselines: many, redirect: true });
    expect(res.status).toBe(303);
    expect(res.headers.get('location').length).toBeLessThan(3000);
    const body = await (await fetch(srv.base + res.headers.get('location'))).json();
    expect(Object.keys(body.results)).toHaveLength(100);
  });

  test('syncFetch and the client follow the redirect and converge', async () => {
    const res = await syncFetch(srv.url, { '/a': 'a1' }, { redirect: true });
    expect(res.status).toBe(200);
    expect(res.body.results['/a']).toMatchObject({ from: 'a1', to: 'a2' });
    const client = createSyncClient(srv.url, { redirect: true, state: { '/a': { version: 'a1', value: doc(1) } } });
    const out = await client.sync(['/a', '/b']);
    expect(out.values).toEqual({ '/a': doc(2), '/b': 'text one\n' });
  });

  test('If the shared result has gone, the client asks again for a direct answer', async () => {
    const seen = [];
    const fetchSpy = async (u, init = {}) => {
      seen.push(`${init.method || 'GET'} ${init.body && JSON.parse(init.body).redirect ? 'redirect' : ''}`.trim());
      if (String(u).includes('/sync/u/')) return new Response(null, { status: 404 });
      return fetch(u, { ...init, redirect: 'manual' });
    };
    const res = await syncFetch(srv.url, { '/a': 'a1' }, { redirect: true, transport: 'query', fetch: fetchSpy });
    expect(res.status).toBe(200);
    expect(res.body.results['/a']).toMatchObject({ from: 'a1', to: 'a2' });
    expect(seen).toEqual(['QUERY redirect', 'GET', 'QUERY']);
  });

  test('The Node http client follows the redirect too', async () => {
    const { syncRequest } = require('../../client/src/sync-client');
    const res = await syncRequest(srv.url, { '/a': 'a1' }, { transport: 'query', redirect: true });
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(true);
    expect(res.body.results['/a']).toMatchObject({ from: 'a1', to: 'a2' });
  });

  test('The experimental SYNC method front never redirects', async () => {
    const { resolveSync } = require('../src/sync-handler');
    const out = await resolveSync(JSON.stringify({ ...request, redirect: true }), {}, { store });
    expect(out.status).toBe(200);
  });
});

// ─── HTTP details: content coding, validators, stable encodings ─────────────

describe('Content coding and validators', () => {
  let srv;
  const LINKS = { secret: SECRET, path: '/sync/u', minBytes: 64 };
  beforeAll(async () => {
    const store = createMemoryStore();
    store.addVersion('/big', 'g1', { pad: 'x'.repeat(3000) });
    store.addVersion('/big', 'g2', { pad: 'y'.repeat(3000) });
    srv = await serve(store, { links: LINKS });
  });
  afterAll(() => srv.close());

  const href = async () => json(await query(srv.url, { baselines: { '/big': null }, links: true })).results['/big'].href;

  test('The gzip-coded form of a link has its own strong entity tag, and both vary on Accept-Encoding', async () => {
    const h = await href();
    const plain = await fetch(srv.base + h, { headers: { 'Accept-Encoding': 'identity' } });
    const gz = await fetch(srv.base + h, { headers: { 'Accept-Encoding': 'gzip' } });
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(gz.headers.get('etag')).not.toBe(plain.headers.get('etag'));
    expect(gz.headers.get('etag')).toBe(plain.headers.get('etag').replace(/"$/, '-gzip"'));
    expect(plain.headers.get('vary')).toMatch(/Accept-Encoding/);
    expect(gz.headers.get('vary')).toMatch(/Accept-Encoding/);
  });

  test('If-None-Match matches only the representation the request selects', async () => {
    const h = await href();
    const plainTag = (await fetch(srv.base + h, { headers: { 'Accept-Encoding': 'identity' } })).headers.get('etag');
    const gzTag = plainTag.replace(/"$/, '-gzip"');
    const ask = (inm, ae) => fetch(srv.base + h, { headers: { 'If-None-Match': inm, 'Accept-Encoding': ae } });
    const r1 = await ask(plainTag, 'identity');
    expect(r1.status).toBe(304);
    expect(r1.headers.get('vary')).toMatch(/Accept-Encoding/);
    expect((await ask(gzTag, 'gzip')).status).toBe(304);
    expect((await ask(plainTag, 'gzip')).status).toBe(200);
    expect((await ask(`"other", ${gzTag}`, 'gzip')).status).toBe(304);
  });

  test('gzip;q=0 refuses gzip', async () => {
    const res = await fetch(srv.url, { method: 'QUERY', headers: { 'Content-Type': 'application/sync-baseline+json', 'Accept-Encoding': 'gzip;q=0, identity' }, body: JSON.stringify({ baselines: { '/big': null } }) });
    expect(res.headers.get('content-encoding')).toBeNull();
    const { acceptsGzip } = require('../src/sync-handler');
    expect(acceptsGzip('gzip')).toBe(true);
    expect(acceptsGzip('br, GZIP;q=0.5')).toBe(true);
    expect(acceptsGzip('gzip;q=0')).toBe(false);
    expect(acceptsGzip('identity')).toBe(false);
    expect(acceptsGzip(undefined)).toBe(false);
  });

  test('The same results always encode to the same multipart octets', async () => {
    const ask = () => query(srv.url, { baselines: { '/big': 'g1' } }, { Accept: 'multipart/mixed', 'Accept-Encoding': 'identity' });
    const [a, b] = await Promise.all([ask(), ask()]);
    expect(a.headers.get('content-type')).toBe(b.headers.get('content-type'));
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  test('A multipart boundary never occurs in the content', () => {
    const crypto = require('crypto');
    const { chooseBoundary } = require('../src/encode');
    const seed = crypto.createHash('sha256').update('seed').digest();
    const first = `sync-${seed.subarray(0, 18).toString('base64url')}`;
    const parts = [{ head: 'Sync-Resource: "/x"', body: Buffer.from(`before ${first} after`) }];
    const chosen = chooseBoundary(parts, seed);
    expect(chosen).not.toBe(first);
    expect(chosen).toMatch(/^sync-[A-Za-z0-9_-]{24}$/);
    expect(chooseBoundary([{ head: '', body: Buffer.from('plain') }], seed)).toBe(first);
  });

  test('Link identifiers are computed once per distinct update', async () => {
    const { createLinkCodec } = require('../src/links');
    const codec = createLinkCodec(SECRET);
    const p = ['/x', '1', '2', null];
    const id = codec.encode(p);
    expect(codec.encode([...p])).toBe(id);
    expect(codec.stats).toEqual({ encoded: 1, reused: 1 });
  });

  test('Large payloads are compressed before encryption and still authenticated', () => {
    const { createLinkCodec } = require('../src/links');
    const codec = createLinkCodec(SECRET);
    const q = Array.from({ length: 100 }, (_, i) => [`/projects/1234/tasks/${i}?status=open`, 200, null, `v-${i}`, null]);
    const payload = { m: 'j', a: null, c: '', q };
    const id = codec.encode(payload);
    expect(id.length).toBeLessThan(JSON.stringify(payload).length / 2);
    expect(codec.decode(id)).toEqual(payload);
    const raw = Buffer.from(id, 'base64url');
    raw[20] ^= 1;
    expect(codec.decode(raw.toString('base64url'))).toBeNull();
  });
});
