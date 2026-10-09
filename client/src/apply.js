'use strict';

const jsonpatch = require('fast-json-patch');

const JSON_PATCH = 'application/json-patch+json';
const MERGE_PATCH = 'application/merge-patch+json';
const SNAPSHOT = 'application/json';

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

// Returns the new local value for one resource result. Throws, leaving the
// caller's state untouched, when a patch does not start from the baseline the
// client actually holds (stale, replayed or cached response).
function applyResult(localValue, localToken, result) {
  if (result.status === 304) return localValue;
  if (result.status !== 200) throw new Error(`Cannot apply result with status ${result.status}`);

  if (result.format === SNAPSHOT) return result.data;

  if ((result.from ?? null) !== (localToken ?? null)) {
    throw new Error(`Patch is from ${result.from} but local baseline is ${localToken}`);
  }
  if (result.format === JSON_PATCH) {
    return jsonpatch.applyPatch(JSON.parse(JSON.stringify(localValue)), result.data, true).newDocument;
  }
  if (result.format === MERGE_PATCH) return applyMergePatch(localValue, result.data);
  throw new Error(`Unsupported format ${result.format}`);
}

module.exports = { applyResult, applyMergePatch, JSON_PATCH, MERGE_PATCH, SNAPSHOT };
