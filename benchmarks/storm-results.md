# Reconnect storm through a shared cache

**Run at:** 2026-10-09T15:28:53.125Z on Node v26.8.1

100 clients hold versions of 50 resources (about 20 KB each) and reconnect within 1000 ms of each other at round 5 (41 of 50 resources changed since round 0). They reach the origin through nginx 1.27 acting as a shared cache (a CDN edge), over a 40 ms round trip; each client uses at most 6 connections. Every variant runs in a fresh client process, with a fresh origin process and an empty cache. Every client's final state is checked against the server's.

## Same state: every client was current at round 0

1 distinct client state.

| Approach | Origin requests | Origin bytes (KB) | Origin CPU (ms) | Updates computed at origin | Client requests | Client bytes (KB) | Storm duration (ms) | Per-client time p50 / p95 (ms) |
|---|---|---|---|---|---|---|---|---|
| GET (full), via shared cache | 50 | 1046 | 10 | 0 | 5000 | 104981 | 1375 | 398 / 742 |
| Braid (braid-http), via shared cache | 50 | 66 | 16 | 41 | 5000 | 7227 | 1441 | 487 / 964 |
| SYNC, inline | 100 | 3988 | 49 | 41 | 100 | 4075 | 1068 | 88 / 98 |
| SYNC, links via shared cache | 141 | 732 | 55 | 41 | 4200 | 6346 | 1420 | 438 / 848 |
| SYNC, shared result (303) via shared cache | 101 | 100 | 38 | 41 | 200 | 4202 | 1147 | 170 / 193 |
| SYNC, shared result (303) with links via shared cache | 142 | 113 | 49 | 41 | 4300 | 6463 | 1512 | 535 / 1035 |
| SYNC, next URI via shared cache | 1 | 40 | 12 | 41 | 100 | 4069 | 1065 | 84 / 106 |
| SYNC, next URI with links via shared cache | 42 | 53 | 22 | 41 | 4200 | 6328 | 1433 | 443 / 928 |
| Mercure (hub) | 100 | 4404 | n/a | n/a | 100 | 4622 | 1065 | 89 / 101 |

## Different states: each client went offline after one of rounds 0 to 4

5 distinct client states.

| Approach | Origin requests | Origin bytes (KB) | Origin CPU (ms) | Updates computed at origin | Client requests | Client bytes (KB) | Storm duration (ms) | Per-client time p50 / p95 (ms) |
|---|---|---|---|---|---|---|---|---|
| GET (full), via shared cache | 50 | 1046 | 11 | 0 | 5000 | 104981 | 1375 | 398 / 738 |
| Braid (braid-http), via shared cache | 97 | 99 | 23 | 60 | 5000 | 5461 | 1388 | 439 / 765 |
| SYNC, inline | 100 | 2629 | 51 | 60 | 100 | 2716 | 1074 | 88 / 99 |
| SYNC, links via shared cache | 160 | 602 | 61 | 60 | 2958 | 4296 | 1395 | 342 / 753 |
| SYNC, shared result (303) via shared cache | 105 | 192 | 44 | 60 | 200 | 2846 | 1146 | 169 / 189 |
| SYNC, shared result (303) with links via shared cache | 165 | 153 | 56 | 60 | 3058 | 4417 | 1474 | 415 / 837 |
| SYNC, next URI via shared cache | 5 | 132 | 19 | 60 | 100 | 2711 | 1062 | 84 / 99 |
| SYNC, next URI with links via shared cache | 65 | 94 | 32 | 60 | 2958 | 4280 | 1408 | 333 / 676 |
| Mercure (hub) | 100 | 2798 | n/a | n/a | 100 | 3025 | 1068 | 87 / 95 |

## How to read this

- **Origin** columns measure what reaches the origin past the shared cache: requests, response bytes, and CPU time of the origin process (which also runs the HTTP stack).
- **SYNC, shared result (303)**: each client sends one QUERY, which the cache passes to the origin (shared caches do not yet store QUERY responses). The origin reads the current version of each resource, computes no update, and answers `303 (See Other)` with a URI that identifies the request and the versions the results lead to (RFC 10008 Section 2.5). Clients in the same state receive the same URI; their GETs are served by the cache, so the origin builds each distinct result once.
- **SYNC, next URI**: when a client last caught up (at the round it went offline), the response named a next URI (`Sync-Next`): the same request from the versions it then held. Every client in the same state holds the same URI. On reconnecting, each client sends one GET of it, which the cache answers; the origin computes the results once per distinct state. The origin gives these responses the same freshness as the cacheable GET and Braid responses (`Cache-Control: public, max-age=600`).
- **SYNC, next URI with links**: as above, with a link in place of each large update, so results for different states share the updates they have in common.
- **SYNC, shared result with links**: as above, and the shared result carries a link in place of each large update, so results for different states share the updates they have in common. It costs each client one request per link.
- **SYNC, links**: the same QUERY, answered with the results and a link in place of each large update; the clients fetch the updates through the cache, which keeps them because each link names one immutable update.
- **SYNC, inline**: the same QUERY with updates inline. The origin computes each distinct update once (it reuses identical updates) but sends every client its own copy.
- **Braid**: per-resource GET with Parents, made cacheable for this benchmark with `Cache-Control: public` and `Vary: Parents` (nginx keys on the Parents header); unchanged resources are answered 304. With that configuration the cache absorbs Braid's catch-up as well: a shared cache is not unique to SYNC. The difference is the number of requests each client makes.
- **GET (full)** is fully cacheable but sends every client the whole of every resource.
- **Mercure**: the hub is the origin and replays the history to each subscriber; SSE streams are not shared by caches. Origin CPU is not measured for the hub (it runs in Docker).
- Updates: SYNC sends the smaller of a JSON Patch and a JSON Merge Patch (or the full document); Mercure events carry the same updates; Braid uses its own range patches.
- All variants are measured without content coding (no gzip). Bytes exclude TCP and TLS handshakes.
- The latency proxies run in their own processes. A client whose catch-up fails with a connection error (the machine's accept queue is small) retries once, whatever the approach; retries: none.
- Durations for the cached variants include nginx's cache lock: while one request fetches an object from the origin, concurrent requests for it wait and nginx re-checks every 500 ms, which keeps the origin from being hit by all of them at once. Without the lock the cached variants finish sooner but more requests reach the origin.
- The edge, the origin and the clients share one machine, so durations reflect the relative cost of each approach, not production latency.
