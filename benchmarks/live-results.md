# Live updates for many clients

**Run at:** 2026-10-09T15:51:41.522Z on Node v26.8.1

100 clients hold the current versions of 50 resources (about 20 KB each) and keep them current while the server commits 10 transactions, one every 300 ms, each changing about 11.9 resources together. Every client reaches the server over a 40 ms round trip. With links, SYNC clients go through Varnish 7.6 acting as a shared cache (streams pass through; immutable updates are cached, and concurrent requests for one are coalesced); the other approaches have nothing to cache and reach the server directly. Every variant runs in a fresh client process with a fresh origin. After every update a client applies, its view is checked against the committed states; every client's final state is checked against the server's.

## Every client watches all 50 resources

| Approach | Origin bytes (KB) | Origin requests | Origin CPU (ms) | Client bytes (KB) | Client requests | Time until a client holds a whole transaction, p50 / p95 (ms) | Torn views |
|---|---|---|---|---|---|---|---|
| SYNC watch | 8301 | 0 | 121 | 8301 | 0 | 38 / 46 | 0 of 1000 (0.0%) |
| SYNC watch, links via shared cache | 287 | 10 | 142 | 9345 | 1000 | 93 / 157 | 0 of 1000 (0.0%) |
| Braid subscriptions (braid-http, multiplexed) | 20685 | 0 | 785 | 20685 | 0 | 152 / 233 | 10900 of 11900 (91.6%) |
| Mercure, one event per resource | 8900 | n/a | 257 | 8900 | 0 | 64 / 78 | 10900 of 11900 (91.6%) |
| Mercure, one event per transaction | 8071 | n/a | 103 | 8071 | 0 | 39 / 48 | 0 of 1000 (0.0%) |

## Each client watches 10 of the 50 resources (chosen at random)

| Approach | Origin bytes (KB) | Origin requests | Origin CPU (ms) | Client bytes (KB) | Client requests | Time until a client holds a whole transaction, p50 / p95 (ms) | Torn views |
|---|---|---|---|---|---|---|---|
| SYNC watch | 1650 | 0 | 155 | 1650 | 0 | 36 / 42 | 0 of 931 (0.0%) |
| SYNC watch, links via shared cache | 1650 | 0 | 156 | 1653 | 0 | 39 / 48 | 0 of 931 (0.0%) |
| Braid subscriptions (braid-http, multiplexed) | 4040 | 0 | 442 | 4040 | 0 | 68 / 85 | 1393 of 2324 (59.9%) |
| Mercure, one event per resource | 1739 | n/a | 127 | 1739 | 0 | 49 / 64 | 1393 of 2324 (59.9%) |
| Mercure, one event per transaction | 7610 | n/a | 100 | 7610 | 0 | 37 / 42 | 0 of 931 (0.0%) |

## How to read this

- Everything is measured from the moment all clients are connected and current until every client holds the last transaction; setting up subscriptions is not included.
- **Origin** is what the origin sent (past the shared cache, for SYNC with links; for Mercure, what the hub sent). Mercure's CPU time is that of the hub's container.
- **Torn views**: after each update a client applies, its view either equals a state the server committed, or mixes resources from different transactions. A torn view is what an application would render between the parts of a transaction.
- **SYNC watch**: one QUERY with `"watch": true` and `"consistent": true` per client; every event is the net change from one snapshot of all requested resources, so transactions arrive whole. With links, each update is an immutable GET that the cache serves to all clients; events carry only the links.
- **Braid**: one subscription per resource (braid-http, multiplexed over one stream per client), each sending its resource's updates as range patches.
- **Mercure**: the hub, with one topic per resource. Usually one event is published per changed resource; publishing one event per transaction (to the topics of every resource it changes) keeps transactions whole, at the cost of sending every subscriber of any of those topics the whole transaction, including changes to resources it does not watch (and might not be allowed to read). The second scenario shows that cost.
- With a subset, views are checked, and transactions timed, on the resources a client watches.
- Updates: SYNC sends the smaller of a JSON Patch and a JSON Merge Patch; Mercure events carry the same updates; Braid uses its own range patches. Nothing is compressed. Bytes exclude TCP and TLS handshakes.
- The edge, the origin, the hub and the clients share one machine, so times reflect the relative cost of each approach, not production latency.
