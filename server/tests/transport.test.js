'use strict';

const http = require('http');
const net = require('net');
const express = require('express');
const { startServer, stopServer } = require('../src/index');
const { syncHandler } = require('../src/handler');
const { syncRequest, resetTransportCache } = require('../../client/src/sync-client');

const PORT = 3003;
const BODY = JSON.stringify({ baselines: { '/users': 'v1' } });

beforeAll(done => { startServer(PORT, done); });
afterAll(done => { stopServer(done); });
beforeEach(() => resetTransportCache());

function rawExchange(payload, { until, timeout = 1500 } = {}) {
  return new Promise(resolve => {
    const c = net.connect(PORT, '127.0.0.1', () => c.write(payload));
    let data = '';
    let timer = setTimeout(() => { c.destroy(); resolve({ data, closed: false }); }, timeout);
    const finish = closed => { clearTimeout(timer); c.destroy(); resolve({ data, closed }); };
    c.on('data', d => { data += d; if (until && until(data)) finish(false); });
    c.on('close', () => finish(true));
    c.on('error', () => {});
  });
}

const syncReq = (extra = '', body = BODY) =>
  `SYNC /x HTTP/1.1\r\nHost: t\r\nContent-Type: application/sync-baseline+json\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

const count = (s, needle) => s.split(needle).length - 1;

// ─── Keep-alive ──────────────────────────────────────────────────────────────

describe('Keep-alive', () => {
  test('Two SYNC requests reuse one connection', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const first = await syncRequest(`http://127.0.0.1:${PORT}/x`, { '/users': 'v1' }, { transport: 'method', agent });
    const sockets = new Set();
    agent.on('free', s => sockets.add(s));
    const second = await syncRequest(`http://127.0.0.1:${PORT}/x`, { '/users': 'v2' }, { transport: 'method', agent });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(Object.keys(agent.freeSockets).length + Object.keys(agent.sockets).length).toBeGreaterThan(0);
    expect(sockets.size).toBe(1);
    agent.destroy();
  });

  test('Pipelined SYNC requests in one write each get a response, in order', async () => {
    const two = syncReq() + syncReq('', JSON.stringify({ baselines: { '/users': 'v3' } }));
    const { data } = await rawExchange(two, { until: d => count(d, 'HTTP/1.1 ') >= 2 && d.includes('204 No Content') });
    expect(count(data, 'HTTP/1.1 ')).toBe(2);
    expect(data.indexOf('HTTP/1.1 200 OK')).toBeLessThan(data.indexOf('HTTP/1.1 204 No Content'));
    expect(data).toMatch(/Connection: keep-alive/);
  });

  test('Connection: close is honoured', async () => {
    const { data, closed } = await rawExchange(syncReq('Connection: close\r\n'));
    expect(data).toMatch(/^HTTP\/1.1 200 OK/);
    expect(data).toMatch(/Connection: close/);
    expect(closed).toBe(true);
  });

  test('HTTP/1.0 without keep-alive closes after the response', async () => {
    const { closed } = await rawExchange(syncReq().replace('HTTP/1.1', 'HTTP/1.0'));
    expect(closed).toBe(true);
  });

  test('A chunked SYNC body is refused with 411 and the connection closed', async () => {
    const req = 'SYNC /x HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n';
    const { data, closed } = await rawExchange(req);
    expect(data).toMatch(/^HTTP\/1.1 411 Length Required/);
    expect(closed).toBe(true);
  });
});

// ─── Robustness ──────────────────────────────────────────────────────────────

describe('Non-object JSON bodies', () => {
  test.each(['null', '[]', '5', '"x"', 'true'])('body %s is rejected with 422 and the server survives', async body => {
    const { data } = await rawExchange(syncReq('Connection: close\r\n', body));
    expect(data).toMatch(/^HTTP\/1.1 422/);
    const after = await rawExchange(syncReq('Connection: close\r\n'));
    expect(after.data).toMatch(/^HTTP\/1.1 200/);
  });
});

// ─── POST form through the main server ───────────────────────────────────────

function post(path, body, contentType = 'application/sync-baseline+json', port = PORT) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST', agent: false,
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('POST form', () => {
  test('Returns the same results as the SYNC method', async () => {
    const viaMethod = await syncRequest(`http://127.0.0.1:${PORT}/x`, { '/users': 'v1', '/posts': 'v1' }, { transport: 'method' });
    const viaPost = await syncRequest(`http://127.0.0.1:${PORT}/x`, { '/users': 'v1', '/posts': 'v1' }, { transport: 'post' });
    expect(viaPost.status).toBe(200);
    expect(viaPost.transport).toBe('POST');
    expect(viaPost.body.results).toEqual(viaMethod.body.results);
  });

  test('Sets Cache-Control: no-store', async () => {
    const res = await post('/x', BODY);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toContain('application/sync-result+json');
  });

  test('204 when everything is current', async () => {
    const res = await post('/x', JSON.stringify({ baselines: { '/users': 'v3' } }));
    expect(res.status).toBe(204);
  });

  test('400 on content that is not valid JSON', async () => {
    expect((await post('/x', '{ nope')).status).toBe(400);
  });

  // Also guards the raw front's hand-off to Express: bytes arriving while the upstream connects must not be dropped.
  test('413 over 64 KiB', async () => {
    const res = await post('/x', JSON.stringify({ baselines: { '/users': 'x'.repeat(70000) } }));
    expect(res.status).toBe(413);
  });

  test('Ordinary POSTs to the same server are unaffected', async () => {
    const res = await post('/api/users', JSON.stringify({ name: 'x' }), 'application/json');
    expect(res.status).toBe(201);
  });
});

// ─── Plain Express app: client fallback and a custom async store ─────────────

function recentOnlyStore() {
  const calls = { getCurrent: 0, getVersion: 0 };
  const states = { '/doc': { v1: { a: 1 }, v2: { a: 1, b: 2 }, v3: { a: 1, b: 2, c: 3, pad: 'x'.repeat(300) } } };
  const tick = () => new Promise(r => setImmediate(r));
  return {
    calls,
    async getCurrent(resource) {
      calls.getCurrent++;
      await tick();
      const s = states[resource];
      return s ? { id: 'v3', data: s.v3 } : null;
    },
    async getVersion(resource, token) {
      calls.getVersion++;
      await tick();
      // keeps only the two most recent versions
      return token === 'v2' ? { id: 'v2', data: states[resource].v2 } : null;
    },
  };
}

// rejectQuery simulates a server or intermediary on the path that does not allow QUERY.
function plainExpress(store, { rejectQuery = false, cacheControl } = {}) {
  const app = express();
  const seen = { methods: [] };
  app.use((req, res, next) => { seen.methods.push(req.method); next(); });
  if (rejectQuery) app.use((req, res, next) => (req.method === 'QUERY' ? res.status(405).end() : next()));
  app.use(syncHandler({ store, cacheControl }));
  app.use((req, res) => res.status(418).end('app'));
  const server = http.createServer(app);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, seen, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
  })));
}

describe('Plain Express app (no raw-TCP front)', () => {
  let app, store;
  beforeEach(async () => { store = recentOnlyStore(); app = await plainExpress(store); });
  afterEach(() => app.close());

  test('transport "method" fails because the runtime rejects SYNC', async () => {
    const res = await syncRequest(`http://127.0.0.1:${app.port}/x`, { '/doc': 'v2' }, { transport: 'method' }).catch(e => ({ status: 'error', e }));
    expect([400, 'error']).toContain(res.status);
  });

  test('transport "auto" uses QUERY, which Node supports natively', async () => {
    const res = await syncRequest(`http://127.0.0.1:${app.port}/x`, { '/doc': 'v2' });
    expect(res.status).toBe(200);
    expect(res.transport).toBe('QUERY');
    expect(res.body.results['/doc']).toMatchObject({ status: 200, from: 'v2', to: 'v3' });
  });

  test('Responses advertise the query format with Accept-Query (RFC 10008 Section 3)', async () => {
    const res = await syncRequest(`http://127.0.0.1:${app.port}/x`, { '/doc': 'v2' }, { transport: 'query' });
    expect(res.headers['accept-query']).toBe('"application/sync-baseline+json"');
  });

  test('Default Cache-Control is no-store', async () => {
    const res = await syncRequest(`http://127.0.0.1:${app.port}/x`, { '/doc': 'v2' }, { transport: 'query' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('A QUERY with another media type is left to the app', async () => {
    const res = await new Promise((resolve, reject) => {
      const body = '$.items';
      const req = http.request({ host: '127.0.0.1', port: app.port, path: '/x', method: 'QUERY', agent: false,
        headers: { 'Content-Type': 'application/jsonpath', 'Content-Length': body.length } }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.on('error', reject);
      req.end(body);
    });
    expect(res).toBe(418);
  });

  test('Async recent-only store: a token it cannot reconstruct gets a snapshot', async () => {
    const res = await syncRequest(`http://127.0.0.1:${app.port}/x`, { '/doc': 'v1' }, { transport: 'post' });
    expect(res.body.results['/doc']).toMatchObject({ status: 200, format: 'application/json', from: null, baseline: 'unrecognized' });
  });

  test('Resources are resolved in parallel and unknown ones report 404', async () => {
    const res = await syncRequest(`http://127.0.0.1:${app.port}/x`, { '/doc': 'v2', '/nope': null }, { transport: 'post' });
    expect(res.body.results['/nope']).toEqual({ status: 404 });
    expect(store.calls.getCurrent).toBe(2);
  });
});

describe('Path that rejects QUERY', () => {
  let app;
  beforeEach(async () => { app = await plainExpress(recentOnlyStore(), { rejectQuery: true }); });
  afterEach(() => app.close());

  test('transport "auto" falls back to POST and succeeds', async () => {
    const res = await syncRequest(`http://127.0.0.1:${app.port}/x`, { '/doc': 'v2' });
    expect(res.status).toBe(200);
    expect(res.transport).toBe('POST');
  });

  test('After one fallback the client goes straight to POST', async () => {
    await syncRequest(`http://127.0.0.1:${app.port}/x`, { '/doc': 'v2' });
    const before = app.seen.methods.length;
    await syncRequest(`http://127.0.0.1:${app.port}/x`, { '/doc': 'v2' });
    expect(app.seen.methods.slice(before)).toEqual(['POST']);
  });
});

describe('strict mode (RFC 10008 Section 2.1)', () => {
  const query = (port, headers, body = '{}') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/sync', method: 'QUERY', agent: false, headers: { ...headers, 'Content-Length': body.length } },
      r => { r.resume(); r.on('end', () => resolve(r)); });
    req.on('error', reject);
    req.end(body);
  });

  test('QUERY without Content-Type gets 400 and Accept-Query', async () => {
    const server = http.createServer((req, res) => syncHandler({ store: recentOnlyStore(), strict: true })(req, res, () => res.end()));
    const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
    const r = await query(port, {});
    server.close();
    expect(r.statusCode).toBe(400);
    expect(r.headers['accept-query']).toBe('"application/sync-baseline+json"');
  });

  test('QUERY with another format gets 415 and Accept-Query', async () => {
    const server = http.createServer((req, res) => syncHandler({ store: recentOnlyStore(), strict: true })(req, res, () => res.end()));
    const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
    const r = await query(port, { 'Content-Type': 'application/jsonpath' }, '$.x');
    server.close();
    expect(r.statusCode).toBe(415);
    expect(r.headers['accept-query']).toBe('"application/sync-baseline+json"');
  });
});

describe('Cache-Control option', () => {
  test('Public data can opt in to shared caching of QUERY responses', async () => {
    const app = await plainExpress(recentOnlyStore(), { cacheControl: 'public, max-age=5' });
    const res = await syncRequest(`http://127.0.0.1:${app.port}/x`, { '/doc': 'v2' }, { transport: 'query' });
    expect(res.headers['cache-control']).toBe('public, max-age=5');
    await app.close();
  });
});

describe('Per-resource authorization', () => {
  test('The store sees the request context and can hide resources (404)', async () => {
    const seen = [];
    const store = {
      getCurrent(resource, ctx) {
        seen.push(ctx);
        if (resource === '/private' && ctx.headers.authorization !== 'Bearer ok') return null;
        return { id: 'v1', data: { r: resource } };
      },
      getVersion: () => null,
    };
    const app = await plainExpress(store);
    const anon = await syncRequest(`http://127.0.0.1:${app.port}/sync`, { '/public': null, '/private': null }, { transport: 'query' });
    const authed = await syncRequest(`http://127.0.0.1:${app.port}/sync`, { '/private': null }, { transport: 'query', headers: { Authorization: 'Bearer ok' } });
    await app.close();
    expect(anon.body.results['/private']).toEqual({ status: 404 });
    expect(anon.body.results['/public'].status).toBe(200);
    expect(authed.body.results['/private'].data).toEqual({ r: '/private' });
    expect(seen[0]).toMatchObject({ method: 'QUERY', target: '/sync' });
  });
});

describe('Failing store', () => {
  test('Returns 500 without taking the server down', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = await plainExpress({ getCurrent: async () => { throw new Error('db down'); }, getVersion: async () => null });
    const first = await post('/x', BODY, 'application/sync-baseline+json', app.port);
    const second = await post('/x', BODY, 'application/sync-baseline+json', app.port);
    expect([first.status, second.status]).toEqual([500, 500]);
    await app.close();
    quiet.mockRestore();
  });
});
