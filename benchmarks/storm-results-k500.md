# Reconnect storm through a shared cache

**Run at:** 2026-10-09T15:48:16.679Z on Node v26.8.1

500 clients hold versions of 50 resources (about 20 KB each) and reconnect within 5000 ms of each other at round 5 (41 of 50 resources changed since round 0). They reach the origin through nginx 1.27 acting as a shared cache (a CDN edge), over a 40 ms round trip; each client uses at most 6 connections. Every variant runs in a fresh client process, with a fresh origin process and an empty cache. Every client's final state is checked against the server's.

## Same state: every client was current at round 0

1 distinct client state.

| Approach | Origin requests | Origin bytes (KB) | Origin CPU (ms) | Updates computed at origin | Client requests | Client bytes (KB) | Storm duration (ms) | Per-client time p50 / p95 (ms) |
|---|---|---|---|---|---|---|---|---|
| GET (full), via shared cache | 50 | 1046 | 10 | 0 | 25000 | 524903 | 5400 | 398 / 407 |
| Braid (braid-http), via shared cache | 50 | 66 | 16 | 41 | 25000 | 36137 | 5425 | 479 / 577 |
| SYNC, inline | 500 | 19942 | 160 | 41 | 500 | 20377 | 5086 | 87 / 94 |
| SYNC, links via shared cache | 541 | 3478 | 161 | 41 | 21000 | 31729 | 5419 | 434 / 466 |
| SYNC, shared result (303) via shared cache | 501 | 340 | 114 | 41 | 1000 | 21012 | 5164 | 167 / 177 |
| SYNC, shared result (303) with links via shared cache | 542 | 353 | 139 | 41 | 21500 | 32315 | 5515 | 503 / 532 |
| SYNC, next URI via shared cache | 1 | 40 | 11 | 41 | 500 | 20343 | 5082 | 84 / 91 |
| SYNC, next URI with links via shared cache | 42 | 53 | 22 | 41 | 21000 | 31640 | 5425 | 426 / 452 |
| Mercure (hub) | 500 | 22019 | n/a | n/a | 500 | 23108 | 5087 | 89 / 97 |

## Different states: each client went offline after one of rounds 0 to 4

5 distinct client states.

| Approach | Origin requests | Origin bytes (KB) | Origin CPU (ms) | Updates computed at origin | Client requests | Client bytes (KB) | Storm duration (ms) | Per-client time p50 / p95 (ms) |
|---|---|---|---|---|---|---|---|---|
| GET (full), via shared cache | 50 | 1046 | 11 | 0 | 25000 | 524903 | 5400 | 399 / 407 |
| Braid (braid-http), via shared cache | 97 | 99 | 25 | 60 | 25000 | 27734 | 5406 | 468 / 552 |
| SYNC, inline | 500 | 13476 | 153 | 60 | 500 | 13912 | 5087 | 87 / 92 |
| SYNC, links via shared cache | 560 | 2776 | 162 | 60 | 15030 | 21948 | 5391 | 339 / 425 |
| SYNC, shared result (303) via shared cache | 505 | 437 | 124 | 60 | 1000 | 14561 | 5163 | 167 / 176 |
| SYNC, shared result (303) with links via shared cache | 565 | 399 | 143 | 60 | 15530 | 22548 | 5471 | 419 / 508 |
| SYNC, next URI via shared cache | 5 | 132 | 19 | 60 | 500 | 13885 | 5081 | 84 / 91 |
| SYNC, next URI with links via shared cache | 65 | 94 | 33 | 60 | 15030 | 21866 | 5390 | 337 / 425 |
| Mercure (hub) | 500 | 14384 | n/a | n/a | 500 | 15522 | 5087 | 87 / 94 |

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
