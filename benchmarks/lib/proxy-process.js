'use strict';

const path = require('path');
const { fork } = require('child_process');

// Children still running when this process exits (for example after an error) are stopped.
const running = new Set();
process.on('exit', () => { for (const c of running) c.kill(); });

// startProxy() in a child process (see proxy-child.js): { port, stats(), close() }.
function startProxyProcess(targetPort, oneWayMs, targetHost = '127.0.0.1') {
  const child = fork(path.join(__dirname, 'proxy-child.js'), [String(targetPort), String(oneWayMs), targetHost]);
  running.add(child);
  child.on('exit', () => running.delete(child));
  const waiting = [];
  child.on('message', m => { if (!m.port) waiting.shift()(m); });
  const ask = msg => new Promise(r => { waiting.push(r); child.send(msg); });
  return new Promise(resolve => child.once('message', m => resolve({
    port: m.port,
    stats: async () => (await ask('stats')).stats,
    close: () => ask('close'),
  })));
}

module.exports = { startProxyProcess };
