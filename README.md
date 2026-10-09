# SYNC: Consistent, Cacheable Synchronization of Many HTTP Resources

A client that holds copies of many resources keeps them in sync with **one request**: it states the version it holds of each, and gets an **independent result per resource**: a patch, "unchanged", or the full representation. It can keep receiving the changes as they happen, change several resources **atomically**, and do all of it through an **ordinary CDN**.

```
Client: "I hold /users at v42, /doc.md at [alice-17, bob-9], and nothing for /logo.png."
Server: "/users: patch.  /doc.md: splice.  /logo.png: here it is."
```

SYNC is a request format for the standard HTTP **QUERY** method ([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008)), with a companion format for POST, so it works with existing servers, browsers and intermediaries. Specification: [`spec/SYNC-method-draft.md`](spec/SYNC-method-draft.md).

## What it solves, measured

Keeping many resources in sync one request at a time costs overhead, shows clients states that never existed, piles load on the origin when clients reconnect together, and leaves related writes half done. Every claim below comes from a benchmark in [`benchmarks/`](benchmarks/README.md) that runs the real alternatives over real sockets with a 40 ms round trip and checks every client's final state. (KB are 1024 bytes.)

**1. One request instead of one per resource.** Catching up 100 resources ([full results](benchmarks/comparative-results.md)):

| | SYNC | Mercure hub 1.1 | braid-http 1.5 |
|---|---|---|---|
| After 1 round of change, minimal headers | **15.6 KB**, 1 connection | 17.2 KB, 1 connection | 58.9 KB, 100 connections |
| After 25 rounds, minimal headers | **314 KB** | 401 KB | 470 KB |
| After 1 round, realistic headers and gzip | **4.7 KB** | 18.7 KB | 108.5 KB |

**2. Never a state that never existed.** A writer commits a transaction every 5 ms that changes three resources together; clients read them 300 times ([full results](benchmarks/consistency-results.md)):

| With realistic network and database timing | Reads that never existed on the server | Median time |
|---|---|---|
| GET, three requests in parallel | 79.3% | 58 ms |
| Braid (braid-http), three requests in parallel | 82.3% | 59 ms |
| **SYNC, `"consistent": true`** | **0%** (95% CI 0 to 1.3%) | 57 ms |

**3. Reconnect storms served by the CDN.** 100 clients reconnect within a second through a shared cache (nginx). Each response names a **next URI**, the client's next catch-up as a plain GET, which every client in the same state shares ([full results](benchmarks/storm-results.md)):

| Every client was current before the outage | Origin requests | Origin bytes | Origin CPU | Requests per client | Per-client time p50 |
|---|---|---|---|---|---|
| **SYNC, next URI** | **1** | **40 KB** | **12 ms** | **1** | **84 ms** |
| Braid, made cacheable (`Vary: Parents`) | 50 | 66 KB | 16 ms | 50 | 487 ms |
| GET (full), cacheable | 50 | 1046 KB | 10 ms | 50 | 398 ms |
| Mercure hub | 100 | 4404 KB | | 1 | 89 ms |

With clients in five different states, next URIs reach the origin 5 times (Braid: 97), and with links the origin sends 94 KB (Braid: 99 KB). A `303 See Other` to a **shared result** (RFC 10008 Section 2.5) gives the same effect for clients without a next URI.

**4. Live updates, whole transactions.** 100 clients keep 50 resources current while the server commits 10 transactions ([full results](benchmarks/live-results.md)):

| | Origin bytes | Time to receive a whole transaction, p50 | Clients that saw a state that never existed |
|---|---|---|---|
| **SYNC watch** | 8.3 MB | **38 ms** | **0%** |
| **SYNC watch, links through a CDN** | **0.29 MB** | 93 ms | **0%** |
| Mercure, one event per transaction | 8.1 MB | 39 ms | 0% |
| Mercure, one event per resource | 8.9 MB | 64 ms | 91.6% of updates |
| braid-http subscriptions | 20.7 MB | 152 ms | 91.6% of updates |

When each client watches only 10 of the 50 resources, SYNC sends 1.65 MB in all and delivers in 36 ms; keeping transactions whole with Mercure means sending every subscriber the whole transaction, 7.6 MB, including changes to resources it does not watch.

**5. Atomic writes and concurrent edits.** ([full results](benchmarks/writes-results.md))

| 10 writers, transfers between 20 accounts | Transfers per second | Reads that saw a wrong total | Debits undone |
|---|---|---|---|
| **SYNC, one atomic write** | **41.5** | **0%** | **0** |
| HTTP, two PUTs with If-Match | 22.1 | 91.7% | 120 |

| 10 writers, edits to one document | Edits per second | Retries | Edits lost | Bytes |
|---|---|---|---|---|
| **SYNC, merged by the server** | **148.7** | **1** | **0** | **226 KB** |
| HTTP, If-Match | 10.8 | 900 | 0 | 6240 KB |
| HTTP, last writer wins | 109.1 | 0 | 180 of 200 | 1030 KB |

**And it is general.** Any media type: JSON (JSON Patch or JSON Merge Patch, whichever is smaller), text and binary (a splice format), with a JSON or `multipart/mixed` result. Versions can be sets of identifiers, as in Braid, so histories that merge are supported.

### Where others still do better

- Braid's merge types resolve concurrent edits to the same place without conflicts; SYNC merges edits to different places and reports the rest as conflicts.
- Mercure's Go hub uses less CPU than this Node reference server for the same live delivery (103 ms against 121 ms).
- With links, live updates take one extra round trip (93 ms against 38 ms) in exchange for 29 times less origin traffic; the server sends events as links only when several clients share them.
- With minimal headers and no compression, a model of Braid over HTTP/2 (one connection, compressed headers, SYNC's patches) sends 1 to 17% fewer bytes than SYNC for 10 or more resources (26% fewer for one); with realistic headers SYNC sends 13 to 64% of the model's bytes. Real braid-http cannot use HTTP/2 over cleartext.

## Where SYNC fits

| Effort | What it does | How SYNC relates |
|---|---|---|
| **Braid-HTTP** | Per-resource `GET` with `Parents`, subscriptions, `PUT`, version DAGs, merge types | SYNC adopts Braid's versions and adds what is missing across resources: one request, consistent snapshots, one stream for many resources with transactions whole, atomic multi-resource writes, and catch-up that caches share. |
| **Mercure** | Publish/subscribe hub over SSE | SYNC needs no hub, resumes with the net change instead of replaying events, keeps transactions whole without sending clients changes they do not watch, and evaluates access per event. |
| **Events Query** | `QUERY` with a notification stream for one resource | SYNC covers many resources, resumption, and writes. |
| **JMAP** (RFC 8620) | `/changes` and `/set` within its own object model | SYNC works for any resources identified by URI. |
| **WebDAV sync** (RFC 6578) | Sync token for one collection | WebDAV-specific. |

## Install

```bash
npm install sync-http-method
```

### Client (browsers and Node 18+, built on `fetch`)

```js
const { createSyncClient } = require('sync-http-method');

const client = createSyncClient('https://api.example.com/sync', {
  next: true,       // catch up through cacheable next URIs
  links: true,      // large updates as cacheable links
});

// Catch up (one request; later calls download only what changed)
const { values, changed } = await client.sync(['/users', '/posts', '/doc.md'], { consistent: true });

// Keep current: one stream, changes made together arrive together
const watch = client.watch(['/users', '/posts'], { consistent: true, onChange: ({ values, changed }) => render(values) });

// Change several resources atomically; edits from an older version are merged when they do not conflict
await client.write({ '/doc.md': { value: newText }, '/todos': { value: todos } }, { merge: true });

// Save and resume (with patches, and with the next URI)
localStorage.setItem('sync', JSON.stringify(client));
```

The client sends QUERY and falls back to POST where QUERY is not supported, tracks versions, refuses patches that do not start from what it holds, follows redirects and links, reconnects watches with the versions it holds, and recovers on its own when a version, a link or a next URI has expired. `write` sends the smallest patch from the version it holds and retries safely with an `Idempotency-Key`. Tested in Node and Chromium.

### Server (any Node HTTP server; Express included)

```js
const { syncHandler } = require('sync-http-method/server');

app.use(syncHandler({
  store: {
    // { version, type?, data } or null; context = { method, target, headers } for per-resource access control
    async getCurrent(resource, context) { /* ... */ },
    async getVersion(resource, version, context) { /* ... */ },  // null when no longer kept
    async snapshot(context) { /* ... */ },          // optional: a read view at one instant ("consistent")
    subscribe(listener) { /* ... */ },              // optional: listener(changedResources); enables watching
    async write(changes, context) { /* ... */ },    // optional: atomic conditional write; enables changes
  },
  links: {
    secret: process.env.SYNC_LINK_SECRET,         // 32+ characters, the same on every server
    path: '/sync/u',                              // links, shared results and next URIs live here
    cacheControl: 'public, max-age=31536000, immutable',  // only for data that is the same for everyone
  },
  cacheControl: 'public, max-age=5',              // current results (QUERY and next URIs); default no-store
}));
```

`createMemoryStore()` implements all five functions (with atomic `commit()` and `remove()`). URIs for links, shared results and next URIs are encrypted and authenticated, reveal no resource names or versions, and are evaluated for each requester. The server computes each distinct update once, and encodes each watch event once for all watchers in the same state with the same credentials. TypeScript definitions are included.

## The formats in brief

Read (QUERY, `application/sync-baseline+json`):

```json
{ "baselines": { "/users": "a4f2", "/doc.md": ["alice-17", "bob-9"], "/config": null },
  "accept": ["application/merge-patch+json", "application/sync-splice+json"],
  "consistent": true, "next": true }
```

Result (`application/sync-result+json`, or `multipart/mixed`):

```json
{ "results": {
    "/users":  { "status": 200, "from": "a4f2", "to": "c93b", "format": "application/merge-patch+json", "data": { "1": { "email": "new@example.com" } } },
    "/doc.md": { "status": 200, "from": ["alice-17", "bob-9"], "to": "alice-18", "format": "application/sync-splice+json",
                 "data": { "unit": "codepoint", "splices": [[120, 4, "SYNC"]] } },
    "/config": { "status": 304, "to": "5d0e" } } }
```

- Per-resource status: `200` update, `304` unchanged, `404` absent or not readable, `409` unknown version (only with `"recover": false`).
- `"watch": true` with `Accept: text/event-stream` turns the response into a stream of result documents.
- `"redirect": true` allows `303 See Other` to a shared result; `"next": true` adds `Sync-Next`; `"links": true` allows links.
- Write (POST, `application/sync-changes+json`): `{ "changes": { "/doc.md": { "base": "v7", "format": "...", "data": ... } }, "merge": true }`; all or nothing, with a status per resource (`412` stale base, `409` conflict, `424` not applied because another change failed).

## This repository

```bash
npm install
npm test                    # 222 tests
npm run demo                # end-to-end demo
npm run bench               # one client: bytes, requests, time vs GET, Braid, Mercure
npm run bench:consistency   # torn reads
npm run bench:storm         # reconnect storms through nginx (needs Docker)
npm run bench:live          # live updates through Varnish (needs Docker)
npm run bench:writes        # concurrent writes
```

```
server/src/
  package.js        # public server API (sync-http-method/server)
  handler.js        # syncHandler: reads, watches, writes, links, shared results, next URIs
  sync-handler.js   # request validation, negotiation, redirects, next URIs, content coding
  sync-core.js      # per-resource planning and updates, update reuse
  writes.js         # atomic changes: validation, preconditions, merging, all or nothing
  rebase.js         # merging concurrent changes (JSON paths, splice ranges)
  encode.js         # JSON and multipart result formats, Accept negotiation
  links.js          # opaque, authenticated URIs
  versions.js       # versions as sets of identifiers
  version-store.js  # in-memory store: snapshots, atomic commits and writes, notifications
  create-server.js  # experimental: the dedicated SYNC method over raw TCP
client/src/
  fetch-client.js   # createSyncClient (sync, watch, write), syncFetch, syncFetchNext
  apply.js          # applies results; refuses patches that do not match the held version
  multipart.js      # multipart/mixed parser
shared/             # media types, patch formats and the choice of the smallest update (server and client)
benchmarks/         # comparative, consistency, storm, live and writes benchmarks
spec/               # Internet-Draft and security analysis
paper/              # paper source
```

The repository keeps the original dedicated `SYNC` method for comparison (`createSyncServer`, client transport `'method'`). Node's HTTP parser rejects unknown methods, so serving it needs a raw TCP front; that cost is one reason the design moved to QUERY ([spec, Appendix A](spec/SYNC-method-draft.md)).

## Status

- Spec: [`spec/SYNC-method-draft.md`](spec/SYNC-method-draft.md) (draft-chauhan-http-sync-00; changes in Appendix B)
- Security analysis: [`spec/SECURITY-ANALYSIS.md`](spec/SECURITY-ANALYSIS.md)
- Package: [`sync-http-method`](https://www.npmjs.com/package/sync-http-method) on npm
- Discussion: IETF HTTP working group list

## License

MIT. See [LICENSE](LICENSE).
