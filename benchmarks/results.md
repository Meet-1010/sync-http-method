# SYNC vs GET Polling — Bandwidth Benchmark

**Run at:** 2026-10-05T13:50:29.508Z

**Seed configuration:**
- Feed size: 100 items
- Rounds: 50
- Changes per round: 3 items modified

## Results

| Metric | GET Polling | SYNC Method |
|---|---|---|
| Total bytes transferred | 509.3 KB | 22.5 KB |
| Bandwidth saved | — | **96%** |
| Requests made | 50 | 50 |
| Unnecessary data sent | 384.9 KB | 0 KB |
| Avg response size | 10431 bytes | 461 bytes |

## Notes

GET polling transfers the full 100-item feed on every request regardless of how much changed.
SYNC transfers only the 3 changed items per round, plus a small version vector in the request.
Savings increase as the feed grows larger and the change rate stays constant.
