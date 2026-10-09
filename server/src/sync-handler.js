'use strict';

const zlib = require('zlib');
const { computeResults, MAX_RESOURCES } = require('./sync-core');

const MAX_BODY_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;

const GZIP_MIN_BYTES = 1024;

function sendResponse(socket, status, statusText, extraHeaders, body, acceptEncoding) {
  let bodyBuf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const hdrs = {
    'Content-Type': 'application/sync-result+json',
    'Cache-Control': 'no-store',
    'Connection': 'close',
    ...extraHeaders,
  };

  if (bodyBuf.length >= GZIP_MIN_BYTES && /\bgzip\b/i.test(acceptEncoding || '')) {
    bodyBuf = zlib.gzipSync(bodyBuf);
    hdrs['Content-Encoding'] = 'gzip';
    hdrs['Vary'] = 'Accept-Encoding';
  }
  hdrs['Content-Length'] = bodyBuf.length;

  let head = `HTTP/1.1 ${status} ${statusText}\r\n`;
  for (const [k, v] of Object.entries(hdrs)) head += `${k}: ${v}\r\n`;
  head += '\r\n';

  socket.write(head);
  if (bodyBuf.length) socket.write(bodyBuf);
  socket.end();
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

function reject(socket, status, text, message) {
  sendResponse(socket, status, text, {}, { error: message });
}

function processSync(socket, bodyStr, headers = {}) {
  const headerValue = headers['sync-baseline'];
  let baselines;
  let accept;
  let recover = true;

  if (bodyStr && headerValue) {
    return reject(socket, 422, 'Unprocessable Entity', 'Send baselines in the body or in Sync-Baseline, not both');
  }

  if (!bodyStr && headerValue !== undefined) {
    baselines = parseBaselineHeader(headerValue);
    if (!baselines) return reject(socket, 422, 'Unprocessable Entity', 'Malformed Sync-Baseline header');
    if (headers['sync-accept']) accept = headers['sync-accept'].split(',').map(s => s.trim()).filter(Boolean);
  } else {
    let parsed;
    try {
      parsed = JSON.parse(bodyStr || '{}');
    } catch {
      return reject(socket, 422, 'Unprocessable Entity', 'Malformed JSON in request body');
    }
    baselines = parsed.baselines;
    accept = parsed.accept;
    if (parsed.recover !== undefined) recover = parsed.recover === true;

    if (accept !== undefined && (!Array.isArray(accept) || !accept.every(a => typeof a === 'string'))) {
      return reject(socket, 422, 'Unprocessable Entity', 'accept must be an array of media types');
    }
  }

  if (!baselines || typeof baselines !== 'object' || Array.isArray(baselines)) {
    return reject(socket, 422, 'Unprocessable Entity', 'Missing or invalid baselines');
  }
  if (!Object.values(baselines).every(t => t === null || typeof t === 'string')) {
    return reject(socket, 422, 'Unprocessable Entity', 'Each baseline must be a string token or null');
  }
  if (Object.keys(baselines).length > MAX_RESOURCES) {
    return reject(socket, 413, 'Content Too Large', `At most ${MAX_RESOURCES} resources per SYNC request`);
  }

  const { results, allUnchanged } = computeResults(baselines, { accept, recover });
  const extraHeaders = { 'Sync-Delta-Complete': 'true' };

  if (allUnchanged) return sendResponse(socket, 204, 'No Content', extraHeaders, null);
  sendResponse(socket, 200, 'OK', extraHeaders, { results, synced_at: new Date().toISOString() }, headers['accept-encoding']);
}

module.exports = { processSync, sendResponse, parseBaselineHeader, MAX_BODY_BYTES, MAX_HEADER_BYTES };
