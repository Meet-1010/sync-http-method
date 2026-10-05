'use strict';

const http = require('http');
const { URL } = require('url');

function syncRequest(rawUrl, versionVector, resources) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const body = JSON.stringify({ version_vector: versionVector, resources: resources || Object.keys(versionVector) });

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname,
      method: 'SYNC',
      headers: {
        'Content-Type': 'application/sync-vector+json',
        'Accept': 'application/sync-delta+json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      if (res.statusCode === 204) return resolve(null);

      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { syncRequest };
