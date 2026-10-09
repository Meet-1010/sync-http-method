# Benchmarks

Three benchmarks. Each one checks every client's final state against the server's, so a run that reports numbers is also a correctness test.

| Script | Question | Results |
|---|---|---|
| `comparative.js` (`npm run bench`) | How many bytes, requests and round trips does one client need to catch up N stale resources after L rounds of change? | [`comparative-results.md`](comparative-results.md) |
| `consistency.js` (`npm run bench:consistency`) | Can a client that reads several related resources end up with a combination that never existed on the server (a torn read)? | [`consistency-results.md`](consistency-results.md) |
| `storm.js` (`npm run bench:storm`) | When many clients reconnect at once, what reaches the origin through a shared cache (a CDN edge)? | [`storm-results.md`](storm-results.md) |

Each script also writes a `.json` file with the raw numbers next to its `.md` report.

## Comparative

One catch-up exchange: a client holding N stale resources brings them current after L rounds of server-side change. It compares SYNC with full GET, conditional GET, the real `braid-http` library, the real Mercure hub, and simple models of both. Every run goes through a TCP proxy that counts bytes and connections and adds a 40 ms round trip.

The caveats at the top of the results file matter: real Braid and Mercure run in their default configurations (no response compression), Braid's Node client runs over HTTP/1.1 here, and byte counts exclude TCP and TLS handshakes (connection counts are reported separately for that reason). A full run takes about four minutes.

## Consistency

A writer commits one transaction every 5 ms that changes `/users`, `/posts` and `/counts` together. Clients read the three resources 300 times per approach and check two invariants that hold in every committed state. Two scenarios: fixed delays (the most favourable case for separate requests) and realistic variation in network and store timing (seeded, so runs are reproducible). Every approach reuses its connections. Rates come with 95% Wilson confidence intervals. No Docker needed; a run takes about four minutes.

## Reconnect storm

K clients (100 by default) reconnect within one second of each other and catch up 50 resources through nginx 1.27 configured as a shared cache, in two scenarios: every client in the same state (as after an outage), and clients that went offline at different times. Approaches: cacheable GET, cacheable Braid, SYNC inline, SYNC with links, SYNC with shared results (303), both together, and the Mercure hub. The report gives, per approach, the requests, bytes and CPU time at the origin, and the requests, bytes and times at the clients ([`storm-results.md`](storm-results.md)).

Every variant runs in its own client process with a fresh origin process and an empty cache, and the latency proxies run in their own processes. Before each variant the script waits until earlier connections have released their ports on the machine and inside the Docker host, so a full run takes about 10 minutes. For 500 clients, spread arrivals so that connection bursts fit the operating system's accept queue (about 25 minutes; results in [`storm-results-k500.md`](storm-results-k500.md)):

```bash
K=500 WINDOW_MS=5000 npm run bench:storm
```

This benchmark needs Docker for nginx (`nginx:1.27-alpine`) and, for the Mercure rows, the hub below. On macOS with colima, the repository must be under your home directory so the generated nginx configuration can be mounted.

## Mercure hub

Without a Mercure hub the Mercure rows are skipped with a warning. To include them, start the hub with Docker first:

```bash
docker run -d --name sync-bench-mercure -p 127.0.0.1:3480:80 -e SERVER_NAME=':80' -e GLOBAL_OPTIONS='auto_https off' -e MERCURE_PUBLISHER_JWT_KEY='bench-publisher-secret-key-0123456789abcdef' -e MERCURE_SUBSCRIBER_JWT_KEY='bench-subscriber-secret-key-0123456789abcdef' -e MERCURE_EXTRA_DIRECTIVES='anonymous' dunglas/mercure
```

These keys are for local benchmarking only. A different hub URL or keys can be passed with `MERCURE_URL`, `MERCURE_PUBLISHER_KEY` and `MERCURE_SUBSCRIBER_KEY`.

Stop the hub afterwards:

```bash
docker rm -f sync-bench-mercure
```

## Running

```bash
npm install
npm run bench
npm run bench:consistency
npm run bench:storm
```

Run them one at a time on an otherwise idle machine: they measure time, and the clients, proxies and servers share the machine.
