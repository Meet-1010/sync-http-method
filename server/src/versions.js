'use strict';

// A version is a non-empty set of version identifiers (strings), as in Braid's
// versioning model: one identifier after a single change, several after a merge.
// On the wire a single identifier MAY be written as a string; otherwise it is an
// array whose order carries no meaning.

const isVersion = v =>
  (typeof v === 'string' && v.length > 0) ||
  (Array.isArray(v) && v.length > 0 && v.every(id => typeof id === 'string' && id.length > 0) && new Set(v).size === v.length);

// Canonical wire form: a string for one identifier, otherwise a sorted array.
function canonical(v) {
  const ids = typeof v === 'string' ? [v] : [...v].sort();
  return ids.length === 1 ? ids[0] : ids;
}

// Stable key for maps and comparisons.
const versionKey = v => JSON.stringify(typeof v === 'string' ? [v] : [...v].sort());

const sameVersion = (a, b) => a != null && b != null && versionKey(a) === versionKey(b);

module.exports = { isVersion, canonical, versionKey, sameVersion };
