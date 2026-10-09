---
Title: SYNC: Catching Up Multiple Resources with HTTP QUERY
Abbrev: SYNC
Intended status: Standards Track (individual submission; venue to be discussed)
Draft name: draft-chauhan-http-sync-00 (supersedes the "SYNC method" proposal posted to ietf-http-wg on 2026-10-05)
Author: Meet Chauhan
Date: October 2026
---

# SYNC: Catching Up Multiple Resources with HTTP QUERY

## Abstract

This document defines a query format for the HTTP QUERY method (RFC 10008) with which a client that already holds copies of several resources declares, for each, the version it holds (its *baseline*), and receives in one response an independent result per resource: an update from that baseline to the current state, or an indication that nothing changed. Updates are expressed in a format negotiated per request (JSON Patch, JSON Merge Patch, or a full representation). The exchange is a single stateless request; a stale or unknown baseline for one resource does not affect the others. The format is intended for catching up after a period of disconnection or between polls, and to compose with subscription mechanisms that deliver later changes. This document does not define a new HTTP method.

---

## 1. Introduction

### 1.1. The Catch-Up Problem

Applications often hold local copies of several resources: a mobile application resuming after being offline, a dashboard, a configuration agent, an intermediary. To bring them current, a client today either re-fetches each resource in full, or issues one conditional request per resource; a conditional `GET` ([RFC9110], Section 13) returns either the complete representation or `304 (Not Modified)`. Finer-grained catch-up is done with application-specific mechanisms.

This document calls the shared need the *catch-up problem*: given the versions a client already holds for N resources, return only what changed, in one exchange.

### 1.2. Approach

SYNC is a query format, identified by the media type `application/sync-baseline+json`, sent with the QUERY method [RFC10008] to a *sync resource*. The QUERY method already provides what the exchange needs: a safe, idempotent request whose content describes the query, defined interactions with caching (Section 2.7 of [RFC10008]), conditional requests (Section 2.6), and a way to give the results a URI (Sections 2.3 and 2.4). An earlier version of this proposal defined a new method; that design is not pursued (Appendix A).

### 1.3. Relationship to Other Work

**Braid-HTTP** [BRAID] [BRAID-VERSIONS]. A `GET` carrying a `Parents` header asks for the updates since a stated version, and Braid defines patches, subscriptions, merge types, and version histories that form a directed acyclic graph. It covers far more than this document, including live updates and multiple concurrent writers. Requests are per resource; Braid's multiplexing extension [BRAID-MUX] carries many subscriptions over one connection, while each resource is still requested individually. SYNC addresses the case of catching up many resources in one request and is intended to be usable alongside Braid: its version tokens are opaque and can carry Braid version identifiers.

**Mercure** [MERCURE]. A publish/subscribe hub that delivers updates over Server-Sent Events, with topic matchers, authorization, and resumption from a hub-wide event identifier. Resumption replays the events published since that identifier rather than returning the net change per resource.

**Events Query** [EVENTS-QUERY]. Uses QUERY to obtain a representation and a stream of notifications from a single resource. It lists multi-resource delivery as a limitation and leaves versioning and resumption out of scope. SYNC uses the same method for the pull-based, multi-resource case.

**JMAP** [RFC8620] provides `/changes` methods that return changes since a client-supplied state, within its own object model and endpoint. **WebDAV collection synchronization** [RFC6578] provides a synchronization token for the members of one collection. **Delta encoding** [RFC3229] lets the server, rather than the client, choose the baseline. SYNC is a generic format for arbitrary resources identified by URI.

### 1.4. Goals and Non-Goals

Goals:

1. Declare baselines for one or more resources in one request.
2. Return an independent result per resource, so that partial failure is routine.
3. Negotiate the update format per request.
4. Keep version tokens opaque, so that counters, content hashes, entity tags, or causal-history identifiers can all be used.
5. Reuse existing HTTP semantics (QUERY, caching, conditional requests, content negotiation) rather than define new ones.

Non-goals:

- Server push. SYNC is client-initiated; subscription mechanisms such as those of Section 1.3 deliver later changes.
- Writes and conflict resolution. SYNC only reads.
- A version model. This document does not define how tokens are generated or ordered.

### 1.5. Notational Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

---

## 2. Terminology

**Sync resource:** The target resource of a QUERY request carrying this format. It defines the scope of the resources that can be named in the request.

**Resource name:** An absolute-path reference (Section 4.2 of [RFC3986]), optionally with a query component and without a fragment, identifying a resource on the same origin as the sync resource; for example `/users` or `/posts?author=17`.

**Version token:** An opaque string assigned by the server to identify a state of a resource. Clients do not interpret tokens.

**Baseline:** The version token the client holds for a resource, or `null` if it holds no state for it.

**Update:** The information that brings a resource from a baseline to its current state, in one of the formats of Section 3.6.

**Result:** The per-resource entry of a response: a status and, where applicable, an update.

---

## 3. The SYNC Query Format

### 3.1. Target Resource and Scope

A SYNC request is a QUERY request to a sync resource. Per Section 2 of [RFC10008], the sync resource determines the scope of the operation. Each resource name in the request is interpreted relative to the origin of the target URI; a server MUST NOT interpret a resource name as identifying a resource on another origin, and the request format does not allow absolute URIs or network-path references. A server decides which names are within the scope of a given sync resource; a name outside that scope is reported as `404` for that resource (Section 3.5).

A server MUST apply to each named resource the same access control it applies to a `GET` of that resource, for the same requester. A resource the requester is not allowed to read MUST be reported in the same way as a resource that does not exist.

### 3.2. Request

The request content is a JSON object [RFC8259] with media type `application/sync-baseline+json`:

```http
QUERY /sync HTTP/1.1
Host: api.example.com
Content-Type: application/sync-baseline+json
Accept: application/sync-result+json

{
  "baselines": { "/users": "a4f2", "/posts": "7b1e", "/config": null },
  "accept": ["application/merge-patch+json", "application/json-patch+json"]
}
```

- `baselines` (REQUIRED): an object whose member names are resource names (Section 2) and whose values are version tokens (strings) or `null`. The set of member names is the set of resources requested.
- `accept` (OPTIONAL): an array of media types in decreasing order of preference, naming update formats (Section 3.6). The default is `["application/json-patch+json"]`. Unrecognized values MUST be ignored.
- `recover` (OPTIONAL, boolean, default `true`): selects the behavior for unrecognized baselines (Section 3.5).

Members not defined here MUST be ignored.

### 3.3. Request Errors

Following Section 2.1 of [RFC10008]:

- A request without a `Content-Type`, or whose content is not valid JSON, fails with `400 (Bad Request)`.
- A request whose content is valid JSON but does not satisfy Section 3.2 (for example, `baselines` missing or not an object, a token that is neither a string nor `null`, or a member name that is not a resource name) fails with `422 (Unprocessable Content)`.
- A server that supports QUERY at the target but not this format responds `415 (Unsupported Media Type)` and lists the formats it supports in `Accept-Query` (Section 3 of [RFC10008]).

### 3.4. Discovery

A sync resource SHOULD include the Accept-Query response field (Section 3 of [RFC10008]) in its responses, listing `"application/sync-baseline+json"`:

```http
Accept-Query: "application/sync-baseline+json"
```

### 3.5. Response

If every requested resource is unchanged, the server MAY respond `204 (No Content)`. Otherwise it responds `200 (OK)` with content of media type `application/sync-result+json`:

```json
{
  "results": {
    "/users":  { "status": 200, "format": "application/merge-patch+json",
                 "from": "a4f2", "to": "c93b",
                 "data": { "1": { "email": "new@example.com" } } },
    "/posts":  { "status": 304, "to": "7b1e" },
    "/config": { "status": 200, "format": "application/json",
                 "from": null, "to": "5d0e", "data": { "timeout": 30 } },
    "/gone":   { "status": 404 }
  }
}
```

Each result has a `status`, using the meaning of the corresponding HTTP status code for that resource:

| status | Meaning | Members |
|---|---|---|
| 200 | An update is present. | `format`, `from`, `to`, `data` |
| 304 | The baseline is the current version. | `to` |
| 404 | The resource does not exist, is outside the scope of the sync resource, or the requester may not read it. | (none) |
| 409 | The baseline is not recognized and `recover` is `false`. | (none) |

`from` is the baseline the update applies to (`null` for a full representation); `to` is the token the client holds after applying it; `data` is the update in the indicated `format`.

When a baseline is not recognized (for example because the server no longer retains that version) and `recover` is `true`, the server SHOULD return status `200` with a full representation (`format` `application/json`, `from` `null`). It MAY add `"baseline": "unrecognized"`; see Section 6.3 before doing so.

A result for one resource MUST NOT depend on whether any other resource in the request could be resolved.

A response carries a single HTTP status code for the exchange and a status per resource in its content, in the manner of WebDAV's `207 (Multi-Status)` [RFC4918]. `207` is not used because it is defined together with an XML response format.

### 3.6. Update Formats

This document uses three formats:

- `application/json-patch+json`: a JSON Patch [RFC6902] document. Paths are JSON Pointers [RFC6901]. Operations apply in order.
- `application/merge-patch+json`: a JSON Merge Patch [RFC7396] document. Merge Patch cannot express setting an object member to `null` and replaces arrays as a whole. A server MUST NOT use it for a change it cannot express, and continues with the client's next preferred format.
- `application/json`: the complete current representation.

For each resource, the server selects the first format in the client's `accept` list in which it can express the change, and SHOULD send the complete representation instead when the selected update is not smaller than it. A server MAY always send the complete representation; clients MUST accept it for any resource.

### 3.7. Scope of This Format: JSON Representations

The model of this document (a baseline per resource, a result per resource) does not depend on the representation's media type. The result format defined here, however, carries updates as JSON values, and the three update formats above apply to JSON representations. Resources with other representations (for example `text/markdown` or `text/html`) require a result format that can carry arbitrary content types and patch types, such as a multipart framing in which each part carries its own `Content-Type` and, where relevant, a range patch [RANGE-PATCH]. Defining such a format is left for future work (Section 9).

### 3.8. Client Processing

Before applying an update whose `from` is not `null`, a client MUST check that `from` equals the baseline it holds for that resource and MUST discard the result otherwise. If applying any part of an update fails, the client MUST leave its copy unchanged. In both cases the client can repeat the request with a `null` baseline for that resource to obtain a full representation.

### 3.9. Partial Results

The `Sync-Delta-Complete` response header field is a Boolean Structured Field [RFC9651]. A value of `?0` indicates that the server omitted results for some requested resources, for example to bound the work done for one request; a client SHOULD repeat the request for the resources whose results are absent. If the field is absent, or has the value `?1`, the response contains a result for every requested resource.

```http
Sync-Delta-Complete: ?0
```

---

## 4. Interaction with HTTP Features

### 4.1. Safety and Idempotency

As QUERY requests, SYNC requests are safe and idempotent (Section 2 of [RFC10008]). They can be retried automatically.

### 4.2. Caching

Responses to QUERY are cacheable, and the cache key incorporates the request content (Section 2.7 of [RFC10008]). Two clients that hold the same baselines and are authorized to see the same data receive the same results, so a shared cache can serve the second from the response to the first. This is useful when many clients synchronize at similar times from the same state.

Results usually depend on who is asking (Section 3.1). A server MUST NOT allow shared caches to store a response whose results depend on the requester's authorization, and SHOULD send `Cache-Control: private` or `no-store` in that case. A server whose results are the same for every requester MAY make responses publicly cacheable. Caches MAY normalize the request content as described in Section 2.7 of [RFC10008]; a server MUST treat semantically equivalent content (for example, the same baselines in a different member order) identically, so that such normalization cannot produce an incorrect response.

### 4.3. Result Resources

A server MAY assign a URI to the results of a SYNC request and return it in `Content-Location` (Section 2.3 of [RFC10008]), or assign a URI to the query itself and return it in `Location` (Section 2.4 of [RFC10008]). A client can then retrieve the same results, or repeat the same query, with `GET`. Such URIs MUST NOT contain version tokens or resource names that the requester could not otherwise disclose (Section 4 of [RFC10008]).

### 4.4. Conditional Requests

Conditional QUERY requests apply to the selected representation, that is, to the results (Section 2.6 of [RFC10008]). This document defines no additional conditional semantics: per-resource conditions are what the baselines express. A server MAY use a resource's strong entity tag as its version token; a client can then use the `ETag` from an earlier `GET` as a baseline. Note that entity tags can differ between content codings of the same state, while a version token identifies the state.

### 4.5. Range Requests

Range requests on QUERY have the semantics defined for GET (Section 2.8 of [RFC10008]). Byte ranges are of little use for results; Section 3.9 provides the format's own way of returning partial results.

### 4.6. Content Coding

Results compress well and MAY be content-coded. See Section 6.6 regarding compression and confidentiality.

---

## 5. Fallback to POST

Some servers, intermediaries, and libraries do not yet support QUERY. A server MAY accept the same request content with the `POST` method when its `Content-Type` is `application/sync-baseline+json`, and if it does, MUST process it as it would the QUERY request and return the same response.

A client SHOULD use QUERY. It MAY retry with `POST` when the QUERY request fails with `400`, `404`, `405`, `415`, or `501`, or is not answered because a connection is closed, and MAY then use `POST` for subsequent requests to the same origin. Intermediaries cannot tell that such a `POST` is safe and idempotent, so they will neither cache nor automatically retry it.

---

## 6. Security Considerations

The companion document `SECURITY-ANALYSIS.md` discusses these points in more detail and states which mitigations the reference implementation enforces. The considerations of [RFC9110] and Section 4 of [RFC10008] apply.

### 6.1. Transport

Baselines reveal what a client holds; results reveal server state. Requests MUST be sent over a secure connection (for example HTTPS) in any deployment where either is sensitive.

### 6.2. Authorization

Authorization is evaluated per named resource (Section 3.1). A server that authorizes only the sync resource would disclose resources the requester cannot otherwise read. Because results are cacheable (Section 4.2), responses that depend on authorization MUST NOT be stored by shared caches.

### 6.3. Probing Version Tokens

Any mechanism in which a client presents a resume token lets the client learn whether the token is recognized: here, as a patch versus a full representation, as the optional `baseline` member, or as status `409`. With guessable tokens, a requester can thereby learn when resources changed. Version tokens SHOULD be unguessable where change history is sensitive; servers SHOULD limit request rates per requester; servers that must not reveal whether a token is recognized SHOULD omit the `baseline` member and MAY return full representations for all resources. Mercure documents a related concern for its event identifiers [MERCURE].

### 6.4. Resource Consumption

One request can name many resources, and computing updates can be expensive. Servers MUST bound the number of resources per request and the size of the request content (responding `413 (Content Too Large)`), SHOULD bound the time spent per request, and MAY use partial results (Section 3.9). Rate limits that count requests undercount the work of a SYNC request; they SHOULD account for the number of resources processed.

### 6.5. Replay and Integrity

An update applied to a different baseline than the one it was computed from corrupts the client's copy; Section 3.8 requires the client to check `from`. A full representation carries no such check, so a replayed response can roll a client back to an older state. Where that matters, servers can use tokens whose order the client can verify. Response integrity relies on the secure connection.

### 6.6. Compression

Results echo resource names from the request and can contain confidential data. Compressing such responses enables length-based attacks when an attacker can influence the request and observe response sizes. QUERY requests, and POST requests with this media type, are not CORS-safelisted [FETCH] and require a preflight, which limits cross-origin influence; servers SHOULD NOT allow untrusted origins to send them.

### 6.7. Result URIs

URIs assigned under Section 4.3 can be logged and shared. They MUST NOT embed version tokens or resource names.

---

## 7. IANA Considerations

### 7.1. Media Type application/sync-baseline+json

- Type name: application
- Subtype name: sync-baseline+json
- Required parameters: none
- Optional parameters: none
- Encoding considerations: binary; as for application/json [RFC8259]
- Security considerations: see Section 6 of this document
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

### 7.2. Media Type application/sync-result+json

As in Section 7.1, with subtype name `sync-result+json`.

### 7.3. HTTP Field Name Sync-Delta-Complete

- Field name: Sync-Delta-Complete
- Status: permanent
- Structured type: Item
- Reference: Section 3.9 of this document

---

## 8. References

### 8.1. Normative References

- [RFC2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119, March 1997.
- [RFC3986] Berners-Lee, T., Fielding, R., and L. Masinter, "Uniform Resource Identifier (URI): Generic Syntax", STD 66, RFC 3986, January 2005.
- [RFC6838] Freed, N., Klensin, J., and T. Hansen, "Media Type Specifications and Registration Procedures", BCP 13, RFC 6838, January 2013.
- [RFC6839] Hansen, T. and A. Melnikov, "Additional Media Type Structured Syntax Suffixes", RFC 6839, January 2013.
- [RFC6901] Bryan, P., Zyp, K., and M. Nottingham, "JavaScript Object Notation (JSON) Pointer", RFC 6901, April 2013.
- [RFC6902] Bryan, P. and M. Nottingham, "JavaScript Object Notation (JSON) Patch", RFC 6902, April 2013.
- [RFC7396] Hoffman, P. and J. Snell, "JSON Merge Patch", RFC 7396, October 2014.
- [RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174, May 2017.
- [RFC8259] Bray, T., "The JavaScript Object Notation (JSON) Data Interchange Format", STD 90, RFC 8259, December 2017.
- [RFC9110] Fielding, R., Nottingham, M., and J. Reschke, "HTTP Semantics", STD 97, RFC 9110, June 2022.
- [RFC9111] Fielding, R., Nottingham, M., and J. Reschke, "HTTP Caching", STD 98, RFC 9111, June 2022.
- [RFC9651] Nottingham, M. and P-H. Kamp, "Structured Field Values for HTTP", RFC 9651, September 2024.
- [RFC10008] Reschke, J., Snell, J., and M. Bishop, "The HTTP QUERY Method", RFC 10008.

### 8.2. Informative References

- [BRAID] Toomim, M., et al., "Braid-HTTP: Synchronization for HTTP", draft-toomim-httpbis-braid-http-04 (expired).
- [BRAID-VERSIONS] Toomim, M., "HTTP Resource Versioning", draft-toomim-httpbis-versions-04 (expired).
- [BRAID-MUX] Braid project, "Multiplexing", https://braid.org/protocol/multiplexing.
- [RANGE-PATCH] Toomim, M., et al., "Range Patch", draft-toomim-httpbis-range-patch-00 (expired).
- [MERCURE] Dunglas, K., "The Mercure Protocol", draft-dunglas-mercure-08.
- [EVENTS-QUERY] Gupta, R., "HTTP Events Query", draft-gupta-httpapi-events-query-03.
- [RFC3229] Mogul, J., et al., "Delta encoding in HTTP", RFC 3229, January 2002.
- [RFC4918] Dusseault, L., "HTTP Extensions for Web Distributed Authoring and Versioning (WebDAV)", RFC 4918, June 2007.
- [RFC6578] Daboo, C. and A. Quillaud, "Collection Synchronization for Web Distributed Authoring and Versioning (WebDAV)", RFC 6578, March 2012.
- [RFC8620] Jenkins, N. and C. Newman, "The JSON Meta Application Protocol (JMAP)", RFC 8620, July 2019.
- [FETCH] WHATWG, "Fetch Standard", https://fetch.spec.whatwg.org/.

---

## 9. Open Questions

1. **Representations other than JSON.** Should the result format be generalized now, for example as a multipart format whose parts carry their own content types and patch types (including Braid range patches), with the JSON format of this document as one profile?
2. **Versions.** Should a baseline be able to carry a set of version identifiers, as Braid's `Parents` does, and should the unrecognized-baseline result align with the `432 (Version Not Found)` status of [BRAID-VERSIONS]?
3. **Relationship to Braid.** Is the multi-resource catch-up of this document better specified as an extension of Braid's versioning and update model than as a separate format?
4. **Caching.** Should this document specify a canonical form of the request content to make shared caching more effective?
5. **Partial results.** Is omission of results sufficient, or is a continuation token needed?
6. **Venue.** HTTPAPI or HTTPBIS.

---

## Appendix A. Why Not a New Method

The proposal posted on 2026-10-05 defined a new method, SYNC. Discussion on the HTTP working group list asked how it differed from QUERY. It does not differ in any way that matters: a safe, idempotent request whose content describes what to return is exactly what QUERY provides, and QUERY additionally brings defined caching, conditional request, and result-URI semantics. A new method would also be rejected by intermediaries and HTTP parsers that do not know it. This document therefore defines a query format instead. The reference implementation retains an experimental `SYNC` method that carries the same content, used only to compare transports; this document does not request its registration.

## Appendix B. Changes

From the 2026-10-05 proposal:

- Carried by QUERY [RFC10008] instead of a new method; `POST` fallback (Section 5).
- Per-resource results instead of a single status for the request.
- Update format negotiated per request; JSON Merge Patch and full representations added.
- "Version vector" replaced by per-resource baselines with opaque tokens.
- Sync resource scope, resource names, and per-resource authorization defined (Section 3.1).
- Interaction with caching, conditional requests, range requests, and result URIs defined (Section 4).
- Request errors aligned with Section 2.1 of [RFC10008].
- `Sync-Delta-Complete` is now a Structured Field Boolean.
- Related work (Section 1.3) and open questions (Section 9) added.
