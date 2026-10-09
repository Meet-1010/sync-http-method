'use strict';

const { resolveSync, encodeResponse, MAX_BODY_BYTES } = require('./sync-handler');

const SYNC_TYPE = 'application/sync-baseline+json';

const isSyncType = req => (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === SYNC_TYPE;

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

// Serves the POST form of SYNC (Content-Type: application/sync-baseline+json).
// Works as Express/Connect middleware or around a plain Node request handler,
// behind any proxy or CDN, with no custom-method support.
//   app.use(syncOverPost({ store }))   // store: see sync-core.js
function syncOverPost({ store } = {}) {
  return async (req, res, next) => {
    if (req.method !== 'POST' || !isSyncType(req)) return next();

    let r;
    try {
      const body = await readBody(req);
      r = body.tooLarge
        ? { status: 413, extraHeaders: {}, body: { error: `Body exceeds ${MAX_BODY_BYTES} bytes` } }
        : await resolveSync(body.text, req.headers, store);
    } catch (e) {
      console.error('SYNC store error:', e);
      r = { status: 500, extraHeaders: {}, body: { error: 'Internal error' } };
    }

    const { buf, headers } = encodeResponse(r.body, req.headers['accept-encoding'], r.extraHeaders);
    res.statusCode = r.status;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(buf);
  };
}

module.exports = { syncOverPost, SYNC_TYPE };
