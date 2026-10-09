'use strict';

// Tracks the version the client holds for each resource (an identifier or a set of identifiers).
class BaselineMap {
  constructor(initial = {}) {
    this._state = { ...initial };
  }

  get(resource) {
    return this._state[resource] ?? null;
  }

  set(resource, version) {
    this._state[resource] = version;
  }

  toJSON() {
    return { ...this._state };
  }

  // Advance the version of every resource the server answered with 200 or 304.
  applyResults(responseBody) {
    if (!responseBody || !responseBody.results) return;
    for (const [resource, result] of Object.entries(responseBody.results)) {
      if ((result.status === 200 || result.status === 304) && result.to) {
        this._state[resource] = result.to;
      }
    }
  }
}

module.exports = { BaselineMap };
