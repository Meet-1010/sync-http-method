'use strict';

const zlib = require('zlib');
const { computeResults, MAX_RESOURCES } = require('./sync-core');
const { isVersion } = require('./versions');
const { negotiate, encodeJson, encodeMultipart, JSON_RESULT } = require('./encode');

const MAX_BODY_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const GZIP_MIN_BYTES = 1024;

const STATUS_TEXT = {
  200: 'OK', 204: 'No Content', 304: 'Not Modified', 400: 'Bad Request', 404: 'Not Found', 406: 'Not Acceptable',
  411: 'Length Required', 413: 'Content Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Content',
  431: 'Request Header Fields Too Large', 500: 'Internal Server Error',
};

// Resource names are absolute-path references (RFC 3986 Section 4.2) on the target's
// origin, optionally with a query: "/" not followed by "/", then path and query
// characters (unreserved, sub-delims, ":", "@", "/", "?", or percent-encoded octets).
const isResourceName = k => /^\/(?!\/)(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*$/.test(k);
const isPrintableVersion = v => (typeof v === 'string' ? [v] : v).every(id => /^[\x20-\x7E]+$/.test(id));

// RFC 9457 problem details.
const problem = (status, detail) => ({
  status,
  headers: { 'Content-Type': 'application/problem+json' },
  body: Buffer.from(JSON.stringify({ title: STATUS_TEXT[status], status, detail })),
});

// Parses a Structured Fields (RFC 9651) List of Inner Lists of Strings:
//   ("/users" "v42"), ("/posts")      (one item = no baseline yet)
// Used only by the experimental SYNC method.
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

// Pure protocol step: request content + headers in, a complete response out
// ({ status, headers, body }), before content coding.
// Status codes follow RFC 10008 Section 2.1: content that is not valid JSON is 400,
// valid JSON that does not describe a valid request is 422.
async function resolveSync(bodyStr, headers = {}, { store, context, links } = {}) {
  const headerValue = headers['sync-baseline'];
  let request;

  if (bodyStr && headerValue) return problem(422, 'Send baselines in the content or in Sync-Baseline, not both');

  if (!bodyStr && headerValue !== undefined) {
    const baselines = parseBaselineHeader(headerValue);
    if (!baselines) return problem(422, 'Malformed Sync-Baseline header');
    request = { baselines };
    if (headers['sync-accept']) request.accept = headers['sync-accept'].split(',').map(s => s.trim()).filter(Boolean);
  } else {
    try {
      request = JSON.parse(bodyStr || '{}');
    } catch {
      return problem(400, 'Request content is not valid JSON');
    }
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      return problem(422, 'Request content must be a JSON object');
    }
  }

  const { baselines, accept } = request;
  if (!baselines || typeof baselines !== 'object' || Array.isArray(baselines)) return problem(422, 'Missing or invalid baselines');
  const names = Object.keys(baselines);
  if (!names.every(isResourceName)) return problem(422, 'Resource names must be absolute paths on this origin, such as "/users"');
  if (!Object.values(baselines).every(b => b === null || (isVersion(b) && isPrintableVersion(b)))) {
    return problem(422, 'Each baseline must be null, a version identifier, or an array of distinct version identifiers (printable ASCII)');
  }
  if (names.length > MAX_RESOURCES) return problem(413, `At most ${MAX_RESOURCES} resources per request`);
  if (accept !== undefined && (!Array.isArray(accept) || !accept.every(a => typeof a === 'string'))) {
    return problem(422, 'accept must be an array of media types');
  }
  for (const flag of ['recover', 'consistent', 'links']) {
    if (request[flag] !== undefined && typeof request[flag] !== 'boolean') return problem(422, `${flag} must be a boolean`);
  }

  const resultType = negotiate(headers.accept);
  if (!resultType) return problem(406, 'Acceptable result formats: application/sync-result+json, multipart/mixed');

  const { results, allUnchanged, consistent } = await computeResults(baselines, {
    accept: accept && accept.map(a => a.toLowerCase()),
    recover: request.recover !== false,
    consistent: request.consistent === true,
    links: request.links === true && links ? links : null,
    store,
    context,
  });

  const out = { 'Sync-Delta-Complete': '?1', Vary: 'Accept' };
  if (request.consistent === true) out['Sync-Consistent'] = consistent ? '?1' : '?0';
  if (allUnchanged) return { status: 204, headers: out, body: null };

  if (resultType === JSON_RESULT) {
    return { status: 200, headers: { ...out, 'Content-Type': JSON_RESULT }, body: encodeJson(results) };
  }
  const { body, contentType } = encodeMultipart(results);
  return { status: 200, headers: { ...out, 'Content-Type': contentType }, body };
}

// Applies content coding and framing headers.
function finalize(response, acceptEncoding) {
  const headers = { ...response.headers };
  let body = response.body || Buffer.alloc(0);
  if (body.length >= GZIP_MIN_BYTES && /\bgzip\b/i.test(acceptEncoding || '')) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = headers.Vary ? `${headers.Vary}, Accept-Encoding` : 'Accept-Encoding';
  }
  headers['Content-Length'] = body.length;
  return { status: response.status, headers, body };
}

function writeRaw(socket, response, keepAlive) {
  let head = `HTTP/1.1 ${response.status} ${STATUS_TEXT[response.status] || ''}\r\n`;
  for (const [k, v] of Object.entries({ ...response.headers, Connection: keepAlive ? 'keep-alive' : 'close' })) head += `${k}: ${v}\r\n`;
  socket.write(`${head}\r\n`);
  if (response.body.length) socket.write(response.body);
  if (!keepAlive) socket.end();
}

// Raw-socket writer used by the experimental SYNC method front.
function sendProblem(socket, status, detail) {
  writeRaw(socket, finalize(problem(status, detail), ''), false);
}

async function processSync(socket, bodyStr, headers = {}, keepAlive = false, store, target = '/') {
  let response;
  try {
    response = await resolveSync(bodyStr, headers, { store, context: { method: 'SYNC', target, headers } });
  } catch (err) {
    console.error('SYNC store error:', err);
    return sendProblem(socket, 500, 'Internal error');
  }
  if (response.status === 200 || response.status === 204) response.headers['Cache-Control'] = 'no-store';
  writeRaw(socket, finalize(response, headers['accept-encoding']), keepAlive);
}

module.exports = {
  processSync, resolveSync, finalize, problem, sendProblem, parseBaselineHeader, isResourceName,
  MAX_BODY_BYTES, MAX_HEADER_BYTES, STATUS_TEXT,
};
