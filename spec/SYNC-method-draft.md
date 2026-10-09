---
Title: SYNC: Consistent, Cacheable Synchronization of Many HTTP Resources
Abbrev: SYNC
Intended status: Standards Track (individual submission; venue to be discussed)
Draft name: draft-chauhan-http-sync-00 (supersedes the "SYNC method" proposal posted to ietf-http-wg on 2026-10-05)
Author: Meet Chauhan
Date: October 2026
---

# SYNC: Consistent, Cacheable Synchronization of Many HTTP Resources

## Abstract

This document defines SYNC, a format for the HTTP QUERY method (RFC 10008), and a companion format for POST, with which a client keeps copies of many resources synchronized with a server. In one request the client states the version it holds of each resource; the server answers each independently with a patch from that version, an indication that nothing changed, or the full representation, and can keep sending the net changes as they happen. Resources may have any media type, and versions may be sets of identifiers, so causal histories are supported. A client can ask for every result to come from one consistent state of the server, so that related resources are never combined in a way that never existed, and can change several resources atomically, with the server merging changes made concurrently to different parts of a resource. Results are designed for ordinary shared caches: the server can redirect clients in the same state to one resource holding their results, name in each response the URI of the client's next catch-up, and return large updates as links to immutable resources, so that a population of clients is served by caches rather than by the origin. This document does not define a new HTTP method.

---

## 1. Introduction

### 1.1. The Catch-Up Problem

Applications often hold local copies of several resources: a mobile application resuming after being offline, a dashboard, an editor holding several documents, a configuration agent. To bring them current a client today re-fetches each resource, or issues one conditional request per resource ([RFC9110], Section 13), which returns either the complete representation or `304 (Not Modified)`. Finer-grained catch-up is done with application-specific mechanisms.

Keeping several resources synchronized with separate requests has four costs that grow with the number of resources:

1. **Overhead.** Each request carries its own headers and, often, its own connection.
2. **Inconsistency.** Separate requests observe the server at different moments. When resources are related (a post and its author, an order and its lines, a configuration and its schema), the client can assemble a combination that never existed on the server. Section 8.2 measures this.
3. **Load concentration.** After an outage or a deployment, many clients reconnect at once from the same state. Unless their requests can be served by shared caches, the origin computes and sends the same catch-up to every client. Section 8.3 measures this; Section 8.4 measures the same effect for clients that keep receiving changes.
4. **Partial writes.** Changing several related resources takes several requests. If one fails, the others have already been applied, and other clients can observe the state in between. Section 8.5 measures this.

### 1.2. Approach

SYNC is a query format, identified by the media type `application/sync-baseline+json`, sent with QUERY [RFC10008] to a *sync resource*. QUERY already provides a safe, idempotent request whose content describes the query, with defined caching (Section 2.7 of [RFC10008]), conditional requests (Section 2.6), and a way to give results a URI (Sections 2.3 and 2.4). On top of it this document defines:

- **per-resource results**, so that a failure for one resource never affects the others (Section 4.4);
- **representations of any media type**, with JSON Patch, JSON Merge Patch, a text and binary *splice* patch, or the full representation (Section 4.5);
- **versions that are sets of identifiers**, compatible with causal histories (Section 3);
- **consistent snapshots**: all results from one state of the server (Section 4.7);
- **links to immutable updates** that shared caches can store (Section 4.8);
- **shared results**: a redirect to a resource holding the results, the same for every client in the same state, which shared caches can store (Section 4.9);
- **next URIs**: in every response, the URI of the client's next catch-up, which clients in the same state share and shared caches can answer (Section 4.11);
- **watching**: a stream of the net changes to many resources, with changes made together delivered together (Section 4.12);
- a **JSON** and a **multipart** result format (Section 5);
- **atomic changes** to several resources, with a precondition per resource and merging of concurrent changes to different parts of a resource (Section 7).

An earlier version of this proposal defined a new method; that design is not pursued (Appendix A).

### 1.3. Relationship to Other Work

**Braid-HTTP** [BRAID] [BRAID-VERSIONS]. A `GET` carrying a `Parents` header asks for the updates since a stated version; Braid defines versions as sets of identifiers forming a history that is a directed acyclic graph, patches, subscriptions, and merge types for multiple concurrent writers. It covers far more than this document. Requests are per resource; Braid's multiplexing extension [BRAID-MUX] carries many subscriptions over one connection, while each resource is still requested individually. SYNC adopts Braid's model of versions and its `Version` and `Parents` fields within multipart results, and is intended to serve Braid resources: a client can catch up many resources with one SYNC request and then subscribe to them. SYNC's watching (Section 4.12) carries changes to many resources in one stream and delivers changes made together as one event; Braid's subscriptions are per resource. SYNC's atomic changes (Section 7) apply to several resources together; Braid's `PUT` applies to one, and Braid's merge types resolve concurrent edits to the same part of a resource, which Section 7.3 reports as a conflict.

**Mercure** [MERCURE]. A publish/subscribe hub delivering updates over Server-Sent Events, with resumption from a hub-wide event identifier. Resumption replays every event published since that identifier rather than returning the net change per resource, and requires a connection to the hub. A publisher can keep a transaction whole by publishing it as one event to the topics of every resource it changes; every subscriber to any of those topics then receives all of it, including changes to resources it does not watch. Section 8.4 measures both ways.

**Events Query** [EVENTS-QUERY]. Uses QUERY to obtain a representation and a stream of notifications from a single resource, using a multipart response. It lists multi-resource delivery as a limitation and leaves versioning and resumption out of scope. SYNC uses the same method for the pull-based, multi-resource case.

**JMAP** [RFC8620] provides `/changes` methods returning changes since a client-supplied state within its own object model. **WebDAV collection synchronization** [RFC6578] provides a synchronization token for the members of one collection. **Delta encoding** [RFC3229] lets the server, rather than the client, choose the baseline. SYNC is a generic format for arbitrary resources identified by URI.

### 1.4. Goals and Non-Goals

Goals: catch up any number of resources, of any media type, in one request; isolate failures per resource; allow results from one consistent state; deliver later changes as they happen, keeping changes made together together; change several resources atomically; allow the bulk of the data to be served by ordinary shared caches; reuse HTTP semantics rather than define new ones.

Non-goals: merging concurrent edits to the same part of a resource without conflicts (merge types such as Braid's provide this); a version model beyond the requirements of Section 3.

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
- `accept` (OPTIONAL): an array of the patch media types the client can apply, in decreasing preference (Section 4.5). The default is `["application/json-patch+json", "application/sync-splice+json"]`. Unrecognized values MUST be ignored.
- `recover` (OPTIONAL, boolean, default `true`): the behavior for baselines the server does not retain (Section 4.4).
- `consistent` (OPTIONAL, boolean, default `false`): requests a consistent snapshot (Section 4.7).
- `links` (OPTIONAL, boolean, default `false`): allows the server to return links instead of inline content (Section 4.8).
- `redirect` (OPTIONAL, boolean, default `false`): allows the server to respond with a redirect to a shared result (Section 4.9).
- `next` (OPTIONAL, boolean, default `false`): asks for the URI of the next catch-up (Section 4.11).
- `watch` (OPTIONAL, boolean, default `false`): asks the server to keep sending changes (Section 4.12).

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

When the server does not retain a baseline and `recover` is `true`, it SHOULD return the full representation and MAY indicate that the baseline was not recognized; see Section 9.3 before doing so.

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

For each resource the server MAY use any format in the client's `accept` list that applies to the resource's media type and can express the change. It SHOULD use the one whose content is smallest, preferring the earlier format in the list when sizes are equal, and SHOULD send the full representation instead when no such patch is smaller. The server MUST send the full representation when the resource's media type differs between the baseline and the current version. A server MAY always send the full representation, and clients MUST accept it for any resource.

### 4.6. Client Processing

Before applying a patch, a client MUST check that the patch's baseline equals the version it holds and MUST discard the result otherwise. If applying any part of an update fails, the client MUST leave its copy unchanged. In both cases the client can repeat the request with a `null` baseline for that resource.

### 4.7. Consistent Snapshots

When a request has `"consistent": true`, the server either returns results that all describe one state of the server, or reports that it did not.

A server that honors the request MUST compute every result from the states of the requested resources at one instant between its receipt of the request and its response, as if all were read atomically, and MUST send `Sync-Consistent: ?1` (a Structured Field Boolean [RFC9651]) in the response. A server that cannot provide such a snapshot MUST send `Sync-Consistent: ?0`, and MUST NOT send `?1`. A client that requires consistency MUST treat a response without `Sync-Consistent: ?1` as not meeting that requirement.

Without consistent snapshots, results for different resources can reflect different moments, even within one request, because a server typically reads them separately. Separate requests for the resources have the same problem, more severely. Section 8.2 measures both.

The guarantee concerns the states from which the results are computed. Links (Section 4.8) do not weaken it, because each link names an update between two fixed versions.

### 4.8. Links to Immutable Updates

When a request has `"links": true`, the server MAY return, for any result with status `200`, a link in place of the content. A link is a URI reference, resolved against the target URI, that identifies a resource whose representation is exactly the content the result would otherwise carry: the patch (with the patch's media type) or the full representation (with the resource's media type). A client retrieves it with `GET`.

The content identified by a link never changes, because it is determined by the resource, the two versions, and the format (Section 3). A server therefore:

- MUST return the same content for every successful `GET` of a link;
- SHOULD make responses cacheable for as long as it expects to retain the versions involved; for resources that are the same for every requester, `Cache-Control: public` with a long lifetime lets shared caches serve every client that catches up from the same state;
- MUST apply to a `GET` of a link the same access control as to a `GET` of the resource, for the requester of that `GET`;
- MUST respond `404 (Not Found)` or `410 (Gone)` when it no longer retains the versions involved; the client then repeats the SYNC request for that resource without links;
- MUST NOT allow a link to be forged or altered to identify other content, and SHOULD use links that do not reveal resource names or version identifiers (Section 9.7).

Because shared caches that do not yet store QUERY responses do store GET responses, links let a deployment place the bulk of a catch-up in today's caches. Section 8.3 measures this.

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

### 4.11. Next URIs

When a request has `"next": true`, the server MAY include in its response the `Sync-Next` response field, a Structured Field String [RFC9651] holding a URI reference resolved against the target URI. The URI identifies the same request (the same resources, members, and result format) with each baseline replaced by the version the corresponding result leads to, or `null` for a result with status `404` or `409`. A `GET` of it is processed as that request would be at the time of the `GET`, and its response has the same form, including a `Sync-Next` field for the request after that. A shared result (Section 4.9) for a request with `"next": true` carries the `Sync-Next` field that the direct response would.

Clients that hold the same versions of the same resources hold the same next URI, so their next catch-up is the same `GET`, which shared caches can answer. A population of clients that were current when they lost their connection can therefore reconnect at the cost of one request to the origin per state, and clients that poll do not reach the origin while nothing has changed. The response to a `GET` of a next URI reflects the state of the server when it was generated: its freshness lifetime is the server's to choose, as for any `GET`, and Section 8.1 applies to results that depend on the requester. The entity tag of such a response SHOULD identify the state its results lead to, so that a conditional request ([RFC9110], Section 13) can confirm that nothing changed without transferring the results.

A client MUST use a next URI only while it holds exactly the versions the URI names, for the resources it names; otherwise, and when the `GET` fails, it sends a request. A server SHOULD NOT send a next URI longer than intermediaries are expected to accept (Section 4.9). The requirements of Section 9.7 apply to next URIs.

### 4.12. Watching

When a request has `"watch": true` and its `Accept` field accepts `text/event-stream`, a server that supports watching MAY respond with a stream of events in the Server-Sent Events format [HTML] (`Content-Type: text/event-stream`). A server that does not support it responds as if `watch` were absent; a client recognizes this by the content type of the response.

Each event has the event type `sync`. Its data is a result document in the JSON format of Section 5.1, or an object whose only member, `href`, is a URI reference identifying a shared result (Section 4.9) that holds the result document. The first event brings every requested resource current, as the response to the request without `watch` would. Each later event carries results for the resources that changed since the previous event, as updates from the versions the previous events led to; a resource that has ceased to exist, or that the requester may no longer read, has status `404`. A server:

- MUST evaluate access control for every event as for a request by the same requester at that time;
- MAY combine changes that occur before an event is sent into that event, so that a client that reads slowly receives the net change rather than every intermediate version;
- with `"consistent": true`, MUST compute every event from one state of all requested resources, as for a consistent request (Section 4.7), and send `Sync-Consistent` in the response, so that changes made together are delivered together and the client never holds a combination that did not exist;
- SHOULD send comment lines at intervals, so that intermediaries do not close a stream that is idle.

When the stream ends, or the client cannot apply an event, the client sends the request again with the versions it holds and so receives the net change since. Event identifiers and `Last-Event-ID` are not used: the baselines of the request are the point of resumption. With `"links": true`, a server MAY send an event whose results are large as a link to a shared result: clients that receive the same change from the same versions receive the same link, so that a shared cache serves the content of the event to all of them.

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

## 7. Atomic Changes

A client changes several resources together by sending `POST` to the sync resource with content of media type `application/sync-changes+json`. `POST` is used because such a request is neither safe nor idempotent; Section 7.4 describes how to repeat it safely.

### 7.1. Request

```json
{
  "changes": {
    "/doc.md": { "base": "v7", "format": "application/sync-splice+json",
                 "data": { "unit": "codepoint", "splices": [[120, 4, "SYNC"]] } },
    "/todos":  { "base": "t3", "format": "application/merge-patch+json",
                 "data": { "3": { "done": true } } },
    "/new":    { "base": null, "type": "application/json", "data": { "title": "New" } },
    "/old":    { "base": "o2", "delete": true }
  },
  "merge": true
}
```

- `changes` (REQUIRED): an object whose member names are resource names (Section 2) and whose values are changes.
- Each change has a `base`: the version the change was made from, or `null` to create a resource that does not exist. It has exactly one of: a patch, given by `format` (a patch format of Section 4.5) and `data`; a full representation, given by `type` and `data`, with `"encoding": "base64"` for media types that are neither JSON nor text, as in Section 5.1; or `"delete": true`, which requires a `base`.
- `merge` (OPTIONAL, boolean, default `false`): allows the server to apply a change whose base is not the current version (Section 7.3).
- `accept` (OPTIONAL): as in Section 4.2, for the updates in the response.

Content that is not valid JSON is rejected with `400`, and content that does not satisfy this section with `422`, as in Section 4.3.

### 7.2. Processing

The server applies all of the changes or none of them. It applies them only if, for every change, the base is the current version of the resource (or is `null` and the resource does not exist), or `merge` is `true` and the change can be merged (Section 7.3). It applies them atomically: a consistent snapshot (Section 4.7) and every watcher (Section 4.12) observe all of them or none. The server assigns each changed resource a new version. Access control for each resource is that of a change to the resource by the same requester.

The response is `200 (OK)` when the changes were applied and `409 (Conflict)` when they were not, with a result per resource in the `results` member of a JSON result document (Section 5.1):

| Status | Meaning | Present |
|---|---|---|
| 200 | Applied. | `from` (the base) and `to` (the new version, absent after a deletion); `rebased` and `update` (Section 7.3) |
| 403 | The requester may read the resource but not change it. | nothing else |
| 404 | The resource does not exist, or the requester may not read it. | nothing else |
| 409 | The change conflicts with a newer version, or its base is no longer retained. | `current`, `reason` |
| 412 | The base is not the current version, and `merge` is not `true`. | `current` |
| 422 | The change is invalid, or does not apply to its base. | `reason` |
| 424 | Not applied, because another change could not be. | nothing else |

`424 (Failed Dependency)` has the meaning that [RFC4918] gives it.

### 7.3. Merging Concurrent Changes

With `"merge": true`, a change made from a base B to a resource whose current version is C is applied to C when it and the change from B to C, which the server computes, affect different parts of the representation:

- JSON representations, changed with JSON Patch or JSON Merge Patch: the parts are JSON Pointer [RFC6901] paths. Two changes conflict when a path that one changes equals, contains, or lies within a path that the other changes. All changes within one array conflict with each other, because positions within it shift.
- Representations changed with splices (Section 6): the parts are ranges of the base. Two changes conflict when the ranges they replace overlap, or when one inserts strictly within a range that the other replaces. Insertions at the same position are both kept, the one already applied first.

A full representation or a deletion whose base is not the current version conflicts. A conflict is reported with status `409`, and nothing is applied.

When a change is applied after merging, its result has `"rebased": true` and an `update`: a patch (`format` and `data`) or a full representation (`type` and `data`, and `encoding` where needed) that brings the client's copy, its base with its own change applied, to the new version. The merged representation is determined by B, C, and the change, so every server produces the same result.

### 7.4. Repeating a Request

A client that does not receive the response does not know whether the changes were applied. A client SHOULD send an `Idempotency-Key` header field [IDEMPOTENCY] with every request of this kind and repeat the request with the same key and content. A server that supports it MUST answer a repeated request with the response to the first, without applying the changes again; MUST scope keys to the requester, so that no requester ever receives the response to another's request; and MUST reject the reuse of a key with different content with `422`. A client can also find out whether its changes were applied by sending a SYNC request for the resources: the versions it receives show it.

---

## 8. Interaction with HTTP, and Measurements

### 8.1. Safety, Idempotency, Caching, Conditional and Range Requests

SYNC requests are QUERY requests and are therefore safe and idempotent. Their responses are cacheable with the request content in the cache key (Section 2.7 of [RFC10008]). Results usually depend on the requester (Section 4.1); a server MUST NOT let shared caches store responses that do, and SHOULD send `Cache-Control: private` or `no-store` for them. A server MUST treat semantically equivalent request content identically, so that a cache's normalization of the content cannot produce an incorrect response. Conditional requests apply to the results (Section 2.6 of [RFC10008]); a server MAY use a resource's strong entity tag as its version identifier, with the caution that entity tags can differ between content codings of one state. Byte ranges are of little use for results (Section 2.8 of [RFC10008]); Section 4.10 provides partial results.

A server MAY give the results or the query a URI (`Content-Location`, `Location`; Sections 2.3 and 2.4 of [RFC10008]). Shared results (Section 4.9) use the redirection of Section 2.5 of [RFC10008] with a URI that names the state as well as the query. Links (Section 4.8) differ in granularity: each names one resource's update, which many different queries share.

### 8.2. Measured: Torn Reads

In a measurement accompanying this document, a writer commits one transaction every 5 ms, each changing three related resources together, while a client reads the three resources 300 times per approach and checks invariants that hold in every committed state. With realistic variation in network and store timing, 79% of reads made with three parallel `GET` requests, and 82% made with three parallel Braid requests (the braid-http library), returned combinations that never existed on the server. One SYNC request without `consistent` did so in 60% of reads, because its server read the resources separately. SYNC with `consistent` never did (0 of 300; 95% confidence interval 0 to 1.3%), at the same median latency (57 ms). The repository contains the scripts and the complete results (`benchmarks/consistency-results.md`).

### 8.3. Measured: Reconnect Storms

In a second measurement, 100 clients holding the same versions of 50 resources reconnect within one second through a shared cache (nginx). With next URIs (Section 4.11), each client sent one `GET`, which the cache answered: the origin received one request and sent 40 KiB. Per-resource `GET` requests with Braid's `Parents`, made cacheable for the measurement, reached the origin 50 times and sent 66 KiB, with 50 requests per client; when every client received its own results, the origin sent 3.9 MiB, and a Mercure hub replaying the same history sent 4.3 MiB. With 500 clients the origin still received one request. With shared results (Section 4.9), each client's `QUERY` reached the origin and was answered with a `303` response; the origin sent 100 KiB. When clients went offline at different times (five distinct states), next URIs reached the origin five times, and next URIs whose results carry links (Section 4.8) sent 94 KiB in 65 requests, against 99 KiB in 97 requests for Braid. The repository contains the figures (`benchmarks/storm-results.md`, `benchmarks/storm-results-k500.md`).

### 8.4. Measured: Live Updates

In a third measurement, 100 clients keep 50 resources current while the server commits 10 transactions, each changing several resources together. With watching (Section 4.12) and `"consistent": true`, no client ever held a combination that did not exist, and a client held each whole transaction 38 ms (median) after it was committed, over a 40 ms round trip. With per-resource subscriptions (braid-http) and with one Mercure event per changed resource, 92% of the states clients held between updates mixed transactions. A Mercure hub publishing one event per transaction kept transactions whole at the same latency, but sends every subscriber of any changed resource the whole transaction: when each client watched 10 of the 50 resources, the hub sent 7.4 MiB and SYNC 1.6 MiB. With links to shared results, the origin sent 0.28 MiB instead of 8.1 MiB, and delivery took one more round trip. The repository contains the figures (`benchmarks/live-results.md`).

### 8.5. Measured: Concurrent Writes

In a fourth measurement, 10 writers transfer units between pairs of 20 accounts while readers read every account. With two conditional `PUT` requests per transfer, 92% of reads saw a wrong total, and 120 debits had to be undone after the second request failed; with one atomic change (Section 7), no read saw a wrong total, nothing was undone, and transfers completed 1.9 times as fast. When 10 writers edited one text document concurrently, merging (Section 7.3) let 199 of 200 edits through on the first attempt, with no edit lost; whole-document `PUT` requests with `If-Match` needed 900 retries and 28 times the bytes, and without `If-Match` lost 180 of 200 edits. The repository contains the figures (`benchmarks/writes-results.md`).

---

## 9. Security Considerations

The companion document `SECURITY-ANALYSIS.md` discusses these points in detail and states which mitigations the reference implementation enforces. The considerations of [RFC9110] and Section 4 of [RFC10008] apply.

### 9.1. Transport

Baselines reveal what a client holds; results reveal server state. Requests MUST be sent over a secure connection in any deployment where either is sensitive.

### 9.2. Authorization and Caching

Authorization is evaluated per named resource (Section 4.1); for links, shared results and next URIs, per `GET` (Sections 4.8, 4.9 and 4.11); for watches, per event (Section 4.12); and for atomic changes, per changed resource (Section 7.2). Responses, link content, shared results and the responses to next URIs that depend on the requester MUST NOT be stored by shared caches. A server that makes them public asserts that they are the same for every requester. A server that computes one event for several watchers (for efficiency) MUST do so only for watchers whose access is the same.

### 9.3. Probing Versions

Any mechanism in which a client presents a resume point lets the client learn whether the server recognizes it: here, as a patch versus a full representation, as `"baseline": "unrecognized"`, or as status `409`. With guessable identifiers, a requester can learn when resources changed. Version identifiers SHOULD be unguessable where change history is sensitive; servers SHOULD rate-limit per requester, and servers that must not reveal recognition SHOULD omit the `unrecognized` indication and MAY return full representations.

### 9.4. Resource Consumption

One request can name many resources. Servers MUST bound the resources per request and the content size, SHOULD bound the time spent per request, and MAY use partial results (Section 4.10). Rate limits that count requests undercount SYNC; they SHOULD count resources processed. A consistent snapshot (Section 4.7) can require the server to retain state for the duration of a request; servers SHOULD bound that time. A redirect to a shared result (Section 4.9) or a next URI (Section 4.11) moves the cost of computing updates to a `GET`, which shared caches can absorb. A watch holds a connection and server state for as long as it lasts; servers SHOULD bound the number of watches per requester and in total, and MAY end a watch at any time, since the client resumes from the versions it holds. Merging a change (Section 7.3) costs a comparison of two versions; servers SHOULD bound the size of the representations they merge.

### 9.5. Replay and Integrity

A patch applied to a different version than its baseline corrupts the client's copy; Section 4.6 requires the client to check. A full representation carries no such check, so a replayed response can roll a client back; where that matters, servers can use version identifiers whose order clients can verify. Response integrity relies on the secure connection.

### 9.6. Malformed Patches

A splice or JSON patch received from a compromised or faulty server could attempt out-of-range or overlapping edits. Section 6 requires recipients to validate splice documents before applying them, and Section 4.6 requires that a failed update leave the client's copy unchanged.

### 9.7. Links, Shared Results, and Next URIs

Links, shared results and next URIs are retrieved with `GET`, and their URIs can appear in logs, caches, and referrers. Servers SHOULD use URIs that reveal neither resource names nor version identifiers, MUST prevent them from being forged or altered (for example by authenticating them), and MUST authorize each `GET` (Sections 4.8, 4.9 and 4.11). A server that encodes the request in the URI, as a stateless server does, MUST bound the work a `GET` can cause as it bounds the request itself (Section 9.4); authenticating the URI ensures that only requests the server accepted can be replayed this way. If the content of a URI is compressed before it is encrypted, its length depends on that content; this reveals nothing to the client, which receives the same information in the results, but can reveal similarity between requests to an observer of URIs who can influence other clients' requests.

### 9.8. Compression

Results echo resource names from the request and can contain confidential data. Compressing such responses enables length-based attacks when an attacker can influence the request and observe response sizes. QUERY requests, and POST requests with the media types of this document, are not CORS-safelisted [FETCH] and require a preflight; servers SHOULD NOT allow untrusted origins to send them.

### 9.9. Atomic Changes

Atomic changes (Section 7) modify resources. Because `POST` requests of type `application/sync-changes+json` require a CORS preflight, a page from another origin cannot send one unless the server allows it; servers MUST NOT allow untrusted origins, and SHOULD require authentication that a page from another origin cannot attach on its own. A server MUST authorize each change as a change to that resource by the same requester, and MUST report a resource the requester may not read as absent (`404`), so that the statuses of a refused request do not reveal it. Idempotency keys (Section 7.4) MUST be scoped to the requester; otherwise one requester could obtain the response to another's request by guessing its key. Merging (Section 7.3) never applies a change to a part of a representation that changed since the client's base, so a client cannot overwrite a change it has not seen.

---

## 10. Fallback to POST

Some servers, intermediaries, and libraries do not yet support QUERY. A server MAY accept the same request content with `POST` and, if it does, MUST process it as it would the QUERY request. A client SHOULD use QUERY and MAY retry with `POST` when the QUERY request fails with `400`, `404`, `405`, `415`, or `501`, or is not answered because a connection is closed, remembering per origin. Intermediaries cannot tell that such a `POST` is safe and idempotent, so they will not cache or automatically retry it.

---

## 11. IANA Considerations

### 11.1. Media Types

This document registers four media types in the "Media Types" registry, with the following common template values:

- Type name: application
- Required parameters: none
- Optional parameters: none
- Encoding considerations: binary; as for application/json [RFC8259]
- Security considerations: Section 9 of this document
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

and the subtype names `sync-baseline+json` (Section 4.2), `sync-result+json` (Section 5.1), `sync-splice+json` (Section 6), and `sync-changes+json` (Section 7).

### 11.2. HTTP Field Names

| Field Name | Status | Structured Type | Reference |
|---|---|---|---|
| Sync-Consistent | permanent | Item | Section 4.7 |
| Sync-Delta-Complete | permanent | Item | Section 4.10 |
| Sync-Next | permanent | Item | Section 4.11 |

The body part fields of Section 5.2 are not HTTP fields and are not registered.

---

## 12. References

### 12.1. Normative References

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
- [HTML] WHATWG, "HTML Living Standard", Section 9.2 "Server-sent events", https://html.spec.whatwg.org/multipage/server-sent-events.html.
- [RFC4918] Dusseault, L., "HTTP Extensions for Web Distributed Authoring and Versioning (WebDAV)", RFC 4918, June 2007.

### 12.2. Informative References

- [BRAID] Toomim, M., et al., "Braid-HTTP: Synchronization for HTTP", draft-toomim-httpbis-braid-http-04 (expired).
- [BRAID-VERSIONS] Toomim, M., "HTTP Resource Versioning", draft-toomim-httpbis-versions-04 (expired).
- [BRAID-MUX] Braid project, "Multiplexing", https://braid.org/protocol/multiplexing.
- [MERCURE] Dunglas, K., "The Mercure Protocol", draft-dunglas-mercure-08.
- [EVENTS-QUERY] Gupta, R., "HTTP Events Query", draft-gupta-httpapi-events-query-03.
- [RFC3229] Mogul, J., et al., "Delta encoding in HTTP", RFC 3229, January 2002.
- [IDEMPOTENCY] Jena, J. and S. Dalal, "The Idempotency-Key HTTP Header Field", draft-ietf-httpapi-idempotency-key-header (work in progress).
- [RFC6578] Daboo, C. and A. Quillaud, "Collection Synchronization for Web Distributed Authoring and Versioning (WebDAV)", RFC 6578, March 2012.
- [RFC8620] Jenkins, N. and C. Newman, "The JSON Meta Application Protocol (JMAP)", RFC 8620, July 2019.
- [FETCH] WHATWG, "Fetch Standard", https://fetch.spec.whatwg.org/.

---

## 13. Open Questions

1. **Relationship to Braid.** Should multi-resource catch-up be specified as an extension of Braid's versioning and update model, with SYNC's request as its multi-resource form?
2. **Patch formats.** Should the splice format give way to Braid's range patches [BRAID] once those are specified, or should both be registered?
3. **Unrecognized baselines.** Should the per-resource status align with the `432 (Version Not Found)` status of [BRAID-VERSIONS]?
4. **Caching of QUERY responses.** Should this document define a canonical form of the request content to make caches' normalization more effective? Should it recommend a freshness lifetime for `303` responses to SYNC requests (Section 4.9), so that QUERY-aware caches also absorb the requests themselves?
5. **Partial results.** Is omission sufficient, or is a continuation token needed?
6. **Merge types.** Should a resource be able to declare a merge type [BRAID] that the server applies to concurrent changes instead of reporting the conflicts of Section 7.3?
7. **Watching.** Server-Sent Events are widely supported; should a multipart stream, as in [EVENTS-QUERY], also be defined?
8. **Venue.** HTTPAPI or HTTPBIS.

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
- Next URIs (Section 4.11) and watching (Section 4.12).
- The smallest patch among the accepted formats (Section 4.5).
- Atomic changes to several resources, with merging of concurrent changes (Section 7).
- Scope, resource names, and per-resource authorization defined.
- Interaction with caching, conditional and range requests, and result URIs defined.
- Errors as problem details, aligned with Section 2.1 of [RFC10008].
- `Sync-Delta-Complete` and `Sync-Consistent` are Structured Field Booleans.
