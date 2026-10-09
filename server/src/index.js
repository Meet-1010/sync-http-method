'use strict';

const net = require('net');
const http = require('http');
const express = require('express');
const { processSync, sendResponse, MAX_BODY_BYTES, MAX_HEADER_BYTES } = require('./sync-handler');

const app = express();
app.use(express.json());

app.get('/api/users', (req, res) => res.json({ resource: 'users' }));
app.get('/api/posts', (req, res) => res.json({ resource: 'posts' }));
app.get('/api/config', (req, res) => res.json({ resource: 'config' }));

app.post('/api/users', (req, res) => res.status(201).json({ created: true }));
app.post('/api/posts', (req, res) => res.status(201).json({ created: true }));
app.post('/api/config', (req, res) => res.status(201).json({ created: true }));

const expressServer = http.createServer(app);
let internalPort = null;

// Main server: raw TCP, bypasses llhttp method validation
const server = net.createServer(socket => {
  let buffer = Buffer.alloc(0);

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);

    // Wait for the first line to determine method
    const firstCrlf = buffer.indexOf('\r\n');
    if (firstCrlf === -1) return;

    const method = buffer.slice(0, buffer.indexOf(' ')).toString('ascii');

    if (method !== 'SYNC') {
      socket.removeListener('data', onData);
      const proxy = net.connect(internalPort, () => {
        proxy.write(buffer);
        socket.pipe(proxy);
        proxy.pipe(socket);
      });
      proxy.on('error', () => socket.destroy());
      socket.on('error', () => proxy.destroy());
      return;
    }

    // For SYNC: accumulate until headers + full body are present
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      if (buffer.length > MAX_HEADER_BYTES) {
        socket.removeListener('data', onData);
        sendResponse(socket, 431, 'Request Header Fields Too Large', {}, { error: 'Headers too large' });
      }
      return;
    }

    const headerSection = buffer.slice(0, headerEnd).toString('utf8');
    const lines = headerSection.split('\r\n');
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const colon = lines[i].indexOf(':');
      if (colon === -1) continue;
      const k = lines[i].slice(0, colon).trim().toLowerCase();
      headers[k] = lines[i].slice(colon + 1).trim();
    }

    const contentLength = parseInt(headers['content-length'] || '0', 10);
    const bodyStart = headerEnd + 4;

    if (!(contentLength >= 0) || contentLength > MAX_BODY_BYTES) {
      socket.removeListener('data', onData);
      return sendResponse(socket, 413, 'Content Too Large', {}, { error: `Body exceeds ${MAX_BODY_BYTES} bytes` });
    }

    if (buffer.length < bodyStart + contentLength) return; // need more data

    socket.removeListener('data', onData);
    const bodyStr = buffer.slice(bodyStart, bodyStart + contentLength).toString('utf8');
    processSync(socket, bodyStr, headers);
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
}

if (require.main === module) {
  startServer(process.env.PORT || 3000, () => {
    console.log(`SYNC server on port ${process.env.PORT || 3000} (internal Express on ${internalPort})`);
  });
}

module.exports = { server, startServer, stopServer };
