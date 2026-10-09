'use strict';

// Braid range patches for the benchmark data: one patch per changed item, with a
// JSON Pointer range as in draft-toomim-httpbis-range-patch-00 ("json /foo/bar/3").
// The full document is sent instead when the patches are not smaller.

const clone = v => JSON.parse(JSON.stringify(v));

function braidUpdate(base, cur) {
  const keys = Object.keys(cur.data).filter(k => JSON.stringify(base.data[k]) !== JSON.stringify(cur.data[k]));
  // JSON ranges are JSON Pointers, as in draft-toomim-httpbis-range-patch-00 ("Content-Range: json /foo/bar/3").
  const patches = keys.map(k => ({ unit: 'json', range: `/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, content: JSON.stringify(cur.data[k]) }));
  const patchBytes = patches.reduce((n, p) => n + p.range.length + p.content.length, 0);
  const snapshot = JSON.stringify(cur.data);
  return patchBytes < snapshot.length ? { patches } : { body: snapshot };
}

function applyBraid(local, update) {
  const text = v => (typeof v === 'string' ? v : Buffer.from(v).toString('utf8'));
  if (update.patches) {
    const out = clone(local);
    for (const p of update.patches) {
      const key = p.range.slice(1).replace(/~1/g, '/').replace(/~0/g, '~');
      out[key] = JSON.parse(p.content_text ?? text(p.content));
    }
    return out;
  }
  return JSON.parse(update.body_text ?? text(update.body));
}

module.exports = { braidUpdate, applyBraid };
