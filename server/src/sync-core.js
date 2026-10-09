'use strict';

const memoryStore = require('./version-store');
const { buildUpdate, SNAPSHOT } = require('./delta-engine');

const MAX_RESOURCES = 100;

// A store answers two questions, synchronously or by promise:
//   getCurrent(resource)        -> { id, data } | null
//   getVersion(resource, token) -> { id, data } | null   (null = cannot reconstruct that state)
// A store that only keeps recent versions is valid: older tokens get a snapshot.
const defaultStore = {
  getCurrent: memoryStore.getCurrentVersion,
  getVersion: memoryStore.getVersion,
};

async function resolveOne(store, resource, token, { accept, recover }) {
  const current = await store.getCurrent(resource);
  if (!current) return { status: 404 };
  if (token === current.id) return { status: 304, to: current.id };

  const base = token === null ? null : await store.getVersion(resource, token);
  if (token !== null && !base) {
    return recover
      ? { status: 200, format: SNAPSHOT, from: null, to: current.id, baseline: 'unrecognized', data: current.data }
      : { status: 409 };
  }

  const update = base
    ? buildUpdate(base.data, current.data, accept)
    : { format: SNAPSHOT, data: current.data };
  return { status: 200, format: update.format, from: base ? token : null, to: current.id, data: update.data };
}

// Resolve every baseline independently. A stale or missing resource affects
// only its own entry, never the rest of the batch.
async function computeResults(baselines, { accept, recover = true, store = defaultStore } = {}) {
  const entries = Object.entries(baselines);
  const resolved = await Promise.all(entries.map(([resource, token]) => resolveOne(store, resource, token, { accept, recover })));

  const results = Object.create(null);
  entries.forEach(([resource], i) => { results[resource] = resolved[i]; });
  return { results, allUnchanged: resolved.every(r => r.status === 304) };
}

module.exports = { computeResults, defaultStore, MAX_RESOURCES };
