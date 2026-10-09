# Reconnect storm through a shared cache

**Run at:** 2026-10-09T10:09:41.031Z on Node v26.8.1

100 clients hold versions of 50 resources (about 20 KB each) and reconnect within 1000 ms of each other at round 5 (41 of 50 resources changed since round 0). They reach the origin through nginx 1.27 acting as a shared cache (a CDN edge), over a 40 ms round trip; each client uses at most 6 connections. Every variant runs in a fresh client process, with a fresh origin process and an empty cache. Every client's final state is checked against the server's.

## Same state: every client was current at round 0

1 distinct client state.

| Approach | Origin requests | Origin bytes (KB) | Origin CPU (ms) | Updates computed at origin | Client requests | Client bytes (KB) | Storm duration (ms) | Per-client time p50 / p95 (ms) |
|---|---|---|---|---|---|---|---|---|
| GET (full), via shared cache | 50 | 1046 | 11 | 0 | 5000 | 104981 | 1376 | 399 / 818 |
| Braid (braid-http), via shared cache | 50 | 66 | 18 | 41 | 5000 | 7227 | 1442 | 523 / 959 |
| SYNC, inline | 100 | 6348 | 48 | 41 | 100 | 6428 | 1080 | 94 / 107 |
| SYNC, links via shared cache | 141 | 751 | 56 | 41 | 4200 | 8742 | 1500 | 520 / 908 |
| SYNC, shared result (303) via shared cache | 101 | 116 | 39 | 41 | 200 | 6542 | 1181 | 183 / 237 |
| SYNC, shared result (303) with links via shared cache | 142 | 130 | 48 | 41 | 4300 | 8846 | 1612 | 584 / 944 |
| Mercure (hub) | 100 | 6803 | n/a | n/a | 100 | 7020 | 1098 | 100 / 168 |

## Different states: each client went offline after one of rounds 0 to 4

5 distinct client states.

| Approach | Origin requests | Origin bytes (KB) | Origin CPU (ms) | Updates computed at origin | Client requests | Client bytes (KB) | Storm duration (ms) | Per-client time p50 / p95 (ms) |
|---|---|---|---|---|---|---|---|---|
| GET (full), via shared cache | 50 | 1046 | 10 | 0 | 5000 | 104981 | 1374 | 400 / 898 |
| Braid (braid-http), via shared cache | 97 | 99 | 25 | 60 | 5000 | 5461 | 1410 | 465 / 818 |
| SYNC, inline | 100 | 4130 | 54 | 60 | 100 | 4210 | 1071 | 91 / 105 |
| SYNC, links via shared cache | 160 | 632 | 61 | 60 | 2958 | 5826 | 1414 | 354 / 670 |
| SYNC, shared result (303) via shared cache | 105 | 259 | 46 | 60 | 200 | 4327 | 1148 | 174 / 190 |
| SYNC, shared result (303) with links via shared cache | 165 | 180 | 56 | 60 | 3058 | 5934 | 1527 | 429 / 557 |
| Mercure (hub) | 100 | 4306 | n/a | n/a | 100 | 4533 | 1068 | 89 / 99 |

## How to read this

- **Origin** columns measure what reaches the origin past the shared cache: requests, response bytes, and CPU time of the origin process (which also runs the HTTP stack).
- **SYNC, shared result (303)**: each client sends one QUERY, which the cache passes to the origin (shared caches do not yet store QUERY responses). The origin reads the current version of each resource, computes no update, and answers `303 (See Other)` with a URI that identifies the request and the versions the results lead to (RFC 10008 Section 2.5). Clients in the same state receive the same URI; their GETs are served by the cache, so the origin builds each distinct result once.
- **SYNC, shared result with links**: as above, and the shared result carries a link in place of each large update, so results for different states share the updates they have in common. It costs each client one request per link.
- **SYNC, links**: the same QUERY, answered with the results and a link in place of each large update; the clients fetch the updates through the cache, which keeps them because each link names one immutable update.
- **SYNC, inline**: the same QUERY with updates inline. The origin computes each distinct update once (it reuses identical updates) but sends every client its own copy.
- **Braid**: per-resource GET with Parents, made cacheable for this benchmark with `Cache-Control: public` and `Vary: Parents` (nginx keys on the Parents header); unchanged resources are answered 304. With that configuration the cache absorbs Braid's catch-up as well: a shared cache is not unique to SYNC. The difference is the number of requests each client makes.
- **GET (full)** is fully cacheable but sends every client the whole of every resource.
- **Mercure**: the hub is the origin and replays the history to each subscriber; SSE streams are not shared by caches. Origin CPU is not measured for the hub (it runs in Docker).
- All variants are measured without content coding (no gzip). Bytes exclude TCP and TLS handshakes.
- The latency proxies run in their own processes. A client whose catch-up fails with a connection error (the machine's accept queue is small) retries once, whatever the approach; retries: none.
- Durations for the cached variants include nginx's cache lock: while one request fetches an object from the origin, concurrent requests for it wait and nginx re-checks every 500 ms, which keeps the origin from being hit by all of them at once. Without the lock the cached variants finish sooner but more requests reach the origin.
- The edge, the origin and the clients share one machine, so durations reflect the relative cost of each approach, not production latency.
