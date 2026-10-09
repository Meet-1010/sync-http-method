'use strict';

const { resolveSync, encodeResponse, MAX_BODY_BYTES } = require('./sync-handler');

const SYNC_TYPE = 'application/sync-baseline+json';
const ACCEPT_QUERY = `"${SYNC_TYPE}"`;

const mediaType = req => (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

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

// Serves SYNC requests carried by QUERY (RFC 10008) and, as a fallback for paths
// that block QUERY, by POST. Only requests whose Content-Type is
// application/sync-baseline+json are handled; everything else goes to next(),
// so other QUERY or POST uses of the same app are unaffected.
//
//   app.use('/sync', syncHandler({ store }))
//
// cacheControl: QUERY responses are cacheable (RFC 10008 Section 2.7). The default
// 'no-store' is safe for per-user data; use e.g. 'public, max-age=5' only when the
// results do not depend on who is asking.
//
// strict: mount the handler on a path that is only a sync resource, and QUERY requests
// with a missing or different Content-Type are answered 400 or 415 (RFC 10008 Section 2.1)
// instead of being passed on.
function syncHandler({ store, cacheControl = 'no-store', allowPost = true, strict = false } = {}) {
  return async (req, res, next) => {
    const isQuery = req.method === 'QUERY';
    const isPost = req.method === 'POST' && allowPost;
    const type = mediaType(req);
    if (strict && isQuery && type !== SYNC_TYPE) {
      req.resume();
      res.statusCode = type ? 415 : 400;
      res.setHeader('Accept-Query', ACCEPT_QUERY);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: type ? `Unsupported query format ${type}` : 'Missing Content-Type' }));
    }
    if ((!isQuery && !isPost) || type !== SYNC_TYPE) return next();

    let r;
    try {
      const body = await readBody(req);
      r = body.tooLarge
        ? { status: 413, extraHeaders: {}, body: { error: `Body exceeds ${MAX_BODY_BYTES} bytes` } }
        : await resolveSync(body.text, req.headers, {
          store,
          context: { method: req.method, target: req.originalUrl || req.url, headers: req.headers },
        });
    } catch (e) {
      console.error('SYNC store error:', e);
      r = { status: 500, extraHeaders: {}, body: { error: 'Internal error' } };
    }

    const extra = { ...r.extraHeaders, 'Accept-Query': ACCEPT_QUERY };
    if (r.status === 200 || r.status === 204) extra['Cache-Control'] = cacheControl;
    const { buf, headers } = encodeResponse(r.body, req.headers['accept-encoding'], extra);
    res.statusCode = r.status;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(buf);
  };
}

module.exports = { syncHandler, SYNC_TYPE };
