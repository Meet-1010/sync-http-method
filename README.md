# SYNC: Catch Up Many HTTP Resources in One QUERY

**SYNC** is a small protocol for one job: a client that already holds copies of several resources asks, in **one request**, for only what changed in each, and gets an **independent result per resource**.

```
Client: "I hold /users at v42, /posts at v18, and nothing for /config."
Server: "/users: patch.  /posts: unchanged.  /config: here is all of it."
```

It is sent with the standard HTTP **QUERY** method ([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008)) as a request of type `application/sync-baseline+json`, so it works with existing servers and browsers, and inherits QUERY's caching and conditional-request rules. It is a single stateless request: no long-lived connection, no subscription state on the server, and a stale or missing version for one resource never fails the others.

SYNC began as a proposal for a new HTTP method. Feedback on the IETF HTTP working group list pointed out that QUERY already provides what a new method would; the design now builds on QUERY ([spec, Appendix A](spec/SYNC-method-draft.md)).

## Where SYNC fits

SYNC is not the first work in this space. Related work, all discussed in the [spec](spec/SYNC-method-draft.md):

| Effort | What it does | How SYNC differs |
|---|---|---|
| **Braid-HTTP** | `GET` + `Parents` returns updates since a version; subscriptions; merge types; multiplexing | Per resource. SYNC catches up many resources in one request. Braid also covers live updates and multi-writer merging, which SYNC does not attempt. |
| **Mercure** | Pub/sub hub over SSE, topics, `Last-Event-ID` resume | Push over a held connection, one hub-wide cursor, replays every event. SYNC is a pull with a baseline per resource and returns the net change. |
| **Events Query** | `QUERY` returns a representation plus a notification stream for one resource | Lists multi-resource delivery and resumption as out of scope. SYNC covers both for the pull case. |
| **JMAP** (RFC 8620) | `/changes` since a state string, batched method calls | A whole application protocol with its own object model. SYNC is a generic format for any resources identified by URI. |
| **WebDAV sync** (RFC 6578) | Sync token for one collection | WebDAV-specific. |

SYNC is meant to **compose** with these: catch up all resources with one request on reconnect, then subscribe for live updates.

## Measured against the real software

[Full results](benchmarks/comparative-results.md) (reproduce with `npm run bench`; see [benchmarks/README.md](benchmarks/README.md)). Catching up 100 resources after one round of change:

| | SYNC (QUERY) | Mercure hub 1.1 (real) | braid-http 1.5 (real) |
|---|---|---|---|
| Minimal headers, no compression | 21.9 KB, 1 connection | 23.6 KB, 1 connection | 58.9 KB, 100 connections |
| Realistic headers + gzip | 5.2 KB | 25.1 KB | 108.5 KB |

What this does and does not show:

- With minimal headers SYNC is comparable to Mercure.
- With realistic headers it is far smaller, but part of that is that Braid and Mercure do not compress by default.
- When many changes pile up, Braid's whole-item patches beat SYNC's JSON Patch.
- For a single resource there is no consistent winner.
- SYNC does not do live push; Braid and Mercure do.

## Install

```bash
npm install sync-http-method
```

### Client (browsers and Node 18+, built on `fetch`)

```js
const { createSyncClient } = require('sync-http-method');

const client = createSyncClient('https://api.example.com/sync');
const { values, changed } = await client.sync(['/users', '/posts', '/config']);
// values: current data for each resource. Later calls download only what changed.
// localStorage.setItem('sync', JSON.stringify(client))  -> resume with patches after a reload
```

The client sends QUERY, and falls back to POST when something on the path does not support QUERY, remembering the choice per origin. It tracks versions, applies patches, refuses patches that do not match what it holds, and recovers from missing history on its own. Tested in Node and Chromium.

### Server (any Node HTTP server; Express included)

```js
const { syncHandler } = require('sync-http-method/server');

app.use('/sync', syncHandler({
  store: {
    // return { id, data } or null. context = { method, target, headers } of the request:
    // return null for a resource this caller may not read; it is reported as 404.
    async getCurrent(resource, context) { /* ... */ },
    // null = this version can no longer be rebuilt; the client gets the full resource instead
    async getVersion(resource, token, context) { /* ... */ },
  },
}));
```

Options:
- `cacheControl` (default `no-store`). QUERY responses are cacheable; use public caching only when results do not depend on who is asking.
- `allowPost` (default `true`) accepts the POST fallback.
- `strict` answers non-SYNC QUERY requests on this path with `400`/`415` as RFC 10008 describes.

`createMemoryStore()` is included for experiments. TypeScript definitions are included.

## Request and response

```http
QUERY /sync HTTP/1.1
Content-Type: application/sync-baseline+json

{ "baselines": { "/users": "v42", "/posts": "v18", "/config": null },
  "accept": ["application/merge-patch+json", "application/json-patch+json"] }
```

```json
{ "results": {
    "/users":  { "status": 200, "format": "application/merge-patch+json", "from": "v42", "to": "v45", "data": { "...": "..." } },
    "/posts":  { "status": 304, "to": "v18" },
    "/config": { "status": 200, "format": "application/json", "from": null, "to": "v9", "data": { "timeout": 30 } } } }
```

- **Resource names** are absolute paths on the same origin (`/users`, `/posts?author=17`).
- **`accept`** lists update formats in preference order: JSON Patch (RFC 6902, default), JSON Merge Patch (RFC 7396), or the full representation. The server sends the full representation whenever it is smaller.
- **Per-resource status:**
  - `200`: an update follows.
  - `304`: unchanged.
  - `404`: absent, out of scope, or not readable by this caller.
  - `409`: unknown version; only sent when `recover` is `false`. By default an unknown version gets the full resource instead.
- **HTTP status:** `204` when everything is unchanged. Malformed JSON is `400` and an invalid request is `422`, as RFC 10008 Section 2.1 describes. Over 100 resources or 64 KiB is `413`.
- **Header:** responses carry `Accept-Query: "application/sync-baseline+json"`.

## Quick start (this repository)

```bash
npm install
npm test        # 93 tests
npm run demo    # end-to-end demo
npm start       # demo server on port 3000
npm run bench   # comparative benchmark (see benchmarks/README.md)
```

## Project structure

```
server/src/
  package.js        # public server API (sync-http-method/server)
  handler.js        # syncHandler: QUERY and POST, for Express or any Node handler
  sync-handler.js   # request validation and response encoding
  sync-core.js      # per-resource resolution (the protocol logic)
  delta-engine.js   # JSON Patch, JSON Merge Patch, full-representation selection
  version-store.js  # in-memory versioned store
  create-server.js  # experimental: the dedicated SYNC method over raw TCP (see below)
  index.js          # demo server
client/src/
  index.js          # public client API (sync-http-method)
  fetch-client.js   # createSyncClient and syncFetch, for browsers and Node
  apply.js          # applies results; refuses patches that do not match the held version
  baseline-map.js   # token bookkeeping for low-level use
  sync-client.js    # Node http-module client used by the tests and benchmark
benchmarks/         # comparative benchmark against braid-http and the Mercure hub
spec/               # Internet-Draft and security analysis
paper/              # arXiv paper source
```

## The experimental SYNC method

The repository keeps the original dedicated `SYNC` method for comparison (`createSyncServer`, client transport `'method'`). Node's HTTP parser rejects unknown methods before any application code runs (still true in Node 26), so serving it requires a raw TCP front that hands every other request to the normal server. That cost is one of the reasons the design moved to QUERY, which Node, browsers and existing infrastructure already handle. The method is not proposed for registration.

## Status

- Spec: [`spec/SYNC-method-draft.md`](spec/SYNC-method-draft.md) (draft-chauhan-http-sync-00, SYNC over QUERY; changes listed in Appendix B)
- Security analysis: [`spec/SECURITY-ANALYSIS.md`](spec/SECURITY-ANALYSIS.md)
- Package: [`sync-http-method`](https://www.npmjs.com/package/sync-http-method) on npm
- Discussion: IETF HTTP working group list

## License

MIT. See [LICENSE](LICENSE).
