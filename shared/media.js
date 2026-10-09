'use strict';

// Shared by server and client (browser-safe: no Node-only APIs).
//
// How a representation is carried depends only on its media type:
//   JSON types (application/json, */*+json)          -> a JSON value
//   text types (text/*, XML, JavaScript, or charset) -> a string (UTF-8 on the wire)
//   anything else                                     -> bytes

const JSON_PATCH = 'application/json-patch+json';
const MERGE_PATCH = 'application/merge-patch+json';
const SPLICE = 'application/sync-splice+json';

const essence = type => String(type || 'application/json').split(';')[0].trim().toLowerCase();

function isJsonType(type) {
  const t = essence(type);
  return t === 'application/json' || t.endsWith('+json');
}

function isTextType(type) {
  if (isJsonType(type)) return false;
  const t = essence(type);
  return t.startsWith('text/') || t === 'application/xml' || t.endsWith('+xml') ||
    t === 'application/javascript' || t === 'application/ecmascript' ||
    /;\s*charset=/i.test(String(type || ''));
}

const utf8Encode = s => new TextEncoder().encode(s);
const utf8Decode = b => new TextDecoder('utf-8', { fatal: true }).decode(b);

function base64Encode(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function base64Decode(str) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(str) || str.length % 4 !== 0) throw new Error('Invalid base64');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

const toBytes = data => (data instanceof Uint8Array ? data : utf8Encode(String(data)));

// Bytes of a representation { type, data } as sent on the wire.
function representationBytes(rep) {
  if (isJsonType(rep.type)) return utf8Encode(JSON.stringify(rep.data));
  if (isTextType(rep.type)) return utf8Encode(typeof rep.data === 'string' ? rep.data : utf8Decode(rep.data));
  return toBytes(rep.data);
}

// The in-memory value for a representation received as bytes.
function decodeRepresentation(type, bytes) {
  if (isJsonType(type)) return JSON.parse(utf8Decode(bytes));
  if (isTextType(type)) return utf8Decode(bytes);
  return bytes;
}

module.exports = {
  JSON_PATCH, MERGE_PATCH, SPLICE,
  essence, isJsonType, isTextType, utf8Encode, utf8Decode, base64Encode, base64Decode,
  representationBytes, decodeRepresentation,
};
