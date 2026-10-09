# Consistency across resources: torn-read benchmark

**Run at:** 2026-10-09T15:14:47.231Z on Node v26.8.1

A writer commits one transaction every 5 ms. Each transaction adds a user, a post by that user, and updates a counter, atomically, and drops the oldest user with their post. In every committed state every post's author is a current user, and the counter's `last` equals the newest user id and the newest post id.

Each approach reads `/users`, `/posts` and `/counts` 300 times through a proxy adding a 40 ms round trip, and checks both invariants. A read that violates either invariant is a combination of resources that never existed on the server.

## idealized (fixed delays)

15029 transactions were committed during this scenario.

| Approach | Torn reads | Rate | 95% CI (Wilson) | Median time |
|---|---|---|---|---|
| GET, parallel | 5 / 300 | 1.7% | 0.7% to 3.8% | 43 ms |
| GET, sequential | 300 / 300 | 100.0% | 98.7% to 100.0% | 127 ms |
| Braid (braid-http), parallel | 9 / 300 | 3.0% | 1.6% to 5.6% | 44 ms |
| SYNC | 0 / 300 | 0.0% | 0.0% to 1.3% | 43 ms |
| SYNC, consistent | 0 / 300 | 0.0% | 0.0% to 1.3% | 43 ms |

## realistic (network jitter up to 10 ms, store reads 1 to 8 ms)

20039 transactions were committed during this scenario.

| Approach | Torn reads | Rate | 95% CI (Wilson) | Median time |
|---|---|---|---|---|
| GET, parallel | 238 / 300 | 79.3% | 74.4% to 83.5% | 58 ms |
| GET, sequential | 300 / 300 | 100.0% | 98.7% to 100.0% | 166 ms |
| Braid (braid-http), parallel | 247 / 300 | 82.3% | 77.6% to 86.2% | 59 ms |
| SYNC | 180 / 300 | 60.0% | 54.4% to 65.4% | 57 ms |
| SYNC, consistent | 0 / 300 | 0.0% | 0.0% to 1.3% | 57 ms |

## Notes

- "SYNC, consistent" sends `"consistent": true`; the server reads every resource from one snapshot of the store and confirms it with `Sync-Consistent: ?1`. It is the only approach here whose result cannot be torn, whatever the timing.
- In the idealized scenario all delays are fixed, so parallel requests reach the server and read the store at almost the same instant; this is the most favourable case for separate requests. With realistic variation in network and database timing, reads made separately drift apart and commits land between them.
- Plain SYNC (without `consistent`) reads the resources concurrently but not atomically, so it can also be torn.
- Separate requests could avoid torn reads only with an additional mechanism, for example a version to read "as of"; HTTP and Braid-HTTP do not define one across resources.
- Every approach reuses its connections (HTTP keep-alive), so times compare like with like.
- The rates depend on the write rate, store latency and network; the comparison shows which approaches can produce a state that never existed, not universal percentages.
