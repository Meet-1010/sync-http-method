'use strict';

const jsonpatch = require('fast-json-patch');
const {
  JSON_PATCH, MERGE_PATCH, SPLICE, isJsonType, isTextType, utf8Decode, base64Decode,
} = require('../../shared/media');

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// RFC 7396
function applyMergePatch(target, patch) {
  if (!isObject(patch)) return patch;
  const out = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = applyMergePatch(out[k], v);
  }
  return out;
}

// application/sync-splice+json. Splices are validated before anything is built:
// sorted, non-overlapping, within bounds, correctly typed.
function applySplice(value, patch) {
  if (!isObject(patch) || !Array.isArray(patch.splices)) throw new Error('Invalid splice patch');
  const unit = patch.unit;
  if (unit !== 'codepoint' && unit !== 'byte') throw new Error(`Unknown splice unit ${unit}`);

  const old = unit === 'codepoint'
    ? Array.from(typeof value === 'string' ? value : utf8Decode(value))
    : (value instanceof Uint8Array ? value : new TextEncoder().encode(String(value)));

  const pieces = [];
  let cursor = 0;
  for (const s of patch.splices) {
    if (!Array.isArray(s) || s.length !== 3) throw new Error('Invalid splice');
    const [start, del, insert] = s;
    if (!Number.isInteger(start) || !Number.isInteger(del) || start < cursor || del < 0 || start + del > old.length || typeof insert !== 'string') {
      throw new Error('Invalid splice');
    }
    pieces.push(old.slice(cursor, start));
    pieces.push(unit === 'codepoint' ? Array.from(insert) : base64Decode(insert));
    cursor = start + del;
  }
  pieces.push(old.slice(cursor));

  if (unit === 'codepoint') return pieces.map(p => p.join('')).join('');
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pieces) { out.set(p, at); at += p.length; }
  return out;
}

const sameVersion = (a, b) => {
  const norm = v => JSON.stringify(typeof v === 'string' ? [v] : [...v].sort());
  return a != null && b != null && norm(a) === norm(b);
};

// The value carried by a full representation in the JSON result format.
function fullValue(result) {
  if ('value' in result) return result.value;
  if (isJsonType(result.type)) return result.data;
  if (result.encoding === 'base64') {
    const bytes = base64Decode(result.data);
    return isTextType(result.type) ? utf8Decode(bytes) : bytes;
  }
  if (isTextType(result.type)) return String(result.data);
  return new TextEncoder().encode(String(result.data));
}

// Returns the new local value for one resource result. Throws, leaving the
// caller's state untouched, when a patch does not start from the version the
// client holds (stale, replayed or cached response) or cannot be applied.
// A result with from === null is a full representation.
function applyResult(localValue, localVersion, result) {
  if (result.status === 304) return localValue;
  if (result.status !== 200) throw new Error(`Cannot apply result with status ${result.status}`);
  if (result.from === null || result.from === undefined) return fullValue(result);

  if (!sameVersion(result.from, localVersion)) {
    throw new Error(`Patch applies to ${JSON.stringify(result.from)} but the local version is ${JSON.stringify(localVersion)}`);
  }
  if (result.format === JSON_PATCH) {
    return jsonpatch.applyPatch(JSON.parse(JSON.stringify(localValue)), result.data, true).newDocument;
  }
  if (result.format === MERGE_PATCH) return applyMergePatch(localValue, result.data);
  if (result.format === SPLICE) return applySplice(localValue, result.data);
  throw new Error(`Unsupported format ${result.format}`);
}

module.exports = { applyResult, applyMergePatch, applySplice, fullValue, sameVersion, JSON_PATCH, MERGE_PATCH, SPLICE };
