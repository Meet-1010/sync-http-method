'use strict';

const { canonical, versionKey } = require('./versions');

// In-memory versioned store implementing the SYNC store interface.
//
//   getCurrent(resource)          -> { version, type, data } | null
//   getVersion(resource, version) -> { version, type, data } | null
//   snapshot()                    -> a read view of every resource at one instant
//
// maxVersions bounds the history kept per resource; older versions then yield
// a full representation. commit() applies changes to several resources
// atomically: a snapshot sees all of them or none.
function createMemoryStore({ maxVersions = Infinity } = {}) {
  const histories = new Map(); // resource -> [{ version, type, data, seq }]
  let seq = 0;

  function append(resource, version, data, type, at) {
    if (!histories.has(resource)) histories.set(resource, []);
    const list = histories.get(resource);
    list.push({ version: canonical(version), type: type || 'application/json', data, seq: at });
    if (list.length > maxVersions) list.splice(0, list.length - maxVersions);
  }

  // addVersion(resource, version, data, type?) where version is a string or an
  // array of strings (a merge); type defaults to application/json.
  function addVersion(resource, version, data, type) {
    append(resource, version, data, type, ++seq);
  }

  // commit([{ resource, version, data, type? }, ...]) applies all at one instant.
  function commit(changes) {
    const at = ++seq;
    for (const c of changes) append(c.resource, c.version, c.data, c.type, at);
  }

  const view = upTo => ({
    getCurrent(resource) {
      const list = histories.get(resource);
      if (!list) return null;
      for (let i = list.length - 1; i >= 0; i--) if (list[i].seq <= upTo) return list[i];
      return null;
    },
    getVersion(resource, version) {
      const list = histories.get(resource);
      if (!list) return null;
      const key = versionKey(version);
      return list.find(v => v.seq <= upTo && versionKey(v.version) === key) || null;
    },
  });

  const live = view(Infinity);

  return {
    addVersion,
    commit,
    getCurrent: live.getCurrent,
    getVersion: live.getVersion,
    getCurrentVersion: live.getCurrent,
    snapshot: () => view(seq),
    listResources: () => [...histories.keys()],
  };
}

// Demo data used by the example server, tests and benchmark.
const demo = createMemoryStore();

demo.addVersion('/users', 'v1', {
  '/users/1': { id: 1, name: 'Alice', email: 'alice@example.com' },
  '/users/2': { id: 2, name: 'Bob', email: 'bob@example.com' },
});
demo.addVersion('/users', 'v2', {
  '/users/1': { id: 1, name: 'Alice', email: 'alice@example.com' },
  '/users/2': { id: 2, name: 'Bob', email: 'bob@example.com' },
  '/users/3': { id: 3, name: 'Carol', email: 'carol@example.com' },
});
demo.addVersion('/users', 'v3', {
  '/users/1': { id: 1, name: 'Alice', email: 'alice_new@example.com' },
  '/users/2': { id: 2, name: 'Bob', email: 'bob@example.com' },
  '/users/3': { id: 3, name: 'Carol', email: 'carol@example.com' },
});

demo.addVersion('/posts', 'v1', { '/posts/1': { id: 1, title: 'Hello World', body: 'First post' } });
demo.addVersion('/posts', 'v2', {
  '/posts/1': { id: 1, title: 'Hello World', body: 'First post' },
  '/posts/2': { id: 2, title: 'SYNC', body: 'Catching up many resources in one request' },
});

demo.addVersion('/config', 'v1', { '/config/timeout': 10, '/config/retries': 3 });
demo.addVersion('/config', 'v2', { '/config/timeout': 20, '/config/retries': 3 });
demo.addVersion('/config', 'v3', { '/config/timeout': 30, '/config/retries': 5 });

module.exports = { createMemoryStore, ...demo, demoStore: demo };
