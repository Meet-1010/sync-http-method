'use strict';

const crypto = require('crypto');
const {
  parseRequest, resolveRequest, respond, finalize, problem, resultResponse, plansOf, resultTypeOf, requestOf, nextField, sharedPayload,
  gzipTag, acceptsGzip, MAX_BODY_BYTES, GZIP_MIN_BYTES,
} = require('./sync-handler');
const { resolveLink, resolvePlanned, planResults, materializeAll } = require('./sync-core');
const { acceptsExactly, encodeJson, JSON_RESULT } = require('./encode');
const { resolveWrite, SYNC_CHANGES_TYPE } = require('./writes');
const { isResourceName } = require('./sync-handler');
const { createLinkCodec } = require('./links');
const { representationBytes } = require('./formats');

const SYNC_TYPE = 'application/sync-baseline+json';
const EVENT_STREAM = 'text/event-stream';
const EVENT_MEMO_ENTRIES = 512;
const IDEMPOTENCY_ENTRIES = 10000;
const ACCEPT_QUERY = `"${SYNC_TYPE}"`;

const mediaType = req => (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
const pathOf = req => (req.originalUrl || req.url || '/').split('?')[0];

// Reads at most MAX_BODY_BYTES; resolves { tooLarge: true } instead of buffering more.
function readBody(req) {
  if (typeof req.body === 'string') return Promise.resolve({ text: req.body });
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    req.resume();
    return Promise.resolve({ tooLarge: true });
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        req.resume();
        return resolve({ tooLarge: true });
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve({ text: Buffer.concat(chunks).toString('utf8') }); } });
    req.on('error', reject);
  });
}

function send(res, response, acceptEncoding, extraHeaders = {}, headOnly = false) {
  const { status, headers, body } = finalize({ ...response, headers: { ...response.headers, ...extraHeaders } }, acceptEncoding);
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(headOnly ? undefined : body);
}

// RFC 9110 Section 4.1 recommends supporting URIs of at least 8000 octets.
const MAX_URI_LENGTH = 8000;

function linkConfig(links) {
  if (!links) return null;
  const {
    secret, path, minBytes = 1024, cacheControl = 'private, max-age=31536000, immutable',
    redirect = true, next = true, maxUriLength = MAX_URI_LENGTH,
  } = links;
  if (typeof path !== 'string' || !/^\/(?!\/)[\x21-\x7E]*$/.test(path) || path.endsWith('/')) {
    throw new Error('links.path must be an absolute path such as "/sync/updates"');
  }
  const codec = createLinkCodec(secret);
  const href = payload => `${path}/${codec.encode(payload)}`;
  return {
    codec, path, minBytes, cacheControl, href,
    shared: redirect ? { href, maxUriLength } : null,
    next: next ? { href, maxUriLength } : null,
  };
}

// If-None-Match uses the weak comparison (RFC 9110 Section 13.1.2).
function noneMatch(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').map(t => t.trim().replace(/^W\//, '')).includes(etag);
}

// Serves SYNC requests carried by QUERY (RFC 10008) and, as a fallback for paths
// that block QUERY, by POST. Only requests whose Content-Type is
// application/sync-baseline+json are handled; everything else goes to next(),
// so other QUERY or POST uses of the same app are unaffected.
//
//   app.use(syncHandler({ store }))
//
// cacheControl: QUERY responses are cacheable (RFC 10008 Section 2.7), and so are
// GETs of next URIs. The default 'no-store' is safe for per-user data; use e.g.
// 'public, max-age=5' only when the results do not depend on who is asking.
//
// strict: on a path that is only a sync resource, answer QUERY requests with a
// missing or different Content-Type with 400 or 415 (RFC 10008 Section 2.1)
// instead of passing them on.
//
// links: { secret, path, minBytes, cacheControl, redirect, next, maxUriLength }.
// Enables three kinds of URI under `path`, all opaque and authenticated, and all
// served here with GET:
// - links: with "links": true, updates of at least minBytes are returned as links
//   instead of inline. Each names one immutable update, so shared caches keep it.
// - shared results: with "redirect": true (unless redirect is false here), the
//   server answers 303 (See Other) with the URI of the whole result (RFC 10008
//   Section 2.5): clients in the same state get the same URI, so a shared cache
//   serves all of them from one response.
// - next URIs: with "next": true (unless next is false here), every response
//   carries Sync-Next, the URI of the same request from the versions the results
//   lead to. Clients in the same state hold the same next URI, so their next
//   catch-up is a GET a shared cache can answer. Its results reflect the current
//   state and use the handler's cacheControl, not links.cacheControl.
// URIs longer than maxUriLength (default 8000) are not used. links.cacheControl
// (for the immutable kinds) defaults to private; use
// 'public, max-age=31536000, immutable' only for data that is the same for everyone.
//
// Watching: a request with "watch": true whose Accept names text/event-stream, to
// a store that offers subscribe(listener), is answered with a stream of result
// documents: the first brings every resource current, each later one the net
// change since the previous. heartbeatMs (default 15000) spaces keep-alive comments.
function syncHandler({ store, cacheControl = 'no-store', allowPost = true, strict = false, links, heartbeatMs = 15000, newVersion } = {}) {
  const lc = linkConfig(links);
  const events = new Map(); // encoded watch events, shared by watchers in the same state
  const watchers = new Set();
  let unsubscribeStore = null;
  let dispatchScheduled = false;
  const idempotent = new Map(); // Idempotency-Key -> { digest, response | null while in progress }

  return async (req, res, next) => {
    const isGet = req.method === 'GET' || req.method === 'HEAD';
    if (lc && isGet && pathOf(req).startsWith(`${lc.path}/`)) return serveLink(req, res);

    const isQuery = req.method === 'QUERY';
    const isPost = req.method === 'POST' && allowPost;
    const type = mediaType(req);
    if (strict && isQuery && type !== SYNC_TYPE) {
      req.resume();
      return send(res, problem(type ? 415 : 400, type ? `Unsupported query format ${type}` : 'Missing Content-Type'), '', { 'Accept-Query': ACCEPT_QUERY });
    }
    if (isPost && type === SYNC_CHANGES_TYPE && typeof store?.write === 'function') return write(req, res);
    if ((!isQuery && !isPost) || type !== SYNC_TYPE) return next();

    let response;
    const context = { method: req.method, target: req.originalUrl || req.url, headers: req.headers };
    try {
      const body = await readBody(req);
      const parsed = body.tooLarge ? { error: problem(413, `Content exceeds ${MAX_BODY_BYTES} bytes`) } : parseRequest(body.text, req.headers);
      if (parsed.error) response = parsed.error;
      else if (parsed.request.watch === true && typeof store?.subscribe === 'function' && acceptsExactly(req.headers.accept, EVENT_STREAM)) {
        return watch(req, res, parsed.request, context);
      } else {
        response = await resolveRequest(parsed.request, req.headers, { store, links: lc, context });
      }
    } catch (e) {
      console.error('SYNC store error:', e);
      response = problem(500, 'Internal error');
    }
    const extra = { 'Accept-Query': ACCEPT_QUERY };
    if (response.status === 200 || response.status === 204 || response.status === 303) extra['Cache-Control'] = cacheControl;
    send(res, response, req.headers['accept-encoding'], extra);
  };

  // A write: atomic changes to several resources (writes.js). A request with an
  // Idempotency-Key that was already answered gets the same answer again, so a
  // client can retry a write whose response it did not receive.
  async function write(req, res) {
    const context = { method: req.method, target: req.originalUrl || req.url, headers: req.headers };
    let response;
    try {
      const body = await readBody(req);
      if (body.tooLarge) return send(res, problem(413, `Content exceeds ${MAX_BODY_BYTES} bytes`), '');
      // Keys are scoped to the requester's credentials, so one requester can never
      // receive the stored response to another's request.
      const scope = crypto.createHash('sha256').update(`${req.headers.authorization || ''}\n${req.headers.cookie || ''}`).digest('base64url');
      const key = req.headers['idempotency-key'] && `${scope} ${req.headers['idempotency-key']}`;
      const digest = key && crypto.createHash('sha256').update(body.text).digest('base64url');
      if (key && idempotent.has(key)) {
        const seen = idempotent.get(key);
        if (seen.digest !== digest) return send(res, problem(422, 'This Idempotency-Key was used with different content'), '');
        if (!seen.response) return send(res, problem(409, 'A request with this Idempotency-Key is in progress'), '');
        return send(res, seen.response, req.headers['accept-encoding'], { 'Cache-Control': 'no-store' });
      }
      if (key) idempotent.set(key, { digest, response: null });
      response = await resolveWrite(body.text, { store, context, newVersion, isResourceName });
      if (key) {
        if (response.status >= 500) idempotent.delete(key);
        else idempotent.set(key, { digest, response });
        if (idempotent.size > IDEMPOTENCY_ENTRIES) idempotent.delete(idempotent.keys().next().value);
      }
    } catch (e) {
      console.error('SYNC store error:', e);
      for (const [k, v] of idempotent) if (!v.response) idempotent.delete(k);
      response = problem(500, 'Internal error');
    }
    send(res, response, req.headers['accept-encoding'], { 'Cache-Control': 'no-store' });
  }

  // A watch: a stream of result documents (text/event-stream, event "sync").
  // The first brings every requested resource current, as a response would; each
  // later one carries the resources that changed since the previous one was sent,
  // as updates from the versions that one led to. An event's data is a result
  // document, or { "href": ... } naming a shared result that holds it. Changes that
  // arrive while an event is being written are coalesced into the next, so a slow
  // client receives the net change rather than a backlog. With "consistent": true,
  // every event is computed from one snapshot of all requested resources, so the
  // client never holds a combination that did not exist. Access is evaluated for
  // every event.
  //
  // After a change, watchers that hold the same versions of the same resources,
  // with the same options and the same credentials, form a group: the event is
  // planned and encoded once and written to every member. A member still writing
  // a previous event (a slow client) leaves the group and catches up on its own.
  async function watch(req, res, request, context) {
    const names = Object.keys(request.baselines);
    const w = {
      names,
      watched: new Set(names),
      held: new Map(Object.entries(request.baselines)), // what the client holds after the events sent so far
      consistent: request.consistent === true,
      request,
      context,
      accept: request.accept && request.accept.map(a => a.toLowerCase()),
      linkOptions: request.links === true ? lc : null,
      // With links allowed, an event whose results are large is sent as a link to a
      // shared result holding them: every watcher that receives the same change from
      // the same versions receives the same link, which shared caches serve.
      eventLinks: request.links === true && lc?.shared ? lc : null,
      credentials: crypto.createHash('sha256').update(`${req.headers.authorization || ''}\n${req.headers.cookie || ''}`).digest('base64url'),
      dirty: new Set(),
      busy: true,
      closed: false,
    };
    w.groupKey = () => JSON.stringify([w.credentials, w.names, w.names.map(r => w.held.get(r) ?? null), w.accept, request.recover !== false, w.consistent, !!w.linkOptions, !!w.eventLinks]);
    w.write = text => new Promise(resolve => {
      if (w.closed) return resolve();
      if (res.write(text)) return resolve();
      res.once('drain', resolve);
      res.once('close', resolve);
    });
    let heartbeat = null;
    w.close = () => {
      if (w.closed) return;
      w.closed = true;
      watchers.delete(w);
      if (!watchers.size && unsubscribeStore) { unsubscribeStore(); unsubscribeStore = null; }
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    };
    req.on('close', w.close);
    res.on('close', w.close);

    watchers.add(w);
    if (!unsubscribeStore) unsubscribeStore = store.subscribe(onStoreChange);

    try {
      res.statusCode = 200;
      res.setHeader('Content-Type', EVENT_STREAM);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no'); // proxies that buffer responses (nginx) pass this one through as it is written
      res.setHeader('Accept-Query', ACCEPT_QUERY);
      res.setHeader('Vary', 'Accept');
      if (w.consistent) res.setHeader('Sync-Consistent', typeof store.snapshot === 'function' ? '?1' : '?0');
      res.flushHeaders();
      const first = await prepare(w, names, true);
      if (first) sendEvent(w, first);
      else release(w);
      heartbeat = setInterval(() => { w.write(': keep-alive\n\n'); }, heartbeatMs);
      heartbeat.unref?.();
    } catch (e) {
      console.error('SYNC store error:', e);
      w.close();
    }
  }

  // Plans `subset` from what watcher `w` holds: { changed, data } for the results
  // that change it, or null when nothing does. `shared` says whether the event goes
  // to more than one watcher: only then can a link to it be served from a cache to
  // several clients, so only then is a large event sent as a link.
  async function prepare(w, subset, everything, shared = false) {
    const { request, accept, held } = w;
    const baselines = Object.fromEntries(subset.map(r => [r, held.get(r) ?? null]));
    const { planned } = await planResults(baselines, { recover: request.recover !== false, consistent: w.consistent, store, context: w.context });
    const changed = everything ? planned : planned.filter(({ resource, plan }) => plan.status !== 304 && !(plan.status === 404 && held.get(resource) === null));
    if (!changed.length) return null;
    // An event's content is determined by the versions it connects and the options,
    // so one encoding serves every watcher that receives it.
    const asLink = !!w.eventLinks && shared;
    const key = JSON.stringify([changed.map(({ resource, plan }) => [resource, plan]), accept, asLink, !!w.linkOptions]);
    let data = events.get(key);
    if (data === undefined) {
      data = encodeJson(materializeAll(changed, { store, accept, links: w.eventLinks ? null : w.linkOptions })).toString('utf8');
      if (asLink && Buffer.byteLength(data) >= w.eventLinks.minBytes) {
        const href = w.eventLinks.shared.href(sharedPayload(changed, JSON_RESULT, { ...request, links: false, next: false }, accept, ''));
        if (href.length <= w.eventLinks.shared.maxUriLength) data = JSON.stringify({ href });
      }
      events.set(key, data);
      if (events.size > EVENT_MEMO_ENTRIES) events.delete(events.keys().next().value);
    }
    return { changed, data };
  }

  // Records what watcher `w` now holds and writes the event; `w` stays busy until
  // the event is written.
  function sendEvent(w, { changed, data }) {
    if (w.closed) return;
    for (const { resource, plan } of changed) w.held.set(resource, plan.status === 200 || plan.status === 304 ? plan.to : null);
    w.write(`event: sync\ndata: ${data}\n\n`).then(() => release(w));
  }

  function release(w) {
    w.busy = false;
    if (w.dirty.size && !w.closed) schedule();
  }

  // Store notifications. Reading starts after the current task, so changes made
  // together (even without an atomic commit) are read together.
  function onStoreChange(changedResources) {
    for (const w of watchers) for (const r of changedResources) if (w.watched.has(r)) w.dirty.add(r);
    schedule();
  }

  function schedule() {
    if (dispatchScheduled) return;
    dispatchScheduled = true;
    queueMicrotask(dispatch);
  }

  function dispatch() {
    dispatchScheduled = false;
    const groups = new Map();
    for (const w of watchers) {
      if (!w.dirty.size || w.busy || w.closed) continue;
      const key = w.groupKey();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(w);
    }
    for (const members of groups.values()) serveGroup(members);
  }

  async function serveGroup(members) {
    const lead = members[0];
    for (const m of members) m.busy = true;
    // A consistent event covers every requested resource at one instant; otherwise
    // only the resources reported as changed are read.
    const subset = lead.consistent ? lead.names : [...new Set(members.flatMap(m => [...m.dirty]))];
    for (const m of members) m.dirty.clear();
    let prepared;
    try {
      prepared = await prepare(lead, subset, false, members.length > 1);
    } catch (e) {
      console.error('SYNC store error:', e);
      for (const m of members) m.close();
      return;
    }
    for (const m of members) {
      if (prepared) sendEvent(m, prepared);
      else release(m);
    }
  }

  // GET or HEAD of a link (one update), a shared result, or a next URI.
  //   link:          [resource, from, to, format]          immutable
  //   shared result: { m, a, rc, l, c, x, q }               immutable
  //   next URI:      { m, a, rc, l, c, b }                  the current results from those baselines
  async function serveLink(req, res) {
    const id = pathOf(req).slice(lc.path.length + 1);
    const payload = lc.codec.decode(id);
    const headOnly = req.method === 'HEAD';
    const kind = !payload ? null : Array.isArray(payload) ? 'link' : Array.isArray(payload.q) ? 'shared' : Array.isArray(payload.b) ? 'next' : null;
    if (!kind) return send(res, problem(404, 'Unknown link'), '', {}, headOnly);

    const context = { method: req.method, target: req.originalUrl || req.url, headers: req.headers };
    let response;
    try {
      if (kind === 'link') response = await linkedUpdate(payload, context);
      else if (kind === 'shared') response = await sharedResults(payload, context);
      else response = await respond(requestOf(payload), resultTypeOf(payload), { store, context, links: lc });
    } catch (e) {
      console.error('SYNC store error:', e);
      return send(res, problem(500, 'Internal error'), '', {}, headOnly);
    }
    if (!response) return send(res, problem(404, 'This content is no longer available'), '', {}, headOnly);
    if (response.status >= 400) return send(res, response, '', {}, headOnly);

    // Links and shared results never change, so their identifier serves as their
    // entity tag. The results behind a next URI change with the server's state;
    // they are identified by the state they lead to, which their Sync-Next names.
    const tagged = kind === 'next' ? response.headers['Sync-Next'] : id;
    const etag = tagged && `"${crypto.createHash('sha256').update(tagged).digest('base64url').slice(0, 22)}"`;
    const cache = kind === 'next' ? cacheControl : lc.cacheControl;
    const headers = { ...response.headers, 'Cache-Control': cache };
    if (etag) headers.ETag = etag;
    // Compare with the representation this request selects: gzip-coded or not.
    const coded = (response.body?.length || 0) >= GZIP_MIN_BYTES;
    const selected = etag && (coded && acceptsGzip(req.headers['accept-encoding']) ? gzipTag(etag) : etag);
    if (selected && noneMatch(req.headers['if-none-match'], selected)) {
      // A 304 carries the fields a 200 would have (RFC 9110 Section 15.4.5).
      const notModified = { ETag: selected, 'Cache-Control': cache };
      if (coded) notModified.Vary = 'Accept-Encoding';
      if (headers['Sync-Next']) notModified['Sync-Next'] = headers['Sync-Next'];
      return send(res, { status: 304, headers: notModified, body: null }, '', {}, true);
    }
    send(res, { ...response, headers }, req.headers['accept-encoding'], {}, headOnly);
  }

  async function linkedUpdate(payload, context) {
    const content = await resolveLink(payload, { store, context });
    if (!content) return null;
    const body = content.patch ? Buffer.from(JSON.stringify(content.data)) : representationBytes(content);
    return { status: 200, headers: { 'Content-Type': content.type }, body };
  }

  async function sharedResults(payload, context) {
    const planned = plansOf(payload);
    const results = await resolvePlanned(planned, { store, context, accept: payload.a || undefined, links: payload.l ? lc : null });
    if (!results) return null;
    const response = resultResponse(results, resultTypeOf(payload), payload.c);
    const request = { recover: payload.rc, links: payload.l, consistent: payload.c !== '', next: payload.x };
    Object.assign(response.headers, nextField(planned, resultTypeOf(payload), request, payload.a || undefined, lc));
    return response;
  }
}

module.exports = { syncHandler, SYNC_TYPE };
