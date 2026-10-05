# SYNC HTTP Method — Security Analysis

---

## 1. Threat Model

### Actors

**Attacker types considered:**

- **Man-in-the-Middle (MITM):** An attacker positioned between client and server on the network path, capable of reading or modifying HTTP traffic. Relevant when TLS is absent or improperly configured.
- **Malicious Client:** A client that deliberately sends crafted SYNC requests — oversized version vectors, probing requests designed to enumerate server history, or replayed old version IDs — to extract information or degrade server performance.
- **Malicious Server:** A server that returns fabricated or manipulated delta responses to cause the client to apply incorrect state. Relevant in federated or multi-origin architectures where clients interact with servers they do not fully control.

### Assets at Risk

| Asset | Risk | Impact |
|---|---|---|
| **Version vectors** | Disclosure reveals client's internal state | Privacy leak; enables targeted attacks |
| **Delta payloads** | Tampering corrupts client state | Data integrity violation |
| **Version ID space** | Enumeration maps server history | Information disclosure |
| **Server compute** | Amplification via large vectors | Denial of service |
| **Response cache** | Stale delta served from cache | Client state divergence |

---

## 2. Attack Vectors and Mitigations

### a) Version Rollback Attack

**Description:**
An attacker who has observed or captured a previous SYNC request replays an old version vector. If the server accepts it, the client receives a delta from an old baseline, potentially re-applying already-applied operations or overwriting valid state with stale data.

**Attack scenario:**
```
Client real state: { /feed: v45 }
Attacker replays:  { /feed: v1  }
Server responds:   full delta from v1 → v45 (large, stale)
Client misapplies: double-applies operations, corrupts state
```

**Mitigations:**
- The server MUST treat SYNC requests as idempotent and safe — they do not mutate server state, so a rollback causes no server-side harm.
- Clients MUST validate that `to_version` in the response is strictly later than their current known version before applying a delta.
- Version IDs SHOULD be monotonically increasing or timestamp-based so clients can detect rollback without contacting the server.
- For sensitive resources, version tokens SHOULD be HMACs over the resource state, making forged tokens computationally infeasible.

---

### b) State Poisoning via Forged Delta

**Description:**
A MITM intercepts a legitimate SYNC response and replaces or augments the `operations` array with fabricated JSON Patch operations. The client applies the poisoned delta, corrupting its local state with attacker-controlled data.

**Attack scenario:**
```
Server sends:   { "op": "replace", "path": "/users/1/role", "value": "user" }
Attacker injects: { "op": "replace", "path": "/users/1/role", "value": "admin" }
Client applies: elevated privilege in local state
```

**Mitigations:**
- **TLS is required.** SYNC MUST be deployed over HTTPS in production. Without TLS, response integrity cannot be guaranteed.
- For highly sensitive resources, the server SHOULD include an HMAC signature over the serialized delta body using a pre-shared secret or a session key derived during TLS handshake:
  ```
  Sync-Delta-Signature: hmac-sha256=<hex>
  ```
- Clients SHOULD verify this signature before applying any operations when it is present.
- JSON Patch operations SHOULD be applied in a transactional manner: if any operation fails validation, the entire delta MUST be rejected.

---

### c) Version Vector Enumeration

**Description:**
An attacker probes version IDs by sending SYNC requests with guessed version strings. A `409 Conflict` response confirms the ID is unrecognizable; a `200` or `204` confirms it exists. By bisecting the version space, the attacker can map the server's full version history and infer when resources changed.

**Attack scenario:**
```
SYNC with { /users: "v1" } → 200 (v1 exists)
SYNC with { /users: "v5" } → 200 (v5 exists)
SYNC with { /users: "v3" } → 200 (v3 exists)
Attacker now knows: resource had versions v1, v3, v5 → timestamps of changes
```

**Mitigations:**
- Version tokens MUST be opaque and non-guessable. Use UUIDs (128-bit random) or HMAC-SHA256 hashes rather than sequential integers.
- Sequential integer version IDs (`v1`, `v2`, `v3`) MUST NOT be used in production deployments where version history is sensitive.
- The server SHOULD apply per-client rate limiting on SYNC requests to make enumeration attacks slow and detectable.
- Authentication SHOULD be required before any version information is revealed.

---

### d) Amplification via Giant Version Vector

**Description:**
A malicious client sends a SYNC request with an extremely large version vector — thousands of resource entries — forcing the server to perform expensive delta computation for each entry, potentially exhausting CPU or memory.

**Attack scenario:**
```
version_vector: {
  "/resource/1": "v1", "/resource/2": "v1", ..., "/resource/10000": "v1"
}
```
Server must look up 10,000 resources and compute 10,000 diffs in a single request.

**Mitigations:**
- Servers MUST enforce a maximum version vector size. The `413 Content Too Large` response code is defined for this case.
- A reasonable default limit is 100 resources per SYNC request; this SHOULD be configurable.
- The `Content-Length` header SHOULD be validated against a byte limit (e.g., 64 KB) before the body is parsed.
- Servers SHOULD implement per-client rate limiting and per-IP request quotas.
- Delta computation SHOULD be time-bounded; if computation exceeds a threshold (e.g., 500ms), the server SHOULD return `503 Service Unavailable` rather than blocking indefinitely.

---

### e) 409 Oracle Attack

**Description:**
The `409 Conflict` response reveals that a given version ID is not in the server's history. By systematically probing with different version IDs and observing whether the response is `200`, `204`, or `409`, an attacker can fingerprint the server's version history even without being able to guess the actual version tokens (if they are not random).

**Attack scenario:**
```
SYNC { /users: "abc123" } → 409   # "abc123" not in history
SYNC { /users: "def456" } → 200   # "def456" is in history
```
Combined with a known version token (obtained legitimately), the attacker can probe what other tokens existed between them.

**Mitigations:**
- As with version vector enumeration, version tokens MUST be opaque and unguessable (random UUIDs or cryptographic hashes).
- The server SHOULD apply constant-time lookup for version IDs so that timing side-channels do not distinguish "not found" from "found but identical."
- `409` responses SHOULD use generic error messages: `"Client version unrecognizable"` not `"Version not found in history after v7"`.
- Authentication and rate limiting apply here as well.

---

### f) Replay Attack on SYNC Response

**Description:**
If a SYNC response is incorrectly cached — either by an intermediate proxy or a misconfigured client — a stale delta may be served for a future SYNC request. The client applies an outdated delta, diverging from server state without knowing it.

**Attack scenario:**
```
Round 1: Client at v1 → Server returns delta v1→v5, cached by proxy
Round 2: Client at v5 → Proxy returns cached delta v1→v5
Client attempts to apply v1→v5 delta when already at v5 → incorrect state
```

**Mitigations:**
- SYNC responses for mutable resources MUST include `Cache-Control: no-store` unless the resource is explicitly read-only and immutable.
- The `Sync-Server-Version` header MUST be included in the cache key when caching is permitted.
- Clients MUST validate that `deltas[resource].from_version` matches their current known version before applying. If it does not match, the delta MUST be discarded and a fresh SYNC request issued.
- Proxies that do not understand SYNC SHOULD be configured to treat it as non-cacheable (same as POST).

---

## 3. Transport Requirements

- SYNC **MUST** use TLS (HTTPS) in any production deployment. The method is safe and idempotent, but the version vector reveals client state and the delta reveals server state — both require confidentiality.
- Version tokens **SHOULD** be opaque, unguessable strings (UUIDs or cryptographic hashes). Sequential integers are convenient for development but MUST NOT be used in production.
- Servers **SHOULD** require authentication before processing SYNC requests for non-public resources. Unauthenticated SYNC requests reveal version history to any caller.
- The `Authorization` header (Bearer token, API key, or session cookie) applies to SYNC in the same way it applies to GET for the same resource.

---

## 4. Comparison with Existing Method Security

**SYNC vs GET:**

| Property | GET | SYNC |
|---|---|---|
| Reveals current resource state | Yes | Yes (via delta) |
| Reveals version history | No | Partially (via 409 oracle) |
| Requires state from client | No | Yes (version vector) |
| Safe (no mutation) | Yes | Yes |
| Cacheable | Yes | Yes, with caveats |

The key new consideration introduced by SYNC is the **409 oracle**: GET has no equivalent. A GET to a resource either returns the resource or a 4xx/5xx. SYNC's 409 response confirms that the client's version ID is not in the server's recognized history, which is information GET never leaks. This is mitigated by opaque version tokens and rate limiting, but implementors must be explicitly aware of it.

SYNC's requirement that clients supply a version vector also introduces a new privacy surface: the version vector reveals which resources the client has fetched previously and approximately when. Servers MUST treat this information as sensitive and subject it to the same data handling policies as other client-provided identifiers.
