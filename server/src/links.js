'use strict';

const crypto = require('crypto');

// Opaque, deterministic, authenticated identifiers for update resources.
//
// The same (resource, from, to, format) always yields the same identifier, so
// shared caches can reuse a response across clients. The identifier reveals
// neither resource names nor version tokens, and cannot be forged or altered.
//
// Construction (deterministic authenticated encryption, synthetic IV):
//   iv  = HMAC-SHA256(macKey, plaintext)[0..16)
//   ct  = AES-256-CTR(encKey, iv, plaintext)
//   id  = base64url(iv || ct)
// Decoding decrypts and recomputes the HMAC; a mismatch means the identifier was
// not issued with this secret.

function deriveKeys(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('links.secret must be a string of at least 32 characters');
  }
  const ikm = Buffer.from(secret, 'utf8');
  const derive = info => Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(info), 32));
  return { encKey: derive('sync-links/enc'), macKey: derive('sync-links/mac') };
}

function createLinkCodec(secret) {
  const { encKey, macKey } = deriveKeys(secret);

  function encode(payload) {
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const iv = crypto.createHmac('sha256', macKey).update(plaintext).digest().subarray(0, 16);
    const cipher = crypto.createCipheriv('aes-256-ctr', encKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, ct]).toString('base64url');
  }

  // Returns the payload, or null for anything not issued with this secret.
  function decode(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{22,4096}$/.test(id)) return null;
    const raw = Buffer.from(id, 'base64url');
    if (raw.length <= 16) return null;
    const iv = raw.subarray(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-ctr', encKey, iv);
    const plaintext = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]);
    const expected = crypto.createHmac('sha256', macKey).update(plaintext).digest().subarray(0, 16);
    if (!crypto.timingSafeEqual(iv, expected)) return null;
    try {
      return JSON.parse(plaintext.toString('utf8'));
    } catch {
      return null;
    }
  }

  return { encode, decode };
}

module.exports = { createLinkCodec };
