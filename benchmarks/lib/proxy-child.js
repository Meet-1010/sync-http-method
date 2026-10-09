'use strict';

// Runs one startProxy() in its own process, so that the clients' work in the parent
// process cannot delay accepting connections or forwarding bytes. Controlled over IPC.

const { startProxy } = require('./proxy');

const [targetPort, oneWayMs, targetHost] = process.argv.slice(2);
startProxy(Number(targetPort), Number(oneWayMs), targetHost).then(proxy => {
  process.send({ port: proxy.port });
  process.on('message', async m => {
    if (m === 'stats') process.send({ stats: { ...proxy.stats } });
    if (m === 'close') { await proxy.close(); process.send({ closed: true }); process.exit(0); }
  });
});
