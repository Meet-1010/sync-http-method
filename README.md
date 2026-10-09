# SYNC: Batch Catch-Up for HTTP

**SYNC** is a proposed safe, idempotent HTTP method for one job: a client that already holds copies of several resources asks, in **one request**, for only what changed in each, and gets an **independent result per resource**.

```
Client: "I hold /users at v42, /posts at v18, and nothing for /config."
Server: "/users: patch.  /posts: unchanged.  /config: here is a snapshot."
```

It is a stateless pull: no long-lived connection, no server-side subscription state. A stale or missing baseline for one resource never fails the others.

## Where SYNC fits (and where it does not)

SYNC is **not the first** proposal in this space. Related work, all of which the spec discusses in [Section 1.5](spec/SYNC-method-draft.md):

| Effort | What it does | How SYNC differs |
|---|---|---|
| **Braid-HTTP** | `GET` + `Parents` header returns updates since a version; subscriptions; merge types | Per-URI. SYNC batches N resources in one request. Braid also covers live streams and CRDT/OT merging, which SYNC does not attempt. |
| **Mercure** | Pub/sub hub over SSE, topics, `Last-Event-ID` resume | Push, long-lived connection, one hub-wide cursor. SYNC is pull with per-resource baselines. |
| **Events Query** | `QUERY` returns a representation plus an event stream for one resource | Lists multi-resource and resumption as out of scope. SYNC addresses both for the pull case. |
| **JMAP** (RFC 8620) | `/changes` since a state string, batched method calls | A whole application protocol with its own object model. SYNC is a generic HTTP method over arbitrary JSON. |
| **WebDAV sync** (RFC 6578) | `sync-token` for one collection | WebDAV-specific. |
| **RFC 3229** | Delta encoding for GET, server picks the baseline | Client cannot declare its version. Barely deployed. |

SYNC is meant to **compose** with these: SYNC once on reconnect for all N resources, then open subscriptions for live updates.

**Honest limits, measured against the real software** ([full results](benchmarks/comparative-results.md), reproduce with `npm run bench`). Catching up 100 resources after one round of change:

| | SYNC | Mercure hub (real) | braid-http (real) |
|---|---|---|---|
| Minimal headers, no compression | 23.8 KB, 1 connection | 23.6 KB, 1 connection | 59.1 KB, 100 connections |
| Realistic headers + gzip | 6.7 KB | 25.1 KB | 108.6 KB |

With minimal headers SYNC ties Mercure. With realistic headers it is far smaller, but part of that is that Braid and Mercure do not compress by default. When many changes accumulate, Braid's item-level patches beat SYNC's JSON Patch. For a single resource there is no consistent winner. SYNC does not do live push; Braid and Mercure do.

## Quick Start

```bash
npm install
npm test        # 77 tests
npm run demo    # end-to-end demo
npm start       # demo server on port 3000
npm run bench   # comparative benchmark (see benchmarks/README.md)
```

## Use it in your own app

Not yet on npm; install from this repository (`npm install github:Meet-1010/sync-http-method`).

**Client** (browsers and Node 18+, built on `fetch`):

```js
const { createSyncClient } = require('sync-http-method');

const client = createSyncClient('https://api.example.com/sync');
const { values, changed } = await client.sync(['/users', '/posts', '/config']);
// values: current data for each resource. Later calls download only what changed.
// localStorage.setItem('sync', JSON.stringify(client))  -> resume with patches after a reload
```

The client tries the SYNC method first and falls back to the POST form when anything on the path rejects it, remembering the choice per origin. It tracks tokens, applies patches, and recovers from stale or missing history on its own.

**Server** (any Node request handler, Express included):

```js
const { createSyncServer, createMemoryStore } = require('sync-http-method/server');

createSyncServer({
  app,                       // your existing handler; every non-SYNC request goes to it
  store: {                   // or createMemoryStore() to try it out
    async getCurrent(resource) { /* return { id, data } or null */ },
    async getVersion(resource, token) { /* null = cannot rebuild it; the client gets a snapshot */ },
  },
}).listen(3000);
```

Only the POST form (for example inside an existing Express app, with no raw-TCP front):

```js
const { syncOverPost } = require('sync-http-method/server');
app.use(syncOverPost({ store }));
```

TypeScript definitions are included.

**Known limits of the Node server.** SYNC connections can be kept alive, but the first non-SYNC request on a connection hands the rest of that connection to your app, so a single connection that mixes SYNC with other methods is not supported. The client's POST fallback covers this.

## Request

```http
SYNC /api/anything HTTP/1.1
Content-Type: application/sync-baseline+json

{
  "baselines": { "/users": "v42", "/posts": "v18", "/config": null },
  "accept": ["application/merge-patch+json", "application/json-patch+json"]
}
```

- `baselines`: resource to opaque version token, or `null` for "I hold nothing". The keys are the resource list.
- `accept`: update formats in preference order. JSON Patch (RFC 6902) is the default; JSON Merge Patch (RFC 7396) and full snapshots are also supported. The server sends a snapshot when it is smaller than the patch.
- `recover` (default `true`): an unrecognized baseline gets a snapshot instead of a failure.

For small requests the baselines can go in a header (RFC 8941 List of Inner Lists):

```http
Sync-Baseline: ("/users" "v42"), ("/posts" "v18"), ("/config")
```

## Response

```json
{
  "results": {
    "/users":  { "status": 200, "format": "application/merge-patch+json", "from": "v42", "to": "v45", "data": { "...": "..." } },
    "/posts":  { "status": 304, "to": "v18" },
    "/config": { "status": 200, "format": "application/json", "from": null, "to": "v9", "data": { "timeout": 30 } }
  }
}
```

| HTTP status | Meaning |
|---|---|
| `200` | At least one resource has a result other than 304. Per-resource `status` is inside the body. |
| `204` | Every resource is unchanged. Empty body. |
| `413` / `431` | More than 100 resources, body over 64 KiB, or oversized headers. |
| `422` | Malformed request. |

Per-resource `status`: `200` update present, `304` unchanged, `404` no such resource, `409` baseline unrecognized (only when `recover` is `false`).

## Project Structure

```
server/src/
  package.js        # public server API (sync-http-method/server)
  create-server.js  # raw TCP front: SYNC method, keep-alive, limits; other methods go to your app
  post-form.js      # POST form, as middleware or around any Node handler
  sync-handler.js   # request validation, header/body forms, response encoding
  sync-core.js      # per-resource resolution (the protocol logic)
  delta-engine.js   # JSON Patch, JSON Merge Patch, snapshot selection
  version-store.js  # in-memory versioned store
  index.js          # demo server
client/src/
  index.js          # public client API (sync-http-method)
  fetch-client.js   # createSyncClient and syncFetch, for browsers and Node
  apply.js          # applies results; refuses patches that do not match the held baseline
  baseline-map.js   # token bookkeeping for low-level use
  sync-client.js    # Node http-module client used by tests and the benchmark
server/tests/       # Jest suite
benchmarks/         # bandwidth and comparative benchmarks
spec/               # Internet-Draft and security analysis
```

## Why net.createServer Instead of Express

Node's llhttp parser rejects unknown HTTP methods before any Express middleware runs, so SYNC cannot be added with `app.use()`. The server intercepts the raw TCP stream, reads the method from the first line, handles SYNC directly, and proxies every other method to an internal Express server.

## Status

- Reference implementation: Node.js, per-resource results, three update formats
- Spec: [`spec/SYNC-method-draft.md`](spec/SYNC-method-draft.md) (revision -01, changes listed in its Appendix A)
- Security analysis: [`spec/SECURITY-ANALYSIS.md`](spec/SECURITY-ANALYSIS.md)
- Discussion: raised on the IETF httpbis list; feedback from Braid's author informed revision -01
- arXiv preprint: in preparation
