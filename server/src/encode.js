'use strict';

const crypto = require('crypto');
const { isJsonType, isTextType, representationBytes } = require('./formats');

const JSON_RESULT = 'application/sync-result+json';
const MULTIPART = 'multipart/mixed';

// ── Accept negotiation (RFC 9110 Section 12.5.1) ──────────────────────────────

function parseAccept(header) {
  return String(header || '').split(',').map(s => s.trim()).filter(Boolean).map(range => {
    const [type, ...params] = range.split(';').map(p => p.trim());
    let q = 1;
    for (const p of params) {
      const m = /^q=([0-9.]+)$/i.exec(p);
      if (m) q = Math.max(0, Math.min(1, Number(m[1])));
    }
    return { type: type.toLowerCase(), q };
  });
}

// The q-value of the most specific range matching `type` (exact, then type/*, then */*).
function qualityFor(ranges, type) {
  const [major] = type.split('/');
  for (const candidate of [type, `${major}/*`, '*/*']) {
    const hit = ranges.filter(r => r.type === candidate);
    if (hit.length) return Math.max(...hit.map(r => r.q));
  }
  return 0;
}

// Returns JSON_RESULT, MULTIPART, or null when neither is acceptable.
function negotiate(acceptHeader) {
  if (!acceptHeader) return JSON_RESULT;
  const ranges = parseAccept(acceptHeader);
  const qJson = qualityFor(ranges, JSON_RESULT);
  const qMultipart = qualityFor(ranges, MULTIPART);
  if (qJson === 0 && qMultipart === 0) return null;
  return qMultipart > qJson ? MULTIPART : JSON_RESULT;
}

// ── Structured Field serialization (RFC 9651) ─────────────────────────────────

const PRINTABLE = /^[\x20-\x7E]*$/;
function sfString(s) {
  if (!PRINTABLE.test(s)) throw new Error('Structured Field strings must be printable ASCII');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
const sfVersion = v => (typeof v === 'string' ? [v] : v).map(sfString).join(', ');

// ── JSON result format ────────────────────────────────────────────────────────

function wireResult(r) {
  if (r.status !== 200) return r.status === 304 ? { status: 304, to: r.to } : { status: r.status };
  const out = { status: 200, from: r.from, to: r.to };
  if (r.format) out.format = r.format;
  else out.type = r.type;
  if (r.href) out.href = r.href;
  else if (r.patch !== undefined) out.data = r.patch;
  else if (isJsonType(r.type)) out.data = r.full.data;
  else if (isTextType(r.type)) out.data = representationBytes({ type: r.type, data: r.full.data }).toString('utf8');
  else { out.encoding = 'base64'; out.data = representationBytes({ type: r.type, data: r.full.data }).toString('base64'); }
  if (r.baseline) out.baseline = r.baseline;
  return out;
}

function encodeJson(results) {
  const wire = {};
  for (const [resource, r] of Object.entries(results)) wire[resource] = wireResult(r);
  return Buffer.from(JSON.stringify({ results: wire }));
}

// ── Multipart result format ───────────────────────────────────────────────────
// One part per resource. Part header fields:
//   Sync-Resource  sf-string   the resource name (always)
//   Sync-Status    sf-integer  200, 304, 404, 409 (always)
//   Version        sf-list     the version after the update (200, 304)
//   Parents        sf-list     the baseline a patch applies to (patches only)
//   Content-Type               the patch format, or the representation's media type
//   Sync-Href      sf-string   where to GET the content, when it is not inline
//   Sync-Baseline  sf-token    "unrecognized" when the baseline was not recognized

function partFor(resource, r) {
  const headers = [`Sync-Resource: ${sfString(resource)}`, `Sync-Status: ${r.status}`];
  let body = Buffer.alloc(0);
  if (r.status === 304) headers.push(`Version: ${sfVersion(r.to)}`);
  if (r.status === 200) {
    headers.push(`Version: ${sfVersion(r.to)}`);
    if (r.from !== null) headers.push(`Parents: ${sfVersion(r.from)}`);
    headers.push(`Content-Type: ${r.format || r.type}`);
    if (r.baseline) headers.push(`Sync-Baseline: ${r.baseline}`);
    if (r.href) headers.push(`Sync-Href: ${sfString(r.href)}`);
    else if (r.patch !== undefined) body = Buffer.from(JSON.stringify(r.patch));
    else body = representationBytes({ type: r.type, data: r.full.data });
  }
  return { head: headers.join('\r\n'), body };
}

function encodeMultipart(results) {
  const parts = Object.entries(results).map(([resource, r]) => partFor(resource, r));
  let boundary;
  do {
    boundary = `sync-${crypto.randomBytes(12).toString('base64url')}`;
  } while (parts.some(p => p.body.includes(boundary)));
  const chunks = [];
  for (const p of parts) chunks.push(Buffer.from(`--${boundary}\r\n${p.head}\r\n\r\n`), p.body, Buffer.from('\r\n'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `${MULTIPART}; boundary="${boundary}"` };
}

module.exports = { JSON_RESULT, MULTIPART, negotiate, encodeJson, encodeMultipart, sfString, parseAccept };
