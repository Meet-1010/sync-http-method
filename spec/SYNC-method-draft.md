---
Title: The SYNC HTTP Method
Abbrev: SYNC Method
Category: Standards Track
Author: Meet Chauhan
Date: October 2026
---

# The SYNC HTTP Method

## Abstract

This document defines the SYNC HTTP method. SYNC is a safe, idempotent request method that allows a client to declare its current resource state via a version vector and receive only the minimal delta required to reach the server's current state. It fills a semantic gap in HTTP where no standard method supports client-declared, resource-level delta synchronization in a single request-response cycle. This document requests registration of the SYNC method in the HTTP Method Registry maintained by IANA.

---

## 1. Introduction

### 1.1 Background and Motivation

HTTP/1.1, as defined in RFC 9110, provides request methods whose semantics cover resource retrieval (GET), creation (POST), full replacement (PUT), partial modification (PATCH), and deletion (DELETE). Conditional request semantics (RFC 7232) allow a client to avoid re-fetching an unchanged resource via ETags and the `If-None-Match` request header. However, these mechanisms collectively leave an important use case unaddressed:

> A client that knows its current state for one or more resources wishes to receive only the changes that have occurred since that state — not the full resource, not a binary hit/miss.

This situation — which we call the *delta synchronization problem* — arises in essentially every application that maintains local state synchronized against a server: document editors, feed readers, mobile apps with offline support, dashboards, configuration management systems, and distributed caches.

Existing approaches each impose significant costs:

**GET polling** forces the client to fetch the entire resource on every synchronization cycle, regardless of how little has changed. For a 100-item feed where 3 items change per cycle, 97% of every response is data the client already has.

**Conditional GET (ETags + `If-None-Match`)** produces a binary outcome: either the full resource is returned (200 OK) or nothing is returned (304 Not Modified). There is no middle ground in which only the changed portion is transferred.

**WebSockets** (RFC 6455) address the real-time push use case by establishing a persistent bidirectional connection. However, this requires a protocol upgrade, introduces stateful connection management, and is architecturally incompatible with standard HTTP caching, load balancing, and REST constraints. For applications that only need periodic synchronization, WebSockets are a significant over-fit.

**Server-Sent Events (SSE)** provide server-initiated push over a long-lived HTTP connection. The client cannot declare its known state to the server; SSE is unidirectional.

**RFC 3229 (Delta Encoding in HTTP, 2002)** introduced delta encoding as a GET extension. Under RFC 3229, the server chooses the baseline for the diff based on its own instance-manipulation history. The client cannot declare which version it currently holds. The RFC was adopted by almost no implementations and is considered abandoned.

The SYNC method addresses all of these shortcomings with a single, well-defined semantics: the client declares its current state as a version vector, and the server responds with only the operations required to advance from each declared version to the server's current version.

### 1.2 Goals

The SYNC method is designed to:

1. Allow a client to declare its exact current state for one or more resources in a single request.
2. Allow the server to respond with the minimal delta required to bring the client to current state, using a standard delta format (JSON Patch, RFC 6902).
3. Be **safe**: SYNC does not modify server state.
4. Be **idempotent**: repeating the same SYNC request with the same version vector produces the same response.
5. Be **bandwidth-efficient**: only changed data is transferred.
6. Be **REST-compatible**: SYNC fits the standard HTTP request-response model, works with existing infrastructure (proxies, load balancers, CDNs), and coexists with other methods on the same endpoint.
7. Be **cacheable**: SYNC responses MAY be cached with appropriate cache key construction (see Section 7).

### 1.3 Non-Goals

The SYNC method is not intended to:

- Replace WebSockets for applications requiring real-time server-initiated push. SYNC is pull-based and requires the client to initiate each synchronization cycle.
- Replace GET for applications that need the full current state of a resource. GET remains appropriate when the client has no prior state.
- Provide bidirectional synchronization. SYNC is read-only; mutations continue to use POST, PUT, or PATCH.
- Address binary or non-JSON resource formats. The delta format defined in this document (JSON Patch) applies to JSON resources. Extension to other delta formats is left for future work.

---

## 2. Conventions and Definitions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all capitals, as shown here.

**Version vector:** A JSON object mapping resource identifiers (URI path strings) to version tokens. Each entry asserts that the client currently holds the state of the named resource at the named version.

**Version token:** An opaque string assigned by the server to identify a specific historical state of a resource. Version tokens MUST be treated as opaque by clients. The server alone defines the relationship between tokens and resource states.

**Delta:** A sequence of JSON Patch operations (RFC 6902) sufficient to transform the resource state at `from_version` into the resource state at `to_version`.

**Synchronization cycle:** A single SYNC request-response exchange in which the client declares its version vector and the server responds with deltas.

---

## 3. The SYNC Method

### 3.1 Semantics

A SYNC request asks the server to compute and return, for each resource identified in the request's version vector, the minimal set of changes (a delta) that transforms the client's declared version of that resource into the server's current version.

The server MUST NOT modify any resource as a result of processing a SYNC request.

The server computes deltas independently for each resource in the version vector. Resources that are already at the server's current version produce an empty operations array. If all requested resources are already at current state, the server returns `204 No Content`.

The semantics are summarized as:

```
Client → Server:  "I hold resource R at version V. What changed?"
Server → Client:  "Here are the operations to advance R from V to V_current."
```

### 3.2 Safety and Idempotency

As defined in RFC 9110 Section 9.2, a method is **safe** if it does not modify server state. SYNC is safe: it is a read-only method. Implementations MUST NOT use SYNC to trigger server-side mutations.

As defined in RFC 9110 Section 9.2, a method is **idempotent** if multiple identical requests have the same effect as a single request. SYNC is idempotent: issuing the same SYNC request (same version vector, same resource list) multiple times against an unchanged server MUST produce the same response.

These properties mean that SYNC requests MAY be automatically retried by clients or intermediaries on transient failure without risk of duplicate side effects.

### 3.3 Relationship to Existing Methods

**Relationship to GET:** GET retrieves the current full state of a resource. SYNC retrieves the delta from a client-declared prior state to the current state. The two methods are complementary: GET is appropriate for initial fetch; SYNC is appropriate for subsequent synchronization.

**Relationship to PATCH:** PATCH applies client-specified changes to a resource (client-to-server direction). SYNC retrieves server-computed changes for the client to apply locally (server-to-client direction). The two methods are directional inverses of each other with respect to where mutations originate.

**Relationship to RFC 3229:** RFC 3229 defines delta encoding for GET responses. Under RFC 3229, the server selects the baseline for the diff using its own instance manipulation history; the client cannot specify which version it holds. SYNC differs fundamentally: the client declares its exact version state, and the server computes a diff specifically from that declared version.

---

## 4. Request Format

### 4.1 Request Headers

A SYNC request SHOULD include the following headers:

- `Content-Type: application/sync-vector+json` — indicates that the request body is a version vector document.
- `Accept: application/sync-delta+json` — indicates that the client expects a delta response.
- `Content-Length` — MUST be included when the request body is present, per RFC 9110.

### 4.2 Version Vector Schema

The request body MUST be a JSON object with the following structure:

```json
{
  "version_vector": {
    "<resource-path>": "<version-token>",
    "<resource-path>": "<version-token>"
  },
  "resources": ["<resource-path>", ...],
  "options": {
    "max_delta_size": <integer>,
    "compression": "<algorithm>"
  }
}
```

Fields:

- `version_vector` (REQUIRED): A JSON object mapping resource path strings to version tokens. Each entry declares the client's current known version for that resource.
- `resources` (OPTIONAL): An explicit list of resource paths to synchronize. If omitted, all keys in `version_vector` are synchronized. An empty array requests synchronization of zero resources; the server MUST respond with `204 No Content`.
- `options` (OPTIONAL): Client preferences for the response.
  - `max_delta_size`: Maximum acceptable response body size in bytes. The server SHOULD respect this limit by returning `413 Content Too Large` if the computed delta would exceed it.
  - `compression`: Preferred delta compression algorithm (e.g., `"gzip"`).

Example request:

```http
SYNC /api/data HTTP/1.1
Host: example.com
Content-Type: application/sync-vector+json
Accept: application/sync-delta+json
Content-Length: 112

{
  "version_vector": {
    "/users": "a4f2c1d9-8e3b-4a1f-b7c2-3d9e0f1a2b3c",
    "/posts": "7b1e2f3a-4c5d-6e7f-8a9b-0c1d2e3f4a5b",
    "/config": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"
  },
  "resources": ["/users", "/posts", "/config"]
}
```

### 4.3 Resource List

The `resources` array specifies which resources to include in this synchronization cycle. A server MAY support SYNC for a subset of its resources; requests for unsupported resources SHOULD return `501 Not Implemented` for that specific resource, or the server MAY return `501` for the entire request.

Servers MUST enforce a maximum number of resources per SYNC request. The RECOMMENDED default limit is 100. Requests exceeding this limit SHOULD receive `413 Content Too Large`.

---

## 5. Response Codes

### 200 OK

The server successfully computed deltas for one or more resources in the version vector. At least one resource has changes relative to the client's declared version. The response body is a delta document (see Section 6).

### 204 No Content

The client's declared version vector is already at the server's current state for all requested resources. No delta is needed. The response body MUST be empty. The server SHOULD include the `Sync-Server-Version` header indicating the current server version.

### 409 Conflict

The server cannot compute a delta from the client's declared version for at least one requested resource. This occurs when the version token is not recognized in the server's history (e.g., the version is older than the server's retention window, or the token is malformed). The client MUST perform a full re-fetch using GET for the affected resources and reset its version vector accordingly.

The `409` response body SHOULD identify which resource(s) caused the conflict.

### 413 Content Too Large

The request body (version vector) exceeds the server's configured size limit, or the computed delta would exceed the `max_delta_size` option specified by the client.

### 422 Unprocessable Entity

The request body is syntactically valid JSON but semantically invalid — for example, the `version_vector` field is missing, null, or not a JSON object.

### 501 Not Implemented

The server does not support SYNC for the requested resource(s). Clients receiving `501` SHOULD fall back to GET for the affected resources.

---

## 6. Delta Format

### 6.1 JSON Patch (RFC 6902) as Delta Encoding

SYNC uses JSON Patch (RFC 6902) as its delta encoding format. Each delta in the response body is an array of JSON Patch operations describing how to transform the resource state at `from_version` into the resource state at `to_version`.

Supported operation types:
- `add` — a new value appeared at `path`
- `remove` — the value at `path` was deleted
- `replace` — the value at `path` changed
- `move` — the value at `from` was relocated to `path`
- `copy` — the value at `from` was copied to `path`

JSON Pointer notation (RFC 6901) is used for `path` and `from` fields. The `/` character in path segments is escaped as `~1`; the `~` character is escaped as `~0`.

### 6.2 Response Body Structure

```json
{
  "deltas": {
    "<resource-path>": {
      "from_version": "<client-declared-token>",
      "to_version": "<server-current-token>",
      "operations": [
        { "op": "add", "path": "/<key>", "value": { ... } },
        { "op": "replace", "path": "/<key>/<field>", "value": "..." },
        { "op": "remove", "path": "/<key>" }
      ]
    }
  },
  "server_version": "<global-server-version>",
  "synced_at": "<ISO 8601 timestamp>"
}
```

Resources with no changes since the client's declared version MUST still appear in the `deltas` map, with an empty `operations` array and `from_version` equal to `to_version`.

### 6.3 Response Headers

- `Content-Type: application/sync-delta+json` — MUST be present on all `200 OK` responses.
- `Sync-Server-Version` — SHOULD be present on all responses (including `204`). Contains the server's current global version token. Clients MAY use this value for logging or display purposes.
- `Sync-Delta-Complete` — MUST be present on `200 OK` responses. Value is `"true"` if the response contains the complete delta; `"false"` if the server truncated the delta due to size limits, indicating that the client should issue another SYNC request after applying the partial delta.

### 6.4 Applying Deltas Client-Side

Clients MUST apply operations from each delta in array order. Before applying a delta, the client MUST verify that `from_version` in the response matches its current known version for that resource. If it does not match, the client MUST discard the delta and issue a fresh SYNC request.

If `Sync-Delta-Complete` is `"false"`, the client MUST apply the partial delta and immediately issue another SYNC request with the updated version vector (using the `to_version` values from this response). This continues until `Sync-Delta-Complete` is `"true"` or a `204` is received.

---

## 7. Caching Considerations

SYNC responses MAY be cached by shared caches and stored by clients. However, caching requires careful cache key construction:

- The `Sync-Server-Version` response header MUST be included in the cache key, in addition to the request URI.
- The version vector in the request body is part of the cache key. Implementations that cache SYNC responses MUST include a hash of the request body in the cache key.
- For resources that change frequently, `Cache-Control: no-store` SHOULD be used to prevent stale deltas from being served.
- SYNC responses MUST NOT be served from cache unless the `Sync-Server-Version` in the cached response matches the server's current version for the requested resources.

---

## 8. Security Considerations

### 8.1 Transport Security

SYNC MUST be deployed over TLS (HTTPS) in any production environment. The version vector exposes client state; the delta response exposes server change history. Both require confidentiality protection.

### 8.2 Version Rollback

Clients MUST validate that `to_version` in a response represents a version at least as recent as their current known version before applying the delta. Servers SHOULD use monotonically advancing version tokens to facilitate this check.

### 8.3 Version Vector Enumeration and 409 Oracle

The `409 Conflict` response confirms that a given version token is not in the server's recognized history. Servers MUST use opaque, non-guessable version tokens (e.g., UUIDs or cryptographic hashes) to prevent enumeration of server version history via probing attacks. Servers SHOULD apply rate limiting to SYNC requests per authenticated identity.

### 8.4 Amplification

A single SYNC request with a large version vector may trigger expensive server-side delta computation for many resources. Servers MUST enforce a maximum version vector size and respond with `413 Content Too Large` for oversized requests. Servers SHOULD impose per-client rate limits and bound the time allocated to delta computation per request.

### 8.5 Delta Integrity

Without TLS, a MITM can modify delta operations in transit. When TLS is in use, the TLS record layer provides integrity. For defense-in-depth on sensitive resources, servers MAY include an HMAC signature over the delta payload in a `Sync-Delta-Signature` response header.

A complete treatment of SYNC security considerations, including the 409 oracle attack, replay attacks on cached responses, and version rollback, is provided in the companion security analysis document.

---

## 9. IANA Considerations

### 9.1 HTTP Method Registration

This document requests that IANA register the following entry in the "Hypertext Transfer Protocol (HTTP) Method Registry" at <https://www.iana.org/assignments/http-methods>:

| Field | Value |
|---|---|
| Method Name | SYNC |
| Safe | Yes |
| Idempotent | Yes |
| Reference | This document |

### 9.2 Media Type Registrations

This document requests registration of the following media types:

- `application/sync-vector+json` — the content type of SYNC request bodies (version vector documents).
- `application/sync-delta+json` — the content type of SYNC response bodies (delta documents).

---

## 10. References

### 10.1 Normative References

- **RFC 2119** — Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119, March 1997.
- **RFC 8174** — Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174, May 2017.
- **RFC 9110** — Fielding, R., et al., "HTTP Semantics", RFC 9110, June 2022.
- **RFC 9112** — Fielding, R., et al., "HTTP/1.1", RFC 9112, June 2022.
- **RFC 6902** — Bryan, P. and M. Nottingham, "JavaScript Object Notation (JSON) Patch", RFC 6902, April 2013.
- **RFC 6901** — Bryan, P., et al., "JavaScript Object Notation (JSON) Pointer", RFC 6901, April 2013.
- **RFC 7232** — Fielding, R. and J. Reschke, "Hypertext Transfer Protocol (HTTP/1.1): Conditional Requests", RFC 7232, June 2014.

### 10.2 Informative References

- **RFC 3229** — Mogul, J., et al., "Delta encoding in HTTP", RFC 3229, January 2002.
- **RFC 6455** — Fette, I. and A. Melnikov, "The WebSocket Protocol", RFC 6455, December 2011.
- **draft-ietf-httpbis-safe-method-w-body** — Snell, J., "HTTP QUERY Method", Internet-Draft, 2021.
- **RFC 4918** — Dusseault, L., "HTTP Extensions for Web Distributed Authoring and Versioning (WebDAV)", RFC 4918, June 2007.
