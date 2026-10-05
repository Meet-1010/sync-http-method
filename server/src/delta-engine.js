'use strict';

const jsonpatch = require('fast-json-patch');

function computeDelta(oldSnapshot, newSnapshot) {
  if (JSON.stringify(oldSnapshot) === JSON.stringify(newSnapshot)) return [];
  return jsonpatch.compare(oldSnapshot, newSnapshot);
}

module.exports = { computeDelta };
