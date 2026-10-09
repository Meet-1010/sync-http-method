'use strict';

// Tracks the opaque version token the client holds for each resource.
class BaselineMap {
  constructor(initial = {}) {
    this._state = { ...initial };
  }

  get(resource) {
    return this._state[resource] ?? null;
  }

  set(resource, token) {
    this._state[resource] = token;
  }

  toJSON() {
    return { ...this._state };
  }

  // Advance tokens for every resource the server answered with 200 or 304.
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
