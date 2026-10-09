'use strict';

const net = require('net');

// TCP proxy that counts bytes and connections in both directions and adds a fixed
// one-way delay (plus one round trip for each new connection, as a TCP handshake).
// targetHost defaults to the loopback interface.
// options.jitterMs adds a random extra delay in [0, jitterMs) to every chunk, drawn
// from options.random (a seeded generator for reproducibility). Order is preserved.
function startProxy(targetPort, oneWayMs, targetHost = '127.0.0.1', { jitterMs = 0, random = Math.random } = {}) {
  const stats = { up: 0, down: 0, connections: 0 };
  const sockets = new Set();

  // Strict FIFO per direction: independent timers with equal deadlines may fire out of order.
  function pipe(from, to, key, handshake) {
    const queue = [];
    let last = 0;
    let first = true;
    let timer = null;

    const pump = () => {
      if (timer || !queue.length) return;
      timer = setTimeout(() => {
        timer = null;
        queue.shift().fn();
        pump();
      }, Math.max(0, queue[0].at - performance.now()));
    };
    const schedule = fn => {
      let at = performance.now() + oneWayMs + (first && handshake ? 2 * oneWayMs : 0) + (jitterMs ? random() * jitterMs : 0);
      first = false;
      if (at < last) at = last;
      last = at;
      queue.push({ at, fn });
      pump();
    };
    from.on('data', c => { stats[key] += c.length; schedule(() => { if (!to.destroyed) to.write(c); }); });
    from.on('end', () => schedule(() => { if (!to.destroyed) to.end(); }));
    from.on('error', () => to.destroy());
  }

  const srv = net.createServer(client => {
    stats.connections++;
    const upstream = net.connect(targetPort, targetHost);
    sockets.add(client); sockets.add(upstream);
    pipe(client, upstream, 'up', true);
    pipe(upstream, client, 'down', false);
  });

  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({
    port: srv.address().port,
    stats,
    close: () => new Promise(res => { for (const s of sockets) s.destroy(); srv.close(res); }),
  })));
}

module.exports = { startProxy };
