'use strict';

const express = require('express');
const { resolveSync, encodeResponse, MAX_BODY_BYTES } = require('./sync-handler');

const SYNC_TYPE = 'application/sync-baseline+json';
const readBody = express.text({ type: SYNC_TYPE, limit: MAX_BODY_BYTES });

// Serves the POST form of SYNC (Content-Type: application/sync-baseline+json).
// Works on any Express app, behind any proxy or CDN, with no custom-method support.
//   app.use(syncOverPost({ store }))   // store: see sync-core.js
function syncOverPost({ store } = {}) {
  return (req, res, next) => {
    if (req.method !== 'POST' || !req.is(SYNC_TYPE)) return next();

    readBody(req, res, async err => {
      let r;
      if (err) {
        r = err.type === 'entity.too.large'
          ? { status: 413, extraHeaders: {}, body: { error: `Body exceeds ${MAX_BODY_BYTES} bytes` } }
          : { status: 422, extraHeaders: {}, body: { error: 'Unreadable request body' } };
      } else {
        try {
          r = await resolveSync(typeof req.body === 'string' ? req.body : '', req.headers, store);
        } catch (e) {
          console.error('SYNC store error:', e);
          r = { status: 500, extraHeaders: {}, body: { error: 'Internal error' } };
        }
      }
      const { buf, headers } = encodeResponse(r.body, req.headers['accept-encoding'], r.extraHeaders);
      res.status(r.status).set(headers).end(buf);
    });
  };
}

module.exports = { syncOverPost, SYNC_TYPE };
