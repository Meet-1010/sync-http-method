'use strict';

const net = require('net');
const http = require('http');
const { processSync, sendProblem, MAX_BODY_BYTES, MAX_HEADER_BYTES } = require('./sync-handler');
const { syncHandler } = require('./handler');

const IDLE_TIMEOUT_MS = 30_000;

function parseHead(headBuf) {
  const lines = headBuf.toString('utf8').split('\r\n');
  const [method, target = '/', version = 'HTTP/1.1'] = lines[0].split(' ');
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon === -1) continue;
    headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
  }
  return { method, target, version, headers };
}

function wantsKeepAlive(version, headers) {
  const conn = (headers['connection'] || '').toLowerCase();
  if (conn.includes('close')) return false;
  return version === 'HTTP/1.1' || conn.includes('keep-alive');
}

// Adds the optional dedicated SYNC method on top of syncHandler (QUERY and POST),
// which most deployments should use directly. Node's parser rejects unknown methods,
// so this front reads raw TCP: SYNC requests are handled here, several per connection,
// and the first request with any other method hands the rest of that connection to
// the app. A connection that mixes the SYNC method with other methods is therefore
// not supported; clients that need that use QUERY.
function createSyncServer({ app, store } = {}) {
  const handle = syncHandler({ store });
  const fallback = app || ((req, res) => { res.statusCode = 404; res.end(); });
  const appServer = http.createServer((req, res) => handle(req, res, () => fallback(req, res)));
  let internalPort = null;
  const openSockets = new Set();

  // allowHalfOpen: a client may half-close after sending its request and still expect a response.
  const server = net.createServer({ allowHalfOpen: true }, socket => {
  let buffer = Buffer.alloc(0);
  let processing = false;
  let handedOff = false;
  let clientEnded = false;
  openSockets.add(socket);
  socket.on('close', () => openSockets.delete(socket));
  socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());

  function handOffToExpress() {
    handedOff = true;
    socket.removeListener('data', onData);
    socket.pause(); // bytes arriving before the upstream connects must be kept, not dropped
    socket.setTimeout(0);
    const proxy = net.connect(internalPort, () => {
      proxy.write(buffer);
      buffer = Buffer.alloc(0);
      socket.pipe(proxy);
      proxy.pipe(socket);
    });
    proxy.on('error', () => socket.destroy());
    socket.on('error', () => proxy.destroy());
  }

  async function drain() {
    if (processing) return;
    processing = true;
    try {
      for (;;) {
        if (buffer.indexOf('\r\n') === -1) return;

        const method = buffer.slice(0, buffer.indexOf(' ')).toString('ascii');
        if (method !== 'SYNC') return handOffToExpress();

        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          if (buffer.length > MAX_HEADER_BYTES) {
            socket.removeListener('data', onData);
            return sendProblem(socket, 431, 'Headers too large');
          }
          return;
        }

        const { version, headers, target } = parseHead(buffer.slice(0, headerEnd));
        const bodyStart = headerEnd + 4;

        if (headers['transfer-encoding']) {
          socket.removeListener('data', onData);
          return sendProblem(socket, 411, 'SYNC requires Content-Length; chunked bodies are not supported');
        }

        const contentLength = parseInt(headers['content-length'] || '0', 10);
        if (!(contentLength >= 0) || contentLength > MAX_BODY_BYTES) {
          socket.removeListener('data', onData);
          return sendProblem(socket, 413, `Content exceeds ${MAX_BODY_BYTES} bytes`);
        }

        if (buffer.length < bodyStart + contentLength) return;

        const bodyStr = buffer.slice(bodyStart, bodyStart + contentLength).toString('utf8');
        buffer = buffer.slice(bodyStart + contentLength);
        const keepAlive = wantsKeepAlive(version, headers);

        await processSync(socket, bodyStr, headers, keepAlive, store, target);
        if (!keepAlive) {
          socket.removeListener('data', onData);
          return;
        }
      }
    } finally {
      processing = false;
      if (clientEnded && !handedOff && !socket.writableEnded) socket.end();
    }
  }

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    drain().catch(() => socket.destroy());
  }

  socket.on('data', onData);
  socket.on('end', () => {
    clientEnded = true;
    if (!handedOff && !processing && !socket.writableEnded) socket.end();
  });
  socket.on('error', () => {});
});

  return {
    server,
    listen(port, host, cb) {
      if (typeof host === 'function') { cb = host; host = undefined; }
      appServer.listen(0, '127.0.0.1', () => {
        internalPort = appServer.address().port;
        server.listen(port, host, cb);
      });
      return this;
    },
    address: () => server.address(),
    close(cb) {
      server.close(() => appServer.close(cb));
      for (const s of openSockets) s.destroy();
      appServer.closeAllConnections?.();
    },
  };
}

module.exports = { createSyncServer };
