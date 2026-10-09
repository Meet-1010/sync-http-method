'use strict';

const jsonpatch = require('fast-json-patch');
const { diffLines } = require('diff');

const {
  JSON_PATCH, MERGE_PATCH, SPLICE, essence, isJsonType, isTextType, representationBytes: repBytes, utf8Decode,
} = require('../../shared/media');

const PATCH_FORMATS = [JSON_PATCH, MERGE_PATCH, SPLICE];
const DEFAULT_ACCEPT = [JSON_PATCH, SPLICE];

const representationBytes = rep => Buffer.from(repBytes(rep));
const textOf = rep => (typeof rep.data === 'string' ? rep.data : utf8Decode(rep.data));

// ── JSON Merge Patch (RFC 7396) ───────────────────────────────────────────────

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// RFC 7396 treats null as "delete", so a null object member cannot be expressed.
function hasNullMember(v) {
  if (v === null) return true;
  if (isObject(v)) return Object.values(v).some(hasNullMember);
  return false;
}

// Returns undefined when the change cannot be expressed as a merge patch.
function computeMergePatch(a, b) {
  if (!isObject(a) || !isObject(b)) return hasNullMember(b) ? undefined : b;
  const patch = {};
  for (const k of Object.keys(a)) if (!(k in b)) patch[k] = null;
  for (const k of Object.keys(b)) {
    if (!(k in a)) {
      if (hasNullMember(b[k])) return undefined;
      patch[k] = b[k];
    } else if (!same(a[k], b[k])) {
      const d = computeMergePatch(a[k], b[k]);
      if (d === undefined) return undefined;
      patch[k] = d;
    }
  }
  return patch;
}

// ── Splice patches (application/sync-splice+json) ─────────────────────────────
// { "unit": "codepoint" | "byte", "splices": [[start, deleteCount, insert], ...] }
// Positions refer to the old representation; splices are sorted and do not overlap.
// For "codepoint", positions count Unicode code points and insert is a string; for
// "byte", positions count bytes and insert is base64.

const codepoints = s => Array.from(s);

function computeTextSplices(oldText, newText) {
  const splices = [];
  let pos = 0;
  let current = null;
  const flush = () => { if (current) { splices.push([current.start, current.del, current.ins]); current = null; } };

  for (const part of diffLines(oldText, newText)) {
    const n = codepoints(part.value).length;
    if (part.added) {
      if (!current) current = { start: pos, del: 0, ins: '' };
      current.ins += part.value;
    } else if (part.removed) {
      if (!current) current = { start: pos, del: 0, ins: '' };
      current.del += n;
      pos += n;
    } else {
      flush();
      pos += n;
    }
  }
  flush();
  return { unit: 'codepoint', splices };
}

function computeByteSplices(oldBytes, newBytes) {
  const a = Buffer.from(oldBytes);
  const b = Buffer.from(newBytes);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  if (prefix === a.length && prefix === b.length) return { unit: 'byte', splices: [] };
  const insert = b.subarray(prefix, b.length - suffix).toString('base64');
  return { unit: 'byte', splices: [[prefix, a.length - prefix - suffix, insert]] };
}

// ── Choosing an update ────────────────────────────────────────────────────────

const patchSize = data => Buffer.byteLength(JSON.stringify(data));

function patchFor(format, base, current) {
  const json = isJsonType(current.type);
  if (format === JSON_PATCH && json) return same(base.data, current.data) ? [] : jsonpatch.compare(base.data, current.data);
  if (format === MERGE_PATCH && json) return computeMergePatch(base.data, current.data);
  if (format === SPLICE && !json) {
    return isTextType(current.type)
      ? computeTextSplices(textOf(base), textOf(current))
      : computeByteSplices(representationBytes(base), representationBytes(current));
  }
  return undefined;
}

// Returns { format, data } for a patch, or { full: true } when the full
// representation should be sent: the media type changed, no accepted format can
// express the change, or the patch is not smaller than the representation.
function buildUpdate(base, current, accept) {
  if (essence(base.type) !== essence(current.type)) return { full: true };
  const prefs = Array.isArray(accept) && accept.length ? accept : DEFAULT_ACCEPT;
  const fullSize = representationBytes(current).length;
  for (const format of prefs) {
    const data = patchFor(format, base, current);
    if (data === undefined) continue;
    return patchSize(data) < fullSize ? { format, data } : { full: true };
  }
  return { full: true };
}

module.exports = {
  JSON_PATCH, MERGE_PATCH, SPLICE, PATCH_FORMATS, DEFAULT_ACCEPT,
  essence, isJsonType, isTextType, representationBytes,
  computeMergePatch, computeTextSplices, computeByteSplices, buildUpdate,
};
