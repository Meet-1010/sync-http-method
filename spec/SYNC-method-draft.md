# The SYNC HTTP Method
**Internet-Draft**
Author: Meet Chauhan
Date: October 2026
Status: Informational / Proposed Standard

---

## Abstract

This document defines the SYNC HTTP method — a new request method that enables
clients to declare their current state as a version vector and receive only the
minimal delta required to reach the server's current state. SYNC is safe,
idempotent, and cacheable, and fills a gap not addressed by any existing HTTP
method or widely adopted extension.

---

## 1. Introduction

### 1.1 Problem Statement

HTTP/1.1 defines methods whose semantics cover creation (POST), full replacement
(PUT), partial modification (PATCH), retrieval (GET), and deletion (DELETE). None
of these methods addresses the following query:

> "I know my current state exactly. Give me only what has changed since that
> state — nothing more."

The practical consequence is that clients wishing to stay synchronized with a
server must choose between:

- **Full re-fetch (GET)** — always returns the entire resource, regardless of
  how little has changed.
- **Conditional GET (ETag / If-None-Match)** — binary outcome: either the full
  resource or a 304 Not Modified. No partial delta.
- **PATCH** — mutates server state; direction is client→server, not
  server→client.
- **WebSockets** — requires a protocol upgrade and a persistent connection;
  not REST-compatible.
- **Server-Sent Events** — server-initiated push only; the client cannot
  declare its known state.
- **RFC 3229 Delta Encoding (2002)** — server-chosen baseline, header-based,
  almost universally unimplemented.

### 1.2 Comparison with Existing Methods

| Mechanism | Client declares state | Returns delta only | Standard HTTP | Pull-based |
|---|---|---|---|---|
| GET | No | No | Yes | Yes |
| GET + ETag | Version token only | No (binary) | Yes | Yes |
| RFC 3229 | No | Yes (server picks baseline) | Partially | Yes |
| WebSockets | Implicit | Application-defined | No | No |
| **SYNC** | **Yes (vector)** | **Yes** | **Proposed** | **Yes** |

---

## 2. The SYNC Method

### 2.1 Semantics

A SYNC request asks the server to compute and return the minimal set of changes
(a "delta") between the state described by the client's version vector and the
server's current state.

The server MUST NOT modify any resource as a result of a SYNC request.

### 2.2 Safety and Idempotency

SYNC is **safe** (it does not modify server state) and **idempotent** (repeating
the same request with the same version vector MUST produce the same response,
subject to the server's state remaining unchanged). SYNC responses MAY be cached
with appropriate cache headers.

### 2.3 Request Format

```
SYNC /api/resource HTTP/1.1
Host: example.com
Content-Type: application/sync-vector+json
Accept: application/sync-delta+json

{
  "version_vector": {
    "/resource/users": "v42",
    "/resource/posts": "v18"
  },
  "resources": ["/resource/users", "/resource/posts"],
  "options": {
    "max_delta_size": 1048576,
    "compression": "gzip"
  }
}
```

### 2.4 Version Vectors

A **version vector** is a JSON object mapping resource identifiers (URI paths)
to opaque version tokens. Version tokens are server-assigned and MUST be treated
as opaque strings by clients. The server alone defines the relationship between
version tokens and resource state.

A client SHOULD include all resources it wishes to synchronize in a single SYNC
request to minimize round trips.

---

## 3. Response Codes

| Code | Meaning |
|---|---|
| `200 OK` | Delta computed; response body contains deltas for all requested resources |
| `204 No Content` | Client is already at the server's current state; no delta needed |
| `409 Conflict` | One or more client versions are too old or unrecognizable; full re-fetch required |
| `413 Content Too Large` | The version vector or options payload exceeds server limits |
| `422 Unprocessable Entity` | The request body is malformed or version_vector is missing |
| `501 Not Implemented` | The server does not support SYNC on this resource |

---

## 4. Delta Format (JSON Patch / RFC 6902)

Delta operations use the JSON Patch format defined in RFC 6902. Each delta entry
in the response body contains:

- `from_version` — the client's version token for this resource
- `to_version` — the server's current version token for this resource
- `operations` — an array of RFC 6902 operations (`add`, `remove`, `replace`,
  `move`, `copy`)

Example response body:

```json
{
  "deltas": {
    "/users": {
      "from_version": "v1",
      "to_version": "v3",
      "operations": [
        { "op": "add", "path": "/~1users~13", "value": { "id": 3, "name": "Carol" } },
        { "op": "replace", "path": "/~1users~11/email", "value": "alice_new@example.com" }
      ]
    }
  },
  "server_version": "v3",
  "synced_at": "2026-10-05T10:00:00Z"
}
```

Response headers:

- `Sync-Server-Version` — the server's current global version
- `Sync-Delta-Complete` — `true` if the entire delta fits in this response;
  `false` if the server truncated the delta (client should paginate)

---

## 5. Security Considerations

**Denial of service:** servers MUST enforce limits on version vector size (per
the `413` response) and on the computational cost of delta generation.

**Information disclosure:** a SYNC response reveals which fields changed between
versions. Servers MUST apply the same access control to SYNC responses as to GET
responses for the same resources.

**Replay:** because SYNC is safe and idempotent, replaying a SYNC request has no
harmful effect beyond the bandwidth cost.

**Version token guessing:** version tokens SHOULD be non-guessable (e.g. random
UUIDs or HMACs) to prevent clients from probing resource history.

---

## 6. IANA Considerations

### 6.1 HTTP Method Registration

This document requests that IANA register the following HTTP method in the
"Hypertext Transfer Protocol (HTTP) Method Registry":

| Method | Safe | Idempotent | Reference |
|---|---|---|---|
| SYNC | Yes | Yes | This document |

---

## 7. References

### 7.1 Normative References

- **RFC 7231** — Hypertext Transfer Protocol (HTTP/1.1): Semantics and Content
- **RFC 5789** — PATCH Method for HTTP
- **RFC 6902** — JavaScript Object Notation (JSON) Patch
- **RFC 7232** — Hypertext Transfer Protocol (HTTP/1.1): Conditional Requests

### 7.2 Informative References

- **RFC 3229** — Delta Encoding in HTTP (2002) — closest prior art; abandoned
- **RFC 4918** — HTTP Extensions for Web Distributed Authoring and Versioning (WebDAV)
- **draft-ietf-httpbis-safe-method-w-body** — IETF QUERY draft (2021)
- Microsoft Graph API `$deltatoken` documentation
- CouchDB Replication Protocol
