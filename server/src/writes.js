'use strict';

const crypto = require('crypto');
const jsonpatch = require('fast-json-patch');
const { isVersion, canonical, sameVersion } = require('./versions');
const {
  JSON_PATCH, MERGE_PATCH, SPLICE, PATCH_FORMATS, isJsonType, isTextType, buildUpdate,
} = require('../../shared/formats');
const { base64Encode, base64Decode } = require('../../shared/media');
const { applyMergePatch, applySplice } = require('../../client/src/apply');
const { rebase } = require('./rebase');
const { JSON_RESULT } = require('./encode');
const { MAX_RESOURCES } = require('./sync-core');

// Atomic changes to several resources (application/sync-changes+json, sent with POST):
//
//   { "changes": {
//       "/doc.md": { "base": "v7", "format": "application/sync-splice+json", "data": { ... } },
//       "/todos":  { "base": "t3", "format": "application/merge-patch+json", "data": { ... } },
//       "/new":    { "base": null, "type": "application/json", "data": { ... } },
//       "/old":    { "base": "o2", "delete": true } },
//     "merge": true,
//     "accept": ["application/merge-patch+json", "application/json-patch+json"] }
//
// Each change names the version it was made from (base; null to create a resource
// that must not exist). Either every change is applied, together, or none is.
// Without "merge", a base that is not the current version fails the request (412
// for that resource). With "merge": true, a change from an earlier version is
// rebased onto the current one when the two touch different parts (rebase.js), and
// conflicts otherwise (409). Results, per resource:
//   200 { from, to }                     applied; `to` is the new version (absent after delete)
//   200 { from, to, rebased: true, update }  applied after rebasing; `update` brings the
//                                        client's copy (base + its change) to `to`
//   404 the resource does not exist, or may not be read
//   409 { current, reason }              a conflict, or the base is no longer kept
//   412 { current }                      the base is not the current version
//   422 { reason }                       the change is invalid or does not apply
//   424                                  not applied because another change failed
// The response is 200 when everything was applied and 409 otherwise.

const SYNC_CHANGES_TYPE = 'application/sync-changes+json';
const ATTEMPTS = 4;
const defaultVersion = () => crypto.randomBytes(9).toString('base64url');

const problemOf = (status, title, detail) => ({
  status,
  headers: { 'Content-Type': 'application/problem+json' },
  body: Buffer.from(JSON.stringify({ title, status, detail })),
});

function validate(request, isResourceName) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return 'Request content must be a JSON object';
  const { changes, merge, accept } = request;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return 'Missing or invalid changes';
  const names = Object.keys(changes);
  if (!names.length) return 'No changes';
  if (!names.every(isResourceName)) return 'Resource names must be absolute paths on this origin, such as "/users"';
  if (merge !== undefined && typeof merge !== 'boolean') return 'merge must be a boolean';
  if (accept !== undefined && (!Array.isArray(accept) || !accept.every(a => typeof a === 'string'))) return 'accept must be an array of media types';
  for (const [name, c] of Object.entries(changes)) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return `Change for ${name} must be an object`;
    if (c.base !== null && !(isVersion(c.base) && (typeof c.base === 'string' ? [c.base] : c.base).every(id => /^[\x20-\x7E]+$/.test(id)))) {
      return `base for ${name} must be null or a version`;
    }
    const kinds = ['format' in c, 'type' in c, c.delete === true].filter(Boolean).length;
    if (kinds !== 1) return `Change for ${name} must have exactly one of format (a patch), type (a representation), or delete`;
    if (c.delete === true && c.base === null) return `Cannot delete ${name} without a base`;
    if ('format' in c && (!PATCH_FORMATS.includes(String(c.format).toLowerCase()) || !('data' in c))) return `Change for ${name}: unsupported patch format or no data`;
    if ('format' in c && c.base === null) return `A patch for ${name} needs a base`;
    if ('type' in c && (typeof c.type !== 'string' || !('data' in c))) return `Change for ${name}: a representation needs a type and data`;
    if ('type' in c && c.encoding !== undefined && c.encoding !== 'base64') return `Change for ${name}: encoding must be "base64"`;
  }
  return null;
}

// The data of a full representation sent by the client, in the store's form.
function representationOf(c) {
  if (isJsonType(c.type)) {
    if (c.encoding) throw new Error('JSON representations are not base64-encoded');
    return c.data;
  }
  if (isTextType(c.type) && c.encoding === undefined) {
    if (typeof c.data !== 'string') throw new Error('a text representation must be a string');
    return c.data;
  }
  if (typeof c.data !== 'string' || c.encoding !== 'base64') throw new Error('a binary representation must be base64 with "encoding": "base64"');
  return base64Decode(c.data);
}

// Applies a client's patch to a representation; throws if it does not apply.
function applyPatch(format, rep, data) {
  if (format === JSON_PATCH) {
    if (!isJsonType(rep.type)) throw new Error('JSON Patch applies to JSON representations');
    return jsonpatch.applyPatch(JSON.parse(JSON.stringify(rep.data)), data, true).newDocument;
  }
  if (format === MERGE_PATCH) {
    if (!isJsonType(rep.type)) throw new Error('JSON Merge Patch applies to JSON representations');
    return applyMergePatch(rep.data, data);
  }
  if (!isJsonType(rep.type) && format === SPLICE) {
    const target = isTextType(rep.type) && data.unit === 'codepoint'
      ? (typeof rep.data === 'string' ? rep.data : Buffer.from(rep.data).toString('utf8'))
      : new Uint8Array(typeof rep.data === 'string' ? Buffer.from(rep.data, 'utf8') : rep.data);
    const out = applySplice(target, data);
    return isTextType(rep.type) && typeof out !== 'string' ? Buffer.from(out).toString('utf8') : out;
  }
  throw new Error(`${format} does not apply to ${rep.type}`);
}

// The update that brings the client's copy (`mine`) to the merged representation, for the response.
function updateFor(mine, merged, accept) {
  const u = buildUpdate(mine, merged, accept);
  if (!u.full) return { format: u.format, data: u.data };
  if (isJsonType(merged.type)) return { type: merged.type, data: merged.data };
  if (isTextType(merged.type)) return { type: merged.type, data: typeof merged.data === 'string' ? merged.data : Buffer.from(merged.data).toString('utf8') };
  return { type: merged.type, encoding: 'base64', data: base64Encode(merged.data) };
}

// Plans every change against the current versions: { entries, results, failed }.
async function plan(request, { store, context, newVersion }) {
  const merge = request.merge === true;
  const accept = request.accept && request.accept.map(a => a.toLowerCase());
  const names = Object.keys(request.changes);
  const reads = await Promise.all(names.map(r => store.getCurrent(r, context)));
  const results = Object.create(null);
  const entries = [];
  let failed = false;
  const fail = (r, result) => { results[r] = result; failed = true; };

  for (const [k, resource] of names.entries()) {
    const c = request.changes[resource];
    const format = c.format && c.format.toLowerCase();
    const current = reads[k];
    const base = c.base === null ? null : canonical(c.base);

    if (base === null) {
      if (current) { fail(resource, { status: 412, current: canonical(current.version) }); continue; }
      let data;
      try { data = representationOf(c); } catch (e) { fail(resource, { status: 422, reason: e.message }); continue; }
      const version = newVersion(resource);
      entries.push({ resource, expect: null, version, type: c.type, data });
      results[resource] = { status: 200, from: null, to: version };
      continue;
    }
    if (!current) { fail(resource, { status: 404 }); continue; }
    const cur = { ...current, type: current.type || 'application/json' };
    const now = canonical(current.version);

    if (sameVersion(base, current.version)) {
      if (c.delete) {
        entries.push({ resource, expect: now, deleted: true });
        results[resource] = { status: 200, from: base };
        continue;
      }
      let rep;
      try {
        rep = format ? { type: cur.type, data: applyPatch(format, cur, c.data) } : { type: c.type, data: representationOf(c) };
      } catch (e) { fail(resource, { status: 422, reason: e.message }); continue; }
      const version = newVersion(resource);
      entries.push({ resource, expect: now, version, type: rep.type, data: rep.data });
      results[resource] = { status: 200, from: base, to: version };
      continue;
    }

    // The resource moved on since the client's base.
    if (!merge) { fail(resource, { status: 412, current: now }); continue; }
    if (!format) { fail(resource, { status: 409, current: now, reason: 'a full representation or a deletion cannot be merged with a newer version' }); continue; }
    const baseRep = await store.getVersion(resource, base, context);
    if (!baseRep) { fail(resource, { status: 409, current: now, reason: 'the base version is no longer kept' }); continue; }
    const b = { ...baseRep, type: baseRep.type || 'application/json' };
    let mine;
    try {
      mine = { type: b.type, data: applyPatch(format, b, c.data) };
    } catch (e) { fail(resource, { status: 422, reason: e.message }); continue; }
    const merged = rebase(format, b, cur, c.data);
    if (merged.conflict) { fail(resource, { status: 409, current: now, reason: merged.conflict }); continue; }
    const version = newVersion(resource);
    entries.push({ resource, expect: now, version, type: cur.type, data: merged.data });
    results[resource] = { status: 200, from: base, to: version, rebased: true, update: updateFor(mine, { type: cur.type, data: merged.data }, accept) };
  }
  return { entries, results, failed };
}

const respondWith = (status, results) => ({ status, headers: { 'Content-Type': JSON_RESULT }, body: Buffer.from(JSON.stringify({ results })) });

// The whole protocol step for one write: content in, response out.
async function resolveWrite(bodyStr, { store, context, newVersion = defaultVersion, isResourceName }) {
  let request;
  try {
    request = JSON.parse(bodyStr || '');
  } catch {
    return problemOf(400, 'Bad Request', 'Request content is not valid JSON');
  }
  const invalid = validate(request, isResourceName);
  if (invalid) return problemOf(422, 'Unprocessable Content', invalid);
  if (Object.keys(request.changes).length > MAX_RESOURCES) return problemOf(413, 'Content Too Large', `At most ${MAX_RESOURCES} resources per request`);

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { entries, results, failed } = await plan(request, { store, context, newVersion });
    if (failed) {
      for (const r of Object.keys(request.changes)) if (results[r]?.status === 200) results[r] = { status: 424 };
      return respondWith(409, results);
    }
    const outcome = await store.write(entries, context);
    if (outcome.ok) return respondWith(200, results);
    // Another write landed between reading and writing: plan again from the new
    // versions. Statuses other than 412 are the store's answer (e.g. 403, 404).
    const statuses = outcome.statuses || {};
    if (Object.values(statuses).every(s => s === 412) && attempt + 1 < ATTEMPTS) continue;
    const out = Object.create(null);
    for (const r of Object.keys(request.changes)) out[r] = statuses[r] ? { status: statuses[r] } : { status: 424 };
    return respondWith(409, out);
  }
  return respondWith(409, {});
}

module.exports = { resolveWrite, SYNC_CHANGES_TYPE, validate };
