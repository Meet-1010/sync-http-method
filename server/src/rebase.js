'use strict';

// Rebasing a client's change onto the current version.
//
// A client changes a resource from version B (its base); meanwhile the server's
// copy moved from B to C. If the two changes touch different parts of the
// representation, the client's change is applied to C; otherwise they conflict.
//
//   JSON (JSON Patch, JSON Merge Patch): the parts are JSON Pointer paths. Two
//   changes conflict when a path one changes equals, contains, or lies inside a
//   path the other changes. An array is one part: any two changes inside the same
//   array conflict, because positions in it shift.
//   Splices (text and binary): the parts are ranges. Two changes conflict when a
//   range one replaces overlaps a range the other replaces, or one inserts strictly
//   inside a range the other replaces. Insertions at the same position are both
//   kept: the server's first.
//
// Every function returns { data } (the merged representation's data) or
// { conflict: reason }.

const jsonpatch = require('fast-json-patch');
const {
  JSON_PATCH, MERGE_PATCH, SPLICE, isJsonType, isTextType,
  computeTextSplices, computeByteSplices, representationBytes,
} = require('../../shared/formats');
const { applyMergePatch, applySplice } = require('../../client/src/apply');
const { utf8Decode } = require('../../shared/media');

// ── JSON ──────────────────────────────────────────────────────────────────────

const unescape = s => s.replace(/~1/g, '/').replace(/~0/g, '~');
const segmentsOf = pointer => (pointer === '' ? [] : pointer.split('/').slice(1).map(unescape));

// The part a path belongs to: the path itself, cut at the first array on the way
// down (in either version), since positions inside an array are not stable.
function partOf(segments, ...docs) {
  for (let i = 0; i < segments.length; i++) {
    for (const doc of docs) {
      let v = doc;
      for (let k = 0; k < i && v !== null && typeof v === 'object'; k++) v = v[segments[k]];
      if (Array.isArray(v)) return segments.slice(0, i);
    }
  }
  return segments;
}

const overlaps = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
};

// The leaves a merge patch sets or removes.
function mergePatchPaths(patch, prefix = []) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return [prefix];
  const out = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...mergePatchPaths(v, [...prefix, k]));
    else out.push([...prefix, k]);
  }
  return out.length ? out : [prefix];
}

function jsonPatchPaths(ops) {
  return ops.flatMap(op => [op.path, ...(op.from !== undefined ? [op.from] : [])]).map(segmentsOf);
}

function rebaseJson(format, base, current, patch) {
  const theirs = jsonpatch.compare(base, current).map(op => partOf(segmentsOf(op.path), base, current));
  const mineRaw = format === MERGE_PATCH ? mergePatchPaths(patch) : jsonPatchPaths(patch);
  const mine = mineRaw.map(p => partOf(p, base, current));
  for (const m of mine) {
    const hit = theirs.find(t => overlaps(m, t));
    if (hit) return { conflict: `both changed /${(m.length <= hit.length ? m : hit).join('/')}` };
  }
  try {
    if (format === MERGE_PATCH) return { data: applyMergePatch(current, patch) };
    return { data: jsonpatch.applyPatch(JSON.parse(JSON.stringify(current)), patch, true).newDocument };
  } catch (e) {
    return { conflict: `does not apply to the current version: ${e.message}` };
  }
}

// ── Splices ───────────────────────────────────────────────────────────────────

// Moves client splices (positions in the base) to positions in the current
// version, given the server's splices from the base to the current version.
function transformSplices(mine, theirs) {
  const out = [];
  for (const [cs, cd, ci] of mine) {
    const ce = cs + cd;
    let shift = 0;
    for (const [ss, sd, si] of theirs) {
      const se = ss + sd;
      const silen = typeof si === 'string' ? Array.from(si).length : si.length;
      if (cd > 0 && sd > 0 && cs < se && ss < ce) return { conflict: `both changed positions ${Math.max(cs, ss)} to ${Math.min(ce, se)}` };
      if (cd > 0 && sd === 0 && silen > 0 && ss > cs && ss < ce) return { conflict: `inserted at ${ss}, inside a range the other change replaces` };
      if (cd === 0 && sd > 0 && cs > ss && cs < se) return { conflict: `inserted at ${cs}, inside a range the other change replaces` };
      // A server splice moves this position if it lies wholly before it; an
      // insertion at the same position goes first.
      if ((sd > 0 && se <= cs) || (sd === 0 && ss <= cs)) shift += silen - sd;
    }
    out.push([cs + shift, cd, ci]);
  }
  return { splices: out };
}

function rebaseSplice(base, current, patch) {
  const text = isTextType(current.type) && patch.unit === 'codepoint';
  if (!text && patch.unit !== 'byte') return { conflict: 'splice unit does not match the media type' };
  const theirs = text
    ? computeTextSplices(textOf(base), textOf(current))
    : computeByteSplices(representationBytes(base), representationBytes(current));
  // Byte splices from the server carry base64 insertions; their length in octets is what moves positions.
  const theirSplices = text ? theirs.splices : theirs.splices.map(([s, d, b64]) => [s, d, Buffer.from(b64, 'base64')]);
  const moved = transformSplices(patch.splices, theirSplices);
  if (moved.conflict) return moved;
  try {
    const target = text ? textOf(current) : new Uint8Array(representationBytes(current));
    return { data: applySplice(target, { unit: patch.unit, splices: moved.splices }) };
  } catch (e) {
    return { conflict: `does not apply to the current version: ${e.message}` };
  }
}

const textOf = rep => (typeof rep.data === 'string' ? rep.data : utf8Decode(representationBytes(rep)));

// ── Entry point ──────────────────────────────────────────────────────────────

// base and current: { type, data }; the client's change is a patch in `format`.
function rebase(format, base, current, patch) {
  if (format === JSON_PATCH || format === MERGE_PATCH) {
    if (!isJsonType(current.type)) return { conflict: `${format} applies to JSON representations` };
    return rebaseJson(format, base.data, current.data, patch);
  }
  if (format === SPLICE) {
    if (isJsonType(current.type)) return { conflict: 'splices apply to text and binary representations' };
    return rebaseSplice(base, current, patch);
  }
  return { conflict: `unsupported format ${format}` };
}

module.exports = { rebase, transformSplices, partOf, mergePatchPaths };
