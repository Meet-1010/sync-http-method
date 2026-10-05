'use strict';

const { getVersion, getCurrentVersion, canComputeDeltaFrom } = require('./version-store');
const { computeDelta } = require('./delta-engine');

// Parse raw HTTP request buffer into { method, path, headers, body }
function parseRawHttp(buffer) {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;

  const headerSection = buffer.slice(0, headerEnd).toString('utf8');
  const bodyBuffer = buffer.slice(headerEnd + 4);
  const lines = headerSection.split('\r\n');
  const [method, path] = lines[0].split(' ');

  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon === -1) continue;
    const key = lines[i].slice(0, colon).trim().toLowerCase();
    const value = lines[i].slice(colon + 1).trim();
    headers[key] = value;
  }

  const contentLength = parseInt(headers['content-length'] || '0', 10);
  return { method, path, headers, bodyBuffer, contentLength };
}

function sendResponse(socket, status, statusText, extraHeaders, body) {
  const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const hdrs = {
    'Content-Type': 'application/sync-delta+json',
    'Content-Length': bodyBuf.length,
    'Connection': 'close',
    ...extraHeaders,
  };
  let head = `HTTP/1.1 ${status} ${statusText}\r\n`;
  for (const [k, v] of Object.entries(hdrs)) head += `${k}: ${v}\r\n`;
  head += '\r\n';

  socket.write(head);
  if (bodyBuf.length) socket.write(bodyBuf);
  socket.end();
}

function handleSyncRaw(socket, initialBuffer) {
  let buffer = initialBuffer;

  function tryProcess() {
    const parsed = parseRawHttp(buffer);
    if (!parsed) {
      socket.resume();
      socket.once('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        tryProcess();
      });
      return;
    }

    const { headers, bodyBuffer, contentLength } = parsed;

    if (bodyBuffer.length < contentLength) {
      socket.resume();
      socket.once('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        tryProcess();
      });
      return;
    }

    socket.resume();
    const bodyStr = bodyBuffer.slice(0, contentLength).toString('utf8');
    processSync(socket, bodyStr);
  }

  tryProcess();
}

function processSync(socket, bodyStr) {
  let parsed;
  try {
    parsed = JSON.parse(bodyStr || '{}');
  } catch {
    return sendResponse(socket, 422, 'Unprocessable Entity', {}, { error: 'Malformed JSON in request body' });
  }

  const { version_vector, resources } = parsed;

  if (!version_vector || typeof version_vector !== 'object' || Array.isArray(version_vector)) {
    return sendResponse(socket, 422, 'Unprocessable Entity', {}, { error: 'Missing or invalid version_vector' });
  }

  const resourceList = Array.isArray(resources) && resources.length > 0
    ? resources
    : Object.keys(version_vector);

  if (resourceList.length === 0) {
    return sendResponse(socket, 204, 'No Content', { 'Sync-Server-Version': '', 'Sync-Delta-Complete': 'true' }, null);
  }

  const deltas = {};
  let hasChanges = false;
  let serverVersion = null;

  for (const resource of resourceList) {
    const current = getCurrentVersion(resource);
    if (!current) {
      return sendResponse(socket, 404, 'Not Found', {}, { error: `Resource not found: ${resource}` });
    }

    serverVersion = current.id;
    const clientVersionId = version_vector[resource];

    if (!clientVersionId) {
      deltas[resource] = { from_version: null, to_version: current.id, operations: computeDelta({}, current.data) };
      hasChanges = true;
      continue;
    }

    if (!canComputeDeltaFrom(resource, clientVersionId)) {
      return sendResponse(socket, 409, 'Conflict', {}, { error: `Client version unrecognizable for resource: ${resource}` });
    }

    const clientSnapshot = getVersion(resource, clientVersionId);
    const ops = computeDelta(clientSnapshot.data, current.data);
    deltas[resource] = { from_version: clientVersionId, to_version: current.id, operations: ops };
    if (ops.length > 0) hasChanges = true;
  }

  const extraHeaders = {
    'Sync-Server-Version': serverVersion || '',
    'Sync-Delta-Complete': 'true',
  };

  if (!hasChanges) {
    return sendResponse(socket, 204, 'No Content', extraHeaders, null);
  }

  const responseBody = { deltas, server_version: serverVersion, synced_at: new Date().toISOString() };
  sendResponse(socket, 200, 'OK', extraHeaders, responseBody);
}

module.exports = { processSync };
