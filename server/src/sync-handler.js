'use strict';

const zlib = require('zlib');
const { planResults, materializeAll, MAX_RESOURCES } = require('./sync-core');
const { isVersion } = require('./versions');
const { negotiate, encodeJson, encodeMultipart, sfString, JSON_RESULT, MULTIPART } = require('./encode');

const MAX_BODY_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const GZIP_MIN_BYTES = 1024;

const STATUS_TEXT = {
  200: 'OK', 204: 'No Content', 303: 'See Other', 304: 'Not Modified', 400: 'Bad Request', 404: 'Not Found', 406: 'Not Acceptable',
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

// Encodes results in the negotiated format, with the fields every result response carries.
function resultResponse(results, resultType, consistentField) {
  const headers = { 'Sync-Delta-Complete': '?1' };
  if (consistentField) headers['Sync-Consistent'] = consistentField;
  if (resultType === JSON_RESULT) return { status: 200, headers: { ...headers, 'Content-Type': JSON_RESULT }, body: encodeJson(results) };
  const { body, contentType } = encodeMultipart(results);
  return { status: 200, headers: { ...headers, 'Content-Type': contentType }, body };
}

// A shared result document: everything needed to rebuild the response from the
// versions alone. m: result format; a: accept list; rc: recover; l: links allowed;
// c: Sync-Consistent value ('' when not requested); x: a next URI was requested;
// q: [resource, status, from, to, baseline] per resource.
function sharedPayload(planned, resultType, request, accept, consistentField) {
  return {
    m: resultType === JSON_RESULT ? 'j' : 'm',
    a: accept || null,
    rc: request.recover !== false,
    l: request.links === true,
    c: consistentField,
    x: request.next === true,
    q: planned.map(({ resource, plan }) => [resource, plan.status, plan.from ?? null, plan.to ?? null, plan.baseline ?? null]),
  };
}

const plansOf = payload => payload.q.map(([resource, status, from, to, baseline]) => {
  const plan = { status };
  if (status === 200 || status === 304) plan.to = to;
  if (status === 200) plan.from = from;
  if (baseline) plan.baseline = baseline;
  return { resource, plan };
});
const resultTypeOf = payload => (payload.m === 'j' ? JSON_RESULT : MULTIPART);

// A next URI: the same request, from the versions the results lead to. A client
// that applied every result holds exactly those versions (null for 404 and 409).
// b: [resource, baseline] per resource; m, a, rc, l as above; c: consistent requested.
function nextPayload(planned, resultType, request, accept) {
  return {
    m: resultType === JSON_RESULT ? 'j' : 'm',
    a: accept || null,
    rc: request.recover !== false,
    l: request.links === true,
    c: request.consistent === true,
    b: planned.map(({ resource, plan }) => [resource, plan.status === 200 || plan.status === 304 ? plan.to : null]),
  };
}

// The request a next URI stands for.
const requestOf = payload => ({
  baselines: Object.fromEntries(payload.b),
  accept: payload.a || undefined,
  recover: payload.rc,
  consistent: payload.c,
  links: payload.l,
  next: true,
});

// The Sync-Next field for these results, or nothing when the URI would be too long.
function nextField(planned, resultType, request, accept, links) {
  if (request.next !== true || !links?.next) return {};
  const uri = links.next.href(nextPayload(planned, resultType, request, accept));
  return uri.length <= links.next.maxUriLength ? { 'Sync-Next': sfString(uri) } : {};
}

// Validates request content (or the experimental Sync-Baseline header) and returns
// { request } or { error } (a problem response).
function parseRequest(bodyStr, headers) {
  const headerValue = headers['sync-baseline'];
  let request;

  if (bodyStr && headerValue) return { error: problem(422, 'Send baselines in the content or in Sync-Baseline, not both') };

  if (!bodyStr && headerValue !== undefined) {
    const baselines = parseBaselineHeader(headerValue);
    if (!baselines) return { error: problem(422, 'Malformed Sync-Baseline header') };
    request = { baselines };
    if (headers['sync-accept']) request.accept = headers['sync-accept'].split(',').map(s => s.trim()).filter(Boolean);
  } else {
    try {
      request = JSON.parse(bodyStr || '{}');
    } catch {
      return { error: problem(400, 'Request content is not valid JSON') };
    }
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      return { error: problem(422, 'Request content must be a JSON object') };
    }
  }

  const { baselines, accept } = request;
  if (!baselines || typeof baselines !== 'object' || Array.isArray(baselines)) return { error: problem(422, 'Missing or invalid baselines') };
  const names = Object.keys(baselines);
  if (!names.every(isResourceName)) return { error: problem(422, 'Resource names must be absolute paths on this origin, such as "/users"') };
  if (!Object.values(baselines).every(b => b === null || (isVersion(b) && isPrintableVersion(b)))) {
    return { error: problem(422, 'Each baseline must be null, a version identifier, or an array of distinct version identifiers (printable ASCII)') };
  }
  if (names.length > MAX_RESOURCES) return { error: problem(413, `At most ${MAX_RESOURCES} resources per request`) };
  if (accept !== undefined && (!Array.isArray(accept) || !accept.every(a => typeof a === 'string'))) {
    return { error: problem(422, 'accept must be an array of media types') };
  }
  for (const flag of ['recover', 'consistent', 'links', 'redirect', 'next', 'watch']) {
    if (request[flag] !== undefined && typeof request[flag] !== 'boolean') return { error: problem(422, `${flag} must be a boolean`) };
  }
  return { request };
}

// The response to a valid request, in the given result format.
// links: { href, minBytes, shared: { href, maxUriLength } | null, next: { href,
// maxUriLength } | null } enables links, 303 (See Other) to a shared result when the
// client allows it with "redirect": true (RFC 10008 Section 2.5), and next URIs
// when the client asks for them with "next": true.
async function respond(request, resultType, { store, context, links }) {
  const accept = request.accept && request.accept.map(a => a.toLowerCase());
  const { planned, allUnchanged, consistent } = await planResults(request.baselines, {
    recover: request.recover !== false,
    consistent: request.consistent === true,
    store,
    context,
  });
  const consistentField = request.consistent === true ? (consistent ? '?1' : '?0') : '';
  const next = nextField(planned, resultType, request, accept, links);

  if (allUnchanged) {
    const out = { 'Sync-Delta-Complete': '?1', ...next };
    if (consistentField) out['Sync-Consistent'] = consistentField;
    return { status: 204, headers: out, body: null };
  }

  // The results as a resource of their own, which every client sending the same
  // request against the same state is redirected to, and shared caches can store.
  if (request.redirect === true && links?.shared) {
    const location = links.shared.href(sharedPayload(planned, resultType, request, accept, consistentField));
    if (location.length <= links.shared.maxUriLength) return { status: 303, headers: { Location: location }, body: null };
  }

  const results = materializeAll(planned, { store, accept, links: request.links === true && links ? links : null });
  const response = resultResponse(results, resultType, consistentField);
  Object.assign(response.headers, next);
  return response;
}

// Pure protocol step: request content + headers in, a complete response out
// ({ status, headers, body }), before content coding.
// Status codes follow RFC 10008 Section 2.1: content that is not valid JSON is 400,
// valid JSON that does not describe a valid request is 422.
async function resolveSync(bodyStr, headers = {}, options = {}) {
  const { request, error } = parseRequest(bodyStr, headers);
  if (error) return error;
  return resolveRequest(request, headers, options);
}

// The response to a parsed request: result format negotiation, then respond().
async function resolveRequest(request, headers, { store, context, links } = {}) {
  const resultType = negotiate(headers.accept);
  if (!resultType) return problem(406, 'Acceptable result formats: application/sync-result+json, multipart/mixed');
  const response = await respond(request, resultType, { store, context, links });
  if (response.status < 400) response.headers.Vary = 'Accept';
  return response;
}

// Whether a client accepts gzip (RFC 9110 Section 12.5.3; "gzip;q=0" refuses it).
function acceptsGzip(acceptEncoding) {
  for (const range of String(acceptEncoding || '').split(',')) {
    const [coding, ...params] = range.split(';').map(s => s.trim().toLowerCase());
    if (coding !== 'gzip' && coding !== 'x-gzip') continue;
    const q = params.map(p => /^q=([0-9.]+)$/.exec(p)).find(Boolean);
    return !q || Number(q[1]) > 0;
  }
  return false;
}

// The entity tag of the gzip-coded form of a representation: a different
// representation, so a different strong validator (RFC 9110 Section 8.8.3).
const gzipTag = etag => etag.replace(/"$/, '-gzip"');

// Applies content coding and framing headers. Responses whose coding depends on
// Accept-Encoding say so in Vary, whether or not this one was compressed.
function finalize(response, acceptEncoding) {
  const headers = { ...response.headers };
  let body = response.body || Buffer.alloc(0);
  const compressible = body.length >= GZIP_MIN_BYTES;
  if (compressible) headers.Vary = headers.Vary ? `${headers.Vary}, Accept-Encoding` : 'Accept-Encoding';
  if (compressible && acceptsGzip(acceptEncoding)) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
    if (headers.ETag) headers.ETag = gzipTag(headers.ETag);
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
  processSync, resolveSync, resolveRequest, parseRequest, respond, resultResponse, plansOf, resultTypeOf, requestOf, nextField, nextPayload, sharedPayload, finalize, gzipTag, acceptsGzip, problem, sendProblem, parseBaselineHeader, isResourceName,
  MAX_BODY_BYTES, MAX_HEADER_BYTES, GZIP_MIN_BYTES, STATUS_TEXT,
};
