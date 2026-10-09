'use strict';

// Helpers for driving a real Mercure.rocks hub (Docker image dunglas/mercure),
// started as described in benchmarks/README.md.

const crypto = require('crypto');
const { delta } = require('./updates');

const MERCURE_URL = process.env.MERCURE_URL || 'http://127.0.0.1:3480';
const MERCURE_PUBLISHER_KEY = process.env.MERCURE_PUBLISHER_KEY || 'bench-publisher-secret-key-0123456789abcdef';
const MERCURE_SUBSCRIBER_KEY = process.env.MERCURE_SUBSCRIBER_KEY || 'bench-subscriber-secret-key-0123456789abcdef';

function mercureToken(action, audience, key) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'at+jwt' });
  const p = b64({
    iss: 'https://localhost', aud: audience, sub: 'bench', client_id: 'bench', iat: now, exp: now + 3600, jti: crypto.randomUUID(),
    authorization_details: [{ type: 'https://mercure.rocks/authorization-detail', actions: [action], topics: [{ match: '*' }] }],
  });
  return `${h}.${p}.${crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64url')}`;
}

async function mercurePublish(topic, data) {
  const res = await fetch(`${MERCURE_URL}/.well-known/mercure`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mercureToken('publish', `${MERCURE_URL}/.well-known/mercure`, MERCURE_PUBLISHER_KEY)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ topic, data }),
  });
  if (res.status !== 200) throw new Error(`Mercure publish failed: ${res.status}`);
  return res.text();
}

async function mercureAvailable() {
  try {
    return (await fetch(MERCURE_URL, { signal: AbortSignal.timeout(1500) })).status === 200;
  } catch {
    return false;
  }
}


// Publishes this configuration's history to the hub; the subscriber later resumes from the marker.
// With { markers: true }, a marker is also published after each round, so a subscriber
// can resume from any round g: markers[g], expecting counts[g] events.
async function mercureSetup({ history, N, L }, prefix, { markers: perRound = false } = {}) {
  const topic = i => `${prefix}/r/${i}`;
  const marker = await mercurePublish(`${prefix}/marker`, 'start');
  const markers = [marker];
  const published = [0];
  let count = 0;
  for (let r = 1; r <= L; r++) {
    for (let i = 0; i < N; i++) {
      const idx = history[i].findIndex(e => e.round === r);
      if (idx < 1) continue;
      const u = delta(history[i][idx - 1].data, history[i][idx].data);
      await mercurePublish(topic(i), JSON.stringify({ topic: i, format: u.format, data: u.data }));
      count++;
    }
    if (perRound && r < L) {
      markers.push(await mercurePublish(`${prefix}/marker`, `round ${r}`));
      published.push(count);
    }
  }
  return { marker, count, topic, markers, counts: published.map(p => count - p) };
}

module.exports = {
  MERCURE_URL, MERCURE_PUBLISHER_KEY, MERCURE_SUBSCRIBER_KEY,
  mercureToken, mercurePublish, mercureAvailable, mercureSetup,
};
