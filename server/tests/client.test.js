'use strict';

const http = require('http');
const net = require('net');
const { createSyncServer, createMemoryStore, syncOverPost } = require('../src/package');
const { createSyncClient, syncFetch } = require('../../client/src/index');
const { resetTransportCache } = require('../../client/src/fetch-client');

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

describe('createSyncClient against createSyncServer', () => {
  let store, sync, url;

  beforeEach(async () => {
    resetTransportCache();
    store = createMemoryStore({ maxVersions: 3 });
    store.addVersion('/users', 'u1', { 1: { name: 'Ann' }, 2: { name: 'Bo' } });
    store.addVersion('/posts', 'p1', { 1: { title: 'Hi', body: 'x'.repeat(200) } });
    sync = createSyncServer({ store });
    const port = await new Promise(r => sync.listen(0, '127.0.0.1', () => r(sync.address().port)));
    url = `http://127.0.0.1:${port}/sync`;
  });
  afterEach(done => sync.close(done));

  test('First sync returns full values for every resource', async () => {
    const client = createSyncClient(url);
    const { values, changed } = await client.sync(['/users', '/posts']);
    expect(values['/users']).toEqual({ 1: { name: 'Ann' }, 2: { name: 'Bo' } });
    expect(values['/posts'][1].title).toBe('Hi');
    expect(changed.sort()).toEqual(['/posts', '/users']);
  });

  test('Later syncs apply patches and report only what changed', async () => {
    const client = createSyncClient(url);
    await client.sync(['/users', '/posts']);
    store.addVersion('/posts', 'p2', { 1: { title: 'Hello', body: 'x'.repeat(200) } });
    const { values, changed } = await client.sync(['/users', '/posts']);
    expect(changed).toEqual(['/posts']);
    expect(values['/posts'][1].title).toBe('Hello');
    expect(client.get('/users')[2].name).toBe('Bo');
  });

  test('Nothing changed: no values altered, changed is empty', async () => {
    const client = createSyncClient(url);
    await client.sync(['/users']);
    const { changed, values } = await client.sync(['/users']);
    expect(changed).toEqual([]);
    expect(values['/users'][1].name).toBe('Ann');
  });

  test('A resource that disappears is reported as removed', async () => {
    const client = createSyncClient(url);
    await client.sync(['/users', '/posts']);
    store.getCurrent = r => (r === '/posts' ? null : store.getCurrentVersion(r));
    const { removed, values } = await client.sync(['/users', '/posts']);
    expect(removed).toEqual(['/posts']);
    expect(values).not.toHaveProperty('/posts');
  });

  test('State survives serialization and resumes with patches', async () => {
    const first = createSyncClient(url);
    await first.sync(['/users']);
    const saved = JSON.parse(JSON.stringify(first));
    store.addVersion('/users', 'u2', { 1: { name: 'Ann' }, 2: { name: 'Bob' } });

    const seen = [];
    const spyFetch = (u, init) => { seen.push(JSON.parse(init.body).baselines); return fetch(u, init); };
    const second = createSyncClient(url, { state: saved, fetch: spyFetch });
    const { values } = await second.sync(['/users']);
    expect(seen[0]).toEqual({ '/users': 'u1' });
    expect(values['/users'][2].name).toBe('Bob');
  });

  test('History evicted from the store: the client silently gets a snapshot', async () => {
    const client = createSyncClient(url);
    await client.sync(['/users']);
    for (let i = 2; i <= 5; i++) store.addVersion('/users', `u${i}`, { 1: { name: `Ann${i}` } });
    const { values } = await client.sync(['/users']);
    expect(values['/users']).toEqual({ 1: { name: 'Ann5' } });
  });

  test('With recover:false the client handles the 409 by asking again from scratch', async () => {
    const client = createSyncClient(url, { recover: false, state: { '/users': { token: 'gone', value: {} } } });
    const { values } = await client.sync(['/users']);
    expect(values['/users'][1].name).toBe('Ann');
  });

  test('Uses the SYNC method when the path allows it', async () => {
    const res = await syncFetch(url, { '/users': null });
    expect(res.transport).toBe('SYNC');
    expect(res.status).toBe(200);
  });
});

describe('createSyncClient against a plain Node server that rejects SYNC', () => {
  let server, url;
  const methods = [];

  beforeAll(async () => {
    resetTransportCache();
    const store = createMemoryStore();
    store.addVersion('/a', 'a1', { k: 1 });
    const post = syncOverPost({ store });
    server = http.createServer((req, res) => { methods.push(req.method); post(req, res, () => { res.statusCode = 404; res.end(); }); });
    url = `http://127.0.0.1:${await listen(server)}/sync`;
  });
  afterAll(done => { server.closeAllConnections(); server.close(done); });

  test('Falls back to POST, then stays on POST', async () => {
    const client = createSyncClient(url);
    expect((await client.sync(['/a'])).values['/a']).toEqual({ k: 1 });
    const before = methods.length;
    await client.sync(['/a']);
    expect(methods.slice(before)).toEqual(['POST']);
  });
});

describe('createSyncServer pass-through to the app', () => {
  // Regression: bytes arriving while the front connects to the app used to be dropped.
  test('A large upload split across TCP writes reaches the app intact', async () => {
    const app = (req, res) => { let n = 0; req.on('data', c => { n += c.length; }); req.on('end', () => res.end(String(n))); };
    const sync = createSyncServer({ app });
    const port = await new Promise(r => sync.listen(0, '127.0.0.1', () => r(sync.address().port)));
    const body = Buffer.alloc(300 * 1024, 'a');
    const reply = await new Promise((resolve, reject) => {
      const c = net.connect(port, '127.0.0.1', () => {
        c.write(`PUT /upload HTTP/1.1\r\nHost: t\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
        setImmediate(() => c.write(body));
      });
      let data = '';
      c.on('data', d => { data += d; });
      c.on('end', () => resolve(data));
      c.on('error', reject);
      setTimeout(() => { c.destroy(); resolve(data); }, 3000);
    });
    await new Promise(r => sync.close(r));
    expect(reply).toMatch(/^HTTP\/1.1 200/);
    expect(reply.endsWith(String(body.length))).toBe(true);
  });

  test('A client that half-closes after sending SYNC still gets its response', async () => {
    const store = createMemoryStore();
    store.addVersion('/a', 'a1', { k: 1 });
    const sync = createSyncServer({ store });
    const port = await new Promise(r => sync.listen(0, '127.0.0.1', () => r(sync.address().port)));
    const body = JSON.stringify({ baselines: { '/a': null } });
    const reply = await new Promise(resolve => {
      const c = net.connect(port, '127.0.0.1', () => c.end(`SYNC /s HTTP/1.1\r\nHost: t\r\nContent-Length: ${body.length}\r\n\r\n${body}`));
      let data = '';
      c.on('data', d => { data += d; });
      c.on('close', () => resolve(data));
      setTimeout(() => { c.destroy(); resolve(data); }, 3000);
    });
    await new Promise(r => sync.close(r));
    expect(reply).toMatch(/^HTTP\/1.1 200 OK/);
    expect(reply).toContain('"k":1');
  });

  test('A client that half-closes after a non-SYNC request still gets its response', async () => {
    const sync = createSyncServer({ app: (req, res) => { req.resume(); req.on('end', () => res.end('ok')); } });
    const port = await new Promise(r => sync.listen(0, '127.0.0.1', () => r(sync.address().port)));
    const reply = await new Promise(resolve => {
      const c = net.connect(port, '127.0.0.1', () => c.end('GET /x HTTP/1.1\r\nHost: t\r\n\r\n'));
      let data = '';
      c.on('data', d => { data += d; });
      c.on('close', () => resolve(data));
      setTimeout(() => { c.destroy(); resolve(data); }, 3000);
    });
    await new Promise(r => sync.close(r));
    expect(reply).toMatch(/^HTTP\/1.1 200 OK/);
    expect(reply.endsWith('ok')).toBe(true);
  });
});
