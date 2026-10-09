'use strict';

const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');

const quote = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// opts.headers: extra request headers; opts.gzip: false to disable compression.
// opts.accept: media types in preference order; opts.recover: false to get 409
// instead of a snapshot for unrecognized baselines; opts.useHeader: send the
// baselines in a Sync-Baseline header (small requests only) instead of the body.
function syncRequest(rawUrl, baselines, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const headers = { 'Accept': 'application/sync-result+json', ...opts.headers };
    if (opts.gzip !== false) headers['Accept-Encoding'] = 'gzip';
    let body = null;

    if (opts.useHeader) {
      headers['Sync-Baseline'] = Object.entries(baselines)
        .map(([r, t]) => (t === null || t === undefined ? `(${quote(r)})` : `(${quote(r)} ${quote(t)})`))
        .join(', ');
      if (opts.accept) headers['Sync-Accept'] = opts.accept.join(', ');
    } else {
      const payload = { baselines };
      if (opts.accept) payload.accept = opts.accept;
      if (opts.recover === false) payload.recover = false;
      body = JSON.stringify(payload);
      headers['Content-Type'] = 'application/sync-baseline+json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname,
      method: 'SYNC',
      agent: false,
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

module.exports = { syncRequest };
