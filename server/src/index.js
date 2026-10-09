'use strict';

const net = require('net');
const http = require('http');
const express = require('express');
const { processSync, sendResponse, MAX_BODY_BYTES, MAX_HEADER_BYTES } = require('./sync-handler');
const { syncOverPost } = require('./express-middleware');

const IDLE_TIMEOUT_MS = 30_000;

const app = express();
app.use(syncOverPost());
app.use(express.json());

app.get('/api/users', (req, res) => res.json({ resource: 'users' }));
app.get('/api/posts', (req, res) => res.json({ resource: 'posts' }));
app.get('/api/config', (req, res) => res.json({ resource: 'config' }));

app.post('/api/users', (req, res) => res.status(201).json({ created: true }));
app.post('/api/posts', (req, res) => res.status(201).json({ created: true }));
app.post('/api/config', (req, res) => res.status(201).json({ created: true }));

const expressServer = http.createServer(app);
let internalPort = null;
const openSockets = new Set();

function parseHead(headBuf) {
  const lines = headBuf.toString('utf8').split('\r\n');
  const [method, , version = 'HTTP/1.1'] = lines[0].split(' ');
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon === -1) continue;
    headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
  }
  return { method, version, headers };
}

function wantsKeepAlive(version, headers) {
  const conn = (headers['connection'] || '').toLowerCase();
  if (conn.includes('close')) return false;
  return version === 'HTTP/1.1' || conn.includes('keep-alive');
}

// Main server: raw TCP, bypasses llhttp's method validation. SYNC requests are
// handled here, several per connection. The first request with any other method
// hands the rest of that connection to Express, so a connection that mixes SYNC
// with other methods is not supported (use the POST form for those clients).
const server = net.createServer(socket => {
  let buffer = Buffer.alloc(0);
  let processing = false;
  openSockets.add(socket);
  socket.on('close', () => openSockets.delete(socket));
  socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());

  function handOffToExpress() {
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
            return sendResponse(socket, 431, 'Request Header Fields Too Large', {}, { error: 'Headers too large' });
          }
          return;
        }

        const { version, headers } = parseHead(buffer.slice(0, headerEnd));
        const bodyStart = headerEnd + 4;

        if (headers['transfer-encoding']) {
          socket.removeListener('data', onData);
          return sendResponse(socket, 411, 'Length Required', {}, { error: 'SYNC requires Content-Length; chunked bodies are not supported' });
        }

        const contentLength = parseInt(headers['content-length'] || '0', 10);
        if (!(contentLength >= 0) || contentLength > MAX_BODY_BYTES) {
          socket.removeListener('data', onData);
          return sendResponse(socket, 413, 'Content Too Large', {}, { error: `Body exceeds ${MAX_BODY_BYTES} bytes` });
        }

        if (buffer.length < bodyStart + contentLength) return;

        const bodyStr = buffer.slice(bodyStart, bodyStart + contentLength).toString('utf8');
        buffer = buffer.slice(bodyStart + contentLength);
        const keepAlive = wantsKeepAlive(version, headers);

        await processSync(socket, bodyStr, headers, keepAlive);
        if (!keepAlive) {
          socket.removeListener('data', onData);
          return;
        }
      }
    } finally {
      processing = false;
    }
  }

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    drain().catch(() => socket.destroy());
  }

  socket.on('data', onData);
  socket.on('error', () => {});
});

function startServer(port, cb) {
  expressServer.listen(0, '127.0.0.1', () => {
    internalPort = expressServer.address().port;
    server.listen(port, cb);
  });
}

function stopServer(cb) {
  server.close(() => expressServer.close(cb));
  for (const s of openSockets) s.destroy();
  expressServer.closeAllConnections?.();
}

if (require.main === module) {
  startServer(process.env.PORT || 3000, () => {
    console.log(`SYNC server on port ${process.env.PORT || 3000} (internal Express on ${internalPort})`);
  });
}

module.exports = { server, startServer, stopServer, app };
