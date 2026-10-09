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
  const prefix = `${resource}\n${versionKey(base.version)}\n${versionKey(current.version)}\n`;
  const key = prefix + (accept || []).join(',');
  if (memo.has(key)) {
    const hit = memo.get(key);
    memo.delete(key);
    memo.set(key, hit);
    stats.reused++;
    return hit;
  }
  const update = buildUpdate({ ...base, type: typeOf(base) }, { ...current, type: typeOf(current) }, accept);
  stats.computed++;
  remember(memo, key, update);
  // Asking for the chosen format alone yields the same patch: a link to it is then
  // served from this entry.
  if (update.format) remember(memo, prefix + update.format, update);
  return update;
}

function remember(memo, key, value) {
  memo.delete(key);
  memo.set(key, value);
  if (memo.size > MEMO_ENTRIES) memo.delete(memo.keys().next().value);
}

// Store results are trusted data but must have the documented shape.
function checked(rep, method) {
  if (rep === null || rep === undefined) return null;
  if (typeof rep !== 'object' || !isVersion(rep.version)) {
    throw new TypeError(`store.${method} must return null or { version, data, type? } with version a string or an array of distinct strings`);
  }
  return rep;
}

// ── Step 1: plan ──────────────────────────────────────────────────────────────
// Which versions each result connects, without computing any update:
//   { status: 404 } | { status: 409 } | { status: 304, to }
//   { status: 200, from, to, baseline? }   from: the patch's baseline, or null
// plus the representations read, so the update can follow without reading again.

async function planOne(view, resource, baseline, { recover, context }) {
  const current = checked(await view.getCurrent(resource, context), 'getCurrent');
  if (!current) return { plan: { status: 404 } };
  const to = canonical(current.version);
  if (baseline !== null && sameVersion(baseline, current.version)) return { plan: { status: 304, to } };

  const base = baseline === null ? null : checked(await view.getVersion(resource, baseline, context), 'getVersion');
  if (baseline !== null && !base) {
    if (!recover) return { plan: { status: 409 } };
    return { plan: { status: 200, from: null, to, baseline: 'unrecognized' }, current };
  }
  return { plan: { status: 200, from: base ? canonical(base.version) : null, to }, base, current };
}

// ── Step 2: the update ────────────────────────────────────────────────────────

function materialize(store, resource, { plan, base, current }, accept, links) {
  if (plan.status !== 200) return plan;
  if (base) {
    const update = memoizedUpdate(store, resource, base, current, accept);
    if (!update.full) {
      return withContent({ status: 200, from: plan.from, to: plan.to, format: update.format, patch: update.data }, resource, links);
    }
  }
  const result = { status: 200, from: null, to: plan.to, type: typeOf(current), full: current };
  if (plan.baseline) result.baseline = plan.baseline;
  return withContent(result, resource, links);
}

// Sizes of patches and representations, remembered per object: memoized updates
// and stored representations are shared between requests.
const sizes = new WeakMap();
function contentSize(result) {
  const key = result.patch !== undefined && result.patch !== null && typeof result.patch === 'object' ? result.patch : result.full;
  if (key && sizes.has(key)) return sizes.get(key);
  const size = result.patch !== undefined
    ? Buffer.byteLength(JSON.stringify(result.patch))
    : representationBytes({ type: result.type, data: result.full.data }).length;
  if (key && typeof key === 'object') sizes.set(key, size);
  return size;
}

// A link's payload: [resource, from, to, format], with versions in canonical form
// and the patch formats this implementation produces abbreviated (null: the full
// representation at `to`).
const FORMAT_CODES = { 'application/json-patch+json': 'j', 'application/merge-patch+json': 'm', 'application/sync-splice+json': 's' };
const FORMATS = Object.fromEntries(Object.entries(FORMAT_CODES).map(([f, c]) => [c, f]));
const linkPayload = (resource, from, to, format) => [resource, from, to, format ? FORMAT_CODES[format] || format : null];

// links: { href(payload), minBytes } returns a link instead of inline content when
// the content would be at least minBytes long.
function withContent(result, resource, links) {
  if (!links || contentSize(result) < links.minBytes) return result;
  const href = links.href(linkPayload(resource, result.from, result.to, result.format));
  const { patch, full, ...rest } = result;
  return { ...rest, href };
}

// ── Requests ──────────────────────────────────────────────────────────────────

// Plans every baseline independently. A stale or missing resource affects only
// its own entry, never the rest of the request. With consistent: true and a store
// that offers snapshot(), every resource is read from the same instant.
async function planResults(baselines, { recover = true, store = defaultStore, context = {}, consistent = false } = {}) {
  const snapshotted = consistent && typeof store.snapshot === 'function';
  const view = snapshotted ? await store.snapshot(context) : store;
  const entries = Object.entries(baselines);
  const planned = await Promise.all(entries.map(([resource, baseline]) =>
    planOne(view, resource, baseline, { recover, context })));
  return {
    planned: entries.map(([resource], i) => ({ resource, ...planned[i] })),
    allUnchanged: planned.every(p => p.plan.status === 304),
    consistent: snapshotted,
  };
}

function materializeAll(planned, { store = defaultStore, accept, links = null } = {}) {
  const results = Object.create(null);
  for (const p of planned) results[p.resource] = materialize(store, p.resource, p, accept, links);
  return results;
}

async function computeResults(baselines, options = {}) {
  const { planned, allUnchanged, consistent } = await planResults(baselines, options);
  return { results: materializeAll(planned, options), allUnchanged, consistent };
}

// Content behind a link: the update from `from` to `to`, or the representation at
// `to`. Returns null when the store no longer has those versions or denies access.
async function resolveLink([resource, from, to, code], { store = defaultStore, context = {} } = {}) {
  const target = checked(await store.getVersion(resource, to, context), 'getVersion');
  if (!target) return null;
  const current = { ...target, type: typeOf(target) };
  if (from === null || code === null) return { type: current.type, data: current.data };
  const base = checked(await store.getVersion(resource, from, context), 'getVersion');
  if (!base) return null;
  const format = FORMATS[code] || code;
  const update = memoizedUpdate(store, resource, base, current, [format]);
  if (update.full || update.format !== format) return null;
  return { type: format, data: update.data, patch: true };
}

// Results of a planned request, rebuilt from the versions alone (for shared result
// documents). Every version involved is read again for this requester; returns
// null if any is no longer available or readable, since the document could then
// not be the same as the one planned.
async function resolvePlanned(plans, { store = defaultStore, context = {}, accept, links = null } = {}) {
  const read = (resource, v) => (v === null ? null : Promise.resolve(store.getVersion(resource, v, context)).then(r => checked(r, 'getVersion')));
  const rebuilt = await Promise.all(plans.map(async ({ resource, plan }) => {
    if (plan.status === 404 || plan.status === 409) return { resource, plan };
    const [current, base] = await Promise.all([read(resource, plan.to), plan.status === 200 ? read(resource, plan.from) : null]);
    if (!current || (plan.status === 200 && plan.from !== null && !base)) return null;
    return { resource, plan, base, current };
  }));
  if (rebuilt.includes(null)) return null;
  return materializeAll(rebuilt, { store, accept, links });
}

module.exports = {
  computeResults, planResults, materializeAll, resolveLink, resolvePlanned,
  defaultStore, MAX_RESOURCES, stats,
};
