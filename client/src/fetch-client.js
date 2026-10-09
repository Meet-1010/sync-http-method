'use strict';

const { applyResult, JSON_PATCH, MERGE_PATCH } = require('./apply');
const { parseMultipartResults, parseSfStrings } = require('./multipart');
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
// next: true asks for a next URI (the Sync-Next response field; see syncFetchNext).
// consistent: true asks for all resources to be read at one instant (see the
//            Sync-Consistent response field).
async function syncFetch(url, baselines, {
  fetch: fetchImpl = globalThis.fetch, transport = 'auto', result = 'json',
  accept, recover, consistent, links, redirect, next, headers, signal,
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
  if (next) payload.next = true;
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

// The next URI in a response (Sync-Next, a Structured Field String), or null.
function nextUriOf(res) {
  const value = res.headers.get('sync-next');
  if (!value) return null;
  try { return parseSfStrings(value)[0] || null; } catch { return null; }
}

// GET of a next URI: the results of the same request from the versions the
// previous results led to. A client may use it only while it holds exactly those
// versions. Shared caches can answer it for every client in the same state.
async function syncFetchNext(uri, { fetch: fetchImpl = globalThis.fetch, result = 'json', headers, signal, base } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available; pass { fetch }');
  const target = new URL(uri, base ?? globalThis.location?.href);
  const res = await fetchImpl(target.toString(), { headers: { Accept: ACCEPT[result], ...headers }, signal });
  const out = { status: res.status, headers: res.headers, body: await readBody(res), transport: 'GET' };
  if (out.status === 200 && out.body?.results) await resolveLinks(out.body.results, target, fetchImpl, headers, signal);
  return out;
}

class SyncError extends Error {
  constructor(status, body, message) {
    const detail = body && typeof body === 'object' ? body.detail || body.title : '';
    super(message || `SYNC request failed with status ${status}${detail ? `: ${detail}` : ''}`);
    this.status = status;
    this.body = body;
  }
}

// Resolves after ms, or as soon as `signal` aborts.
const pause = (ms, signal) => new Promise(resolve => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

const CHANGES_TYPE = 'application/sync-changes+json';
// Stands for "the client's own copy" when applying the update a rebased write returns.
const MINE = '\u0000mine';
const idempotencyKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

// Key under which a client's serialized state keeps its next URI (resource names start with "/").
const NEXT_KEY = '@next';

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
    this.nextUri = null; // { uri, key }: see sync()
    if (options.state) this.load(options.state);
  }

  get(resource) {
    return this.entries.get(resource)?.value;
  }

  // Serializable state, e.g. for localStorage, so a reload resumes with patches
  // (and with the next URI, if any).
  toJSON() {
    const out = {};
    for (const [r, e] of this.entries) out[r] = { version: e.version, type: e.type, ...encodeValue(e.value) };
    if (this.nextUri) out[NEXT_KEY] = { ...this.nextUri };
    return out;
  }

  load(state) {
    for (const [resource, e] of Object.entries(state || {})) {
      if (resource === NEXT_KEY) {
        if (e && typeof e.uri === 'string' && typeof e.key === 'string') this.nextUri = { uri: e.uri, key: e.key };
        continue;
      }
      if (!e || (typeof e.version !== 'string' && !Array.isArray(e.version))) continue;
      this.entries.set(resource, { version: e.version, type: e.type || 'application/json', value: decodeValue(e) });
    }
  }

  // Applies a result document's results; returns the resources that could not be
  // applied (to ask for again from scratch) and records what changed or went away.
  applyResults(results, changed = [], removed = []) {
    const retry = [];
    for (const [resource, result] of Object.entries(results)) {
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
  }

  // Keeps `resources` current: one stream from the server (a request with
  // "watch": true), with each event applied as it arrives and onChange({ values,
  // changed, removed }) called after it. If the stream ends or fails, the client
  // asks again with what it holds, so it receives only the net change it missed.
  // A server that cannot stream answers with ordinary results; the client then
  // polls every pollMs (using its next URI when it has one). With consistent:
  // true, every state passed to onChange existed on the server at one instant.
  // Returns { close(), closed }, where closed settles when watching stops.
  watch(resources, { onChange, onError, signal, consistent = this.options.consistent, pollMs = 5000, retryMs = 1000 } = {}) {
    const list = resources ?? [...this.entries.keys()];
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const stop = controller.signal;
    const values = () => Object.fromEntries(list.filter(r => this.entries.has(r)).map(r => [r, this.entries.get(r).value]));
    const report = (changed, removed) => { if (changed.length || removed.length) onChange?.({ values: values(), changed, removed }); };

    const run = async () => {
      let delay = retryMs;
      while (!stop.aborted) {
        let outcome;
        try {
          outcome = await this.watchOnce(list, consistent, report, stop);
        } catch (err) {
          if (stop.aborted) break;
          if (err instanceof SyncError && err.fatal) { onError?.(err); throw err; }
          onError?.(err);
          outcome = 'failed';
        }
        if (stop.aborted) break;
        if (outcome === 'results') {
          // The server answered without a stream: poll.
          delay = retryMs;
          await pause(pollMs, stop);
          if (stop.aborted) break;
          try {
            const out = await this.sync(list, { consistent, signal: stop });
            report(out.changed, out.removed);
          } catch (err) {
            if (stop.aborted) break;
            if (err instanceof SyncError && err.fatal) { onError?.(err); throw err; }
            onError?.(err);
          }
          continue;
        }
        // The stream ended or failed, or could not be opened: ask again, backing
        // off while it keeps failing.
        if (outcome === 'ended') delay = retryMs;
        await pause(delay, stop);
        if (outcome === 'failed') delay = Math.min(delay * 2, 30000);
      }
    };
    const closed = run();
    closed.catch(() => {});
    return { close: () => controller.abort(), closed };
  }

  // One watch request. Returns 'ended' when the server streamed and the stream
  // ended, 'results' when it answered with ordinary results (already applied).
  async watchOnce(list, consistent, report, signal) {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const base = new URL(this.url, globalThis.location?.href);
    const baselines = Object.fromEntries(list.map(r => [r, this.entries.get(r)?.version ?? null]));
    const { accept, recover, links, headers } = this.options;
    const payload = { baselines, watch: true };
    if (accept) payload.accept = accept;
    if (recover === false) payload.recover = false;
    if (consistent) payload.consistent = true;
    if (links) payload.links = true;
    const init = method => ({
      method,
      headers: { 'Content-Type': SYNC_TYPE, Accept: `text/event-stream, ${RESULT_TYPE};q=0.5`, ...headers },
      body: JSON.stringify(payload),
      signal,
    });

    const transport = this.options.transport ?? 'auto';
    let res;
    if (transport === 'post' || (transport === 'auto' && postOnly.has(base.origin))) res = await fetchImpl(base.toString(), init('POST'));
    else {
      try {
        res = await fetchImpl(base.toString(), init('QUERY'));
      } catch (err) {
        if (transport !== 'auto' || err.name !== 'TypeError' || signal.aborted) throw err;
      }
      if (transport === 'auto' && (!res || FALLBACK_STATUSES.has(res.status))) {
        if (res) await res.arrayBuffer();
        res = await fetchImpl(base.toString(), init('POST'));
        if (res.status < 400) postOnly.add(base.origin);
      }
    }

    if (consistent && res.status < 300 && res.headers.get('sync-consistent') !== '?1') {
      await res.body?.cancel();
      throw Object.assign(new SyncError(res.status, null, 'The server did not guarantee a consistent snapshot'), { fatal: true });
    }
    if (!/^text\/event-stream/i.test(res.headers.get('content-type') || '')) {
      // Ordinary results: apply them like sync() would.
      const body = await readBody(res);
      if (res.status === 204) return 'results';
      if (res.status !== 200) {
        // A request the server refuses (4xx other than timeouts and rate limits) will be refused again.
        const fatal = res.status >= 400 && res.status < 500 && ![408, 425, 429].includes(res.status);
        throw Object.assign(new SyncError(res.status, body), { fatal });
      }
      await resolveLinks(body.results, base, fetchImpl, headers, signal);
      const changed = [];
      const removed = [];
      const retry = this.applyResults(body.results, changed, removed);
      for (const r of retry) this.entries.delete(r);
      report(changed, removed);
      return 'results';
    }

    // The stream: events separated by blank lines; "data:" lines carry a result document.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return 'ended';
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        const data = [];
        for (const line of block.split('\n')) {
          if (!line || line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const val = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = val;
          else if (field === 'data') data.push(val);
        }
        if (event !== 'sync' || !data.length) continue;
        let doc = JSON.parse(data.join('\n'));
        if (doc.href) {
          // The event's results are a shared result: fetch them. If that fails,
          // nothing is applied and the client asks again with what it holds.
          const shared = await fetchImpl(new URL(doc.href, base).toString(), { headers: { Accept: RESULT_TYPE, ...headers }, signal }).catch(() => null);
          const body = shared && shared.status === 200 ? await readBody(shared) : null;
          if (!body?.results) {
            if (shared) await shared.arrayBuffer().catch(() => {});
            await reader.cancel();
            return 'ended';
          }
          doc = body;
        }
        await resolveLinks(doc.results, base, fetchImpl, headers, signal);
        const changed = [];
        const removed = [];
        const retry = this.applyResults(doc.results, changed, removed);
        report(changed, removed);
        if (retry.length) {
          // The server now assumes versions this client does not hold. Ask again:
          // a link that could not be fetched (status 0) is fine to ask for again
          // from the version still held; a result that did not apply means the
          // copy cannot be trusted, so it is dropped and comes back in full.
          for (const r of retry) if (doc.results[r].status !== 0) this.entries.delete(r);
          await reader.cancel();
          return 'ended';
        }
      }
    }
  }

  // Changes several resources atomically (application/sync-changes+json):
  //   await client.write({ '/doc.md': { value: 'new text' }, '/old': { delete: true } }, { merge: true })
  // A change is { value, type? } (the client sends the smallest patch from the
  // version it holds, or the whole value for a resource it does not hold), or
  // { delete: true }. Either every change is applied or none is; with merge: true
  // the server rebases changes made from an older version when they do not
  // conflict. On success the client holds the new versions (merged values if the
  // server rebased); otherwise it throws SyncError with the per-resource results.
  async write(changes, { merge = false, signal } = {}) {
    const { buildUpdate } = require('../../shared/formats');
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const base = new URL(this.url, globalThis.location?.href);
    const accept = this.options.accept;
    const wire = {};
    const mine = {};
    for (const [resource, c] of Object.entries(changes)) {
      const held = this.entries.get(resource);
      if (c.delete) {
        if (!held) throw new Error(`Cannot delete ${resource}: this client does not hold it`);
        wire[resource] = { base: held.version, delete: true };
        continue;
      }
      const type = c.type || held?.type || 'application/json';
      mine[resource] = { type, value: c.value };
      const full = { type, ...(c.value instanceof Uint8Array ? { encoding: 'base64', data: base64Encode(c.value) } : { data: c.value }) };
      if (!held) { wire[resource] = { base: null, ...full }; continue; }
      // A change the server may have to merge must be a patch, even if the whole value is smaller.
      const u = buildUpdate({ type: held.type, data: held.value }, { type, data: c.value }, accept, { patchOnly: merge });
      wire[resource] = u.full ? { base: held.version, ...full } : { base: held.version, format: u.format, data: u.data };
    }
    const body = JSON.stringify({ changes: wire, ...(merge ? { merge: true } : {}), ...(accept ? { accept } : {}) });
    const key = idempotencyKey();
    const send = () => fetchImpl(base.toString(), {
      method: 'POST',
      headers: { 'Content-Type': CHANGES_TYPE, Accept: RESULT_TYPE, 'Idempotency-Key': key, ...this.options.headers },
      body,
      signal,
    });
    let res;
    try {
      res = await send();
    } catch (err) {
      // The request may or may not have been applied: the same key makes a retry safe.
      if (signal?.aborted) throw err;
      res = await send();
    }
    const out = await readBody(res);
    if (res.status !== 200) {
      throw Object.assign(new SyncError(res.status, out, `The changes were not applied (status ${res.status})`), { results: out?.results });
    }
    const rebased = [];
    for (const [resource, result] of Object.entries(out.results)) {
      if (wire[resource].delete) { this.entries.delete(resource); continue; }
      let value = mine[resource].value;
      if (result.rebased) {
        rebased.push(resource);
        const u = result.update;
        value = u.format
          ? applyResult(value, MINE, { status: 200, from: MINE, to: result.to, format: u.format, data: u.data })
          : applyResult(undefined, null, { status: 200, from: null, to: result.to, ...u });
      }
      this.entries.set(resource, { version: result.to, type: mine[resource].type, value });
    }
    return { results: out.results, rebased };
  }

  // What a next URI was issued for: the resources, the versions held, and the
  // options that shape the request. A next URI is used only when all are unchanged.
  stateKey(list, consistent) {
    const held = list.map(r => [r, this.entries.get(r)?.version ?? null]);
    const { accept, recover, links, result } = this.options;
    return JSON.stringify([held, accept, recover !== false, !!links, result || 'json', !!consistent]);
  }

  // options.consistent: require every value to come from one instant; throws
  // SyncError if the server cannot guarantee it.
  async sync(resources, { signal, consistent = this.options.consistent } = {}) {
    const list = resources ?? [...this.entries.keys()];
    const changed = [];
    const removed = [];

    const apply = res => {
      if (consistent && res.status < 300 && res.headers.get('sync-consistent') !== '?1') {
        throw new SyncError(res.status, res.body, 'The server did not guarantee a consistent snapshot');
      }
      if (res.status === 204) return [];
      if (res.status !== 200) throw new SyncError(res.status, res.body);
      return this.applyResults(res.body.results, changed, removed);
    };

    const request = (names, overrides = {}) => {
      const baselines = {};
      for (const r of names) baselines[r] = this.entries.get(r)?.version ?? null;
      return syncFetch(this.url, baselines, { ...this.options, ...overrides, consistent, signal });
    };

    // First round: the next URI if this client holds exactly what it was issued
    // for, otherwise a request. A next URI that fails is replaced by a request.
    const key = this.stateKey(list, consistent);
    let res = null;
    if (this.options.next && this.nextUri?.key === key) {
      try {
        res = await syncFetchNext(this.nextUri.uri, { ...this.options, base: new URL(this.url, globalThis.location?.href), signal });
        if (res.status !== 200 && res.status !== 204) res = null;
      } catch (err) {
        if (signal?.aborted) throw err;
        res = null;
      }
    }
    if (!res) res = await request(list);
    this.nextUri = null;
    const retry = apply(res);
    const uri = this.options.next ? nextUriOf(res) : null;

    if (retry.length) {
      // Ask again from scratch, directly and inline: the server sends full representations.
      const direct = { links: false, redirect: false, next: false };
      for (const r of retry) this.entries.delete(r);
      const stillFailing = apply(await request(retry, direct));
      if (stillFailing.length) throw new SyncError(409, null, `Could not synchronize ${stillFailing.join(', ')}`);
      if (consistent) {
        // The retried resources came from a later instant; read everything again so
        // the values returned belong together.
        const failing = apply(await request(list, direct));
        if (failing.length) throw new SyncError(409, null, `Could not synchronize ${failing.join(', ')} consistently`);
      }
    } else if (uri) {
      // Every result applied: this client now holds exactly the versions the next URI names.
      this.nextUri = { uri, key: this.stateKey(list, consistent) };
    }

    const values = {};
    for (const r of list) if (this.entries.has(r)) values[r] = this.entries.get(r).value;
    return { values, changed, removed };
  }
}

const createSyncClient = (url, options) => new SyncClient(url, options);
const resetTransportCache = () => postOnly.clear();

module.exports = { syncFetch, syncFetchNext, createSyncClient, SyncClient, SyncError, resetTransportCache };
