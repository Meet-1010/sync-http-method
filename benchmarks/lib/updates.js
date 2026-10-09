'use strict';

const { buildUpdate, JSON_PATCH } = require('../../server/src/formats');
const { applyResult } = require('../../client/src/apply');

// The models and Mercure events carry a JSON Patch, or the full document as
// application/json when that is not larger (the same rule SYNC uses).
function delta(oldData, newData) {
  const u = buildUpdate({ type: 'application/json', data: oldData }, { type: 'application/json', data: newData }, [JSON_PATCH]);
  return u.full ? { format: 'application/json', data: newData } : u;
}

// Apply an update from a system that carries no SYNC versions (the models, Mercure).
function applyUpdate(local, format, data) {
  return format === 'application/json'
    ? data
    : applyResult(local, 'x', { status: 200, from: 'x', to: 'y', format, data });
}

module.exports = { delta, applyUpdate };
