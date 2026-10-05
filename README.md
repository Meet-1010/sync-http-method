# SYNC — A New HTTP Method

**SYNC** is a proposed HTTP method that fills a gap in HTTP semantics: no standard method lets a client declare its exact state and receive only the minimal delta to reach the server's current state.

```
# Today (binary outcome — all or nothing)
Client: "Send this resource if it changed since ETag abc"
Server: "Changed? Here's the whole thing. Not changed? 304."

# SYNC (client declares exact state, server returns only what changed)
Client: "I am at { users: v42, posts: v18, config: v7 }"
Server: "Here's exactly what changed since each of those — nothing more"
```

## Why

| Mechanism | Client declares state | Returns delta only | Standard HTTP |
|---|---|---|---|
| GET | No | No | Yes |
| GET + ETag | Token only | No (binary) | Yes |
| RFC 3229 | No | Yes (server picks baseline) | Rarely |
| WebSockets | Implicit | App-defined | No |
| **SYNC** | **Yes (vector)** | **Yes** | **Proposed** |

## Quick Start

```bash
npm install
npm test        # run all 21 tests
npm run demo    # end-to-end demo
npm start       # start server on port 3000
```

## Request Format

```http
SYNC /api/resource HTTP/1.1
Content-Type: application/sync-vector+json

{
  "version_vector": { "/users": "v42", "/posts": "v18" },
  "resources": ["/users", "/posts"]
}
```

## Response Codes

| Code | Meaning |
|---|---|
| `200 OK` | Delta computed and returned |
| `204 No Content` | Client already up to date |
| `409 Conflict` | Client version unrecognizable; re-fetch required |
| `422 Unprocessable Entity` | Malformed or missing version_vector |
| `404 Not Found` | Resource does not exist |

## Project Structure

```
sync-http-method/
├── server/src/
│   ├── index.js          # net.createServer bypasses llhttp method validation
│   ├── sync-handler.js   # parses raw HTTP, computes and sends delta
│   ├── version-store.js  # in-memory versioned resource store
│   └── delta-engine.js   # RFC 6902 JSON Patch diff via fast-json-patch
├── client/src/
│   ├── sync-client.js    # makes SYNC requests via Node's http module
│   └── version-vector.js # tracks + applies client-side version state
├── server/tests/
│   └── sync-method.test.js  # 21 Jest tests
├── demo/demo.js          # end-to-end demo
└── spec/SYNC-method-draft.md  # IETF Internet-Draft style spec
```

## Technical Notes

Node.js's llhttp HTTP parser rejects unknown methods before they reach user code. This implementation uses `net.createServer` (raw TCP) to bypass that restriction, accumulates bytes until the full request is buffered, then routes SYNC requests to the handler directly and all other methods to an internal Express server.

Delta operations use JSON Patch format (RFC 6902): `add`, `remove`, `replace`, `move`, `copy`.

## Why net.createServer Instead of Express

Node's llhttp parser rejects unknown HTTP methods at the TCP parsing layer before any Express middleware runs. This means you cannot add SYNC support via `app.use()` or any Express hook — the request never reaches Express in the first place.

The only correct solution is to intercept the raw TCP stream with `net.createServer`, read the first line to detect the method, handle SYNC requests directly at the byte level, and proxy everything else to an internal Express HTTP server. This is not a workaround — it's the correct architectural layer for method-level protocol extension. Any new HTTP method that doesn't appear in the HTTP/1.1 RFC must be introduced at this layer.

## Status

- Reference implementation: complete
- Test suite: 21/21 passing
- Spec draft: [`spec/SYNC-method-draft.md`](spec/SYNC-method-draft.md) (IETF Internet-Draft format)
- IETF submission: planned

## Spec

See [`spec/SYNC-method-draft.md`](spec/SYNC-method-draft.md) for the IETF Internet-Draft style specification including semantics, request/response format, version vectors, response codes, and security considerations.
