'use strict';

const jsonpatch = require('fast-json-patch');

const JSON_PATCH = 'application/json-patch+json';
const MERGE_PATCH = 'application/merge-patch+json';
const SNAPSHOT = 'application/json';
const SUPPORTED_PATCH_FORMATS = [JSON_PATCH, MERGE_PATCH];

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const size = v => Buffer.byteLength(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function computeDelta(oldSnapshot, newSnapshot) {
  if (same(oldSnapshot, newSnapshot)) return [];
  return jsonpatch.compare(oldSnapshot, newSnapshot);
}

// RFC 7396 treats null as "delete", so a null object member cannot be expressed.
function hasNullMember(v) {
  if (v === null) return true;
  if (isObject(v)) return Object.values(v).some(hasNullMember);
  return false;
}

// Returns undefined when the change cannot be expressed as an RFC 7396 merge patch.
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

// Honour the client's format preference order; send the snapshot when no
// requested patch format is representable or the patch is not smaller.
function buildUpdate(oldData, newData, accept) {
  const snapshot = { format: SNAPSHOT, data: newData };
  const snapshotSize = size(newData);
  const prefs = Array.isArray(accept) && accept.length ? accept : [JSON_PATCH];

  for (const format of prefs) {
    let data;
    if (format === JSON_PATCH) data = computeDelta(oldData, newData);
    else if (format === MERGE_PATCH) data = computeMergePatch(oldData, newData);
    else if (format === SNAPSHOT) return snapshot;
    else continue;

    if (data === undefined) continue;
    return size(data) < snapshotSize ? { format, data } : snapshot;
  }
  return snapshot;
}

module.exports = {
  JSON_PATCH, MERGE_PATCH, SNAPSHOT, SUPPORTED_PATCH_FORMATS,
  computeDelta, computeMergePatch, buildUpdate,
};
