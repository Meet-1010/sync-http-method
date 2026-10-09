'use strict';

const { buildUpdate, JSON_PATCH, MERGE_PATCH } = require('../../server/src/formats');
const { applyResult } = require('../../client/src/apply');

// The update formats every delta protocol in the benchmarks may use, except real
// Braid, which uses its own range patches: the smaller of a JSON Patch and a JSON
// Merge Patch, or the full document when neither is smaller (SYNC's rule).
const FORMATS = [JSON_PATCH, MERGE_PATCH];

// The models and Mercure events carry the same updates as SYNC.
function delta(oldData, newData) {
  const u = buildUpdate({ type: 'application/json', data: oldData }, { type: 'application/json', data: newData }, FORMATS);
  return u.full ? { format: 'application/json', data: newData } : u;
}

// Apply an update from a system that carries no SYNC versions (the models, Mercure).
function applyUpdate(local, format, data) {
  return format === 'application/json'
    ? data
    : applyResult(local, 'x', { status: 200, from: 'x', to: 'y', format, data });
}

module.exports = { delta, applyUpdate, FORMATS };
