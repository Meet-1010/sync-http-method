'use strict';

const zlib = require('zlib');
const { computeResults, MAX_RESOURCES } = require('./sync-core');

const MAX_BODY_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;

const GZIP_MIN_BYTES = 1024;

// Shared by the raw-socket writer and the Express middleware.
function encodeResponse(body, acceptEncoding, extraHeaders = {}) {
  let buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const headers = {
    'Content-Type': 'application/sync-result+json',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };
  if (buf.length >= GZIP_MIN_BYTES && /\bgzip\b/i.test(acceptEncoding || '')) {
    buf = zlib.gzipSync(buf);
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  return { buf, headers };
}

function sendResponse(socket, status, statusText, extraHeaders, body, acceptEncoding, keepAlive = false) {
  const { buf, headers } = encodeResponse(body, acceptEncoding, extraHeaders);
  headers['Connection'] = keepAlive ? 'keep-alive' : 'close';

  let head = `HTTP/1.1 ${status} ${statusText}\r\n`;
  for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
  head += '\r\n';

  socket.write(head);
  if (buf.length) socket.write(buf);
  if (!keepAlive) socket.end();
}

// Parses an RFC 8941 List of Inner Lists of Strings:
//   ("/users" "v42"), ("/posts")      (one item = no baseline yet)
function parseBaselineHeader(value) {
  const out = Object.create(null);
  let i = 0;
  const skipWs = () => { while (value[i] === ' ' || value[i] === '\t') i++; };
  const readString = () => {
    if (value[i] !== '"') return undefined;
    i++;
    let s = '';
    while (i < value.length) {
      const c = value[i++];
      if (c === '\\') {
        const n = value[i++];
        if (n !== '"' && n !== '\\') return undefined;
        s += n;
      } else if (c === '"') {
        return s;
      } else {
        s += c;
      }
    }
    return undefined;
  };

  skipWs();
  while (i < value.length) {
    if (value[i++] !== '(') return null;
    skipWs();
    const key = readString();
    if (key === undefined) return null;
    skipWs();
    let token = null;
    if (value[i] === '"') {
      token = readString();
      if (token === undefined) return null;
      skipWs();
    }
    if (value[i++] !== ')') return null;
    out[key] = token;
    skipWs();
    if (i < value.length) {
      if (value[i++] !== ',') return null;
      skipWs();
      if (i >= value.length) return null;
    }
  }
  return Object.keys(out).length ? out : null;
}

const STATUS_TEXT = { 200: 'OK', 204: 'No Content', 413: 'Content Too Large', 422: 'Unprocessable Entity' };

// Pure protocol step: request body + headers in, a response description out.
async function resolveSync(bodyStr, headers = {}, store) {
  const fail = (status, message) => ({ status, extraHeaders: {}, body: { error: message } });
  const headerValue = headers['sync-baseline'];
  let baselines;
  let accept;
  let recover = true;

  if (bodyStr && headerValue) {
    return fail(422, 'Send baselines in the body or in Sync-Baseline, not both');
  }

  if (!bodyStr && headerValue !== undefined) {
    baselines = parseBaselineHeader(headerValue);
    if (!baselines) return fail(422, 'Malformed Sync-Baseline header');
    if (headers['sync-accept']) accept = headers['sync-accept'].split(',').map(s => s.trim()).filter(Boolean);
  } else {
    let parsed;
    try {
      parsed = JSON.parse(bodyStr || '{}');
    } catch {
      return fail(422, 'Malformed JSON in request body');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail(422, 'Request body must be a JSON object');
    }
    baselines = parsed.baselines;
    accept = parsed.accept;
    if (parsed.recover !== undefined) recover = parsed.recover === true;

    if (accept !== undefined && (!Array.isArray(accept) || !accept.every(a => typeof a === 'string'))) {
      return fail(422, 'accept must be an array of media types');
    }
  }

  if (!baselines || typeof baselines !== 'object' || Array.isArray(baselines)) {
    return fail(422, 'Missing or invalid baselines');
  }
  if (!Object.values(baselines).every(t => t === null || typeof t === 'string')) {
    return fail(422, 'Each baseline must be a string token or null');
  }
  if (Object.keys(baselines).length > MAX_RESOURCES) {
    return fail(413, `At most ${MAX_RESOURCES} resources per SYNC request`);
  }

  const { results, allUnchanged } = await computeResults(baselines, { accept, recover, store });
  const extraHeaders = { 'Sync-Delta-Complete': 'true' };
  if (allUnchanged) return { status: 204, extraHeaders, body: null };
  return { status: 200, extraHeaders, body: { results, synced_at: new Date().toISOString() } };
}

async function processSync(socket, bodyStr, headers = {}, keepAlive = false, store) {
  let r;
  try {
    r = await resolveSync(bodyStr, headers, store);
  } catch (err) {
    console.error('SYNC store error:', err);
    return sendResponse(socket, 500, 'Internal Server Error', {}, { error: 'Internal error' }, '', false);
  }
  sendResponse(socket, r.status, STATUS_TEXT[r.status], r.extraHeaders, r.body, headers['accept-encoding'], keepAlive);
}

module.exports = {
  processSync, resolveSync, encodeResponse, sendResponse, parseBaselineHeader,
  MAX_BODY_BYTES, MAX_HEADER_BYTES,
};
