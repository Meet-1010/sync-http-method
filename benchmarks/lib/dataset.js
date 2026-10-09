'use strict';

// Deterministic synthetic dataset shared by the benchmarks.
//
// N resources, each a JSON object of ITEMS items (about 20 KB). Over MAX_ROUNDS
// rounds about CHANGE_FRACTION of the resources change per round (at least one),
// and each change rewrites ITEMS_PER_CHANGE items. Item text is drawn from a
// seeded vocabulary so it is not trivially compressible.

const ITEMS = 100;
const MAX_ROUNDS = 25;
const CHANGE_FRACTION = 0.2;
const ITEMS_PER_CHANGE = 3;

function rng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ('account update message report session product design review budget meeting deploy server client '
  + 'network cache release feature planning customer invoice payment shipping order status archive profile settings '
  + 'notification schedule calendar document template workflow analytics dashboard export import backup restore '
  + 'security audit policy token request response latency throughput queue worker cluster region storage index '
  + 'search filter sort render layout theme font image video audio stream upload download share comment reply '
  + 'mention thread channel project task sprint ticket issue branch merge commit build test pipeline monitor alert').split(' ');

// Seeded text so bodies have realistic (not trivially compressible) entropy.
function makeBody(id, rev) {
  const r = rng(id * 7919 + rev * 104729 + 17);
  return Array.from({ length: 14 }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
}

const makeItem = (id, rev) => ({
  id,
  title: `Post ${id}: ${makeBody(id, rev).split(' ').slice(0, 3).join(' ')}`,
  body: makeBody(id, rev),
  likes: rev * 3 + (id % 7),
  updated: `2026-10-05T10:${String(rev % 60).padStart(2, '0')}:00Z`,
});

const clone = v => JSON.parse(JSON.stringify(v));

// history[i] = [{ round, token, data }, ...]; a resource only gets a new entry in rounds where it changed.
function buildHistories(N) {
  const rand = rng(1000 + N);
  const history = [];
  for (let i = 0; i < N; i++) {
    const data = {};
    for (let id = 1; id <= ITEMS; id++) data[id] = makeItem(id, 0);
    history.push([{ round: 0, token: 'v0', data }]);
  }
  for (let r = 1; r <= MAX_ROUNDS; r++) {
    for (let i = 0; i < N; i++) {
      if (i !== r % N && rand() >= CHANGE_FRACTION) continue;
      const last = history[i][history[i].length - 1];
      const data = clone(last.data);
      const picked = new Set();
      while (picked.size < ITEMS_PER_CHANGE) picked.add(1 + Math.floor(rand() * ITEMS));
      for (const id of picked) data[id] = makeItem(id, r);
      history[i].push({ round: r, token: `v${history[i].length}`, data });
    }
  }
  return history;
}

const entryAt = (h, L) => h.filter(e => e.round <= L).pop();

module.exports = { rng, buildHistories, entryAt, clone, ITEMS, MAX_ROUNDS, CHANGE_FRACTION, ITEMS_PER_CHANGE };
