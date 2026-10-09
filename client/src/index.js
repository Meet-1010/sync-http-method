'use strict';

const { syncFetch, createSyncClient, SyncClient, SyncError } = require('./fetch-client');
const { BaselineMap } = require('./baseline-map');
const { applyResult, applyMergePatch, applySplice, JSON_PATCH, MERGE_PATCH, SPLICE } = require('./apply');

module.exports = {
  createSyncClient, SyncClient, SyncError, syncFetch,
  BaselineMap, applyResult, applyMergePatch, applySplice,
  JSON_PATCH, MERGE_PATCH, SPLICE,
};
