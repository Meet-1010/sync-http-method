'use strict';

const { syncFetch, createSyncClient, SyncClient, SyncError } = require('./fetch-client');
const { BaselineMap } = require('./baseline-map');
const { applyResult, applyMergePatch, JSON_PATCH, MERGE_PATCH, SNAPSHOT } = require('./apply');

module.exports = {
  createSyncClient, SyncClient, SyncError, syncFetch,
  BaselineMap, applyResult, applyMergePatch,
  JSON_PATCH, MERGE_PATCH, SNAPSHOT,
};
