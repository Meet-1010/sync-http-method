'use strict';

// A shared cache (a CDN edge) in front of an origin on this machine, listening on
// 127.0.0.1:port: nginx (nginx:1.27-alpine) or Varnish (varnish:7.6), chosen by the
// template's extension (.vcl.template for Varnish). The configuration is generated
// from the template (the repository must be mountable by Docker).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const NAME = 'sync-bench-edge';

async function waitFor(url) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(url); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error(`not reachable: ${url}`);
}

async function startEdge({ template, conf, originPort, port }) {
  fs.writeFileSync(conf, fs.readFileSync(template, 'utf8').replace('__ORIGIN_PORT__', String(originPort)));
  stopEdge();
  const varnish = template.endsWith('.vcl.template');
  const args = varnish
    // Long-lived streams each hold a worker thread: allow enough of them, and a
    // queue for bursts, so that the cache never refuses requests for lack of threads.
    ? ['-v', `${conf}:/etc/varnish/default.vcl:ro`, '-e', 'VARNISH_SIZE=1G', 'varnish:7.6',
      '-p', 'thread_pool_min=1000', '-p', 'thread_pool_max=5000', '-p', 'thread_queue_limit=10000', '-p', 'timeout_idle=3600']
    : ['-v', `${conf}:/etc/nginx/nginx.conf:ro`, 'nginx:1.27-alpine'];
  execFileSync('docker', ['run', '-d', '--name', NAME, '--ulimit', 'nofile=1048576:1048576', '-p', `127.0.0.1:${port}:80`, ...args], { stdio: 'ignore' });
  await waitFor(`http://127.0.0.1:${port}/__ready`);
}

function stopEdge() {
  try { execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' }); } catch { /* not running */ }
}

// Closed connections hold their local port for 2 MSL (30 s on macOS, 60 s on Linux),
// and a machine has a limited range of ephemeral ports (about 16000 on macOS).
// Docker's port forwarding also opens connections inside the Docker host (on macOS,
// a Linux VM). waitForPorts() waits until earlier runs' connections have released
// their ports on both, so that a large run does not run out.
function timeWaitCounts() {
  const host = execFileSync('netstat', ['-an', '-p', 'tcp'], { encoding: 'utf8' }).split('\n').filter(l => l.includes('TIME_WAIT')).length;
  const sockstat = execFileSync('docker', ['run', '--rm', '--net=host', 'nginx:1.27-alpine', 'cat', '/proc/net/sockstat'], { encoding: 'utf8' });
  const docker = Number((/\btw (\d+)/.exec(sockstat) || [])[1] || 0);
  return { host, docker };
}

async function waitForPorts(limit = 500) {
  for (let i = 0; i < 90; i++) {
    let counts;
    try {
      counts = timeWaitCounts();
    } catch {
      return;
    }
    if (counts.host < limit && counts.docker < limit) return;
    await new Promise(r => setTimeout(r, 2000));
  }
}

module.exports = { startEdge, stopEdge, waitFor, waitForPorts };
