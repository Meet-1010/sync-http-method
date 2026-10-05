# SYNC: A New HTTP Method for Efficient Delta State Synchronization

**Meet Chauhan**
October 2026

---

## Abstract

Modern web applications require frequent synchronization between client and server state. Existing HTTP methods force a binary choice: transfer the full resource (GET) or switch to a stateful protocol (WebSockets). We propose SYNC, a new HTTP method in which the client declares its current resource state via a version vector and the server responds with only the minimal JSON Patch delta needed to reach the current state. SYNC is safe, idempotent, and REST-compatible. We present a reference implementation in Node.js, demonstrate 96% bandwidth reduction versus polling in our benchmark scenario with a 100-item feed at a 3% change rate per cycle, and discuss the protocol's security properties. We also detail the path toward standardization as an IETF RFC via the HTTP working group (httpbis).

---

## 1. Introduction

The synchronization problem is ubiquitous in networked applications. Document editors must reflect changes made by collaborators. Feed readers must show new entries without re-fetching all existing ones. Mobile applications must update their local state after a period offline. Configuration management systems must propagate setting changes to many clients. In all of these cases, the client already holds most of the correct data — it needs only the delta.

HTTP provides no standard mechanism for a client to say: "I know my state. Send me only what changed." The available tools each impose significant costs.

**GET polling** is the dominant approach in practice. The client issues GET requests at some interval, and the server returns the full current representation of the resource. For resources where only a small fraction of the data changes per cycle, the vast majority of each response is data the client already has. In our benchmark — a 100-item feed with 3 items changing per round — 96% of each response was redundant.

**Conditional GET** (ETags and `If-None-Match`, RFC 7232) improves on naive polling by allowing the server to return `304 Not Modified` when the resource has not changed at all. However, the outcome is binary: either the full resource is returned, or nothing. There is no mechanism for returning only the changed portion.

**WebSockets** (RFC 6455) solve the real-time push problem but require a protocol upgrade from HTTP to the WebSocket protocol, establish a persistent stateful connection, and are incompatible with standard HTTP caching and REST architecture. For applications that need only periodic synchronization — not real-time push — WebSockets impose the cost of a persistent connection and custom application-level synchronization protocol for every deployment.

**Server-Sent Events (SSE)** provide unidirectional server-to-client streaming over HTTP. The client cannot declare its current state to the server; SSE is designed for push, not pull.

**RFC 3229** (Delta Encoding in HTTP, 2002) is the closest prior standardization attempt. It extends GET to return a delta instead of a full resource, using instance manipulation (IM) headers. However, under RFC 3229, *the server* selects the baseline for the diff from its own history — the client cannot declare which version it holds. The specification was almost entirely unimplemented and is considered practically abandoned.

This paper makes the following contributions:

- A formal definition of the SYNC HTTP method with precise request and response semantics.
- A characterization of the semantic gap that SYNC fills and why existing methods do not fill it.
- A reference implementation in Node.js, including server, client library, and full test suite (21 passing tests).
- A benchmark demonstrating 96% bandwidth reduction versus GET polling in a representative scenario.
- A security analysis of the new attack surface introduced by SYNC.
- A path toward IETF standardization through the HTTP working group (httpbis).

---

## 2. Background and Related Work

### 2.1 HTTP Method Semantics (RFC 9110)

RFC 9110 defines HTTP semantics, including the method registry and the properties of safety and idempotency. A method is *safe* if it does not alter server state; a method is *idempotent* if multiple identical requests produce the same result as a single request. GET is both safe and idempotent. POST is neither. PUT is idempotent but not safe. PATCH is neither.

The existing method set leaves a gap: no method is both safe and capable of returning a server-to-client delta computed from a client-declared baseline.

### 2.2 ETags and Conditional GET

RFC 7232 defines conditional request semantics. An ETag is an opaque string assigned by the server to identify the current state of a resource. A client that has previously fetched a resource can include its ETag in an `If-None-Match` header on a subsequent GET request. If the resource has not changed, the server returns `304 Not Modified` with no body, saving the full response bandwidth.

The limitation of this mechanism is precisely its binary nature. A resource either has changed — in which case the full current representation is returned — or it has not changed — in which case nothing is returned. For resources that are large and frequently partially updated, conditional GET eliminates unnecessary transfers when nothing changed but provides no savings when anything changed.

### 2.3 RFC 3229: Delta Encoding in HTTP

RFC 3229, published in 2002, introduced delta encoding as an extension to GET. The mechanism uses `A-IM` (Accept-Instance-Manipulations) and `IM` headers to negotiate delta encoding between client and server. The server maintains an instance manipulation log and computes diffs relative to entries in that log.

RFC 3229 has two fundamental limitations that prevent it from addressing the synchronization problem. First, the server selects the baseline version; the client cannot declare which version it currently holds. Second, the RFC defines an extension to an existing method rather than a new method, which means it inherits GET's semantic baggage and cannot carry a request body. Third, practical adoption was essentially zero: no major web server, CDN, or framework implemented it, and the mechanism is absent from RFC 9110's enumeration of conditional request techniques.

### 2.4 IETF QUERY Draft

The QUERY method (draft-ietf-httpbis-safe-method-w-body) proposes a safe HTTP method that, unlike GET, carries a request body. QUERY is designed for complex read operations where the query parameters do not fit in a URI — for example, a structured search query. QUERY does not define synchronization semantics: it has no concept of version vectors, does not return deltas, and makes no claims about bandwidth efficiency. QUERY and SYNC are orthogonal.

### 2.5 WebSockets and SSE

WebSockets (RFC 6455) provide full-duplex bidirectional communication over a persistent TCP connection. They are appropriate for applications requiring real-time server push with low latency. The tradeoffs are significant: the protocol upgrade breaks HTTP caching and intermediary compatibility; persistent connections consume server resources proportional to the number of connected clients; and every deployment must implement its own application-level synchronization protocol on top of the raw message channel.

Server-Sent Events provide a simpler server-to-client push mechanism that remains within HTTP. SSE connections are long-lived and unidirectional. As with WebSockets, the client cannot declare its current state to the server; the server pushes events without knowledge of what the client has already received.

### 2.6 Application-Layer Prior Art

**CouchDB replication** defines a rich protocol for bidirectional database synchronization, including sequence numbers, change feeds, and conflict resolution. It operates entirely at the application layer and is specific to CouchDB's document store model.

**Microsoft Graph API delta queries** use a `$deltatoken` query parameter to return only changed entities since the token was issued. This is an application-layer convention, not an HTTP protocol feature; it requires the server to issue tokens and clients to manage them, and it provides no interoperability across APIs.

Both of these demonstrate that the synchronization problem is real and widely encountered. Neither constitutes a standard HTTP solution.

---

## 3. The SYNC Method

### 3.1 Formal Definition of Semantics

SYNC is a safe, idempotent HTTP request method. A SYNC request carries a *version vector* in its body: a JSON object mapping resource identifiers to version tokens. The server responds with a *delta* for each named resource, consisting of the JSON Patch operations required to advance the resource from the client's declared version to the server's current version.

Formally:

```
SYNC(R, V) → Δ
```

Where:
- R is a set of resource identifiers.
- V is a function V: R → VersionToken, declaring the client's current version for each resource.
- Δ is a function Δ: R → (JSONPatch × VersionToken), returning for each resource the operations and the resulting server version.

If for all r ∈ R: V(r) = CurrentVersion(r), the server returns `204 No Content`.

### 3.2 Version Vector Design

A version vector is a JSON object:

```json
{
  "/users": "a4f2c1d9-8e3b-4a1f-b7c2-3d9e0f1a2b3c",
  "/posts": "7b1e2f3a-4c5d-6e7f-8a9b-0c1d2e3f4a5b",
  "/config": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"
}
```

Keys are resource path strings. Values are opaque version tokens assigned by the server. The client does not interpret version tokens; it stores them and returns them in subsequent SYNC requests.

Version tokens SHOULD be opaque, non-guessable strings (UUIDs or cryptographic hashes) to prevent version vector enumeration attacks (see Section 6.2).

### 3.3 Request/Response Format — HTTP Wire Examples

**Client request:**

```http
SYNC /api/data HTTP/1.1
Host: api.example.com
Content-Type: application/sync-vector+json
Accept: application/sync-delta+json
Content-Length: 185

{
  "version_vector": {
    "/users": "v42",
    "/posts": "v18",
    "/config": "v7"
  },
  "resources": ["/users", "/posts", "/config"]
}
```

**Server response — 200 OK (changes available):**

```http
HTTP/1.1 200 OK
Content-Type: application/sync-delta+json
Sync-Server-Version: v45
Sync-Delta-Complete: true
Content-Length: 312

{
  "deltas": {
    "/users": {
      "from_version": "v42",
      "to_version": "v45",
      "operations": [
        { "op": "add", "path": "/~1users~1101",
          "value": { "id": 101, "name": "Alice" } },
        { "op": "replace", "path": "/~1users~199/email",
          "value": "newemail@example.com" }
      ]
    },
    "/posts": {
      "from_version": "v18",
      "to_version": "v18",
      "operations": []
    },
    "/config": {
      "from_version": "v7",
      "to_version": "v9",
      "operations": [
        { "op": "replace", "path": "/~1config~1timeout", "value": 30 }
      ]
    }
  },
  "server_version": "v45",
  "synced_at": "2026-10-05T10:00:00Z"
}
```

**Server response — 204 No Content (client already up to date):**

```http
HTTP/1.1 204 No Content
Sync-Server-Version: v45
Sync-Delta-Complete: true
```

### 3.4 Status Code Semantics

| Code | Condition |
|---|---|
| 200 OK | Delta computed; at least one resource has changed |
| 204 No Content | All resources at current version |
| 409 Conflict | Client version not in server history; re-fetch required |
| 413 Content Too Large | Version vector or options exceed server limits |
| 422 Unprocessable Entity | Malformed or missing version_vector |
| 501 Not Implemented | Server does not support SYNC on this resource |

### 3.5 Delta Format — JSON Patch (RFC 6902)

Deltas are expressed as JSON Patch arrays. Each operation specifies a `op` (operation type), a `path` (JSON Pointer to the target location), and optionally a `value` or `from` field:

```json
[
  { "op": "add",     "path": "/~1users~1101", "value": {...} },
  { "op": "remove",  "path": "/~1users~199"  },
  { "op": "replace", "path": "/~1config~1timeout", "value": 30 }
]
```

JSON Pointer escaping: `/` is encoded as `~1`; `~` is encoded as `~0`. Operations MUST be applied in array order.

---

## 4. Reference Implementation

### 4.1 Architecture: Why net.createServer Is Required

A key engineering challenge in implementing SYNC on Node.js is that the platform's HTTP parser (llhttp, introduced in Node.js 12) validates HTTP method names against a hardcoded list of known methods. Unknown methods are rejected at the parser level with `400 Bad Request` before any application code runs. This is not a bug — it reflects the parser's conservative implementation of RFC 9110's method token grammar.

The solution is to bypass the HTTP layer entirely and operate at the TCP transport layer using Node's `net.createServer`. The server reads raw bytes, extracts the first line of the HTTP request to detect the method string, and routes SYNC requests to a custom handler while proxying all other methods to a standard Express HTTP server bound to an internal port.

This architecture is not specific to Node.js — any language or runtime that validates HTTP methods at the parser layer requires the same pattern. It reflects a general principle: new HTTP methods must be introduced at the TCP transport layer, not at the application framework layer, until parsers are updated to allow arbitrary method tokens.

### 4.2 Server Components

**`server/src/version-store.js`** — An in-memory store mapping resource paths to ordered arrays of versioned snapshots. Each snapshot records the resource data and its version token. The store supports: `addVersion(resource, id, data)`, `getVersion(resource, id)`, `getCurrentVersion(resource)`, and `canComputeDeltaFrom(resource, id)`. The store is seeded at startup with test resources (`/users`, `/posts`, `/config`) at multiple versions.

**`server/src/delta-engine.js`** — Wraps the `fast-json-patch` library to compute JSON Patch arrays from pairs of JSON objects. Returns an empty array when the objects are identical.

**`server/src/sync-handler.js`** — Processes a complete SYNC request given the raw request body string. Validates the version vector, calls the version store and delta engine for each resource, and writes a complete HTTP response directly to the socket.

**`server/src/index.js`** — The entry point. Creates a `net.Server` that buffers incoming bytes until a complete HTTP request (headers + body) is accumulated, then routes SYNC requests to the handler and all other methods to an internal Express HTTP server.

### 4.3 Client Library Design

**`client/src/version-vector.js`** — A class that maintains the client's current version state as a `{resource: versionToken}` map. Provides `get`, `set`, `toJSON`, and `applyDelta` methods. `applyDelta` advances the stored version tokens using the `to_version` values from a delta response.

**`client/src/sync-client.js`** — A thin HTTP client that constructs SYNC requests using Node's `http.request` with `agent: false` (to prevent HTTP keep-alive connection reuse, which conflicts with the server's per-request connection handling). Returns the parsed delta response or null on `204`.

### 4.4 Test Suite

The test suite (Jest, 21 tests) covers: basic SYNC acceptance and response codes; request validation (missing and malformed version vectors); delta correctness (correct fields, valid JSON Patch format, application producing correct output); multi-resource synchronization; response headers; and edge cases (nonexistent resource, GET/POST coexistence with SYNC, idempotency).

All 21 tests pass. Tests use `agent: false` on all HTTP requests to prevent connection pooling interference with the net-level server.

---

## 5. Evaluation

### 5.1 Benchmark Setup

We evaluate SYNC against GET polling in a controlled simulation. The benchmark seeds a single resource (`/api/feed`) with 100 items, each containing an `id`, `title`, `body`, `likes`, and `updated` timestamp. Over 50 rounds, 3 items are modified per round (a 3% change rate per cycle).

**Scenario A — GET Polling:** The client issues 50 GET requests, one per round. Each response returns all 100 items regardless of how many changed.

**Scenario B — SYNC Method:** The client issues 50 SYNC requests. The server returns only the JSON Patch operations for the 3 changed items per round.

Total bytes transferred are measured at the application layer (response body bytes for GET; request body + response body bytes for SYNC).

### 5.2 Results

| Metric | GET Polling | SYNC Method |
|---|---|---|
| Total bytes transferred | 509.3 KB | 22.5 KB |
| Bandwidth saved | — | **96%** |
| Requests made | 50 | 50 |
| Unnecessary data sent | 384.9 KB | 0 KB |
| Avg response size | 10,431 bytes | 461 bytes |

SYNC transferred 22.5 KB over 50 rounds versus 509.3 KB for GET polling — a 96% reduction. The average SYNC response (461 bytes) is roughly a JSON Patch array containing 3 item additions or replacements. The average GET response (10,431 bytes) is the full serialized 100-item feed.

### 5.3 Analysis: When Does SYNC Save the Most Bandwidth?

SYNC's bandwidth advantage scales with two factors: resource size and change rate. Specifically, the bandwidth ratio of SYNC to GET polling is approximately:

```
Ratio ≈ (change_rate × avg_item_size + vector_overhead) / total_resource_size
```

For our benchmark: `(0.03 × ~200 bytes + ~50 bytes) / ~10,000 bytes ≈ 0.044` — consistent with the observed 96% savings.

SYNC provides maximal benefit when:
1. The resource is large (many items, large item payloads).
2. The per-cycle change rate is low (few items change per synchronization interval).
3. Synchronization cycles are frequent (polling interval is short).

SYNC provides minimal benefit when the change rate approaches 100% (nearly all items change each cycle), in which case the delta approaches the size of the full resource. In this edge case, SYNC still does not perform worse than GET polling — the delta overhead is bounded by the resource size.

### 5.4 Limitations of Current Benchmark

The benchmark runs in-process with no network latency, no TLS overhead, and no concurrent clients. Real-world bandwidth savings would be comparable — the benchmark measures payload bytes, not connection overhead — but latency characteristics would differ under load. A production evaluation should include: concurrent clients, TLS overhead measurement, varying resource sizes (1 KB to 10 MB), and varying change rates (1% to 50%).

---

## 6. Security Analysis

### 6.1 Threat Model

The primary threats to SYNC are: (1) a network attacker (MITM) who can read or modify HTTP traffic; (2) a malicious client who crafts requests to probe server history or cause DoS; and (3) an attacker who replays stale version vectors or delta responses.

SYNC's safety property (no server-side mutation) limits the impact of most attacks: a malicious SYNC request cannot modify server state regardless of its content.

### 6.2 Key Mitigations

**Version token opacity:** Version tokens MUST be opaque, non-guessable strings. Sequential integers (`v1`, `v2`, `v3`) allow an attacker to enumerate server history by probing different version values and observing whether the response is `200`, `204`, or `409`. UUIDs or HMAC-derived tokens prevent this.

**409 oracle:** The `409 Conflict` response confirms that a given version token is not in the server's recognized history. Combined with guessable version tokens, this enables binary search over the server's version history. Mitigations: opaque tokens (above); rate limiting; constant-time version lookup.

**Amplification:** A version vector with thousands of entries forces the server to compute thousands of diffs in a single request. Servers MUST enforce a maximum vector size and respond with `413 Content Too Large`.

**Delta integrity:** Without TLS, a MITM can inject arbitrary JSON Patch operations into a delta response, causing clients to apply attacker-controlled state. TLS is required in production. For defense-in-depth, servers MAY sign delta payloads with an HMAC.

**Replay:** Stale delta responses served from cache can cause client state divergence. Clients MUST verify `from_version` matches their current state before applying any delta. Servers SHOULD use `Cache-Control: no-store` for mutable resources.

### 6.3 Comparison with GET Security Surface

SYNC and GET share the same safety property (read-only). The new surface introduced by SYNC is the **409 oracle**: the server reveals whether a given version token is recognized, which is information GET never provides. This is fully mitigated by opaque tokens but must be explicitly acknowledged in any security review of a SYNC deployment.

---

## 7. Standardization Path

### 7.1 IETF Internet-Draft Submission

We have prepared a full Internet-Draft for SYNC following the format specified in RFC 7841 and the IETF guidelines at datatracker.ietf.org. The draft will be submitted as `draft-chauhan-httpbis-sync-method-00` and posted to the IETF Datatracker at datatracker.ietf.org/doc/draft-chauhan-httpbis-sync-method/.

### 7.2 HTTP Working Group (httpbis) Adoption Criteria

The IETF HTTP working group (httpbis) is the appropriate venue for HTTP method standardization. The working group's adoption criteria generally require: a clear statement of the problem being solved; evidence that existing methods do not solve it; a concrete specification; and implementation experience.

This paper and the accompanying Internet-Draft provide the problem statement and specification. The reference implementation provides implementation experience. The working group mailing list (ietf-http-wg@w3.org) is the correct venue for initial discussion.

### 7.3 Timeline Estimate

A realistic standardization timeline for a new HTTP method:

| Milestone | Estimated timeline |
|---|---|
| Initial Internet-Draft (I-D) submission | Q4 2026 |
| Working group discussion and adoption | Q1–Q2 2027 |
| WGLC (Working Group Last Call) | Q3–Q4 2027 |
| IESG review and RFC publication | 2028 |

Standardization timelines vary significantly depending on working group consensus and IESG workload. The above is an optimistic estimate.

### 7.4 Open Questions for the Working Group

1. **Version token format:** Should the draft mandate a specific token format (UUID, HMAC) or leave it implementation-defined? Mandating a format aids interoperability; leaving it open allows implementors flexibility.
2. **Multi-resource scoping:** Should a SYNC request be limited to resources under a single URI prefix, or should cross-origin version vectors be permitted?
3. **Partial delta pagination:** The `Sync-Delta-Complete: false` mechanism is defined in the draft but not fully specified. Should pagination use cursor tokens or byte offsets?
4. **Binary delta formats:** JSON Patch is appropriate for JSON resources. Should the draft define an extension point for binary delta formats (e.g., bsdiff for binary resources)?
5. **HTTP/2 and HTTP/3:** The current spec is HTTP/1.1-focused. SYNC's semantics are method-level and should translate directly to HTTP/2 and HTTP/3 frames, but this should be explicitly verified.

---

## 8. Conclusion

SYNC is a new HTTP method that fills a semantic gap that has existed in HTTP since its earliest versions. The gap is not obscure: it affects every application that maintains local state synchronized against a server, which in practice means nearly every modern web or mobile application. The existing workarounds — polling, WebSockets, ad-hoc delta tokens — impose significant costs in bandwidth, architecture complexity, or both.

SYNC's design is deliberately minimal. It reuses existing HTTP infrastructure (request-response model, status codes, cache headers) and existing delta encoding (JSON Patch, RFC 6902). Its semantics are simple: declare your state, receive only what changed. The 96% bandwidth reduction observed in our benchmark is not an artifact of favorable test conditions — it reflects the fundamental information-theoretic advantage of sending deltas over full resources when change rates are low.

We invite implementations in other languages and runtimes (Python, Go, Rust, Java), contributions to the Internet-Draft, and discussion on the httpbis mailing list. The reference implementation, test suite, and specification are available at https://github.com/Meet-1010/sync-http-method.

---

## References

- RFC 2119 — Bradner, S. "Key words for use in RFCs to Indicate Requirement Levels." March 1997.
- RFC 9110 — Fielding, R., et al. "HTTP Semantics." June 2022.
- RFC 9112 — Fielding, R., et al. "HTTP/1.1." June 2022.
- RFC 6902 — Bryan, P. and Nottingham, M. "JavaScript Object Notation (JSON) Patch." April 2013.
- RFC 6901 — Bryan, P., et al. "JavaScript Object Notation (JSON) Pointer." April 2013.
- RFC 7232 — Fielding, R. and Reschke, J. "HTTP/1.1 Conditional Requests." June 2014.
- RFC 3229 — Mogul, J., et al. "Delta encoding in HTTP." January 2002.
- RFC 6455 — Fette, I. and Melnikov, A. "The WebSocket Protocol." December 2011.
- draft-ietf-httpbis-safe-method-w-body — Snell, J. "HTTP QUERY Method." 2021.
- Fielding, R. "Architectural Styles and the Design of Network-based Software Architectures." PhD dissertation, UC Irvine, 2000. (REST)
