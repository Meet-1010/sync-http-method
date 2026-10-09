'use strict';

const crypto = require('crypto');
const { resolveSync, finalize, problem, MAX_BODY_BYTES } = require('./sync-handler');
const { resolveLink } = require('./sync-core');
const { createLinkCodec } = require('./links');
const { representationBytes } = require('./formats');

const SYNC_TYPE = 'application/sync-baseline+json';
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

function linkConfig(links) {
  if (!links) return null;
  const { secret, path, minBytes = 1024, cacheControl = 'private, max-age=31536000, immutable' } = links;
  if (typeof path !== 'string' || !/^\/(?!\/)[\x21-\x7E]*$/.test(path) || path.endsWith('/')) {
    throw new Error('links.path must be an absolute path such as "/sync/updates"');
  }
  const codec = createLinkCodec(secret);
  return { codec, path, minBytes, cacheControl, href: payload => `${path}/${codec.encode(payload)}` };
}

// Serves SYNC requests carried by QUERY (RFC 10008) and, as a fallback for paths
// that block QUERY, by POST. Only requests whose Content-Type is
// application/sync-baseline+json are handled; everything else goes to next(),
// so other QUERY or POST uses of the same app are unaffected.
//
//   app.use(syncHandler({ store }))
//
// cacheControl: QUERY responses are cacheable (RFC 10008 Section 2.7). The default
// 'no-store' is safe for per-user data; use e.g. 'public, max-age=5' only when the
// results do not depend on who is asking.
//
// strict: on a path that is only a sync resource, answer QUERY requests with a
// missing or different Content-Type with 400 or 415 (RFC 10008 Section 2.1)
// instead of passing them on.
//
// links: { secret, path, minBytes, cacheControl }. When a client sends
// "links": true, updates of at least minBytes are returned as links under `path`
// instead of inline. Each link names one immutable update, so shared caches can
// keep it; GET on it is served here. cacheControl defaults to private; use
// 'public, max-age=31536000, immutable' only for data that is the same for everyone.
function syncHandler({ store, cacheControl = 'no-store', allowPost = true, strict = false, links } = {}) {
  const lc = linkConfig(links);

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
    if ((!isQuery && !isPost) || type !== SYNC_TYPE) return next();

    let response;
    try {
      const body = await readBody(req);
      response = body.tooLarge
        ? problem(413, `Content exceeds ${MAX_BODY_BYTES} bytes`)
        : await resolveSync(body.text, req.headers, {
          store,
          links: lc,
          context: { method: req.method, target: req.originalUrl || req.url, headers: req.headers },
        });
    } catch (e) {
      console.error('SYNC store error:', e);
      response = problem(500, 'Internal error');
    }
    const extra = { 'Accept-Query': ACCEPT_QUERY };
    if (response.status === 200 || response.status === 204) extra['Cache-Control'] = cacheControl;
    send(res, response, req.headers['accept-encoding'], extra);
  };

  async function serveLink(req, res) {
    const id = pathOf(req).slice(lc.path.length + 1);
    const payload = lc.codec.decode(id);
    const headOnly = req.method === 'HEAD';
    if (!payload) return send(res, problem(404, 'Unknown link'), '', {}, headOnly);

    let content;
    try {
      content = await resolveLink(payload, { store, context: { method: req.method, target: req.originalUrl || req.url, headers: req.headers } });
    } catch (e) {
      console.error('SYNC store error:', e);
      return send(res, problem(500, 'Internal error'), '', {}, headOnly);
    }
    if (!content) return send(res, problem(404, 'This update is no longer available'), '', {}, headOnly);

    const etag = `"${crypto.createHash('sha256').update(id).digest('base64url').slice(0, 22)}"`;
    const headers = { ETag: etag, 'Cache-Control': lc.cacheControl };
    const inm = req.headers['if-none-match'];
    if (inm && (inm.trim() === '*' || inm.split(',').map(s => s.trim()).includes(etag))) {
      return send(res, { status: 304, headers, body: null }, '', {}, true);
    }
    const body = content.patch ? Buffer.from(JSON.stringify(content.data)) : representationBytes(content);
    send(res, { status: 200, headers: { ...headers, 'Content-Type': content.type }, body }, req.headers['accept-encoding'], {}, headOnly);
  }
}

module.exports = { syncHandler, SYNC_TYPE };
