# SYNC vs GET, Braid, and Mercure: catch-up benchmark

**Run at:** 2026-10-09T15:11:17.894Z on Node v26.8.1

## What is measured

A client holds N resources (100 items each, about 20 KB as JSON) at round 0. The server has advanced L rounds. Each round, about 20% of resources change (at least one), and each changed resource has 3 of its 100 items modified. The client must bring all N resources current and its reconstructed state is checked against the server's (any mismatch aborts the run).

- **Bytes** are measured at a TCP proxy between client and server and include HTTP/2 framing and all headers, both directions. TCP and TLS handshakes are not included; the connection counts at the end of each section show where they would add cost.
- **Time** is wall clock with the proxy adding a 40 ms RTT and one RTT for each new TCP connection. It models latency, not bandwidth or server load. Median of 3 runs. Connections are cold, as when an app resumes.
- All delta protocols except real Braid use the same update generator: the smaller of a JSON Patch and a JSON Merge Patch, or the full document when neither is smaller (SYNC's rule). Differences between them therefore come from protocol framing, request count, and coalescing, not from the diff algorithm. Real Braid uses its own range patches.

## Protocols

- **GET (full)**: N plain GETs, HTTP/1.1, pool of 6 keep-alive connections.
- **GET + ETag**: as above with `If-None-Match`; unchanged resources return 304.
- **Braid model H1 / H2**: my minimal model of draft-toomim-httpbis-braid-http-04 (per-resource `GET` with `Parents`, an update or 304). H2 is cleartext HTTP/2 with all N requests on one connection.
- **Braid real**: the `braid-http` library v1.5.1 (`braidify` on the server, its `fetch` on the client), one `GET` with `Parents` per resource. Its Node client uses undici over HTTP/1.1 here (cleartext rules out HTTP/2 negotiation), so requests run on parallel connections.
- **Braid real mux**: the same library with subscriptions and its Multiplexing v1.0 extension forced on: one `POST` creates a multiplexer, then one `GET` per resource, with all responses carried on the multiplexer stream. The client stops once each resource is caught up (`Current-Version` or the first update).
- **Braid real, patch format**: Braid range patches (`unit: json`, a JSON Pointer range per changed item, as in draft-toomim-httpbis-range-patch-00), with the same "snapshot if smaller" rule. braid-http does not compress responses.
- **Mercure model**: my minimal model of draft-dunglas-mercure-08 (one SSE request, `Last-Event-ID`, replay of every intermediate event), not compressed.
- **Mercure real**: the Mercure.rocks hub (Docker image `dunglas/mercure`, v1.1.0, default bolt history). The history is published to the hub before measurement; the client subscribes with N `match` parameters and `Last-Event-ID`, and disconnects after receiving the expected number of events (a real subscriber would stay connected). In the realistic profile the client sends a real RFC 9068 subscriber token. The hub's default configuration does not compress responses.
- **SYNC**: this repository's `syncHandler` on an ordinary Node HTTP server and its client, sending one `QUERY` (RFC 10008) with N baselines.

## Caveats

- "Model" columns are minimal re-implementations written for this benchmark; "real" columns run the projects' own software. Real Braid patch semantics on the client (applying `json` range patches) are application code written for this benchmark, as the library leaves them to the application.
- Braid's Node client cannot use HTTP/2 over cleartext, so "Braid real" is measured over HTTP/1.1 only; "Braid model H2" is the HTTP/2 estimate.
- Every run is a single cold exchange on fresh connections, so connection reuse (which the SYNC server now supports) is not exercised.
- Only the catch-up exchange is measured. Braid and Mercure also provide live push, which SYNC does not.
- In the realistic profile the "real" Braid and Mercure columns run with their default configuration, which does not compress responses, while the model columns and SYNC use gzip. Part of the realistic-profile gap to the real software is therefore compression defaults, not protocol design; the model columns are the compression-fair comparison.
- Braid's range patches replace whole items, while JSON Patch (used by SYNC and the models) emits one operation per changed field. With many accumulated changes this makes "Braid real" smaller in the lab profile. That is a patch-format difference, and SYNC could negotiate an equivalent format.
- Mercure's replay is history, not state: the client receives every intermediate patch. That is a feature when history matters and a cost when it does not.

## Lab: minimal request headers, no compression

### Total wire bytes (KB, both directions)

| N | L | changed | GET (full) | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 20.9 | 21.0 | 0.9 | 0.9 | 1.4 | 3.4 | 1.0 | 1.5 | 1.2 |
| 1 | 5 | 1 | 21.0 | 21.0 | 3.3 | 3.3 | 4.7 | 8.7 | 3.7 | 4.3 | 3.6 |
| 1 | 25 | 1 | 21.1 | 21.1 | 11.8 | 11.7 | 16.2 | 27.1 | 17.4 | 18.8 | 12.1 |
| 10 | 1 | 3 | 209.4 | 64.4 | 4.2 | 2.5 | 7.2 | 15.7 | 2.5 | 3.4 | 2.9 |
| 10 | 5 | 8 | 209.5 | 168.3 | 11.9 | 9.9 | 17.6 | 33.6 | 10.8 | 12.1 | 10.5 |
| 10 | 25 | 10 | 209.6 | 210.0 | 41.3 | 39.2 | 57.9 | 98.4 | 49.9 | 53.3 | 39.9 |
| 50 | 1 | 12 | 1047.2 | 259.8 | 19.1 | 9.4 | 33.1 | 70.4 | 9.2 | 11.8 | 10.6 |
| 50 | 5 | 41 | 1047.4 | 862.1 | 49.9 | 38.6 | 74.9 | 144.5 | 42.3 | 46.6 | 40.7 |
| 50 | 25 | 50 | 1048.9 | 1050.5 | 174.0 | 162.3 | 244.6 | 416.9 | 197.3 | 209.5 | 164.5 |
| 100 | 1 | 16 | 2094.5 | 353.5 | 32.8 | 13.6 | 58.9 | 126.4 | 12.8 | 17.2 | 15.6 |
| 100 | 5 | 69 | 2094.8 | 1454.3 | 89.9 | 67.6 | 136.3 | 263.4 | 73.6 | 81.2 | 71.3 |
| 100 | 25 | 100 | 2096.5 | 2099.7 | 333.5 | 310.1 | 469.6 | 802.3 | 378.1 | 401.3 | 314.1 |

### Bytes as a fraction of GET (full)

| N | L | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 100.2% | 4.2% | 4.2% | 6.5% | 16.2% | 4.6% | 6.9% | 5.7% |
| 1 | 5 | 100.2% | 15.7% | 15.6% | 22.2% | 41.2% | 17.7% | 20.7% | 17.3% |
| 1 | 25 | 100.2% | 55.8% | 55.8% | 77.1% | 128.6% | 82.9% | 89.4% | 57.4% |
| 10 | 1 | 30.8% | 2.0% | 1.2% | 3.4% | 7.5% | 1.2% | 1.6% | 1.4% |
| 10 | 5 | 80.3% | 5.7% | 4.7% | 8.4% | 16.0% | 5.1% | 5.8% | 5.0% |
| 10 | 25 | 100.2% | 19.7% | 18.7% | 27.6% | 46.9% | 23.8% | 25.4% | 19.0% |
| 50 | 1 | 24.8% | 1.8% | 0.9% | 3.2% | 6.7% | 0.9% | 1.1% | 1.0% |
| 50 | 5 | 82.3% | 4.8% | 3.7% | 7.2% | 13.8% | 4.0% | 4.4% | 3.9% |
| 50 | 25 | 100.2% | 16.6% | 15.5% | 23.3% | 39.7% | 18.8% | 20.0% | 15.7% |
| 100 | 1 | 16.9% | 1.6% | 0.6% | 2.8% | 6.0% | 0.6% | 0.8% | 0.7% |
| 100 | 5 | 69.4% | 4.3% | 3.2% | 6.5% | 12.6% | 3.5% | 3.9% | 3.4% |
| 100 | 25 | 100.2% | 15.9% | 14.8% | 22.4% | 38.3% | 18.0% | 19.1% | 15.0% |

### Wall time (ms, simulated 40 ms RTT)

| N | L | GET (full) | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 85 | 85 | 84 | 87 | 87 | 93 | 84 | 87 | 83 |
| 1 | 5 | 84 | 84 | 84 | 87 | 87 | 94 | 84 | 87 | 83 |
| 1 | 25 | 83 | 84 | 85 | 88 | 91 | 96 | 85 | 92 | 84 |
| 10 | 1 | 132 | 131 | 133 | 91 | 94 | 94 | 84 | 88 | 85 |
| 10 | 5 | 126 | 127 | 126 | 85 | 86 | 90 | 85 | 87 | 83 |
| 10 | 25 | 127 | 125 | 128 | 93 | 104 | 122 | 87 | 100 | 86 |
| 50 | 1 | 448 | 439 | 438 | 100 | 110 | 115 | 89 | 93 | 89 |
| 50 | 5 | 440 | 444 | 461 | 106 | 120 | 129 | 94 | 107 | 92 |
| 50 | 25 | 447 | 442 | 469 | 240 | 121 | 151 | 102 | 177 | 95 |
| 100 | 1 | 799 | 779 | 791 | 102 | 114 | 118 | 93 | 100 | 93 |
| 100 | 5 | 806 | 790 | 823 | 116 | 118 | 141 | 98 | 109 | 97 |
| 100 | 25 | 801 | 807 | 853 | 461 | 136 | 170 | 115 | 197 | 105 |

### Requests / TCP connections opened

Connections matter because the byte counts above exclude TCP and TLS handshakes; under TLS each new connection adds a handshake of several kilobytes.

| N | GET (full) | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 | 2 / 2 | 1 / 1 | 1 / 1 | 1 / 1 |
| 10 | 10 / 6 | 10 / 6 | 10 / 6 | 10 / 1 | 10 / 10 | 11 / 11 | 1 / 1 | 1 / 1 | 1 / 1 |
| 50 | 50 / 6 | 50 / 6 | 50 / 6 | 50 / 1 | 50 / 50 | 51 / 51 | 1 / 1 | 1 / 1 | 1 / 1 |
| 100 | 100 / 6 | 100 / 6 | 100 / 6 | 100 / 1 | 100 / 100 | 101 / 101 | 1 / 1 | 1 / 1 | 1 / 1 |

## Realistic: bearer token + cookie + browser-style headers, gzip

### Total wire bytes (KB, both directions)

| N | L | changed | GET (full) | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 5.3 | 5.4 | 1.5 | 1.3 | 1.8 | 3.9 | 1.5 | 2.3 | 1.8 |
| 1 | 5 | 1 | 5.4 | 5.4 | 1.8 | 1.6 | 5.1 | 9.1 | 4.3 | 5.2 | 2.1 |
| 1 | 25 | 1 | 5.6 | 5.6 | 3.7 | 3.5 | 16.7 | 27.6 | 18.0 | 19.7 | 3.9 |
| 10 | 1 | 3 | 53.3 | 21.6 | 9.9 | 4.8 | 12.1 | 20.6 | 3.0 | 4.2 | 1.9 |
| 10 | 5 | 8 | 53.5 | 44.6 | 13.3 | 7.7 | 22.6 | 38.6 | 11.3 | 13.0 | 3.5 |
| 10 | 25 | 10 | 54.1 | 54.4 | 20.2 | 14.4 | 62.9 | 103.3 | 50.5 | 54.2 | 9.2 |
| 50 | 1 | 12 | 266.5 | 94.0 | 47.4 | 20.4 | 57.9 | 95.2 | 9.8 | 12.9 | 3.6 |
| 50 | 5 | 41 | 267.1 | 227.5 | 66.9 | 37.7 | 99.7 | 169.3 | 42.9 | 47.7 | 8.5 |
| 50 | 25 | 50 | 269.8 | 271.4 | 93.8 | 62.7 | 269.3 | 441.6 | 197.8 | 210.6 | 30.8 |
| 100 | 1 | 16 | 532.9 | 151.3 | 89.4 | 35.5 | 108.5 | 175.9 | 13.4 | 18.7 | 4.7 |
| 100 | 5 | 69 | 534.0 | 395.2 | 124.3 | 66.3 | 185.8 | 312.9 | 74.2 | 82.7 | 13.1 |
| 100 | 25 | 100 | 539.5 | 542.7 | 185.6 | 123.0 | 519.1 | 851.8 | 378.6 | 402.7 | 56.4 |

### Bytes as a fraction of GET (full)

| N | L | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 100.6% | 27.3% | 23.8% | 34.7% | 73.0% | 28.2% | 42.9% | 33.1% |
| 1 | 5 | 100.6% | 33.5% | 29.6% | 95.6% | 169.8% | 78.9% | 96.3% | 38.5% |
| 1 | 25 | 100.6% | 66.2% | 62.3% | 300.9% | 496.2% | 323.7% | 353.7% | 71.1% |
| 10 | 1 | 40.4% | 18.6% | 9.0% | 22.8% | 38.7% | 5.7% | 8.0% | 3.6% |
| 10 | 5 | 83.5% | 24.8% | 14.4% | 42.3% | 72.2% | 21.2% | 24.3% | 6.5% |
| 10 | 25 | 100.6% | 37.4% | 26.6% | 116.2% | 190.9% | 93.3% | 100.2% | 17.0% |
| 50 | 1 | 35.3% | 17.8% | 7.7% | 21.7% | 35.7% | 3.7% | 4.8% | 1.4% |
| 50 | 5 | 85.2% | 25.0% | 14.1% | 37.3% | 63.4% | 16.1% | 17.9% | 3.2% |
| 50 | 25 | 100.6% | 34.8% | 23.2% | 99.8% | 163.7% | 73.3% | 78.1% | 11.4% |
| 100 | 1 | 28.4% | 16.8% | 6.7% | 20.4% | 33.0% | 2.5% | 3.5% | 0.9% |
| 100 | 5 | 74.0% | 23.3% | 12.4% | 34.8% | 58.6% | 13.9% | 15.5% | 2.5% |
| 100 | 25 | 100.6% | 34.4% | 22.8% | 96.2% | 157.9% | 70.2% | 74.6% | 10.5% |

### Wall time (ms, simulated 40 ms RTT)

| N | L | GET (full) | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 84 | 85 | 83 | 84 | 85 | 89 | 85 | 87 | 84 |
| 1 | 5 | 84 | 85 | 85 | 87 | 86 | 91 | 84 | 86 | 84 |
| 1 | 25 | 85 | 85 | 86 | 87 | 87 | 93 | 84 | 86 | 85 |
| 10 | 1 | 140 | 132 | 131 | 90 | 90 | 96 | 86 | 88 | 85 |
| 10 | 5 | 139 | 138 | 132 | 93 | 96 | 104 | 85 | 93 | 87 |
| 10 | 25 | 136 | 136 | 138 | 97 | 101 | 113 | 88 | 100 | 90 |
| 50 | 1 | 476 | 447 | 437 | 99 | 110 | 112 | 91 | 94 | 91 |
| 50 | 5 | 460 | 471 | 460 | 108 | 114 | 130 | 90 | 94 | 92 |
| 50 | 25 | 479 | 479 | 475 | 115 | 119 | 151 | 100 | 149 | 103 |
| 100 | 1 | 856 | 793 | 785 | 103 | 110 | 127 | 94 | 95 | 92 |
| 100 | 5 | 859 | 845 | 827 | 121 | 122 | 137 | 98 | 101 | 95 |
| 100 | 25 | 863 | 879 | 856 | 180 | 132 | 181 | 115 | 264 | 114 |

### Requests / TCP connections opened

Connections matter because the byte counts above exclude TCP and TLS handshakes; under TLS each new connection adds a handshake of several kilobytes.

| N | GET (full) | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 | 2 / 2 | 1 / 1 | 1 / 1 | 1 / 1 |
| 10 | 10 / 6 | 10 / 6 | 10 / 6 | 10 / 1 | 10 / 10 | 11 / 11 | 1 / 1 | 1 / 1 | 1 / 1 |
| 50 | 50 / 6 | 50 / 6 | 50 / 6 | 50 / 1 | 50 / 50 | 51 / 51 | 1 / 1 | 1 / 1 | 1 / 1 |
| 100 | 100 / 6 | 100 / 6 | 100 / 6 | 100 / 1 | 100 / 100 | 101 / 101 | 1 / 1 | 1 / 1 | 1 / 1 |

