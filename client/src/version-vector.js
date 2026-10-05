'use strict';

class VersionVector {
  constructor(initial = {}) {
    this._state = { ...initial };
  }

  get(resource) {
    return this._state[resource] || null;
  }

  set(resource, version) {
    this._state[resource] = version;
  }

  toJSON() {
    return { ...this._state };
  }

  applyDelta(deltaResponse) {
    if (!deltaResponse || !deltaResponse.deltas) return;
    for (const [resource, delta] of Object.entries(deltaResponse.deltas)) {
      if (delta.to_version) {
        this._state[resource] = delta.to_version;
      }
    }
  }
}

module.exports = { VersionVector };
