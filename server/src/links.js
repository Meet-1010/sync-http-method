'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

// Opaque, deterministic, authenticated identifiers for update resources (links)
// and for shared result documents.
//
// The same payload always yields the same identifier, so shared caches can reuse
// a response across clients. The identifier reveals neither resource names nor
// version identifiers, and cannot be forged or altered.
//
// Construction (deterministic authenticated encryption, synthetic IV):
//   pt  = 0x00 || JSON, or 0x01 || deflate-raw(JSON) when that is shorter
//   iv  = HMAC-SHA256(macKey, pt)[0..16)
//   ct  = AES-256-CTR(encKey, iv, pt)
//   id  = base64url(iv || ct)
// Decoding decrypts and recomputes the HMAC; a mismatch means the identifier was
// not issued with this secret. Only authenticated plaintext is decompressed.
// Compression applies only to what the requester learns from the response anyway.

const RAW = 0x00;
const DEFLATED = 0x01;
const COMPRESS_FROM = 256;
const MAX_ID_LENGTH = 16384;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MEMO_ENTRIES = 4096;

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
  // Encoding is deterministic, so identifiers can be remembered: when many clients
  // catch up from the same versions, each identifier is computed once.
  const memo = new Map();
  const stats = { encoded: 0, reused: 0 };

  function encode(payload) {
    const json = JSON.stringify(payload);
    const hit = memo.get(json);
    if (hit !== undefined) {
      memo.delete(json);
      memo.set(json, hit);
      stats.reused++;
      return hit;
    }
    const raw = Buffer.from(json, 'utf8');
    let pt = Buffer.concat([Buffer.from([RAW]), raw]);
    if (raw.length >= COMPRESS_FROM) {
      const deflated = zlib.deflateRawSync(raw, { level: 9 });
      if (deflated.length < raw.length) pt = Buffer.concat([Buffer.from([DEFLATED]), deflated]);
    }
    const iv = crypto.createHmac('sha256', macKey).update(pt).digest().subarray(0, 16);
    const cipher = crypto.createCipheriv('aes-256-ctr', encKey, iv);
    const id = Buffer.concat([iv, cipher.update(pt), cipher.final()]).toString('base64url');
    stats.encoded++;
    memo.set(json, id);
    if (memo.size > MEMO_ENTRIES) memo.delete(memo.keys().next().value);
    return id;
  }

  // Returns the payload, or null for anything not issued with this secret.
  function decode(id) {
    if (typeof id !== 'string' || id.length > MAX_ID_LENGTH || !/^[A-Za-z0-9_-]{23,}$/.test(id)) return null;
    const bytes = Buffer.from(id, 'base64url');
    if (bytes.length <= 17) return null;
    const iv = bytes.subarray(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-ctr', encKey, iv);
    const pt = Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]);
    const expected = crypto.createHmac('sha256', macKey).update(pt).digest().subarray(0, 16);
    if (!crypto.timingSafeEqual(iv, expected)) return null;
    try {
      const body = pt.subarray(1);
      if (pt[0] === RAW) return JSON.parse(body.toString('utf8'));
      if (pt[0] === DEFLATED) return JSON.parse(zlib.inflateRawSync(body, { maxOutputLength: MAX_PAYLOAD_BYTES }).toString('utf8'));
      return null;
    } catch {
      return null;
    }
  }

  return { encode, decode, stats };
}

module.exports = { createLinkCodec };
