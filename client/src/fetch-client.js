'use strict';

const { applyResult, JSON_PATCH, MERGE_PATCH } = require('./apply');

const SYNC_TYPE = 'application/sync-baseline+json';
const RESULT_TYPE = 'application/sync-result+json';
const FALLBACK_STATUSES = new Set([400, 405, 501]);

// Origins where the SYNC method failed and the POST form worked.
const postOnly = new Set();

// Low-level request with any fetch implementation (browsers, Node 18+, Deno, Bun).
// transport: 'auto' (try SYNC, fall back to POST and remember), 'method', or 'post'.
async function syncFetch(url, baselines, { fetch: fetchImpl = globalThis.fetch, transport = 'auto', accept, recover, headers, signal } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available; pass { fetch }');
  const origin = new URL(url, globalThis.location?.href).origin;
  const payload = { baselines };
  if (accept) payload.accept = accept;
  if (recover === false) payload.recover = false;
  const body = JSON.stringify(payload);

  const send = async method => {
    const res = await fetchImpl(url, {
      method,
      headers: { 'Content-Type': SYNC_TYPE, Accept: RESULT_TYPE, ...headers },
      body,
      signal,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null, transport: method };
  };

  if (transport === 'post' || (transport === 'auto' && postOnly.has(origin))) return send('POST');
  if (transport === 'method') return send('SYNC');

  let res;
  try {
    res = await send('SYNC');
  } catch (err) {
    // fetch rejects with TypeError on network or CORS failure, which is how an
    // intermediary that drops unknown methods usually shows up.
    if (err.name !== 'TypeError') throw err;
  }
  if (res && !FALLBACK_STATUSES.has(res.status)) return res;

  const viaPost = await send('POST');
  if (viaPost.status < 400) postOnly.add(origin);
  return viaPost;
}

class SyncError extends Error {
  constructor(status, body) {
    super(`SYNC request failed with status ${status}${body?.error ? `: ${body.error}` : ''}`);
    this.status = status;
    this.body = body;
  }
}

// High-level client: remembers what it holds, applies updates, recovers on its own.
//   const client = createSyncClient('https://api.example.com/sync');
//   const { values, changed } = await client.sync(['/users', '/posts']);
class SyncClient {
  constructor(url, options = {}) {
    this.url = url;
    this.options = { accept: [MERGE_PATCH, JSON_PATCH], ...options };
    this.entries = new Map(); // resource -> { token, value }
    if (options.state) this.load(options.state);
  }

  get(resource) {
    return this.entries.get(resource)?.value;
  }

  // Serializable state, e.g. for localStorage, so a reload resumes with patches.
  toJSON() {
    return Object.fromEntries(this.entries);
  }

  load(state) {
    for (const [resource, entry] of Object.entries(state || {})) {
      if (entry && typeof entry.token === 'string') this.entries.set(resource, { token: entry.token, value: entry.value });
    }
  }

  async sync(resources, { signal } = {}) {
    const list = resources ?? [...this.entries.keys()];
    const changed = [];
    const removed = [];

    const round = async names => {
      const baselines = {};
      for (const r of names) baselines[r] = this.entries.get(r)?.token ?? null;
      const res = await syncFetch(this.url, baselines, { ...this.options, signal });
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
          const value = applyResult(held?.value, held?.token ?? null, result);
          this.entries.set(resource, { token: result.to, value });
          changed.push(resource);
        } catch {
          retry.push(resource);
        }
      }
      return retry;
    };

    const retry = await round(list);
    if (retry.length) {
      for (const r of retry) this.entries.delete(r); // ask again from scratch: the server sends snapshots
      const stillFailing = await round(retry);
      if (stillFailing.length) throw new SyncError(409, { error: `Could not synchronize ${stillFailing.join(', ')}` });
    }

    const values = {};
    for (const r of list) if (this.entries.has(r)) values[r] = this.entries.get(r).value;
    return { values, changed, removed };
  }
}

const createSyncClient = (url, options) => new SyncClient(url, options);
const resetTransportCache = () => postOnly.clear();

module.exports = { syncFetch, createSyncClient, SyncClient, SyncError, resetTransportCache };
