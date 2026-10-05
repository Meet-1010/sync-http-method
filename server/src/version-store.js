'use strict';

// In-memory store: resource → [{ id, data, timestamp }, ...]
const store = new Map();

function seed() {
  addVersion('/users', 'v1', {
    '/users/1': { id: 1, name: 'Alice', email: 'alice@example.com' },
    '/users/2': { id: 2, name: 'Bob', email: 'bob@example.com' },
  });
  addVersion('/users', 'v2', {
    '/users/1': { id: 1, name: 'Alice', email: 'alice@example.com' },
    '/users/2': { id: 2, name: 'Bob', email: 'bob@example.com' },
    '/users/3': { id: 3, name: 'Carol', email: 'carol@example.com' },
  });
  addVersion('/users', 'v3', {
    '/users/1': { id: 1, name: 'Alice', email: 'alice_new@example.com' },
    '/users/2': { id: 2, name: 'Bob', email: 'bob@example.com' },
    '/users/3': { id: 3, name: 'Carol', email: 'carol@example.com' },
  });

  addVersion('/posts', 'v1', {
    '/posts/1': { id: 1, title: 'Hello World', body: 'First post' },
  });
  addVersion('/posts', 'v2', {
    '/posts/1': { id: 1, title: 'Hello World', body: 'First post' },
    '/posts/2': { id: 2, title: 'SYNC Method', body: 'A new HTTP method' },
  });

  addVersion('/config', 'v1', {
    '/config/timeout': 10,
    '/config/retries': 3,
  });
  addVersion('/config', 'v2', {
    '/config/timeout': 20,
    '/config/retries': 3,
  });
  addVersion('/config', 'v3', {
    '/config/timeout': 30,
    '/config/retries': 5,
  });
}

function addVersion(resource, id, data) {
  if (!store.has(resource)) store.set(resource, []);
  store.get(resource).push({ id, data, timestamp: new Date().toISOString() });
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

function canComputeDeltaFrom(resource, versionId) {
  return getVersion(resource, versionId) !== null;
}

function listResources() {
  return [...store.keys()];
}

seed();

module.exports = { addVersion, getVersion, getCurrentVersion, canComputeDeltaFrom, listResources };
