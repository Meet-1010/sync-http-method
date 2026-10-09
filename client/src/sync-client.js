'use strict';

const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');

const quote = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const SYNC_TYPE = 'application/sync-baseline+json';

// Origins where QUERY failed and POST worked, so later calls skip the failed attempt.
const postOnly = new Set();

// Statuses and errors that mean "something on the path does not support this request".
const FALLBACK_STATUSES = new Set([400, 404, 405, 415, 501]);
const FALLBACK_ERRORS = new Set(['ECONNRESET', 'EPIPE']);

function exchange(method, rawUrl, headers, body, agent) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method,
      agent: agent ?? false,
      headers,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        let raw = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') raw = zlib.gunzipSync(raw);
        const text = raw.toString('utf8');
        let parsedBody = null;
        if (text) {
          try { parsedBody = JSON.parse(text); } catch { parsedBody = text; }
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsedBody });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// One SYNC request. A 303 (See Other) is followed with GET; if the shared result
// it names is no longer available, the request is repeated without redirect.
async function send(method, rawUrl, baselines, opts) {
  const headers = { 'Accept': 'application/sync-result+json', ...opts.headers };
  if (opts.gzip !== false) headers['Accept-Encoding'] = 'gzip';
  let body = null;

  if (opts.useHeader && method === 'SYNC') {
    headers['Sync-Baseline'] = Object.entries(baselines)
      .map(([r, t]) => (t === null || t === undefined ? `(${quote(r)})` : `(${quote(r)} ${quote(t)})`))
      .join(', ');
    if (opts.accept) headers['Sync-Accept'] = opts.accept.join(', ');
  } else {
    const payload = { baselines };
    if (opts.accept) payload.accept = opts.accept;
    if (opts.recover === false) payload.recover = false;
    if (opts.consistent) payload.consistent = true;
    if (opts.links) payload.links = true;
    if (opts.redirect) payload.redirect = true;
    body = JSON.stringify(payload);
    headers['Content-Type'] = SYNC_TYPE;
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  const res = await exchange(method, rawUrl, headers, body, opts.agent);
  if (res.status === 303 && res.headers.location) {
    const { 'Content-Type': _t, 'Content-Length': _l, ...getHeaders } = headers;
    const shared = await exchange('GET', new URL(res.headers.location, rawUrl).toString(), getHeaders, null, opts.agent);
    if (shared.status === 200 || !opts.redirect) return { ...shared, transport: method, redirected: true };
    return send(method, rawUrl, baselines, { ...opts, redirect: false });
  }
  return { ...res, transport: method };
}

// Node http-module client (used by the tests and benchmark; applications should use fetch-client).
// opts.transport: 'auto' (default) sends QUERY and falls back to POST;
//                 'query', 'post', or 'method' (the dedicated SYNC method).
// opts.headers: extra request headers; opts.gzip: false to disable compression;
// opts.accept: media types in preference order; opts.recover: false to get 409
// for unrecognized baselines; opts.useHeader: send baselines in Sync-Baseline (SYNC method only);
// opts.consistent / opts.links / opts.redirect: request a consistent snapshot / links
// for large updates / a 303 to a shared result;
// opts.agent: an http.Agent (for keep-alive).
async function syncRequest(rawUrl, baselines, opts = {}) {
  const transport = opts.transport || 'auto';
  const origin = new URL(rawUrl).origin;

  if (transport === 'post' || (transport === 'auto' && postOnly.has(origin))) {
    return send('POST', rawUrl, baselines, opts);
  }
  if (transport === 'query') return send('QUERY', rawUrl, baselines, opts);
  if (transport === 'method') return send('SYNC', rawUrl, baselines, opts);

  let res;
  try {
    res = await send('QUERY', rawUrl, baselines, opts);
  } catch (err) {
    if (!FALLBACK_ERRORS.has(err.code) && err.message !== 'socket hang up') throw err;
    return fallback(rawUrl, baselines, opts, origin);
  }
  if (FALLBACK_STATUSES.has(res.status)) return fallback(rawUrl, baselines, opts, origin);
  return res;
}

async function fallback(rawUrl, baselines, opts, origin) {
  const res = await send('POST', rawUrl, baselines, opts);
  if (res.status < 400) postOnly.add(origin);
  return res;
}

function resetTransportCache() { postOnly.clear(); }

module.exports = { syncRequest, resetTransportCache };
