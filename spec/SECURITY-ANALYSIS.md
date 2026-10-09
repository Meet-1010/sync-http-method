# SYNC: Security Analysis

This document accompanies `SYNC-method-draft.md`. Terminology follows the draft: a client sends a QUERY request to a **sync resource** with a set of **baselines** (resource name to opaque version token or `null`) and receives one **result** per resource. The same content may be sent with `POST` as a fallback.

## 1. Threat Model

**Attackers considered**

- **On-path attacker (MITM):** reads or modifies traffic when TLS is absent or misconfigured.
- **Malicious client:** crafts requests to probe server history, to enumerate resources, or to consume server resources.
- **Malicious or compromised server:** returns fabricated patches to corrupt client state (relevant when a client syncs from servers it does not fully control).
- **Cross-origin page:** a web page the victim visits that tries to make the victim's browser issue SYNC requests.

**Assets**

| Asset | Risk |
|---|---|
| Baseline map | Reveals what the client holds and roughly when it last synced |
| Results | Tampering corrupts client state; disclosure reveals server state |
| Version-token space | Enumeration maps server history |
| Server compute | Large batches multiply per-request work |
| Resource namespace | Per-resource status can reveal which resources exist |
| Shared caches | Cacheable QUERY responses can leak one requester's results to another |

## 2. Implementation Status of Mitigations

The reference server is a research implementation. This table says which mitigations it actually enforces, so that nothing in this document is read as a claim about the code that is not true.

| Mitigation | Reference server |
|---|---|
| Max 100 resources per request, `413` | Implemented |
| Max 64 KiB request body, `413` before buffering | Implemented |
| Max 16 KiB header section, `431` | Implemented |
| Client checks `from` equals held baseline before applying | Implemented in `client/src/apply.js` |
| Per-resource failure isolation (no whole-request failure from one bad entry) | Implemented |
| Prototype-pollution-safe handling of resource names such as `__proto__` | Implemented, tested |
| Resource names restricted to absolute paths on the same origin (no scheme, authority or fragment) | Implemented, tested |
| Per-resource authorization hook: the store receives the request context and can hide resources as `404` | Implemented, tested (the policy itself is the application's) |
| `Cache-Control: no-store` by default, public caching only by explicit configuration | Implemented, tested |
| Opaque, unguessable tokens | **Not implemented.** Demo data uses `v1`, `v2`; a deployment must not |
| TLS | **Not implemented.** Run behind a TLS terminator |
| Authentication | **Not implemented**; the application supplies it |
| Rate limiting | **Not implemented** |
| Per-request computation time bound | **Not implemented** |
| Signed results (`HMAC`) | **Not implemented**, optional in the draft |

## 3. Attack Vectors and Mitigations

### a) Version rollback and replayed responses

**Description.** An attacker (or a misbehaving cache) replays an old response. If the client applies a patch computed from a different baseline than the one it holds, local state silently diverges.

```
Client holds:  /feed at token T5
Replayed:      patch with from = T1, to = T3
Client applies it to T5 state -> corrupt
```

**Mitigations**

- Clients MUST verify that a patch's `from` equals the baseline they hold and discard it otherwise. (Implemented: `applyResult` throws and leaves state untouched.)
- Servers SHOULD send `Cache-Control: no-store`. (Implemented.)
- Snapshots are not subject to this check, since they replace state wholesale. A replayed snapshot rolls the client back to older state without any `from` mismatch to detect. Where freshness matters, tokens SHOULD be ordered or signed so the client can reject a `to` older than what it holds.

### b) State poisoning via forged patch

**Description.** An on-path attacker rewrites patch operations, for example changing a role field.

**Mitigations**

- TLS is REQUIRED in production.
- For high-value resources, servers MAY sign result documents and clients SHOULD verify the signature before applying.
- Clients SHOULD apply a patch atomically: if any operation fails, the local state MUST be left unchanged. (Implemented: `applyResult` operates on a copy for JSON Patch.)
- A malicious *server* can always send arbitrary state; signatures protect against on-path attackers, not against a server the client has chosen to trust.

### c) Baseline probing (previously "409 oracle" and "enumeration")

**Description.** Any protocol in which a client presents a resume cursor lets a prober learn whether the cursor is recognized. In SYNC this is visible in two ways: a patch response (token recognized) versus a snapshot with `"baseline": "unrecognized"` or a `409`. By probing guessed tokens, an attacker can map which tokens exist and so infer when resources changed.

Mercure documents a related leak: its event cursors let a subscriber infer the existence and approximate timing of events it cannot read. This is a property of cursor-based resumption in general, not a SYNC-specific flaw.

**Mitigations**

- Tokens MUST be opaque and unguessable (random identifiers or keyed hashes). Sequential integers MUST NOT be used where history is sensitive.
- Servers SHOULD rate-limit per authenticated identity.
- Servers that must not reveal token validity SHOULD omit the `baseline` member and MAY answer every resource with a snapshot (at a bandwidth cost). With unguessable tokens the residual leak is only that a client already holding a valid token learns it is still valid, which it knew.
- With `recover: true` (the default) an unrecognized baseline no longer produces a distinct error status, which removes the explicit `409` oracle of revision -00. It does not remove the patch-versus-snapshot distinction described above.

### d) Amplification via large baseline maps

**Description.** A request naming thousands of resources forces thousands of diffs.

**Mitigations**

- Servers MUST cap resources per request (default 100) and body size (default 64 KiB), answering `413`. (Implemented, including checking `Content-Length` before buffering.)
- Servers SHOULD bound delta-computation time and MAY return `Sync-Delta-Complete: false` with the remaining resources omitted. (Not implemented in the reference server.)
- Per-client rate limiting and quotas. (Not implemented.)
- Note that batching changes the cost model: one request can be as expensive as 100 GETs while looking like one request to a request-counting rate limiter. Limiters SHOULD account for resources processed, not just requests received.

### e) Per-resource authorization and existence leaks

**Description.** Batching puts resources with different access rules into one request. A server that authorizes at request level, or that returns different statuses for "forbidden" and "does not exist", leaks the namespace.

**Mitigations**

- Authorization MUST be evaluated per resource, as it would be for GET on that resource. The reference implementation passes the request context (method, target, headers) to the store for this purpose.
- For resources the caller may not read, servers SHOULD return the same result as for a nonexistent resource (`404`).
- Patches MUST NOT include data the caller is not authorized to read, even if the baseline would have allowed it at an earlier time (permissions can be revoked between versions).

### f) Shared caching of QUERY responses

**Description.** Responses to QUERY are cacheable, with the request content in the cache key (RFC 10008, Section 2.7). Two requesters that send the same baselines get the same cache key. If the results depend on who is asking and a shared cache stores the first response, the second requester can receive data it is not allowed to read.

**Mitigations**

- Responses whose results depend on authorization MUST NOT be stored by shared caches: send `Cache-Control: private` or `no-store`. The reference handler sends `no-store` unless configured otherwise.
- Only make responses publicly cacheable when the results are identical for every requester.
- Servers MUST treat semantically equivalent request content identically, because caches may normalize the content before computing the key (RFC 10008, Section 2.7); otherwise normalization can return a wrong response.
- URIs assigned to results or queries (`Content-Location`, `Location`) MUST NOT embed version tokens or resource names.

### g) Compression side channels

**Description.** The reference server and client now support gzip for large results. Compressing responses that contain secrets together with attacker-influenced text, over TLS, enables length-based attacks of the BREACH family. In SYNC, resource names from the request are echoed as keys in `results`, and snapshots can contain sensitive values.

**Mitigations**

- Servers SHOULD NOT compress results that mix secrets with request-controlled content unless the attacker cannot cause a victim's client to send chosen SYNC requests.
- QUERY is not a CORS-safelisted method, and `application/sync-baseline+json` is not a safelisted request content type, so browsers preflight cross-origin SYNC requests sent with either QUERY or POST. Servers SHOULD NOT allow them from untrusted origins. This substantially narrows the cross-origin path to this attack.

### h) Cross-origin requests

Because neither QUERY nor a POST with this content type is CORS-safelisted, a cross-origin page cannot send a SYNC request without a successful preflight. Servers SHOULD NOT reflect arbitrary origins in `Access-Control-Allow-Origin` for sync resources, and SHOULD require an authentication mechanism (such as a bearer token) that a cross-origin page cannot attach on its own.

## 4. Transport Requirements

- SYNC MUST be deployed over TLS in production. Baselines reveal client state and results reveal server state.
- Tokens MUST be opaque and unguessable in production.
- Servers SHOULD authenticate callers for non-public resources; `Authorization` applies to SYNC as it does to GET on the same resources.

## 5. Comparison with Existing Methods

| Property | GET | SYNC |
|---|---|---|
| Reveals current state | Yes | Yes (as patch or snapshot) |
| Reveals version history | No | Partially (token recognition) |
| Requires client-supplied state | No | Yes (baselines) |
| Safe | Yes | Yes |
| Cost per request | One resource | Up to the resource cap |
| Cacheable | Yes | Yes (as QUERY); `private` or `no-store` when results depend on the requester |

The new surface relative to GET is baseline probing (3c), batching (3d, 3e), and caching of responses whose cache key is the request content (3f). The first is shared with every resume-token protocol; the second is specific to multi-resource requests; the third is shared with every use of QUERY.

## 6. What This Analysis Does Not Cover

- Interaction with Braid-style merge semantics or CRDT conflict resolution (SYNC is read-only).
- A formal model or proof; this is a threat enumeration.
- Denial of service at the transport layer.
