# SYNC: Consistent, Cacheable Catch-Up of Many HTTP Resources

A client that already holds copies of several resources asks, in **one request**, for what changed in each, and gets an **independent result per resource**: a patch, "unchanged", or the full representation.

```
Client: "I hold /users at v42, /doc.md at [alice-17, bob-9], and nothing for /logo.png."
Server: "/users: patch.  /doc.md: splice.  /logo.png: here it is."
```

SYNC is a request format for the standard HTTP **QUERY** method ([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008)), so it works with existing servers, browsers and intermediaries, with a POST fallback for paths that do not yet allow QUERY. Specification: [`spec/SYNC-method-draft.md`](spec/SYNC-method-draft.md).

## The problems it solves

Bringing several resources up to date with one request per resource has three costs that grow with the number of resources. SYNC addresses each, and the repository measures each against the real alternatives.

**1. Overhead.** One request instead of one per resource: one set of headers, one connection, one round trip. Catching up 100 resources after one round of change ([full results](benchmarks/comparative-results.md)):

| | SYNC | Mercure hub 1.1 (real) | braid-http 1.5 (real) |
|---|---|---|---|
| Minimal headers, no compression | 21.9 KB, 1 connection | 23.6 KB, 1 connection | 58.9 KB, 100 connections |
| Realistic headers, gzip | 5.1 KB | 25.1 KB | 108.5 KB |

**2. Torn reads.** Separate requests observe the server at different moments, so related resources (a post and its author, an order and its lines) can be combined in a way that never existed. With `"consistent": true` every result comes from one snapshot, confirmed by `Sync-Consistent: ?1`. A writer commits a transaction every 5 ms that changes three resources together; clients read them 300 times ([full results](benchmarks/consistency-results.md)):

| With realistic network and database timing | Reads that never existed on the server | Median time |
|---|---|---|
| GET, three requests in parallel | 82.3% | 58 ms |
| Braid (braid-http), three requests in parallel | 82.0% | 60 ms |
| SYNC, one request | 57.7% | 57 ms |
| **SYNC, `"consistent": true`** | **0%** (95% CI 0 to 1.3%) | 58 ms |

**3. Reconnect storms.** After an outage or a deployment, many clients reconnect at once from the same state, and without help the origin computes and sends the same catch-up to each. With `"redirect": true` the server answers `303 See Other` (RFC 10008 Section 2.5) with the URI of a **shared result**: every client in the same state gets the same URI, so an ordinary CDN serves all of them from one response. 100 clients, 50 resources, through nginx as a shared cache ([full results](benchmarks/storm-results.md)):

| Every client was current before the outage | Origin bytes | Origin requests | Requests per client | Per-client time p50 |
|---|---|---|---|---|
| SYNC, inline | 6348 KB | 100 | 1 | 94 ms |
| Mercure hub | 6803 KB | 100 | 1 | 100 ms |
| GET (full), cacheable | 1046 KB | 50 | 50 | 399 ms |
| Braid, made cacheable (`Vary: Parents`) | 66 KB | 50 | 50 | 523 ms |
| **SYNC, shared result (303)** | **116 KB** | 101 | **2** | 183 ms |

A cache absorbs per-resource Braid requests as well; the difference is that a SYNC client makes 2 requests instead of 50. Each client's QUERY still reaches the origin, which answers it with a small `303` without computing any update: with 500 clients the origin sent 327 KB, against 31739 KB inline and 34013 KB from the Mercure hub ([results](benchmarks/storm-results-k500.md)). When clients went offline at different times, large updates can also be returned as **links**: immutable, cacheable GETs that results for different states share. (KB here are 1024 bytes.)

**And it is general.** Resources can have any media type: JSON (JSON Patch, JSON Merge Patch), text and binary (a splice format with code-point or byte positions), with a JSON or `multipart/mixed` result. Versions can be sets of identifiers, as in Braid's versioning model, so histories that merge are supported.

## Where SYNC fits

| Effort | What it does | How SYNC relates |
|---|---|---|
| **Braid-HTTP** | Per-resource `GET` with `Parents`, subscriptions, version DAGs, merge types, multiplexing | SYNC adopts Braid's versions (`Version`, `Parents` in multipart results) and adds the multi-resource, consistent, shareable catch-up step. Braid covers live updates and concurrent writers, which SYNC does not attempt. |
| **Mercure** | Publish/subscribe hub over SSE, resume with `Last-Event-ID` | Replays every event since a hub-wide cursor. SYNC returns the net change per resource and needs no hub. |
| **Events Query** | `QUERY` returns a representation plus notifications for one resource | Lists multi-resource delivery and resumption as out of scope. SYNC covers both for the pull case. |
| **JMAP** (RFC 8620) | `/changes` since a state string | An application protocol with its own object model. SYNC works for any resources identified by URI. |
| **WebDAV sync** (RFC 6578) | Sync token for one collection | WebDAV-specific. |

SYNC is meant to **compose** with subscriptions: catch up everything with one request when reconnecting, then subscribe for live updates.

## Install

```bash
npm install sync-http-method
```

### Client (browsers and Node 18+, built on `fetch`)

```js
const { createSyncClient } = require('sync-http-method');

const client = createSyncClient('https://api.example.com/sync', {
  redirect: true,     // allow 303 to a shared result (served by your CDN)
  links: true,        // allow large updates as cacheable links
});
const { values, changed } = await client.sync(['/users', '/posts', '/doc.md'], { consistent: true });
// values: JSON values, strings for text types, Uint8Array for binary types.
// Later calls download only what changed.
// localStorage.setItem('sync', JSON.stringify(client))  -> resume with patches after a reload
```

The client sends QUERY and falls back to POST when something on the path does not support QUERY, remembering the choice per origin. It tracks versions, refuses patches that do not start from what it holds, follows redirects and links, and recovers on its own when the server no longer has a version or a link has expired. With `consistent: true` it throws `SyncError` unless the server confirms a consistent snapshot. Options: `result: 'multipart'`, `accept` (patch formats in preference order), `recover`, `transport`, `headers`, `fetch`. Tested in Node and Chromium.

### Server (any Node HTTP server; Express included)

```js
const { syncHandler } = require('sync-http-method/server');

app.use(syncHandler({
  store: {
    // { version, type?, data } or null. context = { method, target, headers } of the request:
    // return null for a resource this caller may not read; it is reported as 404.
    // type defaults to application/json; text types hold strings, others bytes.
    async getCurrent(resource, context) { /* ... */ },
    // null = this version is no longer kept; the client gets the full representation instead
    async getVersion(resource, version, context) { /* ... */ },
    // optional: a read view fixed at one instant, for "consistent": true
    async snapshot(context) { /* ... */ },
  },
  links: {
    secret: process.env.SYNC_LINK_SECRET,   // 32+ characters, the same on every server
    path: '/sync/u',                        // links and shared results are served here
    cacheControl: 'public, max-age=31536000, immutable', // only for data that is the same for everyone
  },
}));
```

Options:
- `cacheControl` (default `no-store`) for SYNC responses. QUERY responses are cacheable; use public caching only when results do not depend on who is asking.
- `links`: enables links (`minBytes`, default 1024) and shared results (`redirect`, default `true`; `maxUriLength`, default 8000). Their URIs are encrypted and authenticated, reveal no resource names or versions, and every GET is authorized through your store. Responses are `private` unless you configure otherwise.
- `allowPost` (default `true`) accepts the POST fallback.
- `strict` answers non-SYNC QUERY requests on this path with `400`/`415` as RFC 10008 describes.

The server computes each distinct update once and reuses it for every client that catches up from the same versions. `createMemoryStore()` is included (with `snapshot()` and atomic multi-resource `commit()`); TypeScript definitions are included.

## Request and response

```http
QUERY /sync HTTP/1.1
Content-Type: application/sync-baseline+json
Accept: application/sync-result+json

{ "baselines": { "/users": "a4f2", "/doc.md": ["alice-17", "bob-9"], "/config": null },
  "accept": ["application/merge-patch+json", "application/sync-splice+json"],
  "consistent": true }
```

```json
{ "results": {
    "/users":  { "status": 200, "from": "a4f2", "to": "c93b", "format": "application/merge-patch+json", "data": { "1": { "email": "new@example.com" } } },
    "/doc.md": { "status": 200, "from": ["alice-17", "bob-9"], "to": "alice-18", "format": "application/sync-splice+json",
                 "data": { "unit": "codepoint", "splices": [[120, 4, "SYNC"]] } },
    "/config": { "status": 304, "to": "5d0e" } } }
```

- **Resource names** are absolute paths on the same origin (`/users`, `/posts?author=17`).
- **Versions** are a string or a set of strings (an array whose order carries no meaning).
- **Per-resource status:** `200` an update follows; `304` unchanged; `404` absent, out of scope, or not readable by this caller; `409` unknown version when `recover` is `false` (by default an unknown version gets the full representation).
- **Updates:** JSON Patch (RFC 6902), JSON Merge Patch (RFC 7396), the splice format for text and binary, or the full representation when it is smaller or the media type changed.
- **Result formats:** `application/sync-result+json` (above) or `multipart/mixed` with one part per resource and Braid-style `Version` and `Parents` part fields, chosen by `Accept`.
- **HTTP status:** `204` when nothing changed; `303` to a shared result when the client allowed it; errors are RFC 9457 problem details: `400` malformed JSON, `422` invalid request, `406` no acceptable result format, `413` over 100 resources or 64 KiB.

## Quick start (this repository)

```bash
npm install
npm test                    # 165 tests
npm run demo                # end-to-end demo
npm start                   # demo server on port 3000
npm run bench               # one client: bytes, requests, time vs GET, Braid, Mercure
npm run bench:consistency   # torn reads
npm run bench:storm         # reconnect storm through nginx (needs Docker)
```

See [benchmarks/README.md](benchmarks/README.md) for what each benchmark measures and how to run it.

## Project structure

```
server/src/
  package.js        # public server API (sync-http-method/server)
  handler.js        # syncHandler: QUERY and POST, links and shared results, for Express or any Node handler
  sync-handler.js   # request validation, negotiation, 303 decision, content coding
  sync-core.js      # per-resource planning and updates (the protocol logic), update reuse
  formats.js        # JSON Patch, Merge Patch, splices; patch or full representation
  encode.js         # JSON and multipart result formats, Accept negotiation
  links.js          # opaque, authenticated URIs for links and shared results
  versions.js       # versions as sets of identifiers
  version-store.js  # in-memory store with snapshots and atomic commits
  create-server.js  # experimental: the dedicated SYNC method over raw TCP (see below)
  index.js          # demo server
client/src/
  index.js          # public client API (sync-http-method)
  fetch-client.js   # createSyncClient and syncFetch, for browsers and Node
  apply.js          # applies results; refuses patches that do not match the held version
  multipart.js      # multipart/mixed result parser
  baseline-map.js   # version bookkeeping for low-level use
  sync-client.js    # Node http-module client used by the tests and benchmarks
shared/media.js     # media type classes, UTF-8 and base64, shared by server and client
benchmarks/         # comparative, consistency and reconnect-storm benchmarks
spec/               # Internet-Draft and security analysis
paper/              # paper source
```

## The experimental SYNC method

The repository keeps the original dedicated `SYNC` method for comparison (`createSyncServer`, client transport `'method'`). Node's HTTP parser rejects unknown methods before any application code runs, so serving it requires a raw TCP front that hands every other request to the normal server. That cost is one of the reasons the design moved to QUERY, which Node, browsers and existing infrastructure already handle. The method is not proposed for registration ([spec, Appendix A](spec/SYNC-method-draft.md)).

## Status

- Spec: [`spec/SYNC-method-draft.md`](spec/SYNC-method-draft.md) (draft-chauhan-http-sync-00; changes in Appendix B)
- Security analysis: [`spec/SECURITY-ANALYSIS.md`](spec/SECURITY-ANALYSIS.md)
- Package: [`sync-http-method`](https://www.npmjs.com/package/sync-http-method) on npm
- Discussion: IETF HTTP working group list

## License

MIT. See [LICENSE](LICENSE).
