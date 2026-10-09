---
Title: The SYNC HTTP Method
Abbrev: SYNC Method
Category: Standards Track
Author: Meet Chauhan
Date: October 2026
Revision: -01
---

# The SYNC HTTP Method

## Abstract

This document defines the SYNC HTTP method. SYNC is a safe, idempotent request method with which a client declares, for one or more resources, the version it already holds (its *baselines*) and receives, in a single response, an independent per-resource result: an update from that baseline to the current state, expressed as a JSON Patch, a JSON Merge Patch, or a full snapshot. SYNC is a stateless pull: it needs no long-lived connection, and a stale or missing baseline for one resource never fails the others. It is intended as a batch catch-up primitive that composes with, rather than replaces, subscription-based approaches. This document requests registration of the SYNC method in the HTTP Method Registry maintained by IANA.

---

## 1. Introduction

### 1.1 Background and Motivation

HTTP provides methods for retrieval (GET), creation (POST), replacement (PUT), partial modification (PATCH), and deletion (DELETE). Conditional requests (RFC 9110, Section 13) let a client avoid re-fetching an unchanged resource via entity tags, but the outcome is binary: the full representation or `304 Not Modified`.

Many applications hold local copies of several resources and periodically need to bring all of them up to date: a mobile app resuming after being offline, a dashboard, a configuration agent, a cache. Today such a client typically either re-fetches every resource in full, or issues one request per resource that carries a baseline in some mechanism particular to that API. This document calls the shared need the *catch-up problem*: given what I already hold for N resources, send me only what changed.

### 1.2 Position Relative to Existing Work

This is not the first proposal in this space, and this document does not claim it is. Section 1.4 compares SYNC with the related work. In brief, SYNC occupies one narrow combination that the cited efforts treat as secondary or out of scope:

1. **Multiple resources per request**, each with its own baseline.
2. **A stateless pull** with no long-lived connection and no server-side subscription state.
3. **Independent per-resource outcomes**, so partial failure is routine, not exceptional.
4. **A negotiated update format** rather than a single mandated one.

### 1.3 Goals

1. Let a client declare its current baseline for one or more resources in a single request.
2. Let the server answer each resource independently with the smallest update it can produce in a format the client accepts.
3. Be **safe** and **idempotent** (Section 3.2).
4. Keep the version-token scheme opaque so that integer counters, hashes, or causal-history identifiers (for example Braid version IDs) can all be used.
5. Compose with subscription mechanisms: a client can SYNC to catch up on N resources, then open streams for live updates.

### 1.4 Non-Goals

- Real-time server push. SYNC is client-initiated. Subscription-based mechanisms (Section 1.5) are the right tool for push.
- Writes or conflict resolution. SYNC is read-only. Mutations continue to use PUT, POST, or PATCH; merge semantics (CRDT/OT) are out of scope.
- A specific version scheme. Tokens are opaque; this document does not define how servers generate or order them.

### 1.5 Related Work

**Braid-HTTP** (`draft-toomim-httpbis-braid-http-04`; versions in `draft-toomim-httpbis-versions-04`). A `GET` carrying a `Parents` header asks for updates since a stated version, and the draft allows JSON Patch (RFC 6902) as a patch type. This is the closest prior art to the single-resource form of SYNC. Braid additionally defines subscriptions (`Subscribe`, `209`), merge types, and version DAGs, all of which are outside SYNC's scope. Braid operates per URI; a client tracking N resources issues N requests or subscriptions. The published drafts have expired, and the latest Braid-HTTP draft (-04) has not yet filled in its Security Considerations section.

**Mercure** (`draft-dunglas-mercure-08`). A publish/subscribe hub delivering updates over Server-Sent Events, with topic matchers, OAuth-based authorization, and `Last-Event-ID` resumption. Resumption uses one hub-wide event cursor rather than a per-resource version, and the hub may discard history. Mercure is push-oriented and requires a long-lived connection.

**Events Query** (`draft-gupta-httpapi-events-query-03`). Uses the QUERY method (RFC 10008) to return a representation and a stream of event notifications from one resource. It lists multi-resource delivery as a limitation (its Section 2.5) and places versioning and resumption out of scope (its Section 2.4.3). SYNC addresses exactly those two points for the pull case.

**JMAP** (RFC 8620). A complete JSON application protocol whose `/changes` methods return changes since a client-supplied state string, and which batches multiple method calls in one request. SYNC differs in being a generic HTTP method over arbitrary JSON resources, not an application protocol with its own object model and endpoint.

**WebDAV Collection Synchronization** (RFC 6578). Defines a `sync-token` for efficiently synchronizing the members of one WebDAV collection. It is specific to WebDAV collections.

**RFC 3229** (Delta encoding in HTTP). Extends GET with server-chosen baselines selected from the server's own instance history. The client cannot declare which version it holds. It saw little deployment.

**QUERY** (RFC 10008). A safe, idempotent method that carries a request body. SYNC is also a safe, idempotent method with a body, and the same considerations about cache keys apply (Section 7). SYNC defines semantics for that body; QUERY defines none. An alternative design is to express SYNC as a QUERY with a defined media type (see Section 11).

---

## 2. Conventions and Definitions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all capitals, as shown here.

**Baseline:** A version token declaring the state of one resource that the client currently holds. A baseline of `null` declares that the client holds no state for that resource.

**Baseline map:** A JSON object mapping resource identifiers (URI path strings) to baselines. (Revision -00 called this a "version vector". That term has a specific meaning in distributed systems, one counter per replica, which this structure is not, so it was renamed.)

**Version token:** An opaque string assigned by the server to identify a state of a resource. Clients MUST treat tokens as opaque. The server alone defines which tokens it recognizes and how they relate to resource states.

**Update:** The information needed to move one resource from its baseline to the server's current state, in one of the formats of Section 6.

**Result:** The per-resource entry in a SYNC response: a status plus, where applicable, an update.

---

## 3. The SYNC Method

### 3.1 Semantics

A SYNC request asks the server to resolve each resource in the baseline map independently and return one result per resource. The server MUST NOT modify any resource as a result of processing a SYNC request.

```
Client -> Server:  "I hold /a at token T1, /b at T2, and nothing for /c."
Server -> Client:  "/a: here is a patch to current. /b: unchanged. /c: here is a snapshot."
```

If every requested resource is unchanged, the server returns `204 No Content`.

### 3.2 Safety and Idempotency

SYNC is **safe** (RFC 9110, Section 9.2.1): it is a read-only method, and implementations MUST NOT use it to trigger mutations. SYNC is **idempotent** (RFC 9110, Section 9.2.2): repeating the same request against an unchanged server produces the same response. Clients and intermediaries MAY therefore retry SYNC automatically.

### 3.3 Relationship to Existing Methods

**GET** retrieves current state; SYNC retrieves the change from a declared prior state, for several resources at once. They are complementary: GET for first fetch, SYNC afterward.

**PATCH** carries client-originated changes to the server; SYNC returns server-originated changes to the client. SYNC returns patches in the same formats PATCH accepts (RFC 6902, RFC 7396) but is not itself a mutation.

**Subscriptions** (Braid `Subscribe`, Mercure, Events Query) deliver future changes over a held connection. SYNC delivers accumulated past changes in one exchange. A client MAY SYNC to catch up and then subscribe; this document does not define the subscription.

---

## 4. Request Format

### 4.1 Request Headers

- `Content-Type: application/sync-baseline+json` when a body is present.
- `Accept: application/sync-result+json`.
- `Content-Length`, per RFC 9110.

### 4.2 Request Body

```json
{
  "baselines": {
    "/users":  "a4f2c1d9",
    "/posts":  "7b1e2f3a",
    "/config": null
  },
  "accept": ["application/merge-patch+json", "application/json-patch+json"],
  "recover": true
}
```

- `baselines` (REQUIRED): object mapping resource paths to a token string or `null`. The set of resources to synchronize is exactly the set of keys.
- `accept` (OPTIONAL): array of media types in decreasing preference, drawn from Section 6. Default: `["application/json-patch+json"]`. Unknown media types MUST be ignored. A server MAY always answer with a snapshot (`application/json`) regardless of `accept` (Section 6.4).
- `recover` (OPTIONAL, default `true`): controls the response to an unrecognized baseline (Section 5.2).

### 4.3 Header Form

For small requests, the baseline map MAY be carried instead in a `Sync-Baseline` request header whose value is an RFC 8941 List of Inner Lists of Strings. Each inner list is `(resource token)`, or `(resource)` for no baseline:

```
Sync-Baseline: ("/users" "a4f2c1d9"), ("/posts" "7b1e2f3a"), ("/config")
Sync-Accept: application/merge-patch+json, application/json-patch+json
```

A Dictionary cannot be used because Dictionary keys cannot contain `/`. A request MUST NOT carry baselines in both the header and the body; the server MUST answer `422`. Because many implementations limit header size, the body form is RECOMMENDED when more than a handful of resources are listed.

### 4.4 Limits

Servers MUST bound the cost of a SYNC request:

- At most a configured number of resources per request; the RECOMMENDED default is 100. Excess: `413 Content Too Large`.
- A maximum body size; the RECOMMENDED default is 64 KiB. Excess: `413`, ideally without reading the whole body.
- A maximum header section size. Excess: `431 Request Header Fields Too Large`.

### 4.5 POST Compatibility Form

Many servers, proxies, CDNs, and WAFs reject methods they do not know, and some runtimes do so at the HTTP parser (Node.js returns `400` before any application code runs). To make SYNC deployable on such paths, a server that supports SYNC SHOULD also accept the same request as a `POST` whose `Content-Type` is `application/sync-baseline+json`, and MUST then process it exactly as it would the SYNC method and return an identical response.

A client SHOULD try the SYNC method first and fall back to the POST form on `400`, `405`, or `501`, or when the connection is reset before a response, and SHOULD remember per origin that the POST form is required. Generic intermediaries do not know that this POST is safe and idempotent, so they will not cache or automatically retry it. SYNC-aware clients MAY retry it, because the exchange is idempotent. Servers MUST apply the limits of Section 4.4 to this form as well.

The POST form trades the clean semantics of a dedicated method for reach. Whether the specification should instead define SYNC only as a QUERY profile (Section 11) is open.

---

## 5. Response Format

### 5.1 Status Codes

**200 OK.** At least one resource has a result other than `304`. The body is a result document (Section 5.3). `200` is used even when some or all results are errors, because success of the exchange is distinct from success per resource.

**204 No Content.** Every requested resource is unchanged. The body MUST be empty.

**413 Content Too Large**, **431 Request Header Fields Too Large.** Limits of Section 4.4.

**422 Unprocessable Content.** The request is malformed: invalid JSON, missing or non-object `baselines`, a token that is neither string nor `null`, a malformed `Sync-Baseline` header, or baselines in both header and body.

**411 Length Required.** A SYNC request used a chunked body. Servers MAY require `Content-Length` for this method.

**501 Not Implemented.** The server does not support SYNC at the target.

### 5.2 Per-Resource Status

Each result carries its own `status`, modelled on HTTP status codes:

| status | Meaning |
|---|---|
| 200 | An update is present: `format`, `from`, `to`, `data`. |
| 304 | The baseline is the current version. Only `to` is present. |
| 404 | The resource does not exist. |
| 409 | The baseline is not recognized and the request set `recover` to `false`. |

When a baseline is not recognized (for example because it is older than the server's retention window) and `recover` is `true`, the server SHOULD return status `200` with `format: "application/json"`, `from: null`, and `data` holding the full current representation. It MAY add `"baseline": "unrecognized"` so the client knows it was reset. A server that does not wish to reveal whether a token is recognized (Section 8.3) SHOULD omit that member. This recovers in the same round trip, whereas a bare `409` would force the client to issue a separate GET.

A failure for one resource MUST NOT prevent results for other resources.

### 5.3 Result Document

```json
{
  "results": {
    "/users": {
      "status": 200,
      "format": "application/merge-patch+json",
      "from": "a4f2c1d9",
      "to": "c93b7e10",
      "data": { "/users/1": { "email": "new@example.com" } }
    },
    "/posts":  { "status": 304, "to": "7b1e2f3a" },
    "/config": { "status": 200, "format": "application/json", "from": null, "to": "5d0e1b22", "data": { "timeout": 30 } },
    "/gone":   { "status": 404 }
  },
  "synced_at": "2026-10-09T10:00:00Z"
}
```

- `from` is the baseline the update starts from (`null` for a snapshot).
- `to` is the token the client holds after applying the update.
- `data` is the patch or snapshot, as indicated by `format`.

### 5.4 Response Headers

- `Content-Type: application/sync-result+json` on `200`.
- `Cache-Control: no-store` (see Section 7).
- `Sync-Delta-Complete: true|false`. `false` means the server omitted some requested resources from `results` (for example to bound work per request); the client MUST re-request the omitted resources. Omitted resources are those present in the request but absent from `results`.

There is deliberately no single "server version" header. Revision -00 defined one, but a single value is not well defined across several independently versioned resources.

---

## 6. Update Formats

### 6.1 JSON Patch (`application/json-patch+json`)

An RFC 6902 array. JSON Pointer (RFC 6901) paths escape `/` as `~1` and `~` as `~0`. Operations MUST be applied in array order.

### 6.2 JSON Merge Patch (`application/merge-patch+json`)

An RFC 7396 document. Merge Patch cannot represent a `null` object member (null means delete) and replaces arrays wholesale. When a change cannot be expressed as a merge patch, the server MUST NOT use that format for the resource; it MUST proceed to the client's next preferred format.

### 6.3 Snapshot (`application/json`)

The full current representation, replacing the client's copy.

### 6.4 Format Selection

For each resource the server walks the client's `accept` list in order and picks the first format in which it can express the change. It SHOULD send a snapshot instead if the chosen update is not smaller than the snapshot. A server MAY always send a snapshot. A client MUST therefore be prepared to receive a snapshot for any resource.

Other formats (for example binary diffs, or Braid-style range patches) may be registered later; unknown formats in `accept` are ignored.

### 6.5 Applying Updates Client-Side

Before applying a patch, the client MUST check that the result's `from` equals the baseline it holds for that resource. If not, it MUST discard the result and issue a fresh request. Applying a patch to a different state than it was computed against can silently corrupt local state. If applying any operation fails, the client MUST leave its state unchanged.

---

## 7. Caching Considerations

SYNC responses reveal per-client state transitions and are only meaningful relative to the request body. Servers SHOULD send `Cache-Control: no-store` and, in this revision, caching of SYNC responses is not specified. A future revision could allow caching using the approach of RFC 10008, where the cache key includes the normalized request content.

---

## 8. Security Considerations

A fuller analysis, including attack scenarios, is in the companion document (`SECURITY-ANALYSIS.md`).

### 8.1 Transport Security

SYNC MUST be deployed over TLS. The baselines reveal what the client holds; the results reveal server state.

### 8.2 Rollback and Replay

A replayed or cached response can carry a patch computed from an older baseline. Clients MUST apply the check in Section 6.5. Servers SHOULD send `Cache-Control: no-store`.

### 8.3 Baseline Probing

Any protocol in which a client presents a resume cursor lets a prober distinguish recognized from unrecognized cursors. In SYNC the distinction is visible as patch-versus-snapshot (and as `409` when `recover` is `false`). Mercure documents a related leak, in which an event cursor lets a subscriber infer the existence and approximate timing of events it cannot read. Mitigations: tokens MUST be opaque and unguessable (random identifiers or keyed hashes, not sequential integers); servers SHOULD rate-limit per authenticated identity; and servers that must not reveal token validity SHOULD NOT include the `baseline` member of Section 5.2 and MAY choose a snapshot for every resource, at a bandwidth cost.

### 8.4 Amplification

A request naming many resources multiplies server work. Servers MUST enforce the limits of Section 4.4, SHOULD bound per-request computation time, and MAY use `Sync-Delta-Complete: false` to defer remaining resources.

### 8.5 Authorization

Authorization applies per resource. A result of `404` MAY be used to avoid revealing whether an unauthorized resource exists. Servers MUST NOT disclose, through a patch, data the client is not authorized to read.

### 8.6 Compression and Cross-Origin Use

Result documents echo resource names from the request and may contain sensitive values. Response compression over TLS can enable length-based attacks (BREACH family) when an attacker can cause a victim's client to send chosen requests. Because SYNC is not a CORS-safelisted method, browsers preflight cross-origin SYNC requests; servers SHOULD NOT permit SYNC from untrusted origins.

### 8.7 Delta Integrity

Without TLS, an on-path attacker can alter a patch. Under TLS, record-layer integrity applies. For defense in depth, servers MAY sign result documents (for example in a `Sync-Result-Signature` header; its definition is out of scope here).

---

## 9. IANA Considerations

### 9.1 HTTP Method Registration

| Field | Value |
|---|---|
| Method Name | SYNC |
| Safe | Yes |
| Idempotent | Yes |
| Reference | This document |

### 9.2 Media Types

- `application/sync-baseline+json`: request body (Section 4.2).
- `application/sync-result+json`: response body (Section 5.3).

### 9.3 HTTP Field Names

- `Sync-Baseline` (request; Section 4.3)
- `Sync-Accept` (request; Section 4.3)
- `Sync-Delta-Complete` (response; Section 5.4)

---

## 10. References

### 10.1 Normative References

- **RFC 2119**, **RFC 8174**: BCP 14 key words.
- **RFC 9110**: Fielding, R., Nottingham, M., Reschke, J., "HTTP Semantics", June 2022.
- **RFC 9112**: Fielding, R., Nottingham, M., Reschke, J., "HTTP/1.1", June 2022.
- **RFC 6901**: Bryan, P., Zyp, K., Nottingham, M., "JavaScript Object Notation (JSON) Pointer", April 2013.
- **RFC 6902**: Bryan, P., Nottingham, M., "JavaScript Object Notation (JSON) Patch", April 2013.
- **RFC 7396**: Hoffman, P., Snell, J., "JSON Merge Patch", October 2014.
- **RFC 8941**: Nottingham, M., Kamp, P-H., "Structured Field Values for HTTP", February 2021.

### 10.2 Informative References

- **RFC 10008**: Reschke, J., Snell, J., Bishop, M., "The HTTP QUERY Method".
- **RFC 8620**: Jenkins, N., Newman, C., "The JSON Meta Application Protocol (JMAP)", July 2019.
- **RFC 6578**: Daboo, C., Quillaud, A., "Collection Synchronization for Web Distributed Authoring and Versioning (WebDAV)", March 2012.
- **RFC 3229**: Mogul, J., et al., "Delta encoding in HTTP", January 2002.
- **RFC 6455**: Fette, I., Melnikov, A., "The WebSocket Protocol", December 2011.
- **draft-toomim-httpbis-braid-http-04**: Toomim, M., et al., "Braid-HTTP: Synchronization for HTTP" (expired).
- **draft-toomim-httpbis-versions-04**: Toomim, M., "HTTP Resource Versioning" (expired).
- **draft-dunglas-mercure-08**: Dunglas, K., "The Mercure Protocol".
- **draft-gupta-httpapi-events-query-03**: Gupta, R., "HTTP Events Query".

---

## 11. Open Questions

1. **New method, POST form, or QUERY profile?** The POST form (Section 4.5) works everywhere today and loses method-level semantics for intermediaries.
2. **New method or QUERY profile?** Since RFC 10008, SYNC could be defined as a QUERY with `application/sync-baseline+json`, avoiding a new method registration. The cost is that QUERY semantics for intermediaries are generic; the benefit is deployability on infrastructure that already tolerates QUERY.
3. **Alignment with Braid version tokens.** Tokens are opaque so a Braid version-ID set can be carried as a string. Should the draft define a recommended encoding for sets of IDs?
4. **Caching.** Can SYNC responses be made safely cacheable, and is that valuable?
5. **Truncation.** `Sync-Delta-Complete: false` is specified minimally. Is omission of resources sufficient, or is a continuation cursor needed?
6. **HTTP/2 and HTTP/3.** With multiplexing, N parallel GETs cost less than under HTTP/1.1. The remaining advantage of a batch is measured in the accompanying benchmark.
7. **Binary and non-JSON resources.** Which update formats should be registered?

---

## Appendix A. Changes from -00

- "Version vector" renamed "baseline map"; request field `baselines` replaces `version_vector`; `resources` removed (the keys are the resource list).
- Per-resource results with their own status replace whole-request `404`/`409`.
- Unrecognized baselines recover with a snapshot by default.
- Update format is negotiated (`accept`); JSON Merge Patch and snapshot added to JSON Patch; snapshot fallback when smaller.
- `Sync-Baseline` header form added.
- Media types renamed: `application/sync-baseline+json`, `application/sync-result+json`.
- `Sync-Server-Version`, `options.max_delta_size`, and `options.compression` removed.
- Limits (resource count, body size, header size) and `Cache-Control: no-store` are now implemented by the reference server.
- Related work and positioning added (Section 1.5).
- POST compatibility form added (Section 4.5), with client fallback guidance.
- Servers may keep connections alive across SYNC requests; chunked SYNC bodies are refused with `411`.
- The reference server's data source is now a pluggable, possibly asynchronous store; a store that cannot reconstruct an old token simply causes a snapshot to be sent.
