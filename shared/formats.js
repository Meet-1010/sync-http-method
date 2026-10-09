'use strict';

const jsonpatch = require('fast-json-patch');
const { diffLines, diffWordsWithSpace } = require('diff');

const {
  JSON_PATCH, MERGE_PATCH, SPLICE, essence, isJsonType, isTextType, representationBytes: repBytes,
  utf8Encode, utf8Decode, base64Encode,
} = require('./media');

const PATCH_FORMATS = [JSON_PATCH, MERGE_PATCH, SPLICE];
const DEFAULT_ACCEPT = [JSON_PATCH, SPLICE];

// Bytes of a representation (Uint8Array; a Buffer in Node).
const representationBytes = rep => (typeof Buffer === 'function' ? Buffer.from(repBytes(rep)) : repBytes(rep));
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

// Splices from a jsdiff change list, with positions offset by `start`; each splice
// also keeps the text it deletes, for refinement.
function splicesFromParts(parts, start = 0) {
  const splices = [];
  let pos = start;
  let current = null;
  const flush = () => { if (current) { splices.push(current); current = null; } };
  for (const part of parts) {
    const n = codepoints(part.value).length;
    if (part.added) {
      if (!current) current = { start: pos, del: 0, deleted: '', ins: '' };
      current.ins += part.value;
    } else if (part.removed) {
      if (!current) current = { start: pos, del: 0, deleted: '', ins: '' };
      current.del += n;
      current.deleted += part.value;
      pos += n;
    } else {
      flush();
      pos += n;
    }
  }
  flush();
  return splices;
}

const byteLength = text => utf8Encode(text).length;
const spliceSize = list => list.reduce((n, sp) => n + byteLength(JSON.stringify([sp.start, sp.del, sp.ins])) + 1, 0);
const WORD_DIFF_LIMIT = 4000;

// One replaced block of lines, made as small as possible: the text it shares at
// both ends is kept, and if the words that changed inside it are cheaper to
// describe separately, they are.
function refine(sp) {
  const del = codepoints(sp.deleted);
  const ins = codepoints(sp.ins);
  let p = 0;
  while (p < del.length && p < ins.length && del[p] === ins[p]) p++;
  let q = 0;
  while (q < del.length - p && q < ins.length - p && del[del.length - 1 - q] === ins[ins.length - 1 - q]) q++;
  const trimmed = [{ start: sp.start + p, del: del.length - p - q, ins: ins.slice(p, ins.length - q).join('') }];
  if (del.length + ins.length > WORD_DIFF_LIMIT || !sp.del || !sp.ins) return trimmed;
  const words = splicesFromParts(diffWordsWithSpace(sp.deleted, sp.ins), sp.start);
  return spliceSize(words) < spliceSize(trimmed) ? words : trimmed;
}

// Two candidates, of which the smaller is sent: a line diff with each changed
// block refined, and the whole text reduced to the one span that changed (a line
// diff can pair repeated lines so that one edit becomes two large splices).
function computeTextSplices(oldText, newText) {
  const byLines = splicesFromParts(diffLines(oldText, newText)).flatMap(refine);
  const whole = refine({ start: 0, del: codepoints(oldText).length, deleted: oldText, ins: newText });
  const best = spliceSize(whole) < spliceSize(byLines) ? whole : byLines;
  return { unit: 'codepoint', splices: best.filter(r => r.del || r.ins).map(r => [r.start, r.del, r.ins]) };
}

function computeByteSplices(oldBytes, newBytes) {
  const a = oldBytes;
  const b = newBytes;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  if (prefix === a.length && prefix === b.length) return { unit: 'byte', splices: [] };
  const insert = base64Encode(b.subarray(prefix, b.length - suffix));
  return { unit: 'byte', splices: [[prefix, a.length - prefix - suffix, insert]] };
}

// ── Choosing an update ────────────────────────────────────────────────────────

const patchSize = data => byteLength(JSON.stringify(data));

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

// Returns { format, data } for the smallest patch in any accepted format (the
// client's order breaks ties), or { full: true } when the full representation
// should be sent: the media type changed, no accepted format can express the
// change, or no patch is smaller than the representation.
function buildUpdate(base, current, accept) {
  if (essence(base.type) !== essence(current.type)) return { full: true };
  const prefs = [...new Set(Array.isArray(accept) && accept.length ? accept : DEFAULT_ACCEPT)];
  let best = null;
  for (const format of prefs) {
    const data = patchFor(format, base, current);
    if (data === undefined) continue;
    const size = patchSize(data);
    if (!best || size < best.size) best = { format, data, size };
  }
  if (!best || best.size >= representationBytes(current).length) return { full: true };
  return { format: best.format, data: best.data };
}

module.exports = {
  JSON_PATCH, MERGE_PATCH, SPLICE, PATCH_FORMATS, DEFAULT_ACCEPT,
  essence, isJsonType, isTextType, representationBytes,
  computeMergePatch, computeTextSplices, computeByteSplices, buildUpdate,
};
