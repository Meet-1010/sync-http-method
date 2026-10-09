---
Title: SYNC: Consistent, Cacheable Catch-Up of Multiple HTTP Resources
Abbrev: SYNC
Intended status: Standards Track (individual submission; venue to be discussed)
Draft name: draft-chauhan-http-sync-00 (supersedes the "SYNC method" proposal posted to ietf-http-wg on 2026-10-05)
Author: Meet Chauhan
Date: October 2026
---

# SYNC: Consistent, Cacheable Catch-Up of Multiple HTTP Resources

## Abstract

This document defines SYNC, a format for the HTTP QUERY method (RFC 10008) with which a client that already holds copies of several resources brings them up to date in one exchange. For each resource the client states the version it holds; the server answers each independently with a patch from that version, an indication that nothing changed, or the full representation. Resources may have any media type, and versions may be single identifiers or sets of identifiers, so causal histories are supported. A client can ask for all results to come from one consistent state of the server, so that related resources are never combined in a way that never existed. A client can also allow the server to answer with a redirect, as QUERY defines, to a resource holding the results: every client in the same state is sent to the same resource, so that ordinary shared caches serve a population of reconnecting clients from one response. Large updates can likewise be returned as links to immutable, cacheable updates. This document does not define a new HTTP method.

---

## 1. Introduction

### 1.1. The Catch-Up Problem

Applications often hold local copies of several resources: a mobile application resuming after being offline, a dashboard, an editor holding several documents, a configuration agent. To bring them current a client today re-fetches each resource, or issues one conditional request per resource ([RFC9110], Section 13), which returns either the complete representation or `304 (Not Modified)`. Finer-grained catch-up is done with application-specific mechanisms.

Catching up several resources with separate requests has three costs that grow with the number of resources:

1. **Overhead.** Each request carries its own headers and, often, its own connection.
2. **Inconsistency.** Separate requests observe the server at different moments. When resources are related (a post and its author, an order and its lines, a configuration and its schema), the client can assemble a combination that never existed on the server. Section 7.2 measures this.
3. **Load concentration.** After an outage or a deployment, many clients reconnect at once from the same state. Unless their requests can be served by shared caches, the origin computes and sends the same catch-up to every client. Section 7.3 measures this.

### 1.2. Approach

SYNC is a query format, identified by the media type `application/sync-baseline+json`, sent with QUERY [RFC10008] to a *sync resource*. QUERY already provides a safe, idempotent request whose content describes the query, with defined caching (Section 2.7 of [RFC10008]), conditional requests (Section 2.6), and a way to give results a URI (Sections 2.3 and 2.4). On top of it this document defines:

- **per-resource results**, so that a failure for one resource never affects the others (Section 4.4);
- **representations of any media type**, with JSON Patch, JSON Merge Patch, a text and binary *splice* patch, or the full representation (Section 4.5);
- **versions that are sets of identifiers**, compatible with causal histories (Section 3);
- **consistent snapshots**: all results from one state of the server (Section 4.7);
- **links to immutable updates** that shared caches can store (Section 4.8);
- **shared results**: a redirect to a resource holding the results, the same for every client in the same state, which shared caches can store (Section 4.9);
- a **JSON** and a **multipart** result format (Section 5).

An earlier version of this proposal defined a new method; that design is not pursued (Appendix A).

### 1.3. Relationship to Other Work

**Braid-HTTP** [BRAID] [BRAID-VERSIONS]. A `GET` carrying a `Parents` header asks for the updates since a stated version; Braid defines versions as sets of identifiers forming a history that is a directed acyclic graph, patches, subscriptions, and merge types for multiple concurrent writers. It covers far more than this document. Requests are per resource; Braid's multiplexing extension [BRAID-MUX] carries many subscriptions over one connection, while each resource is still requested individually. SYNC adopts Braid's model of versions and its `Version` and `Parents` fields within multipart results, and is intended to serve as a multi-resource catch-up step for Braid resources: a client can catch up many resources with one SYNC request and then subscribe to them.

**Mercure** [MERCURE]. A publish/subscribe hub delivering updates over Server-Sent Events, with resumption from a hub-wide event identifier. Resumption replays every event published since that identifier rather than returning the net change per resource, and requires a connection to the hub.

**Events Query** [EVENTS-QUERY]. Uses QUERY to obtain a representation and a stream of notifications from a single resource, using a multipart response. It lists multi-resource delivery as a limitation and leaves versioning and resumption out of scope. SYNC uses the same method for the pull-based, multi-resource case.

**JMAP** [RFC8620] provides `/changes` methods returning changes since a client-supplied state within its own object model. **WebDAV collection synchronization** [RFC6578] provides a synchronization token for the members of one collection. **Delta encoding** [RFC3229] lets the server, rather than the client, choose the baseline. SYNC is a generic format for arbitrary resources identified by URI.

### 1.4. Goals and Non-Goals

Goals: catch up any number of resources, of any media type, in one request; isolate failures per resource; allow results from one consistent state; allow the bulk of the data to be served by ordinary shared caches; reuse HTTP semantics rather than define new ones.

Non-goals: server push (subscription mechanisms such as those in Section 1.3 deliver later changes); writes and conflict resolution (SYNC only reads); a version model beyond the requirements of Section 3.

### 1.5. Notational Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

---

## 2. Terminology

**Sync resource:** The target resource of a SYNC request. It defines the scope of the resources that can be named in the request.

**Resource name:** An absolute-path reference (Section 4.2 of [RFC3986]), optionally with a query component and without a fragment, identifying a resource on the same origin as the sync resource; for example `/users` or `/posts?author=17`.

**Version identifier:** A string, assigned by the server, consisting of printable ASCII characters (%x20-7E) so that it can also be carried in a Structured Field String [RFC9651].

**Version:** A non-empty set of distinct version identifiers. A version after a single change is a set of one identifier; a version after merging concurrent changes may have several. In JSON a version is written as a string (one identifier) or an array of strings (whose order carries no meaning). Two versions are equal when they are equal as sets.

**Baseline:** The version of a resource that the client holds, or `null` if it holds no state for that resource.

**Update:** The information that brings a resource from a baseline to its current state: a patch, or the full representation.

**Result:** The per-resource entry of a response.

---

## 3. Versions

A server assigns versions to the states of each resource. A version MUST identify exactly one state of its resource: the representation (including its media type) associated with a version never changes. Servers MAY retain any subset of a resource's past versions and MAY stop retaining any version at any time.

Because a version identifies one state, the update between two given versions of a resource, in a given format, is fixed. Servers rely on this to give updates stable links (Section 4.8) and MAY reuse an update computed for one request in another.

Clients treat versions as opaque, except for testing them for equality. Versions are compatible with the Version and Parents model of [BRAID-VERSIONS]; a server holding Braid resources can use their versions directly.

---

## 4. The SYNC Query Format

### 4.1. Target Resource and Scope

A SYNC request is a QUERY request to a sync resource. Per Section 2 of [RFC10008], the sync resource determines the scope of the operation. Each resource name is interpreted relative to the origin of the target URI; a server MUST NOT interpret a resource name as identifying a resource on another origin, and the request format does not allow absolute URIs or network-path references. A name outside the scope of the sync resource is reported as `404` for that resource (Section 4.4).

A server MUST apply to each named resource the same access control it applies to a `GET` of that resource by the same requester. A resource the requester may not read MUST be reported in the same way as a resource that does not exist.

### 4.2. Request

The request content is a JSON object [RFC8259] with media type `application/sync-baseline+json`:

```http
QUERY /sync HTTP/1.1
Host: api.example.com
Content-Type: application/sync-baseline+json
Accept: application/sync-result+json

{
  "baselines": {
    "/users": "a4f2",
    "/doc.md": ["alice-17", "bob-9"],
    "/config": null
  },
  "accept": ["application/merge-patch+json", "application/sync-splice+json"],
  "consistent": true,
  "links": true,
  "redirect": true
}
```

- `baselines` (REQUIRED): an object whose member names are resource names and whose values are versions or `null`. The member names are the set of resources requested.
- `accept` (OPTIONAL): an array of patch media types in decreasing preference (Section 4.5). The default is `["application/json-patch+json", "application/sync-splice+json"]`. Unrecognized values MUST be ignored.
- `recover` (OPTIONAL, boolean, default `true`): the behavior for baselines the server does not retain (Section 4.4).
- `consistent` (OPTIONAL, boolean, default `false`): requests a consistent snapshot (Section 4.7).
- `links` (OPTIONAL, boolean, default `false`): allows the server to return links instead of inline content (Section 4.8).
- `redirect` (OPTIONAL, boolean, default `false`): allows the server to respond with a redirect to a shared result (Section 4.9).

Members not defined here MUST be ignored.

### 4.3. Request Errors

Following Section 2.1 of [RFC10008], and using problem details [RFC9457] in the response content:

- A request without a `Content-Type`, or whose content is not valid JSON, fails with `400 (Bad Request)`.
- Content that is valid JSON but does not satisfy Section 4.2 fails with `422 (Unprocessable Content)`; for example, `baselines` missing or not an object, a member name that is not a resource name, a baseline that is neither `null` nor a version, or a flag that is not a boolean.
- A server that supports QUERY at the target but not this format responds `415 (Unsupported Media Type)` and lists its formats in `Accept-Query` (Section 3 of [RFC10008]).
- A request whose `Accept` field excludes both result formats (Section 5) fails with `406 (Not Acceptable)`.
- A server MUST bound the number of resources and the size of the content it accepts; beyond those bounds it responds `413 (Content Too Large)`.

A sync resource SHOULD include `Accept-Query: "application/sync-baseline+json"` in its responses.

### 4.4. Per-Resource Results

If every requested resource is unchanged, the server MAY respond `204 (No Content)`. Otherwise it responds `200 (OK)` with a result for each requested resource, in one of the formats of Section 5, or redirects to a shared result (Section 4.9). Each result has a status whose meaning is that of the corresponding HTTP status code for that resource:

| Status | Meaning | Present |
|---|---|---|
| 200 | An update follows. | the version after the update; for a patch, its baseline and format; for a full representation, its media type; the content, or a link |
| 304 | The baseline is the current version. | the current version |
| 404 | The resource does not exist, is outside the scope of the sync resource, or the requester may not read it. | nothing else |
| 409 | The server does not retain the baseline and `recover` is `false`. | nothing else |

When the server does not retain a baseline and `recover` is `true`, it SHOULD return the full representation and MAY indicate that the baseline was not recognized; see Section 8.3 before doing so.

A result for one resource MUST NOT depend on whether any other requested resource could be resolved.

A response carries one HTTP status code for the exchange and a status per resource in its content, in the manner of WebDAV's `207 (Multi-Status)` [RFC4918]. `207` is not used because it is defined together with an XML response format.

### 4.5. Updates and Media Types

An update is either a **patch**, which applies to the client's copy at the baseline and is described by a patch media type, or the **full representation**, with the resource's own media type. A result carries a patch only if it states the patch's baseline; a result with no baseline carries the full representation.

How a representation is held and carried depends only on its media type:

- **JSON types** (`application/json` and any type with the `+json` suffix [RFC6839]): a JSON value.
- **Text types**: `text/*`, `application/xml` and types with the `+xml` suffix, `application/javascript`, and any media type with a `charset` parameter. The representation is UTF-8 [RFC3629] text.
- **All other types**: a sequence of octets.

Patch formats:

- `application/json-patch+json` [RFC6902], for JSON types.
- `application/merge-patch+json` [RFC7396], for JSON types. Merge Patch cannot express setting an object member to `null` and replaces arrays as a whole; a server MUST NOT use it for a change it cannot express.
- `application/sync-splice+json` (Section 6), for text and other non-JSON types.

For each resource the server uses the first format in the client's `accept` list that applies to the resource's media type and can express the change, and SHOULD send the full representation instead when that patch is not smaller. The server MUST send the full representation when the resource's media type differs between the baseline and the current version. A server MAY always send the full representation, and clients MUST accept it for any resource.

### 4.6. Client Processing

Before applying a patch, a client MUST check that the patch's baseline equals the version it holds and MUST discard the result otherwise. If applying any part of an update fails, the client MUST leave its copy unchanged. In both cases the client can repeat the request with a `null` baseline for that resource.

### 4.7. Consistent Snapshots

When a request has `"consistent": true`, the server either returns results that all describe one state of the server, or reports that it did not.

A server that honors the request MUST compute every result from the states of the requested resources at one instant between its receipt of the request and its response, as if all were read atomically, and MUST send `Sync-Consistent: ?1` (a Structured Field Boolean [RFC9651]) in the response. A server that cannot provide such a snapshot MUST send `Sync-Consistent: ?0`, and MUST NOT send `?1`. A client that requires consistency MUST treat a response without `Sync-Consistent: ?1` as not meeting that requirement.

Without consistent snapshots, results for different resources can reflect different moments, even within one request, because a server typically reads them separately. Separate requests for the resources have the same problem, more severely. Section 7.2 measures both.

The guarantee concerns the states from which the results are computed. Links (Section 4.8) do not weaken it, because each link names an update between two fixed versions.

### 4.8. Links to Immutable Updates

When a request has `"links": true`, the server MAY return, for any result with status `200`, a link in place of the content. A link is a URI reference, resolved against the target URI, that identifies a resource whose representation is exactly the content the result would otherwise carry: the patch (with the patch's media type) or the full representation (with the resource's media type). A client retrieves it with `GET`.

The content identified by a link never changes, because it is determined by the resource, the two versions, and the format (Section 3). A server therefore:

- MUST return the same content for every successful `GET` of a link;
- SHOULD make responses cacheable for as long as it expects to retain the versions involved; for resources that are the same for every requester, `Cache-Control: public` with a long lifetime lets shared caches serve every client that catches up from the same state;
- MUST apply to a `GET` of a link the same access control as to a `GET` of the resource, for the requester of that `GET`;
- MUST respond `404 (Not Found)` or `410 (Gone)` when it no longer retains the versions involved; the client then repeats the SYNC request for that resource without links;
- MUST NOT allow a link to be forged or altered to identify other content, and SHOULD use links that do not reveal resource names or version identifiers (Section 8.7).

Because shared caches that do not yet store QUERY responses do store GET responses, links let a deployment place the bulk of a catch-up in today's caches. Section 7.3 measures this.

### 4.9. Shared Results

When a request has `"redirect": true`, the server MAY respond `303 (See Other)` with a `Location` field instead of the results (Section 2.5 of [RFC10008]). The URI in `Location` identifies a *shared result*: a resource whose `GET` returns, with status `200 (OK)`, the response the request would otherwise have received at that moment, in the result format that the request's `Accept` field selected (Section 5), including its `Sync-Consistent` and `Sync-Delta-Complete` fields. A client retrieves it with `GET`.

The purpose is that clients in the same state, sending the same request at about the same time, are directed to one URI, so that a shared cache answers all of them from one response; this is the case when many clients reconnect after an outage or a deployment. Unlike the URI that `Location` carries in a `2xx` response to QUERY (Section 2.4 of [RFC10008]), which identifies the query and whose results change over time, a shared result identifies the results at one state. Therefore:

- The URI MUST identify the request and the version that each result leads to, so that two requests receive the same URI only if they would receive the same results, and a change to any requested resource leads to a different URI. The content of a shared result then never changes.
- The requirements for links (Section 4.8) apply to shared results: the same content for every successful `GET`; cacheability; access control for the requester of each `GET`, for every resource whose result is `200` or `304` in the shared result; `404 (Not Found)` or `410 (Gone)` when the server no longer retains a version involved; and protection against forgery and alteration.
- A server MUST NOT redirect a request when every requested resource is unchanged (Section 4.4).
- A server SHOULD redirect only when shared caches may store the shared result, that is, when the results are the same for every requester; otherwise the redirect costs the client a round trip without benefit.
- A server MUST NOT send a URI longer than the intermediaries on its path are expected to accept; Section 4.1 of [RFC9110] recommends support for URIs of at least 8000 octets. It sends the results directly instead.

A client that receives `404` or `410` for a shared result, or cannot retrieve it, SHOULD repeat the request without `redirect`.

A `303` response to a SYNC request names the state at the time it was generated. A cache that stores QUERY responses (Section 2.7 of [RFC10008]) can reuse it only within the freshness lifetime the server gives it, and the results it leads to are then as old as that response; a server SHOULD give the `303` response a lifetime no longer than it is willing for results to be stale, or none.

Clients that implement the Fetch standard [FETCH] follow a `303` response with `GET` on their own. The `redirect` member exists because other clients might not.

### 4.10. Partial Results

The `Sync-Delta-Complete` response field is a Boolean Structured Field. `?0` indicates that results for some requested resources were omitted, for example to bound the work of one request; the client SHOULD request the omitted resources again. If the field is absent or `?1`, every requested resource has a result.

---

## 5. Result Formats

The server selects a result format by proactive negotiation on `Accept` ([RFC9110], Section 12.5.1) and MUST include `Vary: Accept` in responses whose content depends on it. If neither format is acceptable it responds `406`. Without an `Accept` field, or when both are equally acceptable, the JSON format is used.

### 5.1. JSON (`application/sync-result+json`)

```json
{
  "results": {
    "/users":  { "status": 200, "from": "a4f2", "to": "c93b",
                 "format": "application/merge-patch+json",
                 "data": { "1": { "email": "new@example.com" } } },
    "/doc.md": { "status": 200, "from": ["alice-17", "bob-9"], "to": "alice-18",
                 "format": "application/sync-splice+json",
                 "data": { "unit": "codepoint", "splices": [[120, 4, "SYNC"]] } },
    "/logo":   { "status": 200, "from": null, "to": "l7", "type": "image/png",
                 "href": "/sync/u/8Jv3Qm0yX4sZt2cHkT1qLw..." },
    "/config": { "status": 304, "to": "5d0e" },
    "/gone":   { "status": 404 }
  }
}
```

For status `200`: `from` is the patch's baseline, or `null` for a full representation; `to` is the version after the update; `format` is the patch media type (patches only); `type` is the resource's media type (full representations only). The content is in `data`, or is replaced by `href` (Section 4.8). For full representations, `data` is the JSON value for JSON types, a string for text types, and for other types the base64 encoding ([RFC4648], Section 4) of the octets with `"encoding": "base64"`. For status `304`, `to` is the current version.

### 5.2. Multipart (`multipart/mixed`)

The response is a `multipart/mixed` entity [RFC2046] with one body part per requested resource. Body part header fields:

| Field | Value | Present |
|---|---|---|
| `Sync-Resource` | Structured Field String: the resource name | always |
| `Sync-Status` | Structured Field Integer: 200, 304, 404, or 409 | always |
| `Version` | List of Strings: the version after the update | 200, 304 |
| `Parents` | List of Strings: the patch's baseline | patches only |
| `Content-Type` | the patch media type, or the resource's media type | 200 |
| `Sync-Href` | Structured Field String: a link (Section 4.8) | when the content is a link |
| `Sync-Baseline` | Token `unrecognized` | optional (Section 4.4) |

The body part's content is the patch or the full representation as octets, or empty for other statuses and for links. `Version` and `Parents` follow the syntax of the corresponding fields of [BRAID-VERSIONS]. These are fields of body parts within this format, not HTTP header fields.

The multipart format carries representations of any type without re-encoding them.

---

## 6. The Splice Patch Format (`application/sync-splice+json`)

A splice document describes replacements of ranges of a representation:

```json
{ "unit": "codepoint", "splices": [[120, 4, "SYNC"], [300, 0, "new line\n"]] }
```

- `unit`: `"codepoint"` or `"byte"`.
  - `"codepoint"` applies to representations that are valid UTF-8. Positions count Unicode scalar values of the decoded text, and each insertion is a JSON string.
  - `"byte"` applies to any representation. Positions count octets, and each insertion is the base64 encoding ([RFC4648], Section 4) of the octets to insert.
- `splices`: an array of `[start, deleteCount, insert]`. Positions refer to the representation the patch applies to. `start` and `deleteCount` are non-negative integers. The splices are sorted, and do not overlap: each `start` is at least the previous `start` plus the previous `deleteCount`, and `start + deleteCount` does not exceed the length of the representation.

Applying a splice document yields the concatenation of the unchanged ranges and the insertions, in order. A recipient MUST reject a document that violates these rules, and MUST then leave its copy unchanged.

---

## 7. Interaction with HTTP, and Measurements

### 7.1. Safety, Idempotency, Caching, Conditional and Range Requests

SYNC requests are QUERY requests and are therefore safe and idempotent. Their responses are cacheable with the request content in the cache key (Section 2.7 of [RFC10008]). Results usually depend on the requester (Section 4.1); a server MUST NOT let shared caches store responses that do, and SHOULD send `Cache-Control: private` or `no-store` for them. A server MUST treat semantically equivalent request content identically, so that a cache's normalization of the content cannot produce an incorrect response. Conditional requests apply to the results (Section 2.6 of [RFC10008]); a server MAY use a resource's strong entity tag as its version identifier, with the caution that entity tags can differ between content codings of one state. Byte ranges are of little use for results (Section 2.8 of [RFC10008]); Section 4.10 provides partial results.

A server MAY give the results or the query a URI (`Content-Location`, `Location`; Sections 2.3 and 2.4 of [RFC10008]). Shared results (Section 4.9) use the redirection of Section 2.5 of [RFC10008] with a URI that names the state as well as the query. Links (Section 4.8) differ in granularity: each names one resource's update, which many different queries share.

### 7.2. Measured: Torn Reads

In a measurement accompanying this document, a writer commits one transaction every 5 ms, each changing three related resources together, while a client reads the three resources 300 times per approach and checks invariants that hold in every committed state. With realistic variation in network and store timing, 82% of reads made with three parallel `GET` requests, and 82% made with three parallel Braid requests (the braid-http library), returned combinations that never existed on the server. One SYNC request without `consistent` did so in 58% of reads, because its server read the resources separately. SYNC with `consistent` never did (0 of 300; 95% confidence interval 0 to 1.3%), at the same median latency. The repository contains the scripts and the complete results (`benchmarks/consistency-results.md`).

### 7.3. Measured: Reconnect Storms

In a second measurement, 100 clients holding the same versions of 50 resources reconnect within one second through a shared cache (nginx). When every client received its own results, the origin sent 6.2 MiB (and a Mercure hub replaying the same history sent 6.6 MiB). With shared results (Section 4.9), each client sent one QUERY, which the origin answered with a `303` response after reading only current versions, and one `GET`, which the cache answered. The origin sent 116 KiB in total and computed each update once. Per-resource `GET` requests with Braid's `Parents`, made cacheable for the measurement, reached 66 KiB at the origin, but with 50 requests per client instead of 2. When clients went offline at different times (five distinct states), shared results that carry links (Section 4.8) let the states share updates. With 500 clients the origin sent 327 KiB with shared results, against 31 MiB when every client received its own results. The repository contains the figures (`benchmarks/storm-results.md`, `benchmarks/storm-results-k500.md`).

---

## 8. Security Considerations

The companion document `SECURITY-ANALYSIS.md` discusses these points in detail and states which mitigations the reference implementation enforces. The considerations of [RFC9110] and Section 4 of [RFC10008] apply.

### 8.1. Transport

Baselines reveal what a client holds; results reveal server state. Requests MUST be sent over a secure connection in any deployment where either is sensitive.

### 8.2. Authorization and Caching

Authorization is evaluated per named resource (Section 4.1) and, for links and shared results, per `GET` (Sections 4.8 and 4.9). Responses, link content and shared results that depend on the requester MUST NOT be stored by shared caches. A server that makes them public asserts that they are the same for every requester.

### 8.3. Probing Versions

Any mechanism in which a client presents a resume point lets the client learn whether the server recognizes it: here, as a patch versus a full representation, as `"baseline": "unrecognized"`, or as status `409`. With guessable identifiers, a requester can learn when resources changed. Version identifiers SHOULD be unguessable where change history is sensitive; servers SHOULD rate-limit per requester, and servers that must not reveal recognition SHOULD omit the `unrecognized` indication and MAY return full representations.

### 8.4. Resource Consumption

One request can name many resources. Servers MUST bound the resources per request and the content size, SHOULD bound the time spent per request, and MAY use partial results (Section 4.10). Rate limits that count requests undercount SYNC; they SHOULD count resources processed. A consistent snapshot (Section 4.7) can require the server to retain state for the duration of a request; servers SHOULD bound that time. A redirect to a shared result (Section 4.9) moves the cost of computing updates from the request to the `GET`, which shared caches can absorb.

### 8.5. Replay and Integrity

A patch applied to a different version than its baseline corrupts the client's copy; Section 4.6 requires the client to check. A full representation carries no such check, so a replayed response can roll a client back; where that matters, servers can use version identifiers whose order clients can verify. Response integrity relies on the secure connection.

### 8.6. Malformed Patches

A splice or JSON patch received from a compromised or faulty server could attempt out-of-range or overlapping edits. Section 6 requires recipients to validate splice documents before applying them, and Section 4.6 requires that a failed update leave the client's copy unchanged.

### 8.7. Links and Shared Results

Links and shared results are retrieved with `GET`, and their URIs can appear in logs, caches, and referrers. Servers SHOULD use URIs that reveal neither resource names nor version identifiers, MUST prevent them from being forged or altered (for example by authenticating them), and MUST authorize each `GET` (Sections 4.8 and 4.9). A server that encodes the request in the URI, as a stateless server does, MUST bound the work a `GET` can cause as it bounds the request itself (Section 8.4); authenticating the URI ensures that only requests the server accepted can be replayed this way. If the content of a URI is compressed before it is encrypted, its length depends on that content; this reveals nothing to the client, which receives the same information in the results, but can reveal similarity between requests to an observer of URIs who can influence other clients' requests.

### 8.8. Compression

Results echo resource names from the request and can contain confidential data. Compressing such responses enables length-based attacks when an attacker can influence the request and observe response sizes. QUERY requests, and POST requests with this media type, are not CORS-safelisted [FETCH] and require a preflight; servers SHOULD NOT allow untrusted origins to send them.

---

## 9. Fallback to POST

Some servers, intermediaries, and libraries do not yet support QUERY. A server MAY accept the same request content with `POST` and, if it does, MUST process it as it would the QUERY request. A client SHOULD use QUERY and MAY retry with `POST` when the QUERY request fails with `400`, `404`, `405`, `415`, or `501`, or is not answered because a connection is closed, remembering per origin. Intermediaries cannot tell that such a `POST` is safe and idempotent, so they will not cache or automatically retry it.

---

## 10. IANA Considerations

### 10.1. Media Types

This document registers three media types in the "Media Types" registry, with the following common template values:

- Type name: application
- Required parameters: none
- Optional parameters: none
- Encoding considerations: binary; as for application/json [RFC8259]
- Security considerations: Section 8 of this document
- Interoperability considerations: none
- Published specification: this document
- Applications that use this media type: HTTP clients and servers that synchronize copies of resources
- Fragment identifier considerations: as for the "+json" structured syntax suffix [RFC6839]
- Additional information: Deprecated alias names: none; Magic number(s): none; File extension(s): none; Macintosh file type code(s): none
- Person and email address to contact for further information: Meet Chauhan, meetsc04@gmail.com
- Intended usage: COMMON
- Restrictions on usage: none
- Author: Meet Chauhan
- Change controller: IETF

and the subtype names `sync-baseline+json` (Section 4.2), `sync-result+json` (Section 5.1), and `sync-splice+json` (Section 6).

### 10.2. HTTP Field Names

| Field Name | Status | Structured Type | Reference |
|---|---|---|---|
| Sync-Consistent | permanent | Item | Section 4.7 |
| Sync-Delta-Complete | permanent | Item | Section 4.10 |

The body part fields of Section 5.2 are not HTTP fields and are not registered.

---

## 11. References

### 11.1. Normative References

- [RFC2046] Freed, N. and N. Borenstein, "Multipurpose Internet Mail Extensions (MIME) Part Two: Media Types", RFC 2046, November 1996.
- [RFC2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119, March 1997.
- [RFC3629] Yergeau, F., "UTF-8, a transformation format of ISO 10646", STD 63, RFC 3629, November 2003.
- [RFC3986] Berners-Lee, T., Fielding, R., and L. Masinter, "Uniform Resource Identifier (URI): Generic Syntax", STD 66, RFC 3986, January 2005.
- [RFC4648] Josefsson, S., "The Base16, Base32, and Base64 Data Encodings", RFC 4648, October 2006.
- [RFC6838] Freed, N., Klensin, J., and T. Hansen, "Media Type Specifications and Registration Procedures", BCP 13, RFC 6838, January 2013.
- [RFC6839] Hansen, T. and A. Melnikov, "Additional Media Type Structured Syntax Suffixes", RFC 6839, January 2013.
- [RFC6901] Bryan, P., Zyp, K., and M. Nottingham, "JavaScript Object Notation (JSON) Pointer", RFC 6901, April 2013.
- [RFC6902] Bryan, P. and M. Nottingham, "JavaScript Object Notation (JSON) Patch", RFC 6902, April 2013.
- [RFC7396] Hoffman, P. and J. Snell, "JSON Merge Patch", RFC 7396, October 2014.
- [RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174, May 2017.
- [RFC8259] Bray, T., "The JavaScript Object Notation (JSON) Data Interchange Format", STD 90, RFC 8259, December 2017.
- [RFC9110] Fielding, R., Nottingham, M., and J. Reschke, "HTTP Semantics", STD 97, RFC 9110, June 2022.
- [RFC9111] Fielding, R., Nottingham, M., and J. Reschke, "HTTP Caching", STD 98, RFC 9111, June 2022.
- [RFC9457] Nottingham, M., Wilde, E., and S. Dalal, "Problem Details for HTTP APIs", RFC 9457, July 2023.
- [RFC9651] Nottingham, M. and P-H. Kamp, "Structured Field Values for HTTP", RFC 9651, September 2024.
- [RFC10008] Reschke, J., Snell, J., and M. Bishop, "The HTTP QUERY Method", RFC 10008.

### 11.2. Informative References

- [BRAID] Toomim, M., et al., "Braid-HTTP: Synchronization for HTTP", draft-toomim-httpbis-braid-http-04 (expired).
- [BRAID-VERSIONS] Toomim, M., "HTTP Resource Versioning", draft-toomim-httpbis-versions-04 (expired).
- [BRAID-MUX] Braid project, "Multiplexing", https://braid.org/protocol/multiplexing.
- [MERCURE] Dunglas, K., "The Mercure Protocol", draft-dunglas-mercure-08.
- [EVENTS-QUERY] Gupta, R., "HTTP Events Query", draft-gupta-httpapi-events-query-03.
- [RFC3229] Mogul, J., et al., "Delta encoding in HTTP", RFC 3229, January 2002.
- [RFC4918] Dusseault, L., "HTTP Extensions for Web Distributed Authoring and Versioning (WebDAV)", RFC 4918, June 2007.
- [RFC6578] Daboo, C. and A. Quillaud, "Collection Synchronization for Web Distributed Authoring and Versioning (WebDAV)", RFC 6578, March 2012.
- [RFC8620] Jenkins, N. and C. Newman, "The JSON Meta Application Protocol (JMAP)", RFC 8620, July 2019.
- [FETCH] WHATWG, "Fetch Standard", https://fetch.spec.whatwg.org/.

---

## 12. Open Questions

1. **Relationship to Braid.** Should multi-resource catch-up be specified as an extension of Braid's versioning and update model, with SYNC's request as its multi-resource form?
2. **Patch formats.** Should the splice format give way to Braid's range patches [BRAID] once those are specified, or should both be registered?
3. **Unrecognized baselines.** Should the per-resource status align with the `432 (Version Not Found)` status of [BRAID-VERSIONS]?
4. **Caching of QUERY responses.** Should this document define a canonical form of the request content to make caches' normalization more effective? Should it recommend a freshness lifetime for `303` responses to SYNC requests (Section 4.9), so that QUERY-aware caches also absorb the requests themselves?
5. **Partial results.** Is omission sufficient, or is a continuation token needed?
6. **Venue.** HTTPAPI or HTTPBIS.

---

## Appendix A. Why Not a New Method

The proposal posted on 2026-10-05 defined a new method, SYNC. Discussion on the HTTP working group list asked how it differed from QUERY. It does not differ in any way that matters: a safe, idempotent request whose content describes what to return is what QUERY provides, together with defined caching, conditional request, and result-URI semantics. A new method would also be rejected by intermediaries and HTTP parsers that do not know it. This document therefore defines a query format. The reference implementation retains an experimental `SYNC` method carrying the same content, for comparison only; this document does not request its registration.

## Appendix B. Changes from the 2026-10-05 Proposal

- Carried by QUERY [RFC10008] instead of a new method; `POST` fallback.
- Per-resource results instead of a single status.
- Representations of any media type; the splice patch format; a multipart result format.
- Versions are sets of identifiers, compatible with [BRAID-VERSIONS]; "version vector" withdrawn.
- Consistent snapshots (Section 4.7).
- Links to immutable, cacheable updates (Section 4.8).
- Shared results through `303 (See Other)` (Section 4.9).
- Scope, resource names, and per-resource authorization defined.
- Interaction with caching, conditional and range requests, and result URIs defined.
- Errors as problem details, aligned with Section 2.1 of [RFC10008].
- `Sync-Delta-Complete` and `Sync-Consistent` are Structured Field Booleans.
