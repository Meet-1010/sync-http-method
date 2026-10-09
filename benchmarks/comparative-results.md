# SYNC vs GET, Braid-style, and Mercure-style: catch-up benchmark

**Run at:** 2026-10-09T04:22:50.825Z on Node v26.8.1

## What is measured

A client holds N resources (100 items each, about 20 KB as JSON) at round 0. The server has advanced L rounds. Each round, about 20% of resources change (at least one), and each changed resource has 3 of its 100 items modified. The client must bring all N resources current and its reconstructed state is checked against the server's (any mismatch aborts the run).

- **Bytes** are measured at a TCP proxy between client and server and include HTTP/2 framing and all headers, both directions. TLS is not modelled.
- **Time** is wall clock with the proxy adding a 40 ms RTT and one RTT for each new TCP connection. It models latency, not bandwidth or server load. Median of 3 runs. Connections are cold, as when an app resumes.
- All delta protocols use the same JSON Patch generator and the same "snapshot if smaller" rule, so differences come from protocol framing, request count, and coalescing, not from the diff algorithm.

## Protocols

- **GET (full)**: N plain GETs, HTTP/1.1, pool of 6 keep-alive connections.
- **GET + ETag**: as above with `If-None-Match`; unchanged resources return 304.
- **Braid-style H1 / H2**: per-resource `GET` with `Parents`, server returns a JSON Patch (or 304). Modelled on draft-toomim-httpbis-braid-http-04 Section 2.4/3.2, not the Braid reference implementation. H2 is cleartext HTTP/2 with all N requests multiplexed on one connection.
- **Mercure-style**: one SSE request with N topic matchers and `Last-Event-ID`, hub replays every event after the cursor as it occurred (one JSON Patch event per resource per round). Modelled on draft-dunglas-mercure-08, not the Mercure hub. The stream is closed after replay (a real subscriber would keep it open) and responses are not compressed.
- **SYNC**: the reference server and client in this repository: one request, N baselines.

## Caveats

- The Braid-style and Mercure-style servers are minimal re-implementations written for this benchmark, not the projects' own software.
- The SYNC server closes the connection after each response (no keep-alive), so SYNC pays a TCP handshake per request. This hurts it in the time columns for repeated polling; every run here is a single cold exchange so it does not distort these numbers.
- Only the catch-up exchange is measured. Braid and Mercure also provide live push, which SYNC does not.
- Mercure's replay is history, not state: the client receives every intermediate patch. That is a feature when history matters and a cost when it does not.

## Lab: minimal request headers, no compression

### Total wire bytes (KB, both directions)

| N | L | changed | GET (full) | GET + ETag | Braid-style H1 | Braid-style H2 | Mercure-style | SYNC |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 20.9 | 21.0 | 1.3 | 1.3 | 1.4 | 1.5 |
| 1 | 5 | 1 | 21.0 | 21.0 | 5.3 | 5.3 | 5.7 | 5.5 |
| 1 | 25 | 1 | 21.1 | 21.1 | 19.4 | 19.4 | 27.4 | 19.6 |
| 10 | 1 | 3 | 209.4 | 64.4 | 5.4 | 3.7 | 3.7 | 4.2 |
| 10 | 5 | 8 | 209.5 | 168.3 | 17.9 | 15.9 | 16.8 | 16.6 |
| 10 | 25 | 10 | 209.6 | 210.0 | 66.8 | 64.7 | 78.7 | 65.4 |
| 50 | 1 | 12 | 1047.2 | 259.8 | 23.9 | 14.2 | 14.0 | 16.2 |
| 50 | 5 | 41 | 1047.4 | 862.1 | 73.5 | 62.2 | 66.3 | 65.1 |
| 50 | 25 | 50 | 1048.9 | 1050.5 | 279.3 | 267.8 | 310.8 | 270.7 |
| 100 | 1 | 16 | 2094.5 | 353.5 | 39.2 | 20.0 | 19.2 | 23.8 |
| 100 | 5 | 69 | 2094.8 | 1454.3 | 131.1 | 109.1 | 115.2 | 114.3 |
| 100 | 25 | 100 | 2096.5 | 2099.7 | 535.0 | 511.7 | 595.9 | 517.6 |

### Bytes as a fraction of GET (full)

| N | L | GET + ETag | Braid-style H1 | Braid-style H2 | Mercure-style | SYNC |
|---|---|---|---|---|---|---|
| 1 | 1 | 100.2% | 6.2% | 6.1% | 6.5% | 7.1% |
| 1 | 5 | 100.2% | 25.3% | 25.2% | 27.2% | 26.2% |
| 1 | 25 | 100.2% | 92.0% | 92.0% | 130.3% | 93.0% |
| 10 | 1 | 30.8% | 2.6% | 1.7% | 1.8% | 2.0% |
| 10 | 5 | 80.3% | 8.6% | 7.6% | 8.0% | 7.9% |
| 10 | 25 | 100.2% | 31.9% | 30.9% | 37.5% | 31.2% |
| 50 | 1 | 24.8% | 2.3% | 1.4% | 1.3% | 1.5% |
| 50 | 5 | 82.3% | 7.0% | 5.9% | 6.3% | 6.2% |
| 50 | 25 | 100.2% | 26.6% | 25.5% | 29.6% | 25.8% |
| 100 | 1 | 16.9% | 1.9% | 1.0% | 0.9% | 1.1% |
| 100 | 5 | 69.4% | 6.3% | 5.2% | 5.5% | 5.5% |
| 100 | 25 | 100.2% | 25.5% | 24.4% | 28.4% | 24.7% |

### Wall time (ms, simulated 40 ms RTT)

| N | L | GET (full) | GET + ETag | Braid-style H1 | Braid-style H2 | Mercure-style | SYNC |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 83 | 83 | 83 | 85 | 82 | 82 |
| 1 | 5 | 82 | 82 | 83 | 83 | 83 | 83 |
| 1 | 25 | 82 | 82 | 83 | 86 | 87 | 84 |
| 10 | 1 | 131 | 126 | 128 | 88 | 85 | 86 |
| 10 | 5 | 128 | 128 | 133 | 90 | 86 | 88 |
| 10 | 25 | 127 | 128 | 133 | 93 | 93 | 93 |
| 50 | 1 | 416 | 413 | 424 | 90 | 85 | 87 |
| 50 | 5 | 422 | 412 | 423 | 106 | 98 | 103 |
| 50 | 25 | 427 | 427 | 448 | 351 | 120 | 114 |
| 100 | 1 | 771 | 756 | 753 | 107 | 95 | 98 |
| 100 | 5 | 770 | 770 | 798 | 197 | 107 | 114 |
| 100 | 25 | 776 | 775 | 823 | 639 | 135 | 117 |

### Requests made

| N | GET (full) | GET + ETag | Braid-style H1 | Braid-style H2 | Mercure-style | SYNC |
|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| 10 | 10 | 10 | 10 | 10 | 1 | 1 |
| 50 | 50 | 50 | 50 | 50 | 1 | 1 |
| 100 | 100 | 100 | 100 | 100 | 1 | 1 |

## Realistic: bearer token + cookie + browser-style headers, gzip

### Total wire bytes (KB, both directions)

| N | L | changed | GET (full) | GET + ETag | Braid-style H1 | Braid-style H2 | Mercure-style | SYNC |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 5.3 | 5.4 | 1.9 | 1.7 | 1.9 | 1.4 |
| 1 | 5 | 1 | 5.4 | 5.4 | 2.0 | 1.8 | 6.3 | 2.2 |
| 1 | 25 | 1 | 5.6 | 5.6 | 4.3 | 4.1 | 28.0 | 4.5 |
| 10 | 1 | 3 | 53.3 | 21.6 | 9.9 | 4.7 | 4.2 | 2.0 |
| 10 | 5 | 8 | 53.5 | 44.6 | 13.0 | 7.3 | 17.3 | 4.0 |
| 10 | 25 | 10 | 54.1 | 54.4 | 22.5 | 16.6 | 79.2 | 11.4 |
| 50 | 1 | 12 | 266.5 | 94.0 | 48.5 | 21.3 | 14.6 | 4.6 |
| 50 | 5 | 41 | 267.1 | 227.5 | 66.6 | 36.6 | 66.9 | 11.3 |
| 50 | 25 | 50 | 269.8 | 271.4 | 102.7 | 71.6 | 311.4 | 41.4 |
| 100 | 1 | 16 | 532.9 | 151.3 | 90.2 | 36.0 | 19.8 | 6.7 |
| 100 | 5 | 69 | 534.0 | 395.2 | 126.1 | 66.9 | 115.8 | 18.2 |
| 100 | 25 | 100 | 539.5 | 542.7 | 201.7 | 139.2 | 596.5 | 77.3 |

### Bytes as a fraction of GET (full)

| N | L | GET + ETag | Braid-style H1 | Braid-style H2 | Mercure-style | SYNC |
|---|---|---|---|---|---|---|
| 1 | 1 | 100.6% | 34.8% | 31.3% | 35.7% | 26.3% |
| 1 | 5 | 100.6% | 37.0% | 33.0% | 116.1% | 39.9% |
| 1 | 25 | 100.6% | 77.8% | 74.0% | 503.7% | 80.9% |
| 10 | 1 | 40.4% | 18.5% | 8.8% | 7.9% | 3.8% |
| 10 | 5 | 83.5% | 24.4% | 13.7% | 32.4% | 7.5% |
| 10 | 25 | 100.6% | 41.5% | 30.7% | 146.5% | 21.0% |
| 50 | 1 | 35.3% | 18.2% | 8.0% | 5.5% | 1.7% |
| 50 | 5 | 85.2% | 24.9% | 13.7% | 25.0% | 4.2% |
| 50 | 25 | 100.6% | 38.1% | 26.5% | 115.4% | 15.3% |
| 100 | 1 | 28.4% | 16.9% | 6.8% | 3.7% | 1.3% |
| 100 | 5 | 74.0% | 23.6% | 12.5% | 21.7% | 3.4% |
| 100 | 25 | 100.6% | 37.4% | 25.8% | 110.6% | 14.3% |

### Wall time (ms, simulated 40 ms RTT)

| N | L | GET (full) | GET + ETag | Braid-style H1 | Braid-style H2 | Mercure-style | SYNC |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 83 | 83 | 82 | 84 | 82 | 83 |
| 1 | 5 | 83 | 82 | 83 | 84 | 83 | 82 |
| 1 | 25 | 84 | 83 | 83 | 85 | 87 | 84 |
| 10 | 1 | 135 | 130 | 129 | 87 | 84 | 85 |
| 10 | 5 | 135 | 133 | 132 | 89 | 86 | 88 |
| 10 | 25 | 136 | 138 | 136 | 95 | 95 | 92 |
| 50 | 1 | 463 | 434 | 426 | 99 | 89 | 94 |
| 50 | 5 | 462 | 462 | 448 | 105 | 97 | 104 |
| 50 | 25 | 466 | 467 | 463 | 114 | 121 | 112 |
| 100 | 1 | 841 | 774 | 768 | 107 | 95 | 99 |
| 100 | 5 | 845 | 826 | 808 | 120 | 105 | 114 |
| 100 | 25 | 848 | 839 | 834 | 212 | 132 | 116 |

### Requests made

| N | GET (full) | GET + ETag | Braid-style H1 | Braid-style H2 | Mercure-style | SYNC |
|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| 10 | 10 | 10 | 10 | 10 | 1 | 1 |
| 50 | 50 | 50 | 50 | 50 | 1 | 1 |
| 100 | 100 | 100 | 100 | 100 | 1 | 1 |

