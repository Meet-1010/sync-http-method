# SYNC vs GET, Braid, and Mercure: catch-up benchmark

**Run at:** 2026-10-09T09:57:27.479Z on Node v26.8.1

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
| 1 | 1 | 1 | 20.9 | 21.0 | 1.3 | 1.3 | 1.4 | 3.4 | 1.4 | 1.9 | 1.5 |
| 1 | 5 | 1 | 21.0 | 21.0 | 5.3 | 5.3 | 4.7 | 8.7 | 5.7 | 6.4 | 5.6 |
| 1 | 25 | 1 | 21.1 | 21.1 | 19.4 | 19.4 | 16.2 | 27.1 | 27.4 | 28.8 | 19.6 |
| 10 | 1 | 3 | 209.4 | 64.4 | 5.4 | 3.7 | 7.2 | 15.7 | 3.7 | 4.6 | 4.1 |
| 10 | 5 | 8 | 209.5 | 168.3 | 17.9 | 15.9 | 17.6 | 33.6 | 16.8 | 18.1 | 16.4 |
| 10 | 25 | 10 | 209.6 | 210.0 | 66.8 | 64.7 | 57.9 | 98.4 | 78.7 | 82.1 | 65.3 |
| 50 | 1 | 12 | 1047.2 | 259.8 | 23.9 | 14.2 | 33.1 | 70.4 | 14.0 | 16.6 | 15.4 |
| 50 | 5 | 41 | 1047.4 | 862.1 | 73.5 | 62.2 | 74.9 | 144.5 | 66.3 | 70.6 | 64.3 |
| 50 | 25 | 50 | 1048.9 | 1050.5 | 279.3 | 267.8 | 244.6 | 416.9 | 310.8 | 323.0 | 269.8 |
| 100 | 1 | 16 | 2094.5 | 353.5 | 39.2 | 20.0 | 58.9 | 126.4 | 19.2 | 23.6 | 21.9 |
| 100 | 5 | 69 | 2094.8 | 1454.3 | 131.1 | 109.1 | 136.3 | 263.4 | 115.2 | 122.8 | 112.4 |
| 100 | 25 | 100 | 2096.5 | 2099.7 | 535.0 | 511.7 | 469.6 | 802.3 | 595.9 | 619.1 | 515.5 |

### Bytes as a fraction of GET (full)

| N | L | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 100.2% | 6.2% | 6.1% | 6.5% | 16.2% | 6.5% | 8.9% | 7.4% |
| 1 | 5 | 100.2% | 25.3% | 25.2% | 22.2% | 41.2% | 27.2% | 30.3% | 26.5% |
| 1 | 25 | 100.2% | 92.0% | 92.0% | 77.1% | 128.6% | 130.3% | 136.8% | 93.2% |
| 10 | 1 | 30.8% | 2.6% | 1.7% | 3.4% | 7.5% | 1.8% | 2.2% | 1.9% |
| 10 | 5 | 80.3% | 8.6% | 7.6% | 8.4% | 16.0% | 8.0% | 8.6% | 7.8% |
| 10 | 25 | 100.2% | 31.9% | 30.9% | 27.6% | 46.9% | 37.5% | 39.2% | 31.1% |
| 50 | 1 | 24.8% | 2.3% | 1.4% | 3.2% | 6.7% | 1.3% | 1.6% | 1.5% |
| 50 | 5 | 82.3% | 7.0% | 5.9% | 7.2% | 13.8% | 6.3% | 6.7% | 6.1% |
| 50 | 25 | 100.2% | 26.6% | 25.5% | 23.3% | 39.7% | 29.6% | 30.8% | 25.7% |
| 100 | 1 | 16.9% | 1.9% | 1.0% | 2.8% | 6.0% | 0.9% | 1.1% | 1.0% |
| 100 | 5 | 69.4% | 6.3% | 5.2% | 6.5% | 12.6% | 5.5% | 5.9% | 5.4% |
| 100 | 25 | 100.2% | 25.5% | 24.4% | 22.4% | 38.3% | 28.4% | 29.5% | 24.6% |

### Wall time (ms, simulated 40 ms RTT)

| N | L | GET (full) | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 83 | 83 | 83 | 84 | 87 | 90 | 83 | 86 | 83 |
| 1 | 5 | 82 | 82 | 83 | 84 | 84 | 91 | 85 | 87 | 84 |
| 1 | 25 | 83 | 83 | 84 | 86 | 87 | 96 | 83 | 87 | 83 |
| 10 | 1 | 129 | 126 | 130 | 88 | 92 | 95 | 81 | 83 | 81 |
| 10 | 5 | 123 | 124 | 123 | 83 | 85 | 87 | 82 | 83 | 82 |
| 10 | 25 | 123 | 123 | 123 | 86 | 98 | 94 | 85 | 89 | 85 |
| 50 | 1 | 432 | 420 | 425 | 101 | 106 | 112 | 90 | 96 | 92 |
| 50 | 5 | 429 | 434 | 439 | 106 | 102 | 126 | 86 | 95 | 92 |
| 50 | 25 | 413 | 407 | 449 | 355 | 114 | 157 | 125 | 142 | 104 |
| 100 | 1 | 781 | 765 | 768 | 93 | 110 | 124 | 95 | 99 | 96 |
| 100 | 5 | 776 | 769 | 798 | 204 | 117 | 138 | 101 | 116 | 105 |
| 100 | 25 | 781 | 780 | 828 | 648 | 128 | 181 | 136 | 223 | 113 |

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
| 1 | 1 | 1 | 5.3 | 5.4 | 1.9 | 1.7 | 1.8 | 3.9 | 1.9 | 2.7 | 1.4 |
| 1 | 5 | 1 | 5.4 | 5.4 | 2.0 | 1.8 | 5.1 | 9.1 | 6.3 | 7.2 | 2.2 |
| 1 | 25 | 1 | 5.6 | 5.6 | 4.3 | 4.1 | 16.7 | 27.6 | 28.0 | 29.7 | 4.5 |
| 10 | 1 | 3 | 53.3 | 21.6 | 9.9 | 4.7 | 12.1 | 20.6 | 4.2 | 5.4 | 2.0 |
| 10 | 5 | 8 | 53.5 | 44.6 | 13.0 | 7.3 | 22.6 | 38.6 | 17.3 | 19.0 | 3.9 |
| 10 | 25 | 10 | 54.1 | 54.4 | 22.5 | 16.6 | 62.9 | 103.3 | 79.2 | 83.0 | 11.3 |
| 50 | 1 | 12 | 266.5 | 94.0 | 48.5 | 21.3 | 57.9 | 95.2 | 14.6 | 17.7 | 3.9 |
| 50 | 5 | 41 | 267.1 | 227.5 | 66.6 | 36.6 | 99.7 | 169.3 | 66.9 | 71.7 | 10.6 |
| 50 | 25 | 50 | 269.8 | 271.4 | 102.7 | 71.6 | 269.3 | 441.6 | 311.4 | 324.2 | 40.6 |
| 100 | 1 | 16 | 532.9 | 151.3 | 90.2 | 36.0 | 108.5 | 175.9 | 19.8 | 25.1 | 5.1 |
| 100 | 5 | 69 | 534.0 | 395.2 | 126.1 | 66.9 | 185.8 | 312.9 | 115.8 | 124.2 | 16.6 |
| 100 | 25 | 100 | 539.5 | 542.7 | 201.7 | 139.2 | 519.1 | 851.8 | 596.5 | 620.6 | 75.7 |

### Bytes as a fraction of GET (full)

| N | L | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 100.6% | 34.8% | 31.3% | 34.7% | 73.0% | 35.7% | 50.5% | 27.0% |
| 1 | 5 | 100.6% | 37.0% | 33.0% | 95.6% | 169.8% | 116.1% | 133.5% | 40.6% |
| 1 | 25 | 100.6% | 77.8% | 74.0% | 300.9% | 496.2% | 503.7% | 533.6% | 81.5% |
| 10 | 1 | 40.4% | 18.5% | 8.8% | 22.8% | 38.7% | 7.9% | 10.2% | 3.7% |
| 10 | 5 | 83.5% | 24.4% | 13.7% | 42.3% | 72.2% | 32.4% | 35.5% | 7.3% |
| 10 | 25 | 100.6% | 41.5% | 30.7% | 116.2% | 190.9% | 146.5% | 153.3% | 20.8% |
| 50 | 1 | 35.3% | 18.2% | 8.0% | 21.7% | 35.7% | 5.5% | 6.6% | 1.5% |
| 50 | 5 | 85.2% | 24.9% | 13.7% | 37.3% | 63.4% | 25.0% | 26.9% | 4.0% |
| 50 | 25 | 100.6% | 38.1% | 26.5% | 99.8% | 163.7% | 115.4% | 120.2% | 15.1% |
| 100 | 1 | 28.4% | 16.9% | 6.8% | 20.4% | 33.0% | 3.7% | 4.7% | 1.0% |
| 100 | 5 | 74.0% | 23.6% | 12.5% | 34.8% | 58.6% | 21.7% | 23.3% | 3.1% |
| 100 | 25 | 100.6% | 37.4% | 25.8% | 96.2% | 157.9% | 110.6% | 115.0% | 14.0% |

### Wall time (ms, simulated 40 ms RTT)

| N | L | GET (full) | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 83 | 84 | 82 | 84 | 84 | 86 | 83 | 85 | 82 |
| 1 | 5 | 83 | 83 | 84 | 84 | 84 | 87 | 83 | 85 | 82 |
| 1 | 25 | 83 | 82 | 83 | 84 | 86 | 88 | 86 | 92 | 83 |
| 10 | 1 | 136 | 128 | 129 | 87 | 89 | 94 | 85 | 89 | 84 |
| 10 | 5 | 131 | 134 | 133 | 92 | 92 | 99 | 88 | 91 | 86 |
| 10 | 25 | 134 | 137 | 138 | 96 | 96 | 115 | 93 | 99 | 90 |
| 50 | 1 | 442 | 429 | 425 | 97 | 107 | 115 | 91 | 96 | 92 |
| 50 | 5 | 459 | 451 | 445 | 108 | 107 | 128 | 99 | 108 | 97 |
| 50 | 25 | 461 | 466 | 460 | 115 | 112 | 143 | 117 | 133 | 102 |
| 100 | 1 | 835 | 778 | 767 | 108 | 108 | 127 | 94 | 99 | 97 |
| 100 | 5 | 829 | 804 | 790 | 114 | 115 | 149 | 104 | 114 | 103 |
| 100 | 25 | 822 | 831 | 830 | 216 | 127 | 179 | 135 | 194 | 107 |

### Requests / TCP connections opened

Connections matter because the byte counts above exclude TCP and TLS handshakes; under TLS each new connection adds a handshake of several kilobytes.

| N | GET (full) | GET + ETag | Braid model H1 | Braid model H2 | Braid real | Braid real mux | Mercure model | Mercure real | SYNC |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 | 2 / 2 | 1 / 1 | 1 / 1 | 1 / 1 |
| 10 | 10 / 6 | 10 / 6 | 10 / 6 | 10 / 1 | 10 / 10 | 11 / 11 | 1 / 1 | 1 / 1 | 1 / 1 |
| 50 | 50 / 6 | 50 / 6 | 50 / 6 | 50 / 1 | 50 / 50 | 51 / 51 | 1 / 1 | 1 / 1 | 1 / 1 |
| 100 | 100 / 6 | 100 / 6 | 100 / 6 | 100 / 1 | 100 / 100 | 101 / 101 | 1 / 1 | 1 / 1 | 1 / 1 |

