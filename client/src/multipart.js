'use strict';

const { decodeRepresentation, utf8Decode } = require('../../shared/media');

// Parses the multipart/mixed SYNC result format into the same result objects as
// the JSON format. Browser-safe.

function boundaryOf(contentType) {
  const m = /;\s*boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType || '');
  if (!m) throw new Error('multipart response without boundary');
  return m[1] || m[2];
}

function indexOf(haystack, needle, from = 0) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// RFC 9651 sf-string and lists of sf-strings, as used in part header fields.
function parseSfStrings(value) {
  const out = [];
  let i = 0;
  const ws = () => { while (value[i] === ' ' || value[i] === '\t') i++; };
  ws();
  while (i < value.length) {
    if (value[i++] !== '"') throw new Error('Expected a string');
    let s = '';
    for (;;) {
      if (i >= value.length) throw new Error('Unterminated string');
      const c = value[i++];
      if (c === '\\') {
        const n = value[i++];
        if (n !== '"' && n !== '\\') throw new Error('Invalid escape');
        s += n;
      } else if (c === '"') break;
      else s += c;
    }
    out.push(s);
    ws();
    if (i < value.length) {
      if (value[i++] !== ',') throw new Error('Expected ","');
      ws();
    }
  }
  return out;
}

const versionFrom = list => (list.length === 1 ? list[0] : [...list].sort());

function parseParts(bytes, boundary) {
  const enc = new TextEncoder();
  const delimiter = enc.encode(`--${boundary}`);
  const parts = [];
  let pos = indexOf(bytes, delimiter);
  if (pos < 0) throw new Error('multipart delimiter not found');
  for (;;) {
    pos += delimiter.length;
    if (bytes[pos] === 0x2d && bytes[pos + 1] === 0x2d) break; // closing delimiter
    if (bytes[pos] !== 0x0d || bytes[pos + 1] !== 0x0a) throw new Error('Malformed multipart delimiter line');
    pos += 2;
    const headerEnd = indexOf(bytes, enc.encode('\r\n\r\n'), pos);
    if (headerEnd < 0) throw new Error('Malformed part headers');
    const headers = {};
    for (const line of utf8Decode(bytes.subarray(pos, headerEnd)).split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const next = indexOf(bytes, enc.encode(`\r\n--${boundary}`), headerEnd + 4);
    if (next < 0) throw new Error('Unterminated part');
    parts.push({ headers, body: bytes.subarray(headerEnd + 4, next) });
    pos = next + 2;
  }
  return parts;
}

function resultOf(part) {
  const h = part.headers;
  const status = Number(h['sync-status']);
  if (![200, 304, 404, 409].includes(status)) throw new Error(`Unexpected part status ${h['sync-status']}`);
  if (status === 404 || status === 409) return { status };
  const to = versionFrom(parseSfStrings(h.version || ''));
  if (status === 304) return { status, to };

  const from = h.parents ? versionFrom(parseSfStrings(h.parents)) : null;
  const contentType = h['content-type'];
  const out = { status, from, to };
  if (h['sync-baseline']) out.baseline = h['sync-baseline'];
  if (from === null) out.type = contentType;
  else out.format = contentType;
  if (h['sync-href']) out.href = parseSfStrings(h['sync-href'])[0];
  else if (from === null) out.value = decodeRepresentation(contentType, part.body);
  else out.data = JSON.parse(utf8Decode(part.body));
  return out;
}

function parseMultipartResults(bytes, contentType) {
  const results = {};
  for (const part of parseParts(bytes, boundaryOf(contentType))) {
    const name = parseSfStrings(part.headers['sync-resource'] || '')[0];
    if (!name) throw new Error('Part without Sync-Resource');
    results[name] = resultOf(part);
  }
  return { results };
}

module.exports = { parseMultipartResults, parseSfStrings };
