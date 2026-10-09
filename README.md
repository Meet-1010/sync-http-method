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

**Honest limits.** SYNC's saving over naive GET polling is large, but a single-resource Braid `GET`+`Parents` achieves a similar saving, and with minimal headers and no compression SYNC, Braid over HTTP/2, and a Mercure-style replay land within a few percent of each other. SYNC's advantage appears with many resources under realistic header and compression overhead (for example 6.7 KB vs 36 KB for Braid-style HTTP/2 to catch up 100 resources after one round of change), and over HTTP/1.1, where request count dominates latency. See [`benchmarks/comparative-results.md`](benchmarks/comparative-results.md) for measurements against Braid-style and Mercure-style baselines (`npm run bench` reproduces them).

## Quick Start

```bash
npm install
npm test        # all tests
npm run demo    # end-to-end demo
npm start       # server on port 3000
```

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
  index.js          # net.createServer: bypasses llhttp's method whitelist, enforces size limits
  sync-handler.js   # request validation, header/body forms, response writing
  sync-core.js      # per-resource resolution (the protocol logic)
  delta-engine.js   # JSON Patch, JSON Merge Patch, snapshot selection
  version-store.js  # in-memory versioned store
client/src/
  sync-client.js    # SYNC requests via Node's http module
  baseline-map.js   # tracks the tokens the client holds
  apply.js          # applies results; refuses patches that do not match the held baseline
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
