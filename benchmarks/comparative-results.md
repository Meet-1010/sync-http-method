# SYNC vs GET, Braid, and Mercure: catch-up benchmark

**Run at:** 2026-10-09T05:17:27.995Z on Node v26.8.1

## What is measured

A client holds N resources (100 items each, about 20 KB as JSON) at round 0. The server has advanced L rounds. Each round, about 20% of resources change (at least one), and each changed resource has 3 of its 100 items modified. The client must bring all N resources current and its reconstructed state is checked against the server's (any mismatch aborts the run).

- **Bytes** are measured at a TCP proxy between client and server and include HTTP/2 framing and all headers, both directions. TCP and TLS handshakes are not included; the connection counts at the end of each section show where they would add cost.
- **Time** is wall clock with the proxy adding a 40 ms RTT and one RTT for each new TCP connection. It models latency, not bandwidth or server load. Median of 3 runs. Connections are cold, as when an app resumes.
- All delta protocols use the same JSON Patch generator and the same "snapshot if smaller" rule, so differences come from protocol framing, request count, and coalescing, not from the diff algorithm.

## Protocols

- **GET (full)**: N plain GETs, HTTP/1.1, pool of 6 keep-alive connections.
- **GET + ETag**: as above with `If-None-Match`; unchanged resources return 304.
- **Braid model H1 / H2**: my minimal model of draft-toomim-httpbis-braid-http-04 (per-resource `GET` with `Parents`, JSON Patch or 304). H2 is cleartext HTTP/2 with all N requests on one connection.
- **Braid real**: the `braid-http` library v1.5.1 (`braidify` on the server, its `fetch` on the client), one `GET` with `Parents` per resource. Its Node client uses undici over HTTP/1.1 here (cleartext rules out HTTP/2 negotiation), so requests run on parallel connections.
- **Braid real mux**: the same library with subscriptions and its Multiplexing v1.0 extension forced on: one `POST` creates a multiplexer, then one `GET` per resource, with all responses carried on the multiplexer stream. The client stops once each resource is caught up (`Current-Version` or the first update).
- **Braid real, patch format**: Braid range patches (`unit: json`, one per changed item), with the same "snapshot if smaller" rule. braid-http does not compress responses.
- **Mercure model**: my minimal model of draft-dunglas-mercure-08 (one SSE request, `Last-Event-ID`, replay of every intermediate event), not compressed.
- **Mercure real**: the Mercure.rocks hub (Docker image `dunglas/mercure`, v1.1.0, default bolt history). The history is published to the hub before measurement; the client subscribes with N `match` parameters and `Last-Event-ID`, and disconnects after receiving the expected number of events (a real subscriber would stay connected). In the realistic profile the client sends a real RFC 9068 subscriber token. The hub's default configuration does not compress responses.
- **SYNC**: the reference server and client in this repository: one request, N baselines.

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
| 1 | 1 | 1 | 20.9 | 21.0 | 1.3 | 1.3 | 1.4 | 3.4 | 1.4 | 1.9 | 1.5 |
| 1 | 5 | 1 | 21.0 | 21.0 | 5.3 | 5.3 | 4.7 | 8.7 | 5.7 | 6.4 | 5.5 |
| 1 | 25 | 1 | 21.1 | 21.1 | 19.4 | 19.4 | 16.4 | 27.2 | 27.4 | 28.8 | 19.6 |
| 10 | 1 | 3 | 209.4 | 64.4 | 5.4 | 3.7 | 7.2 | 15.7 | 3.7 | 4.6 | 4.2 |
| 10 | 5 | 8 | 209.5 | 168.3 | 17.9 | 15.9 | 17.8 | 33.8 | 16.8 | 18.1 | 16.6 |
| 10 | 25 | 10 | 209.6 | 210.0 | 66.8 | 64.7 | 58.5 | 98.9 | 78.7 | 82.1 | 65.4 |
| 50 | 1 | 12 | 1047.2 | 259.8 | 23.9 | 14.2 | 33.2 | 70.6 | 14.0 | 16.6 | 16.2 |
| 50 | 5 | 41 | 1047.4 | 862.1 | 73.5 | 62.2 | 75.4 | 145.1 | 66.3 | 70.6 | 65.1 |
| 50 | 25 | 50 | 1048.9 | 1050.5 | 279.3 | 267.8 | 246.9 | 419.2 | 310.8 | 323.0 | 270.7 |
| 100 | 1 | 16 | 2094.5 | 353.5 | 39.2 | 20.0 | 59.1 | 126.6 | 19.2 | 23.6 | 23.8 |
| 100 | 5 | 69 | 2094.8 | 1454.3 | 131.1 | 109.1 | 137.2 | 264.3 | 115.2 | 122.8 | 114.3 |
| 100 | 25 | 100 | 2096.5 | 2099.7 | 535.0 | 511.7 | 474.0 | 806.7 | 595.9 | 619.1 | 517.6 |

### Bytes as a fraction of GET (full)

| N | L | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 100.2% | 6.2% | 6.1% | 6.5% | 16.3% | 6.5% | 8.9% | 7.1% |
| 1 | 5 | 100.2% | 25.3% | 25.2% | 22.4% | 41.4% | 27.2% | 30.3% | 26.2% |
| 1 | 25 | 100.2% | 92.0% | 92.0% | 77.9% | 129.4% | 130.3% | 136.8% | 93.0% |
| 10 | 1 | 30.8% | 2.6% | 1.7% | 3.4% | 7.5% | 1.8% | 2.2% | 2.0% |
| 10 | 5 | 80.3% | 8.6% | 7.6% | 8.5% | 16.1% | 8.0% | 8.6% | 7.9% |
| 10 | 25 | 100.2% | 31.9% | 30.9% | 27.9% | 47.2% | 37.5% | 39.2% | 31.2% |
| 50 | 1 | 24.8% | 2.3% | 1.4% | 3.2% | 6.7% | 1.3% | 1.6% | 1.5% |
| 50 | 5 | 82.3% | 7.0% | 5.9% | 7.2% | 13.9% | 6.3% | 6.7% | 6.2% |
| 50 | 25 | 100.2% | 26.6% | 25.5% | 23.5% | 40.0% | 29.6% | 30.8% | 25.8% |
| 100 | 1 | 16.9% | 1.9% | 1.0% | 2.8% | 6.0% | 0.9% | 1.1% | 1.1% |
| 100 | 5 | 69.4% | 6.3% | 5.2% | 6.5% | 12.6% | 5.5% | 5.9% | 5.5% |
| 100 | 25 | 100.2% | 25.5% | 24.4% | 22.6% | 38.5% | 28.4% | 29.5% | 24.7% |

### Wall time (ms, simulated 40 ms RTT)

| N | L | GET (full) | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 86 | 85 | 85 | 87 | 89 | 91 | 84 | 87 | 85 |
| 1 | 5 | 83 | 85 | 85 | 88 | 86 | 90 | 86 | 88 | 85 |
| 1 | 25 | 82 | 84 | 85 | 86 | 90 | 100 | 90 | 97 | 85 |
| 10 | 1 | 133 | 132 | 135 | 87 | 90 | 99 | 84 | 89 | 88 |
| 10 | 5 | 130 | 134 | 133 | 94 | 98 | 104 | 89 | 97 | 92 |
| 10 | 25 | 132 | 131 | 135 | 95 | 99 | 120 | 99 | 103 | 95 |
| 50 | 1 | 448 | 436 | 441 | 102 | 100 | 120 | 91 | 97 | 96 |
| 50 | 5 | 443 | 446 | 449 | 108 | 108 | 125 | 95 | 107 | 98 |
| 50 | 25 | 445 | 427 | 429 | 360 | 99 | 127 | 104 | 108 | 98 |
| 100 | 1 | 763 | 769 | 764 | 101 | 113 | 126 | 97 | 98 | 99 |
| 100 | 5 | 805 | 805 | 825 | 208 | 114 | 144 | 103 | 108 | 110 |
| 100 | 25 | 781 | 780 | 819 | 674 | 125 | 182 | 137 | 177 | 125 |

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
| 1 | 1 | 1 | 5.3 | 5.4 | 1.9 | 1.7 | 1.9 | 3.9 | 1.9 | 2.7 | 1.4 |
| 1 | 5 | 1 | 5.4 | 5.4 | 2.0 | 1.8 | 5.2 | 9.2 | 6.3 | 7.2 | 2.2 |
| 1 | 25 | 1 | 5.6 | 5.6 | 4.3 | 4.1 | 16.9 | 27.7 | 28.0 | 29.7 | 4.5 |
| 10 | 1 | 3 | 53.3 | 21.6 | 9.9 | 4.7 | 12.2 | 20.7 | 4.2 | 5.4 | 2.0 |
| 10 | 5 | 8 | 53.5 | 44.6 | 13.0 | 7.3 | 22.7 | 38.7 | 17.3 | 19.0 | 4.0 |
| 10 | 25 | 10 | 54.1 | 54.4 | 22.5 | 16.6 | 63.4 | 103.9 | 79.2 | 83.0 | 11.4 |
| 50 | 1 | 12 | 266.5 | 94.0 | 48.5 | 21.3 | 58.0 | 95.3 | 14.6 | 17.7 | 4.6 |
| 50 | 5 | 41 | 267.1 | 227.5 | 66.6 | 36.6 | 100.2 | 169.8 | 66.9 | 71.7 | 11.3 |
| 50 | 25 | 50 | 269.8 | 271.4 | 102.7 | 71.6 | 271.6 | 444.0 | 311.4 | 324.2 | 41.4 |
| 100 | 1 | 16 | 532.9 | 151.3 | 90.2 | 36.0 | 108.6 | 176.1 | 19.8 | 25.1 | 6.7 |
| 100 | 5 | 69 | 534.0 | 395.2 | 126.1 | 66.9 | 186.7 | 313.8 | 115.8 | 124.2 | 18.2 |
| 100 | 25 | 100 | 539.5 | 542.7 | 201.7 | 139.2 | 523.5 | 856.3 | 596.5 | 620.6 | 77.3 |

### Bytes as a fraction of GET (full)

| N | L | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 100.6% | 34.8% | 31.3% | 34.8% | 73.1% | 35.7% | 50.5% | 26.3% |
| 1 | 5 | 100.6% | 37.0% | 33.0% | 96.4% | 170.6% | 116.1% | 133.5% | 40.0% |
| 1 | 25 | 100.6% | 77.8% | 74.0% | 303.9% | 499.2% | 503.7% | 533.6% | 80.9% |
| 10 | 1 | 40.4% | 18.5% | 8.8% | 22.8% | 38.8% | 7.9% | 10.2% | 3.8% |
| 10 | 5 | 83.5% | 24.4% | 13.7% | 42.5% | 72.4% | 32.4% | 35.5% | 7.5% |
| 10 | 25 | 100.6% | 41.5% | 30.7% | 117.2% | 192.0% | 146.5% | 153.3% | 21.0% |
| 50 | 1 | 35.3% | 18.2% | 8.0% | 21.8% | 35.8% | 5.5% | 6.6% | 1.7% |
| 50 | 5 | 85.2% | 24.9% | 13.7% | 37.5% | 63.6% | 25.0% | 26.9% | 4.2% |
| 50 | 25 | 100.6% | 38.1% | 26.5% | 100.7% | 164.6% | 115.4% | 120.2% | 15.3% |
| 100 | 1 | 28.4% | 16.9% | 6.8% | 20.4% | 33.0% | 3.7% | 4.7% | 1.3% |
| 100 | 5 | 74.0% | 23.6% | 12.5% | 35.0% | 58.8% | 21.7% | 23.3% | 3.4% |
| 100 | 25 | 100.6% | 37.4% | 25.8% | 97.0% | 158.7% | 110.6% | 115.0% | 14.3% |

### Wall time (ms, simulated 40 ms RTT)

| N | L | GET (full) | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 84 | 84 | 85 | 85 | 86 | 88 | 84 | 85 | 82 |
| 1 | 5 | 83 | 85 | 85 | 86 | 85 | 91 | 85 | 89 | 85 |
| 1 | 25 | 85 | 86 | 86 | 89 | 88 | 94 | 90 | 91 | 85 |
| 10 | 1 | 132 | 131 | 130 | 89 | 91 | 95 | 87 | 90 | 89 |
| 10 | 5 | 138 | 134 | 134 | 94 | 95 | 103 | 87 | 96 | 88 |
| 10 | 25 | 136 | 140 | 137 | 95 | 101 | 122 | 96 | 101 | 92 |
| 50 | 1 | 466 | 444 | 444 | 97 | 92 | 120 | 90 | 97 | 93 |
| 50 | 5 | 463 | 469 | 462 | 110 | 110 | 135 | 104 | 103 | 99 |
| 50 | 25 | 464 | 436 | 440 | 106 | 101 | 132 | 119 | 127 | 115 |
| 100 | 1 | 864 | 805 | 798 | 104 | 111 | 131 | 96 | 100 | 93 |
| 100 | 5 | 846 | 835 | 794 | 102 | 104 | 126 | 96 | 127 | 99 |
| 100 | 25 | 795 | 867 | 856 | 211 | 126 | 183 | 141 | 213 | 123 |

### Requests / TCP connections opened

Connections matter because the byte counts above exclude TCP and TLS handshakes; under TLS each new connection adds a handshake of several kilobytes.

| N | GET (full) | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 | 2 / 2 | 1 / 1 | 1 / 1 | 1 / 1 |
| 10 | 10 / 6 | 10 / 6 | 10 / 6 | 10 / 1 | 10 / 10 | 11 / 11 | 1 / 1 | 1 / 1 | 1 / 1 |
| 50 | 50 / 6 | 50 / 6 | 50 / 6 | 50 / 1 | 50 / 50 | 51 / 51 | 1 / 1 | 1 / 1 | 1 / 1 |
| 100 | 100 / 6 | 100 / 6 | 100 / 6 | 100 / 1 | 100 / 100 | 101 / 101 | 1 / 1 | 1 / 1 | 1 / 1 |

