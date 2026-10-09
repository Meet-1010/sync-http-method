'use strict';

const { createSyncServer } = require('./create-server');
const { syncOverPost, SYNC_TYPE } = require('./post-form');
const { computeResults } = require('./sync-core');
const { createMemoryStore } = require('./version-store');
const { buildUpdate, JSON_PATCH, MERGE_PATCH, SNAPSHOT } = require('./delta-engine');

module.exports = {
  createSyncServer, syncOverPost, computeResults, createMemoryStore,
  buildUpdate, JSON_PATCH, MERGE_PATCH, SNAPSHOT, SYNC_TYPE,
};
