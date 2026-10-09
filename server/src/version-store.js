'use strict';

// In-memory versioned store implementing the SYNC store interface.
// maxVersions bounds history per resource; older tokens then get a snapshot.
function createMemoryStore({ maxVersions = Infinity } = {}) {
  const store = new Map();

  function addVersion(resource, id, data) {
    if (!store.has(resource)) store.set(resource, []);
    const versions = store.get(resource);
    versions.push({ id, data, timestamp: new Date().toISOString() });
    if (versions.length > maxVersions) versions.splice(0, versions.length - maxVersions);
  }

  function getVersion(resource, versionId) {
    const versions = store.get(resource);
    if (!versions) return null;
    return versions.find(v => v.id === versionId) || null;
  }

  function getCurrentVersion(resource) {
    const versions = store.get(resource);
    if (!versions || versions.length === 0) return null;
    return versions[versions.length - 1];
  }

  return {
    addVersion,
    getVersion,
    getCurrentVersion,
    canComputeDeltaFrom: (resource, versionId) => getVersion(resource, versionId) !== null,
    listResources: () => [...store.keys()],
    // the two methods the SYNC resolver needs
    getCurrent: getCurrentVersion,
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
  '/posts/2': { id: 2, title: 'SYNC Method', body: 'A new HTTP method' },
});

demo.addVersion('/config', 'v1', { '/config/timeout': 10, '/config/retries': 3 });
demo.addVersion('/config', 'v2', { '/config/timeout': 20, '/config/retries': 3 });
demo.addVersion('/config', 'v3', { '/config/timeout': 30, '/config/retries': 5 });

module.exports = { createMemoryStore, ...demo, demoStore: demo };
