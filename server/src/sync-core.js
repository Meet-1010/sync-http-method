'use strict';

const { demoStore } = require('./version-store');
const { buildUpdate, representationBytes } = require('./formats');
const { canonical, sameVersion, versionKey, isVersion } = require('./versions');

const MAX_RESOURCES = 100;

// A store answers two questions, synchronously or by promise:
//   getCurrent(resource, context)          -> { version, type, data } | null
//   getVersion(resource, version, context) -> { version, type, data } | null
// and may offer
//   snapshot(context)                      -> { getCurrent, getVersion } fixed at one instant
// context is { method, target, headers } of the request, for per-resource
// authorization: return null for a resource the caller may not read (reported as
// 404). getVersion may return null for versions it no longer keeps; the client
// then receives the full representation. Versions are strings or arrays of
// strings (see versions.js); type defaults to application/json.
const defaultStore = demoStore;

const typeOf = rep => rep.type || 'application/json';

// Updates are memoized per store. A version identifier names one immutable state,
// so the update between two versions never changes; when many clients catch up
// from the same versions (for example after an outage) it is computed once.
const MEMO_ENTRIES = 2000;
const memos = new WeakMap();
const stats = { computed: 0, reused: 0 };

function memoizedUpdate(store, resource, base, current, accept) {
  if (!memos.has(store)) memos.set(store, new Map());
  const memo = memos.get(store);
  const key = `${resource}\n${versionKey(base.version)}\n${versionKey(current.version)}\n${(accept || []).join(',')}`;
  if (memo.has(key)) {
    const hit = memo.get(key);
    memo.delete(key);
    memo.set(key, hit);
    stats.reused++;
    return hit;
  }
  const update = buildUpdate({ ...base, type: typeOf(base) }, { ...current, type: typeOf(current) }, accept);
  stats.computed++;
  memo.set(key, update);
  if (memo.size > MEMO_ENTRIES) memo.delete(memo.keys().next().value);
  return update;
}

// Store results are trusted data but must have the documented shape.
function checked(rep, method) {
  if (rep === null || rep === undefined) return null;
  if (typeof rep !== 'object' || !isVersion(rep.version)) {
    throw new TypeError(`store.${method} must return null or { version, data, type? } with version a string or an array of distinct strings`);
  }
  return rep;
}

// links: { href(payload), minBytes } returns a link instead of inline content when
// the content would be at least minBytes long.
async function resolveOne(view, resource, baseline, { accept, recover, context, links, store }) {
  const current = checked(await view.getCurrent(resource, context), 'getCurrent');
  if (!current) return { status: 404 };
  const to = canonical(current.version);
  if (baseline !== null && sameVersion(baseline, current.version)) return { status: 304, to };

  const base = baseline === null ? null : checked(await view.getVersion(resource, baseline, context), 'getVersion');
  if (baseline !== null && !base) {
    if (!recover) return { status: 409 };
    return withContent({ status: 200, from: null, to, type: typeOf(current), full: current, baseline: 'unrecognized' }, resource, links);
  }

  if (base) {
    const update = memoizedUpdate(store, resource, base, current, accept);
    if (!update.full) {
      return withContent({ status: 200, from: canonical(base.version), to, format: update.format, patch: update.data }, resource, links);
    }
  }
  return withContent({ status: 200, from: null, to, type: typeOf(current), full: current }, resource, links);
}

function withContent(result, resource, links) {
  if (!links) return result;
  const size = result.patch !== undefined
    ? Buffer.byteLength(JSON.stringify(result.patch))
    : representationBytes({ type: result.type, data: result.full.data }).length;
  if (size < links.minBytes) return result;
  const href = links.href({
    r: resource,
    f: result.from === null ? null : JSON.parse(versionKey(result.from)),
    t: JSON.parse(versionKey(result.to)),
    fmt: result.format || null,
  });
  const { patch, full, ...rest } = result;
  return { ...rest, href };
}

// Resolve every baseline independently. A stale or missing resource affects only
// its own entry, never the rest of the request. With consistent: true and a store
// that offers snapshot(), every resource is read from the same instant.
async function computeResults(baselines, { accept, recover = true, store = defaultStore, context = {}, consistent = false, links = null } = {}) {
  const snapshotted = consistent && typeof store.snapshot === 'function';
  const view = snapshotted ? await store.snapshot(context) : store;
  const entries = Object.entries(baselines);
  const resolved = await Promise.all(entries.map(([resource, baseline]) =>
    resolveOne(view, resource, baseline, { accept, recover, context, links, store })));

  const results = Object.create(null);
  entries.forEach(([resource], i) => { results[resource] = resolved[i]; });
  return { results, allUnchanged: resolved.every(r => r.status === 304), consistent: snapshotted };
}

// Content behind a link: the update from `f` to `t`, or the representation at `t`.
// Returns null when the store no longer has those versions or denies access.
async function resolveLink(payload, { store = defaultStore, context = {} } = {}) {
  const target = checked(await store.getVersion(payload.r, canonical(payload.t), context), 'getVersion');
  if (!target) return null;
  const current = { ...target, type: typeOf(target) };
  if (payload.f === null || payload.fmt === null) return { type: current.type, data: current.data };
  const base = checked(await store.getVersion(payload.r, canonical(payload.f), context), 'getVersion');
  if (!base) return null;
  const update = memoizedUpdate(store, payload.r, base, current, [payload.fmt]);
  if (update.full || update.format !== payload.fmt) return null;
  return { type: payload.fmt, data: update.data, patch: true };
}

module.exports = { computeResults, resolveLink, defaultStore, MAX_RESOURCES, stats };
