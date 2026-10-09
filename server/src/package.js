'use strict';

const { createSyncServer } = require('./create-server');
const { syncHandler, SYNC_TYPE } = require('./handler');
const { computeResults } = require('./sync-core');
const { createMemoryStore } = require('./version-store');
const { buildUpdate, JSON_PATCH, MERGE_PATCH, SNAPSHOT } = require('./delta-engine');

module.exports = {
  createSyncServer, syncHandler, computeResults, createMemoryStore,
  buildUpdate, JSON_PATCH, MERGE_PATCH, SNAPSHOT, SYNC_TYPE,
};
