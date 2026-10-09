'use strict';

const { getCurrentVersion, getVersion } = require('./version-store');
const { buildUpdate, SNAPSHOT } = require('./delta-engine');

const MAX_RESOURCES = 100;

// Resolve every baseline independently. A stale or missing resource affects
// only its own entry, never the rest of the batch.
function computeResults(baselines, { accept, recover = true } = {}) {
  const results = Object.create(null);
  let allUnchanged = true;

  for (const [resource, token] of Object.entries(baselines)) {
    const current = getCurrentVersion(resource);
    if (!current) {
      results[resource] = { status: 404 };
      allUnchanged = false;
      continue;
    }

    if (token === current.id) {
      results[resource] = { status: 304, to: current.id };
      continue;
    }
    allUnchanged = false;

    const base = token === null ? null : getVersion(resource, token);
    if (token !== null && !base) {
      results[resource] = recover
        ? { status: 200, format: SNAPSHOT, from: null, to: current.id, baseline: 'unrecognized', data: current.data }
        : { status: 409 };
      continue;
    }

    const update = base
      ? buildUpdate(base.data, current.data, accept)
      : { format: SNAPSHOT, data: current.data };
    results[resource] = { status: 200, format: update.format, from: base ? token : null, to: current.id, data: update.data };
  }

  return { results, allUnchanged };
}

module.exports = { computeResults, MAX_RESOURCES };
