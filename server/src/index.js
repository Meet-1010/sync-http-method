'use strict';

const express = require('express');
const { createSyncServer } = require('./create-server');

// Example app: ordinary routes plus SYNC (method and POST form) over the demo store.
const app = express();
app.use(express.json());

app.get('/api/users', (req, res) => res.json({ resource: 'users' }));
app.get('/api/posts', (req, res) => res.json({ resource: 'posts' }));
app.get('/api/config', (req, res) => res.json({ resource: 'config' }));

app.post('/api/users', (req, res) => res.status(201).json({ created: true }));
app.post('/api/posts', (req, res) => res.status(201).json({ created: true }));
app.post('/api/config', (req, res) => res.status(201).json({ created: true }));

const sync = createSyncServer({ app });
const server = sync.server;

function startServer(port, cb) {
  sync.listen(port, cb);
}

function stopServer(cb) {
  sync.close(cb);
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  startServer(port, () => console.log(`SYNC demo server on port ${port}`));
}

module.exports = { server, startServer, stopServer, app };
