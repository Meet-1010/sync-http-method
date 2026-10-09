'use strict';

const { applyResult, JSON_PATCH, MERGE_PATCH } = require('./apply');
const { parseMultipartResults } = require('./multipart');
const { SPLICE, decodeRepresentation, utf8Decode, base64Encode, base64Decode } = require('../../shared/media');

const SYNC_TYPE = 'application/sync-baseline+json';
const RESULT_TYPE = 'application/sync-result+json';
const ACCEPT = {
  json: RESULT_TYPE,
  multipart: `multipart/mixed, ${RESULT_TYPE};q=0.5`,
};

// A server or intermediary that does not support QUERY for this resource typically
// answers 400, 404, 405, 415 or 501, or drops the request (fetch rejects with TypeError).
const FALLBACK_STATUSES = new Set([400, 404, 405, 415, 501]);
const LINK_CONCURRENCY = 6;

// Origins where QUERY failed and POST worked.
const postOnly = new Set();

async function readBody(res) {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get('content-type') || '';
  if (!bytes.length) return null;
  if (/^multipart\/mixed/i.test(type)) return parseMultipartResults(bytes, type);
  const text = utf8Decode(bytes);
  try { return JSON.parse(text); } catch { return text; }
}

// Fetch the content behind links, at most LINK_CONCURRENCY at a time. A link that
// fails leaves { status: 0 } so the caller can ask again without links.
async function resolveLinks(results, baseUrl, fetchImpl, headers, signal) {
  const pending = Object.entries(results).filter(([, r]) => r.href);
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const [name, r] = pending[next++];
      try {
        const res = await fetchImpl(new URL(r.href, baseUrl).toString(), { headers, signal });
        if (res.status !== 200) throw new Error(`link ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const { href, ...rest } = r;
        results[name] = r.from === null
          ? { ...rest, value: decodeRepresentation(r.type, bytes) }
          : { ...rest, data: JSON.parse(utf8Decode(bytes)) };
      } catch (err) {
        if (signal?.aborted) throw err;
        results[name] = { status: 0 };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LINK_CONCURRENCY, pending.length) }, worker));
}

// Low-level request with any fetch implementation (browsers, Node 18+, Deno, Bun).
// transport: 'auto' (QUERY, falling back to POST and remembering per origin),
//            'query', 'post', or 'method' (the dedicated SYNC method).
// result: 'json' (default) or 'multipart'.
// links: true lets the server return links for large updates; they are fetched here.
// redirect: true lets the server answer 303 (See Other) with the URI of the whole
//            result, which shared caches can serve to every client in the same state;
//            it is followed here (fetch follows it itself), and if that URI fails the
//            request is repeated without redirect.
// consistent: true asks for all resources to be read at one instant (see the
//            Sync-Consistent response field).
async function syncFetch(url, baselines, {
  fetch: fetchImpl = globalThis.fetch, transport = 'auto', result = 'json',
  accept, recover, consistent, links, redirect, headers, signal,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available; pass { fetch }');
  if (!ACCEPT[result]) throw new Error(`Unknown result format ${result}`);
  const base = new URL(url, globalThis.location?.href);
  const payload = { baselines };
  if (accept) payload.accept = accept;
  if (recover === false) payload.recover = false;
  if (consistent) payload.consistent = true;
  if (links) payload.links = true;
  if (redirect) payload.redirect = true;
  const body = JSON.stringify(payload);
  const { redirect: _, ...direct } = payload;

  const send = async (method, content = body, again = false) => {
    let res = await fetchImpl(base.toString(), {
      method,
      headers: { 'Content-Type': SYNC_TYPE, Accept: ACCEPT[result], ...headers },
      body: content,
      signal,
    });
    let redirected = res.redirected;
    // fetch follows 303 with GET itself; this covers implementations that return it.
    const location = res.status === 303 && res.headers.get('location');
    if (location) {
      await res.arrayBuffer();
      res = await fetchImpl(new URL(location, base).toString(), { headers: { Accept: ACCEPT[result], ...headers }, signal });
      redirected = true;
    }
    // A shared result that is no longer available: ask once more for a direct answer.
    if (redirected && res.status !== 200 && !again) {
      await res.arrayBuffer();
      return send(method, JSON.stringify(direct), true);
    }
    return { status: res.status, headers: res.headers, body: await readBody(res), transport: method };
  };

  const resolved = async res => {
    if (res.status === 200 && res.body?.results) await resolveLinks(res.body.results, base, fetchImpl, headers, signal);
    return res;
  };

  if (transport === 'post' || (transport === 'auto' && postOnly.has(base.origin))) return resolved(await send('POST'));
  if (transport === 'query') return resolved(await send('QUERY'));
  if (transport === 'method') return resolved(await send('SYNC'));

  let res;
  try {
    res = await send('QUERY');
  } catch (err) {
    if (err.name !== 'TypeError' || signal?.aborted) throw err;
  }
  if (res && !FALLBACK_STATUSES.has(res.status)) return resolved(res);

  const viaPost = await send('POST');
  if (viaPost.status < 400) postOnly.add(base.origin);
  return resolved(viaPost);
}

class SyncError extends Error {
  constructor(status, body, message) {
    const detail = body && typeof body === 'object' ? body.detail || body.title : '';
    super(message || `SYNC request failed with status ${status}${detail ? `: ${detail}` : ''}`);
    this.status = status;
    this.body = body;
  }
}

// Serializable form of a value (binary values as base64).
const encodeValue = v => (v instanceof Uint8Array ? { value: base64Encode(v), encoding: 'base64' } : { value: v });
const decodeValue = e => (e.encoding === 'base64' ? base64Decode(e.value) : e.value);

// High-level client: remembers what it holds, applies updates, recovers on its own.
//   const client = createSyncClient('https://api.example.com/sync');
//   const { values, changed } = await client.sync(['/users', '/posts']);
// Values are JSON values, strings (text media types) or Uint8Array (other types).
class SyncClient {
  constructor(url, options = {}) {
    this.url = url;
    this.options = { accept: [MERGE_PATCH, JSON_PATCH, SPLICE], ...options };
    this.entries = new Map(); // resource -> { version, type, value }
    if (options.state) this.load(options.state);
  }

  get(resource) {
    return this.entries.get(resource)?.value;
  }

  // Serializable state, e.g. for localStorage, so a reload resumes with patches.
  toJSON() {
    const out = {};
    for (const [r, e] of this.entries) out[r] = { version: e.version, type: e.type, ...encodeValue(e.value) };
    return out;
  }

  load(state) {
    for (const [resource, e] of Object.entries(state || {})) {
      if (!e || (typeof e.version !== 'string' && !Array.isArray(e.version))) continue;
      this.entries.set(resource, { version: e.version, type: e.type || 'application/json', value: decodeValue(e) });
    }
  }

  // options.consistent: require every value to come from one instant; throws
  // SyncError if the server cannot guarantee it.
  async sync(resources, { signal, consistent = this.options.consistent } = {}) {
    const list = resources ?? [...this.entries.keys()];
    const changed = [];
    const removed = [];

    const round = async (names, overrides = {}) => {
      const baselines = {};
      for (const r of names) baselines[r] = this.entries.get(r)?.version ?? null;
      const res = await syncFetch(this.url, baselines, { ...this.options, ...overrides, consistent, signal });
      if (consistent && res.status < 300 && res.headers.get('sync-consistent') !== '?1') {
        throw new SyncError(res.status, res.body, 'The server did not guarantee a consistent snapshot');
      }
      if (res.status === 204) return [];
      if (res.status !== 200) throw new SyncError(res.status, res.body);

      const retry = [];
      for (const [resource, result] of Object.entries(res.body.results)) {
        if (result.status === 304) continue;
        if (result.status === 404) {
          if (this.entries.delete(resource)) removed.push(resource);
          continue;
        }
        if (result.status !== 200) { retry.push(resource); continue; }
        const held = this.entries.get(resource);
        try {
          const value = applyResult(held?.value, held?.version ?? null, result);
          this.entries.set(resource, { version: result.to, type: result.type || held?.type || 'application/json', value });
          if (!changed.includes(resource)) changed.push(resource);
        } catch {
          retry.push(resource);
        }
      }
      return retry;
    };

    const retry = await round(list);
    if (retry.length) {
      // Ask again from scratch, directly and inline: the server sends full representations.
      const direct = { links: false, redirect: false };
      for (const r of retry) this.entries.delete(r);
      const stillFailing = await round(retry, direct);
      if (stillFailing.length) throw new SyncError(409, null, `Could not synchronize ${stillFailing.join(', ')}`);
      if (consistent) {
        // The retried resources came from a later instant; read everything again so
        // the values returned belong together.
        const failing = await round(list, direct);
        if (failing.length) throw new SyncError(409, null, `Could not synchronize ${failing.join(', ')} consistently`);
      }
    }

    const values = {};
    for (const r of list) if (this.entries.has(r)) values[r] = this.entries.get(r).value;
    return { values, changed, removed };
  }
}

const createSyncClient = (url, options) => new SyncClient(url, options);
const resetTransportCache = () => postOnly.clear();

module.exports = { syncFetch, createSyncClient, SyncClient, SyncError, resetTransportCache };
