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
// Changes one character in the middle of a URI's last segment.
const tamper = uri => { const i = uri.lastIndexOf('/') + 10; return uri.slice(0, i) + (uri[i] === 'A' ? 'B' : 'A') + uri.slice(i + 1); };

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

// ─── The smallest update ─────────────────────────────────────────────────────

describe('The server sends the smallest update the client accepts', () => {
  const { buildUpdate, JSON_PATCH, MERGE_PATCH, SPLICE } = require('../src/formats');
  const { applySplice } = require('../../client/src/apply');
  const json = data => ({ type: 'application/json', data });
  const size = u => JSON.stringify(u.data).length;

  test('Merge Patch wins when many fields of an object change', () => {
    const a = json({ item: { title: 'one', body: 'x'.repeat(40), likes: 1, tags: { a: 1, b: 2 } }, other: 'z'.repeat(400) });
    const b = json({ item: { title: 'two', body: 'y'.repeat(40), likes: 2, tags: { a: 3, b: 4 } }, other: 'z'.repeat(400) });
    const u = buildUpdate(a, b, [JSON_PATCH, MERGE_PATCH]);
    expect(u.format).toBe(MERGE_PATCH);
    expect(size(u)).toBeLessThan(size(buildUpdate(a, b, [JSON_PATCH])));
  });

  test('JSON Patch wins when one element of a long array changes, even if listed second', () => {
    const list = Array.from({ length: 200 }, (_, i) => `entry ${i}`);
    const a = json({ list });
    const b = json({ list: list.map((v, i) => (i === 50 ? 'changed' : v)) });
    expect(buildUpdate(a, b, [MERGE_PATCH, JSON_PATCH]).format).toBe(JSON_PATCH);
  });

  test("The client's order breaks ties, and only accepted formats are used", () => {
    const a = json({ k: 1, pad: 'p'.repeat(200) });
    const b = json({ k: 2, pad: 'p'.repeat(200) });
    expect(buildUpdate(a, b, [MERGE_PATCH]).format).toBe(MERGE_PATCH);
    expect(buildUpdate(a, b, [JSON_PATCH]).format).toBe(JSON_PATCH);
    expect(buildUpdate(a, b, [SPLICE]).full).toBe(true);
  });

  test('A one-word edit in a long line travels as that word', () => {
    const line = 'The quick brown fox jumps over the lazy dog while the cat watches from the window. ';
    const before = `${line.repeat(20)}\n${line.repeat(20)}\n`;
    const after = before.replace('lazy', 'sleepy');
    const u = buildUpdate({ type: 'text/plain', data: before }, { type: 'text/plain', data: after });
    // "lazy" -> "sleepy" shares its last letter, so only "laz" -> "sleep" travels.
    expect(u.data.splices).toEqual([[before.indexOf('lazy'), 3, 'sleep']]);
    expect(applySplice(before, u.data)).toBe(after);
  });

  test('Several word edits inside one changed block travel separately when that is smaller', () => {
    const block = Array.from({ length: 12 }, (_, i) => `sentence number ${i} says something rather long about nothing in particular`).join(' ');
    const before = `head\n${block}\ntail\n`;
    const after = before.replace('number 2 says', 'number 2 shouts').replace('number 9 says', 'number 9 whispers');
    const u = buildUpdate({ type: 'text/plain', data: before }, { type: 'text/plain', data: after });
    expect(u.data.splices.length).toBe(2);
    expect(applySplice(before, u.data)).toBe(after);
  });

  test('Randomized edits round-trip exactly (emoji, CJK, combining marks, line endings)', () => {
    let seed = 12345;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const words = ['alpha', 'beta', 'γάμμα', '漢字', 'emoji😀', 'e\u0301', 'tab\t', 'x', '', 'долгое', '👩‍👩‍👧'];
    const pick = () => words[Math.floor(rand() * words.length)];
    const text = n => Array.from({ length: n }, () => Array.from({ length: 1 + Math.floor(rand() * 12) }, pick).join(' ')).join(rand() < 0.5 ? '\n' : '\r\n');
    for (let t = 0; t < 400; t++) {
      const before = text(1 + Math.floor(rand() * 30));
      const cps = Array.from(before);
      let after = cps.slice();
      for (let e = 0; e < 1 + Math.floor(rand() * 6); e++) {
        const at = Math.floor(rand() * (after.length + 1));
        const del = Math.floor(rand() * 8);
        after.splice(at, del, ...Array.from(rand() < 0.3 ? '\n' + pick() : pick()));
      }
      after = after.join('');
      const u = buildUpdate({ type: 'text/plain', data: before }, { type: 'text/plain', data: after });
      const out = u.full ? after : applySplice(before, u.data);
      expect(out).toBe(after);
    }
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
    expect((await fetch(srv.base + tamper(a.href))).status).toBe(404);
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
    expect((await fetch(srv.base + tamper(location))).status).toBe(404);
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

// ─── Next URIs: the following catch-up as a cacheable GET ───────────────────

describe('Next URIs (Sync-Next)', () => {
  let srv, store, guarded;
  const doc = n => ({ n, pad: 'p'.repeat(300) });
  const LINKS = { secret: SECRET, path: '/sync/u', minBytes: 64, cacheControl: 'public, max-age=31536000, immutable' };
  const { parseSfStrings } = require('../../client/src/multipart');
  const nextOf = res => parseSfStrings(res.headers.get('sync-next'))[0];
  beforeEach(async () => {
    store = createMemoryStore({ maxVersions: 5 });
    store.addVersion('/a', 'a1', doc(1));
    store.addVersion('/b', 'b1', 'text one\n', 'text/plain');
    store.addVersion('/private', 'p1', { secret: 1 });
    guarded = {
      getCurrent: (r, ctx) => (r === '/private' && ctx.headers.authorization !== 'Bearer ok' ? null : store.getCurrent(r)),
      getVersion: (r, v, ctx) => (r === '/private' && ctx.headers.authorization !== 'Bearer ok' ? null : store.getVersion(r, v)),
      snapshot: () => store.snapshot(),
    };
    srv = await serve(guarded, { links: LINKS, cacheControl: 'public, max-age=60' });
  });
  afterEach(() => srv.close());

  const request = { baselines: { '/a': null, '/b': null, '/missing': null }, next: true };

  test('A response names the next URI only when asked', async () => {
    const res = await query(srv.url, request);
    expect(nextOf(res)).toMatch(/^\/sync\/u\/[A-Za-z0-9_-]+$/);
    expect(nextOf(res)).not.toMatch(/a1|b1|missing/);
    expect((await query(srv.url, { ...request, next: undefined })).headers.get('sync-next')).toBeNull();
    const plain = await serve(store);
    const r = await query(plain.url, request);
    await plain.close();
    expect(r.headers.get('sync-next')).toBeNull();
    expect((await query(srv.url, { ...request, next: 'yes' })).status).toBe(422);
  });

  test('Clients in the same state hold the same next URI', async () => {
    const one = nextOf(await query(srv.url, request));
    const two = nextOf(await query(srv.url, request));
    expect(two).toBe(one);
    expect(nextOf(await query(srv.url, { baselines: { '/a': 'a1', '/b': 'b1', '/missing': null }, next: true }))).toBe(one);
  });

  test('GET of a next URI is the same request from the versions the results led to', async () => {
    const present = nextOf(await query(srv.url, { baselines: { '/a': null, '/b': null }, next: true }));
    const quiet = await fetch(srv.base + present);
    expect(quiet.status).toBe(204);
    expect(nextOf(quiet)).toBe(present);
    const uri = nextOf(await query(srv.url, request));
    store.addVersion('/a', 'a2', doc(2));
    const res = await fetch(srv.base + uri);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const body = await res.json();
    expect(body).toEqual(json(await query(srv.url, { baselines: { '/a': 'a1', '/b': 'b1', '/missing': null } })));
    expect(body.results['/a']).toMatchObject({ from: 'a1', to: 'a2' });
    expect(nextOf(res)).not.toBe(uri);
  });

  test('A resource that appears later arrives in full through the next URI', async () => {
    const uri = nextOf(await query(srv.url, request));
    store.addVersion('/missing', 'm1', { here: true });
    const body = await (await fetch(srv.base + uri)).json();
    expect(body.results['/missing']).toEqual({ status: 200, from: null, to: 'm1', type: 'application/json', data: { here: true } });
  });

  test('Next URIs are validated with ETag; the tag follows the state', async () => {
    const uri = nextOf(await query(srv.url, request));
    store.addVersion('/a', 'a2', doc(2));
    const first = await fetch(srv.base + uri, { headers: { 'Accept-Encoding': 'identity' } });
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{22}"$/);
    const again = await fetch(srv.base + uri, { headers: { 'If-None-Match': etag, 'Accept-Encoding': 'identity' } });
    expect(again.status).toBe(304);
    expect(nextOf(again)).toBe(nextOf(first));
    store.addVersion('/b', 'b2', 'text two\n', 'text/plain');
    expect((await fetch(srv.base + uri, { headers: { 'If-None-Match': etag, 'Accept-Encoding': 'identity' } })).status).toBe(200);
  });

  test('A next URI is evaluated for its requester', async () => {
    const auth = { Authorization: 'Bearer ok' };
    const uri = nextOf(await query(srv.url, { baselines: { '/private': null, '/a': null }, next: true }, auth));
    store.addVersion('/private', 'p2', { secret: 2 });
    const anonymous = await (await fetch(srv.base + uri)).json();
    expect(anonymous.results['/private']).toEqual({ status: 404 });
    const owner = await (await fetch(srv.base + uri, { headers: auth })).json();
    expect(owner.results['/private']).toMatchObject({ status: 200, to: 'p2' });
  });

  test('Format, consistency and links carry over to the next URI', async () => {
    const mp = nextOf(await query(srv.url, { ...request, consistent: true, links: true }, { Accept: 'multipart/mixed' }));
    store.addVersion('/a', 'a2', { n: 2, pad: 'q'.repeat(300) });
    const res = await fetch(srv.base + mp);
    expect(res.headers.get('content-type')).toMatch(/^multipart\/mixed/);
    expect(res.headers.get('sync-consistent')).toBe('?1');
    const parsed = parseMultipartResults(new Uint8Array(await res.arrayBuffer()), res.headers.get('content-type'));
    expect(parsed.results['/a'].href).toMatch(/^\/sync\/u\//);
  });

  test('A shared result carries the same next URI as the direct response', async () => {
    store.addVersion('/a', 'a2', doc(2));
    const direct = nextOf(await query(srv.url, { ...request, baselines: { '/a': 'a1', '/b': 'b1', '/missing': null } }));
    const redirected = await fetch(srv.url, { method: 'QUERY', headers: { 'Content-Type': 'application/sync-baseline+json' }, body: JSON.stringify({ ...request, baselines: { '/a': 'a1', '/b': 'b1', '/missing': null }, redirect: true }) });
    expect(redirected.redirected).toBe(true);
    expect(nextOf(redirected)).toBe(direct);
  });

  test('Altered next URIs are 404, and long ones are not sent', async () => {
    const uri = nextOf(await query(srv.url, request));
    expect((await fetch(srv.base + tamper(uri))).status).toBe(404);
    const short = await serve(store, { links: { ...LINKS, maxUriLength: 40 } });
    const r = await query(short.url, request);
    await short.close();
    expect(r.headers.get('sync-next')).toBeNull();
  });

  test('The client catches up through its next URI, also after a reload', async () => {
    const seen = [];
    const spy = async (u, init = {}) => { seen.push(`${init.method || 'GET'} ${new URL(u).pathname.startsWith('/sync/u/') ? 'next' : 'sync'}`); return fetch(u, init); };
    const client = createSyncClient(srv.url, { next: true, fetch: spy });
    await client.sync(['/a', '/b']);
    store.addVersion('/a', 'a2', doc(2));
    const second = await client.sync(['/a', '/b']);
    expect(second.changed).toEqual(['/a']);
    expect(client.get('/a')).toEqual(doc(2));
    expect(seen).toEqual(['QUERY sync', 'GET next']);

    const saved = JSON.parse(JSON.stringify(client));
    expect(saved['@next'].uri).toMatch(/^\/sync\/u\//);
    store.addVersion('/b', 'b2', 'text two\n', 'text/plain');
    seen.length = 0;
    const restored = createSyncClient(srv.url, { next: true, fetch: spy, state: saved });
    expect((await restored.sync(['/a', '/b'])).changed).toEqual(['/b']);
    expect(seen).toEqual(['GET next']);
  });

  test('The client uses a next URI only while it holds what it was issued for, and falls back when it fails', async () => {
    const seen = [];
    let failNext = false;
    const spy = async (u, init = {}) => {
      const kind = new URL(u).pathname.startsWith('/sync/u/') ? 'next' : 'sync';
      seen.push(`${init.method || 'GET'} ${kind}`);
      if (kind === 'next' && failNext) return new Response(null, { status: 410 });
      return fetch(u, init);
    };
    const client = createSyncClient(srv.url, { next: true, fetch: spy });
    await client.sync(['/a', '/b']);
    seen.length = 0;
    await client.sync(['/a']);                 // a different list: a request, and it changes what is held
    store.addVersion('/a', 'a2', doc(2));
    await client.sync(['/a', '/b']);           // the URI for ['/a', '/b'] was replaced by the one for ['/a']
    expect(seen).toEqual(['QUERY sync', 'QUERY sync']);
    seen.length = 0;
    failNext = true;
    store.addVersion('/b', 'b2', 'text two\n', 'text/plain');
    const out = await client.sync(['/a', '/b']);
    expect(seen).toEqual(['GET next', 'QUERY sync']);
    expect(out.values).toEqual({ '/a': doc(2), '/b': 'text two\n' });
  });
});

test('Identifiers have one spelling: a non-canonical base64url form is rejected', () => {
  const { createLinkCodec } = require('../src/links');
  const codec = createLinkCodec(SECRET);
  const payloads = [['/x', 'a', 'b', null], ['/longer/name', '1', '2', 'j'], ['/y', null, 'z', null]];
  for (const p of payloads) {
    const id = codec.encode(p);
    expect(codec.decode(id)).toEqual(p);
    if (id.length % 4 === 0) continue; // no unused bits in the last character
    const last = id.at(-1);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const sibling = alphabet[alphabet.indexOf(last) ^ 1];
    const variant = id.slice(0, -1) + sibling;
    if (Buffer.from(variant, 'base64url').equals(Buffer.from(id, 'base64url'))) expect(codec.decode(variant)).toBeNull();
  }
});

// ─── Watching: live updates for many resources in one stream ────────────────

describe('Watching (live updates)', () => {
  let srv, store;
  const doc = n => ({ n, pad: 'p'.repeat(300) });
  const LINKS = { secret: SECRET, path: '/sync/u', minBytes: 200, cacheControl: 'public, max-age=31536000, immutable' };
  const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
  beforeEach(async () => {
    store = createMemoryStore();
    store.addVersion('/a', 'a1', doc(1));
    store.addVersion('/b', 'b1', doc(1));
    store.addVersion('/c', 'c1', 'text\n', 'text/plain');
    srv = await serve(store, { links: LINKS, heartbeatMs: 40 });
  });
  afterEach(() => srv.close());

  // Opens a raw watch and collects events (and comments) until close().
  async function rawWatch(payload, headers = {}) {
    const controller = new AbortController();
    const res = await fetch(srv.url, {
      method: 'QUERY',
      headers: { 'Content-Type': 'application/sync-baseline+json', Accept: 'text/event-stream', ...headers },
      body: JSON.stringify({ ...payload, watch: true }),
      signal: controller.signal,
    });
    const events = [];
    const comments = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (block.startsWith(':')) { comments.push(block); continue; }
            const data = block.split('\n').find(l => l.startsWith('data: '));
            if (data) { const doc = JSON.parse(data.slice(6)); events.push(doc.results ?? doc); }
          }
        }
      } catch { /* aborted */ }
    })();
    return { res, events, comments, close: async () => { controller.abort(); await pump; } };
  }

  test('The first event brings everything current; later events carry only what changed', async () => {
    const w = await rawWatch({ baselines: { '/a': 'a1', '/b': null, '/c': 'c1' } });
    expect(w.res.headers.get('content-type')).toBe('text/event-stream');
    expect(w.res.headers.get('cache-control')).toBe('no-store');
    await tick();
    expect(w.events).toHaveLength(1);
    expect(w.events[0]['/a']).toEqual({ status: 304, to: 'a1' });
    expect(w.events[0]['/b']).toMatchObject({ status: 200, from: null, to: 'b1' });
    store.addVersion('/a', 'a2', doc(2));
    await tick();
    expect(w.events).toHaveLength(2);
    expect(Object.keys(w.events[1])).toEqual(['/a']);
    expect(w.events[1]['/a']).toMatchObject({ status: 200, from: 'a1', to: 'a2' });
    store.addVersion('/unwatched', 'u1', {});
    await tick();
    expect(w.events).toHaveLength(2);
    await w.close();
  });

  test('Changes committed together arrive together', async () => {
    const w = await rawWatch({ baselines: { '/a': 'a1', '/b': 'b1', '/c': 'c1', '/missing': null }, consistent: true });
    expect(w.res.headers.get('sync-consistent')).toBe('?1');
    await tick();
    store.commit([{ resource: '/a', version: 'a2', data: doc(2) }, { resource: '/b', version: 'b2', data: doc(2) }]);
    await tick();
    expect(w.events).toHaveLength(2);
    expect(Object.keys(w.events[1]).sort()).toEqual(['/a', '/b']);
    await w.close();
  });

  test('Consistent events cover every resource of a commit even when the store reports them one at a time', async () => {
    // A store whose notifications for one commit arrive separately, as from a change feed.
    const staggered = {
      getCurrent: r => store.getCurrent(r),
      getVersion: (r, v) => store.getVersion(r, v),
      snapshot: () => store.snapshot(),
      subscribe: l => store.subscribe(rs => rs.forEach((r, i) => setTimeout(() => l([r]), i * 40))),
    };
    const s = await serve(staggered);
    const controller = new AbortController();
    const res = await fetch(s.url, { method: 'QUERY', headers: { 'Content-Type': 'application/sync-baseline+json', Accept: 'text/event-stream' }, body: JSON.stringify({ baselines: { '/a': 'a1', '/b': 'b1' }, watch: true, consistent: true }), signal: controller.signal });
    const reader = res.body.getReader();
    let text = '';
    const events = () => text.split('\n\n').filter(b => b.startsWith('event: sync')).map(b => JSON.parse(b.split('data: ')[1]).results);
    while (events().length < 1) text += new TextDecoder().decode((await reader.read()).value);
    store.commit([{ resource: '/a', version: 'a2', data: doc(2) }, { resource: '/b', version: 'b2', data: doc(2) }]);
    while (events().length < 2) text += new TextDecoder().decode((await reader.read()).value);
    await tick(120);
    controller.abort();
    await s.close();
    expect(Object.keys(events()[1]).sort()).toEqual(['/a', '/b']);
    expect(events()).toHaveLength(2);
  });

  test('Changes made in one task are coalesced into the net change', async () => {
    const w = await rawWatch({ baselines: { '/a': 'a1' } });
    await tick();
    store.addVersion('/a', 'a2', doc(2));
    store.addVersion('/a', 'a3', doc(3));
    store.addVersion('/a', 'a4', doc(4));
    await tick();
    expect(w.events).toHaveLength(2);
    expect(w.events[1]['/a']).toMatchObject({ from: 'a1', to: 'a4' });
    await w.close();
  });

  test('Removal is reported as 404, and a resource that returns arrives in full', async () => {
    const w = await rawWatch({ baselines: { '/a': 'a1' } });
    await tick();
    store.remove('/a');
    await tick();
    expect(w.events[1]['/a']).toEqual({ status: 404 });
    store.addVersion('/a', 'a9', doc(9));
    await tick();
    expect(w.events[2]['/a']).toMatchObject({ status: 200, from: null, to: 'a9' });
    await w.close();
  });

  test('A large event is a link to a shared result, the same for every watcher in the same state', async () => {
    const one = await rawWatch({ baselines: { '/a': 'a1', '/b': 'b1' }, links: true });
    const two = await rawWatch({ baselines: { '/a': 'a1', '/b': 'b1' }, links: true });
    await tick();
    store.commit([{ resource: '/a', version: 'a2', data: { n: 2, pad: 'q'.repeat(300) } }, { resource: '/b', version: 'b2', data: doc(2) }]);
    await tick();
    expect(one.events[1]).toEqual({ href: expect.stringMatching(/^\/sync\/u\//) });
    expect(two.events[1].href).toBe(one.events[1].href);
    const shared = await fetch(srv.base + one.events[1].href);
    expect(shared.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const results = (await shared.json()).results;
    expect(Object.keys(results).sort()).toEqual(['/a', '/b']);
    expect(results['/a']).toMatchObject({ status: 200, to: 'a2' });
    expect(results['/b']).toMatchObject({ status: 200, from: 'b1', to: 'b2' });
    await one.close();
    await two.close();
  });

  test('A large event for a lone watcher is sent inline: a link would have nothing to share', async () => {
    const w = await rawWatch({ baselines: { '/a': 'a1', '/b': 'b1' }, links: true });
    await tick();
    store.commit([{ resource: '/a', version: 'a2', data: { n: 2, pad: 'q'.repeat(300) } }, { resource: '/b', version: 'b2', data: doc(2) }]);
    await tick();
    expect(w.events[1]['/a']).toMatchObject({ status: 200, to: 'a2', data: expect.anything() });
    await w.close();
  });

  test('Small events stay inline, and without shared results large updates become links one by one', async () => {
    const w = await rawWatch({ baselines: { '/a': 'a1' }, links: true });
    await tick();
    store.addVersion('/a', 'a2', { ...doc(1), n: 2 });
    await tick();
    expect(w.events[1]['/a']).toMatchObject({ status: 200, from: 'a1', to: 'a2', data: expect.anything() });
    await w.close();
    const noShared = await serve(store, { links: { ...LINKS, redirect: false } });
    const controller = new AbortController();
    const res = await fetch(noShared.url, { method: 'QUERY', headers: { 'Content-Type': 'application/sync-baseline+json', Accept: 'text/event-stream' }, body: JSON.stringify({ baselines: { '/a': 'a2' }, watch: true, links: true }), signal: controller.signal });
    const reader = res.body.getReader();
    let text = '';
    while ((text.match(/event: sync/g) || []).length < 1) text += new TextDecoder().decode((await reader.read()).value);
    store.addVersion('/a', 'a3', { n: 3, pad: 'z'.repeat(300) });
    while ((text.match(/event: sync/g) || []).length < 2) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    await noShared.close();
    const last = JSON.parse(text.trim().split('\n\n').pop().split('data: ')[1]);
    expect(last.results['/a'].href).toMatch(/^\/sync\/u\//);
  });

  test('Access is evaluated for every event', async () => {
    let allowed = true;
    const guarded = {
      getCurrent: (r, ctx) => (r === '/a' && !allowed ? null : store.getCurrent(r)),
      getVersion: (r, v) => store.getVersion(r, v),
      subscribe: l => store.subscribe(l),
    };
    const g = await serve(guarded);
    const controller = new AbortController();
    const res = await fetch(g.url, { method: 'QUERY', headers: { 'Content-Type': 'application/sync-baseline+json', Accept: 'text/event-stream' }, body: JSON.stringify({ baselines: { '/a': 'a1' }, watch: true }), signal: controller.signal });
    const reader = res.body.getReader();
    let text = '';
    const read = async () => { const { value } = await reader.read(); text += new TextDecoder().decode(value); };
    await read();
    allowed = false;
    store.addVersion('/a', 'a2', doc(2));
    await read();
    controller.abort();
    await g.close();
    expect(text).toMatch(/"\/a":\{"status":404\}/);
  });

  test('Watchers with different credentials never share an event', async () => {
    store.addVersion('/private', 'p1', { secret: 1 });
    // Both may read /private at first, so both hold the same versions; then the
    // anonymous watcher loses access. Access applies to every read, including
    // reads through a snapshot.
    let anonymousAllowed = true;
    const allowed = ctx => ctx.headers.authorization === 'Bearer ok' || anonymousAllowed;
    const guard = view => ({
      getCurrent: (r, ctx) => (r === '/private' && !allowed(ctx) ? null : view.getCurrent(r)),
      getVersion: (r, v, ctx) => (r === '/private' && !allowed(ctx) ? null : view.getVersion(r, v)),
    });
    const guarded = { ...guard(store), snapshot: () => guard(store.snapshot()), subscribe: l => store.subscribe(l) };
    const g = await serve(guarded);
    const open = async headers => {
      const controller = new AbortController();
      const res = await fetch(g.url, { method: 'QUERY', headers: { 'Content-Type': 'application/sync-baseline+json', Accept: 'text/event-stream', ...headers }, body: JSON.stringify({ baselines: { '/private': null, '/a': 'a1' }, watch: true, consistent: true }), signal: controller.signal });
      const reader = res.body.getReader();
      const box = { text: '', controller };
      (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) return; box.text += new TextDecoder().decode(value); } } catch {} })();
      return box;
    };
    const owner = await open({ Authorization: 'Bearer ok' });
    const anonymous = await open({});
    await tick(50);
    anonymousAllowed = false;
    store.commit([{ resource: '/private', version: 'p2', data: { secret: 2 } }, { resource: '/a', version: 'a2', data: doc(2) }]);
    await tick(80);
    owner.controller.abort();
    anonymous.controller.abort();
    await g.close();
    expect(owner.text).toContain('"secret":2');
    expect(anonymous.text).toContain('"secret":1');       // when it was allowed
    expect(anonymous.text).not.toContain('"secret":2');
    expect(anonymous.text).toContain('"/private":{"status":404}');
  });

  test('Heartbeats keep the stream alive, and closing unsubscribes', async () => {
    let active = 0;
    const counted = { ...store, subscribe: l => { active++; const off = store.subscribe(l); return () => { active--; off(); }; } };
    const s = await serve(counted, { heartbeatMs: 20 });
    const controller = new AbortController();
    const res = await fetch(s.url, { method: 'QUERY', headers: { 'Content-Type': 'application/sync-baseline+json', Accept: 'text/event-stream' }, body: JSON.stringify({ baselines: { '/a': null }, watch: true }), signal: controller.signal });
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes(': keep-alive')) text += new TextDecoder().decode((await reader.read()).value);
    expect(active).toBe(1);
    controller.abort();
    await tick(50);
    expect(active).toBe(0);
    await s.close();
  });

  test('Without text/event-stream in Accept, or with a store that cannot notify, the answer is ordinary results', async () => {
    const plain = await query(srv.url, { baselines: { '/a': null }, watch: true });
    expect(plain.headers.get('content-type')).toBe('application/sync-result+json');
    const noSubscribe = await serve({ getCurrent: r => store.getCurrent(r), getVersion: (r, v) => store.getVersion(r, v) });
    const r = await query(noSubscribe.url, { baselines: { '/a': null }, watch: true }, { Accept: 'text/event-stream, application/sync-result+json;q=0.5' });
    await noSubscribe.close();
    expect(r.headers.get('content-type')).toBe('application/sync-result+json');
    expect((await query(srv.url, { baselines: { '/a': null }, watch: 'yes' })).status).toBe(422);
  });

  test('client.watch keeps values current, follows links, and never shows a torn state', async () => {
    const client = createSyncClient(srv.url, { links: true });
    const seen = [];
    const torn = [];
    const handle = client.watch(['/a', '/b', '/c'], {
      consistent: true,
      onChange: ({ values, changed }) => {
        seen.push(changed);
        if (values['/a'] && values['/b'] && values['/a'].n !== values['/b'].n) torn.push([values['/a'].n, values['/b'].n]);
      },
    });
    await tick(60);
    for (let n = 2; n <= 6; n++) {
      store.commit([{ resource: '/a', version: `a${n}`, data: { n, pad: 'x'.repeat(300 + n) } }, { resource: '/b', version: `b${n}`, data: { n, pad: 'y'.repeat(300 + n) } }]);
      await tick(15);
    }
    store.addVersion('/c', 'c2', 'text\nmore\n', 'text/plain');
    await tick(100);
    handle.close();
    await handle.closed;
    expect(client.get('/a')).toEqual(store.getCurrent('/a').data);
    expect(client.get('/b')).toEqual(store.getCurrent('/b').data);
    expect(client.get('/c')).toBe('text\nmore\n');
    expect(torn).toEqual([]);
    expect(seen.length).toBeGreaterThan(1);
  });

  test('client.watch drops a copy an event cannot be applied to, and gets it back in full', async () => {
    // JSON Patch checks the paths it changes, so the corrupted copy is detected.
    const client = createSyncClient(srv.url, { accept: ['application/json-patch+json'], state: { '/a': { version: 'a1', value: { corrupted: true } } } });
    const handle = client.watch(['/a'], { retryMs: 10 });
    await tick(60);
    store.addVersion('/a', 'a2', doc(2));
    await tick(200);
    handle.close();
    await handle.closed;
    expect(client.get('/a')).toEqual(doc(2));
  });

  test('client.watch keeps its copy when a link fails, and asks for the update again', async () => {
    let failLinks = 1;
    const requests = [];
    const spy = async (u, init = {}) => {
      const isLink = new URL(u).pathname.startsWith('/sync/u/');
      requests.push(isLink ? 'link' : `watch from ${JSON.parse(init.body).baselines['/a']}`);
      if (isLink && failLinks-- > 0) return new Response(null, { status: 503 });
      return fetch(u, init);
    };
    const client = createSyncClient(srv.url, { links: true, fetch: spy, state: { '/a': { version: 'a1', value: doc(1) } } });
    const handle = client.watch(['/a'], { retryMs: 10 });
    // A second watcher in the same state and with the same options, so that the
    // event is shared and sent as a link.
    const other = await rawWatch({ baselines: { '/a': 'a1' }, links: true, accept: client.options.accept });
    await tick(60);
    // A patch (about 260 bytes) that is smaller than the document.
    const updated = { ...doc(1), n: 2, note: 'z'.repeat(250) };
    store.addVersion('/a', 'a2', updated);
    await tick(200);
    handle.close();
    await handle.closed;
    await other.close();
    expect(client.get('/a')).toEqual(updated);
    // After the failed link, the client asks again from the version it still holds.
    expect(requests).toEqual(['watch from a1', 'link', 'watch from a1']);
  });

  test('client.watch reconnects with what it holds and receives only the net change it missed', async () => {
    const client = createSyncClient(srv.url);
    const handle = client.watch(['/a'], { retryMs: 20 });
    await tick(60);
    expect(client.get('/a')).toEqual(doc(1));
    srv.close();                                   // the stream breaks
    const restarted = await serve(store);          // same store, new server (new port)
    client.url = restarted.url;
    store.addVersion('/a', 'a2', doc(2));
    store.addVersion('/a', 'a3', doc(3));
    await tick(300);
    expect(client.get('/a')).toEqual(doc(3));
    handle.close();
    await handle.closed;
    await restarted.close();
    srv = { close: async () => {} };
  });

  test('client.watch polls a server that cannot stream, using its next URI', async () => {
    const plainStore = { getCurrent: r => store.getCurrent(r), getVersion: (r, v) => store.getVersion(r, v) };
    const p = await serve(plainStore, { links: LINKS });
    const seen = [];
    const spy = async (u, init = {}) => { seen.push(`${init.method || 'GET'} ${new URL(u).pathname.startsWith('/sync/u/') ? 'next' : 'sync'}`); return fetch(u, init); };
    const client = createSyncClient(p.url, { next: true, fetch: spy });
    const handle = client.watch(['/a'], { pollMs: 30 });
    await tick(50);
    store.addVersion('/a', 'a2', doc(2));
    await tick(120);
    handle.close();
    await handle.closed;
    await p.close();
    expect(client.get('/a')).toEqual(doc(2));
    expect(seen[0]).toBe('QUERY sync');
    expect(seen.slice(1).length).toBeGreaterThan(0);
  });

  test('client.watch stops when consistency is required and the server cannot provide it', async () => {
    const noSnapshot = { getCurrent: r => store.getCurrent(r), getVersion: (r, v) => store.getVersion(r, v), subscribe: l => store.subscribe(l) };
    const p = await serve(noSnapshot);
    const errors = [];
    const handle = createSyncClient(p.url).watch(['/a'], { consistent: true, onError: e => errors.push(e) });
    await expect(handle.closed).rejects.toBeInstanceOf(SyncError);
    await p.close();
    expect(errors).toHaveLength(1);
  });
});

// ─── Atomic changes to several resources ────────────────────────────────────

describe('Atomic writes (application/sync-changes+json)', () => {
  let srv, store;
  const post = (payload, headers = {}) => fetch(srv.url, { method: 'POST', headers: { 'Content-Type': 'application/sync-changes+json', ...headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  const text = 'line one\nline two\nline three\n';
  let versions = 0;
  beforeEach(async () => {
    store = createMemoryStore();
    store.addVersion('/a', 'a1', { title: 'A', count: 1, tags: ['x', 'y'] });
    store.addVersion('/b', 'b1', { title: 'B', count: 1 });
    store.addVersion('/t', 't1', text, 'text/plain');
    store.addVersion('/bin', 'n1', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'application/octet-stream');
    srv = await serve(store, { newVersion: r => `${r.slice(1)}-w${++versions}` });
  });
  afterEach(() => srv.close());

  test('All changes apply together, with new versions', async () => {
    const res = await post({ changes: {
      '/a': { base: 'a1', format: 'application/merge-patch+json', data: { count: 2 } },
      '/b': { base: 'b1', delete: true },
      '/c': { base: null, type: 'application/json', data: { created: true } },
    } });
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results['/a']).toEqual({ status: 200, from: 'a1', to: store.getCurrent('/a').version });
    expect(results['/b']).toEqual({ status: 200, from: 'b1' });
    expect(results['/c']).toEqual({ status: 200, from: null, to: store.getCurrent('/c').version });
    expect(store.getCurrent('/a').data.count).toBe(2);
    expect(store.getCurrent('/b')).toBeNull();
    expect(store.getCurrent('/c').data).toEqual({ created: true });
  });

  test('If one change cannot apply, none does (412 for a stale base, 424 for the rest)', async () => {
    store.addVersion('/b', 'b2', { title: 'B2', count: 1 });
    const res = await post({ changes: {
      '/a': { base: 'a1', format: 'application/merge-patch+json', data: { count: 2 } },
      '/b': { base: 'b1', format: 'application/merge-patch+json', data: { count: 2 } },
    } });
    expect(res.status).toBe(409);
    const { results } = await res.json();
    expect(results).toEqual({ '/a': { status: 424 }, '/b': { status: 412, current: 'b2' } });
    expect(store.getCurrent('/a').version).toBe('a1');
  });

  test('Creating a resource that exists, changing one that does not, and invalid patches fail per resource', async () => {
    const res = await post({ changes: {
      '/a': { base: null, type: 'application/json', data: {} },
      '/missing': { base: 'x1', format: 'application/merge-patch+json', data: {} },
      '/b': { base: 'b1', format: 'application/json-patch+json', data: [{ op: 'replace', path: '/nope/deeper', value: 1 }] },
    } });
    const { results } = await res.json();
    expect(results['/a']).toEqual({ status: 412, current: 'a1' });
    expect(results['/missing']).toEqual({ status: 404 });
    expect(results['/b']).toMatchObject({ status: 422 });
  });

  test('With merge, a change from an older version is rebased when it touches other fields', async () => {
    store.addVersion('/a', 'a2', { title: 'A, renamed', count: 1, tags: ['x', 'y'] });
    const res = await post({ changes: { '/a': { base: 'a1', format: 'application/merge-patch+json', data: { count: 5 } } }, merge: true });
    expect(res.status).toBe(200);
    const r = (await res.json()).results['/a'];
    expect(r).toMatchObject({ status: 200, from: 'a1', rebased: true });
    expect(store.getCurrent('/a').data).toEqual({ title: 'A, renamed', count: 5, tags: ['x', 'y'] });
    // The update brings the client's copy (a1 + its change) to the merged version.
    // (a patch, or the whole value when that is smaller).
    const mine = { title: 'A', count: 5, tags: ['x', 'y'] };
    const next = r.update.format
      ? applyResult(mine, 'mine', { status: 200, from: 'mine', to: r.to, ...r.update })
      : applyResult(undefined, null, { status: 200, from: null, to: r.to, ...r.update });
    expect(next).toEqual(store.getCurrent('/a').data);
  });

  test('With merge, changes to the same field, or inside the same array, conflict', async () => {
    store.addVersion('/a', 'a2', { title: 'Theirs', count: 1, tags: ['x', 'y', 'z'] });
    const same = await post({ changes: { '/a': { base: 'a1', format: 'application/merge-patch+json', data: { title: 'Mine' } } }, merge: true });
    expect(same.status).toBe(409);
    expect((await same.json()).results['/a']).toMatchObject({ status: 409, current: 'a2', reason: expect.stringContaining('/title') });
    const array = await post({ changes: { '/a': { base: 'a1', format: 'application/json-patch+json', data: [{ op: 'add', path: '/tags/0', value: 'w' }] } }, merge: true });
    expect((await array.json()).results['/a']).toMatchObject({ status: 409, reason: expect.stringContaining('/tags') });
    expect(store.getCurrent('/a').version).toBe('a2');
  });

  test('Without merge, a stale base is never rebased', async () => {
    store.addVersion('/a', 'a2', { title: 'A, renamed', count: 1, tags: ['x', 'y'] });
    const res = await post({ changes: { '/a': { base: 'a1', format: 'application/merge-patch+json', data: { count: 5 } } } });
    expect((await res.json()).results['/a']).toEqual({ status: 412, current: 'a2' });
  });

  test('Text edits to different places are merged; edits to the same place conflict', async () => {
    store.addVersion('/t', 't2', text.replace('line one', 'LINE ONE'), 'text/plain');
    const at = text.indexOf('three');
    const ok = await post({ changes: { '/t': { base: 't1', format: 'application/sync-splice+json', data: { unit: 'codepoint', splices: [[at, 5, '3']] } } }, merge: true });
    expect(ok.status).toBe(200);
    expect(store.getCurrent('/t').data).toBe('LINE ONE\nline two\nline 3\n');
    const clash = await post({ changes: { '/t': { base: 't1', format: 'application/sync-splice+json', data: { unit: 'codepoint', splices: [[0, 4, 'first']] } } }, merge: true });
    expect(clash.status).toBe(409);
  });

  test('Binary edits to different places are merged', async () => {
    store.addVersion('/bin', 'n2', new Uint8Array([9, 2, 3, 4, 5, 6, 7, 8]), 'application/octet-stream');
    const res = await post({ changes: { '/bin': { base: 'n1', format: 'application/sync-splice+json', data: { unit: 'byte', splices: [[6, 2, Buffer.from([70, 80, 90]).toString('base64')]] } } }, merge: true });
    expect(res.status).toBe(200);
    expect([...store.getCurrent('/bin').data]).toEqual([9, 2, 3, 4, 5, 6, 70, 80, 90]);
  });

  test('A full representation or a deletion from an older version is never merged', async () => {
    store.addVersion('/b', 'b2', { title: 'B2', count: 1 });
    const res = await post({ changes: { '/b': { base: 'b1', type: 'application/json', data: { replaced: true } } }, merge: true });
    expect((await res.json()).results['/b']).toMatchObject({ status: 409, current: 'b2' });
  });

  test('Requests are validated', async () => {
    expect((await post('not json')).status).toBe(400);
    for (const bad of [
      {},
      { changes: {} },
      { changes: { 'x': { base: null, type: 'application/json', data: 1 } } },
      { changes: { '/a': { base: 'a1' } } },
      { changes: { '/a': { base: 'a1', format: 'application/json-patch+json', type: 'application/json', data: [] } } },
      { changes: { '/a': { base: null, delete: true } } },
      { changes: { '/a': { base: null, format: 'application/merge-patch+json', data: {} } } },
      { changes: { '/a': { base: 'a1', format: 'text/x-unknown', data: {} } } },
      { changes: { '/a': { base: 'a1', type: 'image/png', encoding: 'hex', data: '00' } } },
      { changes: { '/a': { base: 'a1', delete: true } }, merge: 'yes' },
    ]) {
      expect((await post(bad)).status).toBe(422);
    }
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`/r${i}`, { base: null, type: 'application/json', data: i }]));
    expect((await post({ changes: many })).status).toBe(413);
  });

  test('A repeated Idempotency-Key replays the first answer without applying twice, per requester', async () => {
    const change = { changes: { '/a': { base: 'a1', format: 'application/merge-patch+json', data: { count: 2 } } } };
    const first = await post(change, { 'Idempotency-Key': 'k1' });
    const again = await post(change, { 'Idempotency-Key': 'k1' });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    const other = await post({ changes: { '/b': { base: 'b1', delete: true } } }, { 'Idempotency-Key': 'k1' });
    expect(other.status).toBe(422);
    const someoneElse = await post(change, { 'Idempotency-Key': 'k1', Authorization: 'Bearer other' });
    expect(someoneElse.status).toBe(409); // a fresh request for this requester: a1 is no longer current
  });

  test('A write that loses a race is planned again from the new versions', async () => {
    let raced = false;
    const racing = {
      getCurrent: r => store.getCurrent(r),
      getVersion: (r, v) => store.getVersion(r, v),
      write: changes => {
        if (!raced) { raced = true; store.addVersion('/a', 'a-other', { title: 'Other', count: 1, tags: ['x', 'y'] }); }
        return store.write(changes);
      },
    };
    const s = await serve(racing);
    const res = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/sync-changes+json' }, body: JSON.stringify({ changes: { '/a': { base: 'a1', format: 'application/merge-patch+json', data: { count: 9 } } }, merge: true }) });
    await s.close();
    expect(res.status).toBe(200);
    expect(store.getCurrent('/a').data).toEqual({ title: 'Other', count: 9, tags: ['x', 'y'] });
  });

  test("The store's refusal (for example 403) is reported per resource", async () => {
    const guarded = { getCurrent: r => store.getCurrent(r), getVersion: (r, v) => store.getVersion(r, v), write: () => ({ ok: false, statuses: { '/a': 403 } }) };
    const s = await serve(guarded);
    const res = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/sync-changes+json' }, body: JSON.stringify({ changes: { '/a': { base: 'a1', format: 'application/merge-patch+json', data: { count: 2 } }, '/b': { base: 'b1', delete: true } } }) });
    await s.close();
    expect(res.status).toBe(409);
    expect((await res.json()).results).toEqual({ '/a': { status: 403 }, '/b': { status: 424 } });
  });

  test('A store without write passes the request on', async () => {
    const readOnly = await serve({ getCurrent: r => store.getCurrent(r), getVersion: (r, v) => store.getVersion(r, v) });
    const res = await fetch(readOnly.url, { method: 'POST', headers: { 'Content-Type': 'application/sync-changes+json' }, body: '{}' });
    await readOnly.close();
    expect(res.status).toBe(404);
  });

  test('client.write sends the smallest patch, merges, deletes, and creates', async () => {
    const client = createSyncClient(srv.url);
    await client.sync(['/a', '/b', '/t']);
    store.addVersion('/a', 'a2', { title: 'Theirs', count: 1, tags: ['x', 'y'] });
    const out = await client.write({
      '/a': { value: { title: 'A', count: 7, tags: ['x', 'y'] } },
      '/t': { value: text.replace('two', '2') },
      '/b': { delete: true },
      '/new': { value: 'hello\n', type: 'text/plain' },
    }, { merge: true });
    expect(out.rebased).toEqual(['/a']);
    expect(client.get('/a')).toEqual({ title: 'Theirs', count: 7, tags: ['x', 'y'] });
    expect(client.get('/a')).toEqual(store.getCurrent('/a').data);
    expect(client.get('/t')).toBe(store.getCurrent('/t').data);
    expect(client.get('/b')).toBeUndefined();
    expect(store.getCurrent('/new').data).toBe('hello\n');
    const again = await client.sync(['/a', '/t', '/new']);
    expect(again.changed).toEqual([]);
  });

  test('client.write leaves everything unchanged when the server refuses', async () => {
    const client = createSyncClient(srv.url);
    await client.sync(['/a']);
    store.addVersion('/a', 'a2', { title: 'Theirs', count: 1, tags: ['x', 'y'] });
    const err = await client.write({ '/a': { value: { title: 'Mine', count: 1, tags: ['x', 'y'] } } }, { merge: true }).catch(e => e);
    expect(err).toBeInstanceOf(SyncError);
    expect(err.results['/a']).toMatchObject({ status: 409 });
    expect(client.get('/a')).toEqual({ title: 'A', count: 1, tags: ['x', 'y'] });
  });

  test('Watchers see a write as one event', async () => {
    const seen = [];
    const client = createSyncClient(srv.url);
    await client.sync(['/a', '/b']);
    const handle = client.watch(['/a', '/b'], { consistent: true, onChange: ({ changed }) => seen.push(changed.slice().sort()) });
    await new Promise(r => setTimeout(r, 60));
    await post({ changes: { '/a': { base: 'a1', format: 'application/merge-patch+json', data: { count: 3 } }, '/b': { base: 'b1', format: 'application/merge-patch+json', data: { count: 3 } } } });
    await new Promise(r => setTimeout(r, 80));
    handle.close();
    await handle.closed;
    expect(seen).toEqual([['/a', '/b']]);
  });
});

describe('Rebasing text: merged edits equal both edits applied to the base', () => {
  const { rebase } = require('../src/rebase');
  const { computeTextSplices } = require('../src/formats');
  let seed = 99;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const words = ['alpha', 'βeta', '漢字', '😀', 'x', ' ', '\n', 'longer words here', 'é'];
  const pick = () => words[Math.floor(rand() * words.length)];

  test('400 random pairs of edits to disjoint ranges merge exactly', () => {
    let merged = 0;
    for (let t = 0; t < 400; t++) {
      const base = Array.from({ length: 30 + Math.floor(rand() * 60) }, pick).join('');
      const cps = Array.from(base);
      // Two disjoint ranges [a, a+da) and [b, b+db) with a gap between them.
      const a = Math.floor(rand() * (cps.length / 2));
      const da = Math.floor(rand() * 5);
      const b = a + da + 1 + Math.floor(rand() * (cps.length - a - da - 1));
      const db = Math.min(Math.floor(rand() * 5), cps.length - b);
      const insA = rand() < 0.8 ? pick() : '';
      const insB = rand() < 0.8 ? pick() : '';
      const edit = (src, s, d, ins) => { const out = src.slice(); out.splice(s, d, ...Array.from(ins)); return out; };
      const theirs = edit(cps, a, da, insA).join('');
      const expected = edit(edit(cps, b, db, insB), a, da, insA).join('');   // both edits, the later range first
      const mine = { unit: 'codepoint', splices: db || insB ? [[b, db, insB]] : [] };
      if (!mine.splices.length) continue;
      const out = rebase('application/sync-splice+json', { type: 'text/plain', data: base }, { type: 'text/plain', data: theirs }, mine);
      if (out.conflict) {
        // The server's diff of its own edit may extend into the client's range only if the texts make that ambiguous.
        const theirSplices = computeTextSplices(base, theirs).splices;
        const touches = theirSplices.some(([s, d]) => s + d > b && s < b + db);
        expect(touches || out.conflict).toBeTruthy();
        continue;
      }
      expect(out.data).toBe(expected);
      merged++;
    }
    expect(merged).toBeGreaterThan(300);
  });
});
