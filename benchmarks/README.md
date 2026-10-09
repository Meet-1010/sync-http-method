# Benchmarks

Five benchmarks. Each checks every client's final state against the server's, so a run that reports numbers is also a correctness test.

| Script | Question | Results |
|---|---|---|
| `comparative.js` (`npm run bench`) | How many bytes, requests and round trips does one client need to catch up N stale resources after L rounds of change? | [`comparative-results.md`](comparative-results.md) |
| `consistency.js` (`npm run bench:consistency`) | Can a client that reads several related resources end up with a combination that never existed on the server (a torn read)? | [`consistency-results.md`](consistency-results.md) |
| `storm.js` (`npm run bench:storm`) | When many clients reconnect at once, what reaches the origin through a shared cache (a CDN edge)? | [`storm-results.md`](storm-results.md), [`storm-results-k500.md`](storm-results-k500.md) |
| `live.js` (`npm run bench:live`) | When many clients keep many resources current while the server commits transactions, what does it cost the origin, how soon does each client hold each transaction, and does any client see a state that never existed? | [`live-results.md`](live-results.md) |
| `writes.js` (`npm run bench:writes`) | When writers change related resources, or one document, concurrently, how many changes go through, how many are retried, and are any lost or seen half done? | [`writes-results.md`](writes-results.md) |

Each script also writes a `.json` file with the raw numbers next to its `.md` report. Everything runs on one machine, over loopback with an emulated 40 ms round trip, so times show the relative cost of each approach, not production latency.

## Comparative

One catch-up exchange: a client holding N stale resources brings them current after L rounds of server-side change. It compares SYNC with full GET, conditional GET, the real `braid-http` library, the real Mercure hub, and simple models of both. Every run goes through a TCP proxy that counts bytes and connections and adds a 40 ms round trip. All delta protocols except real Braid use the same update generator (the smaller of a JSON Patch and a JSON Merge Patch, or the full document); real Braid uses its own range patches.

The caveats at the top of the results file matter: real Braid and Mercure run in their default configurations (no response compression), Braid's Node client runs over HTTP/1.1 here, and byte counts exclude TCP and TLS handshakes (connection counts are reported separately for that reason). A run takes about four minutes.

## Consistency

A writer commits one transaction every 5 ms that changes `/users`, `/posts` and `/counts` together. Clients read the three resources 300 times per approach and check two invariants that hold in every committed state. Two scenarios: fixed delays (the most favourable case for separate requests) and realistic variation in network and store timing (seeded, so runs are reproducible). Every approach reuses its connections. Rates come with 95% Wilson confidence intervals. No Docker needed; a run takes about four minutes.

## Reconnect storm

K clients (100 by default) reconnect within one second of each other and catch up 50 resources through nginx 1.27 configured as a shared cache, in two scenarios: every client in the same state (as after an outage), and clients that went offline at different times. Approaches: cacheable GET, cacheable Braid, SYNC inline, SYNC with links, SYNC with shared results (303), SYNC with next URIs (each with and without links), and the Mercure hub.

Every variant runs in its own client process with a fresh origin process and an empty cache, and the latency proxies run in their own processes. Before each variant the script waits until earlier connections have released their ports on the machine and inside the Docker host, so a run takes about 10 minutes. For 500 clients, spread arrivals so that connection bursts fit the operating system's accept queue (about 25 minutes):

```bash
K=500 WINDOW_MS=5000 npm run bench:storm
```

## Live updates

K clients (100 by default) keep 50 resources current while the server commits 10 transactions, each changing several resources together, in two scenarios: every client watches all resources, and each client watches 10 of them. Approaches: SYNC watches (inline, and with each large event as a link to a shared result served through Varnish 7.6 as a shared cache), braid-http subscriptions (multiplexed), and the Mercure hub (one event per changed resource, and one event per transaction). After every update a client applies, its view is checked against the committed states. A run takes about 15 minutes.

## Concurrent writes

Writers transfer units between 20 accounts while readers check the total (plain HTTP with two conditional PUTs and an undo on failure, against one SYNC atomic write), and writers edit one text document concurrently (plain HTTP with If-Match, plain HTTP without a condition, and SYNC with merging). No Docker needed; a run takes about two minutes.

## Docker

The storm and live benchmarks need Docker: nginx (`nginx:1.27-alpine`) and Varnish (`varnish:7.6`) as shared caches, and the Mercure hub for the Mercure rows. On macOS with colima, the repository must be under your home directory so the generated cache configurations can be mounted.

Without a Mercure hub the Mercure rows are skipped with a warning. To include them, start the hub first:

```bash
docker run -d --name sync-bench-mercure -p 127.0.0.1:3480:80 -e SERVER_NAME=':80' -e GLOBAL_OPTIONS='auto_https off' -e MERCURE_PUBLISHER_JWT_KEY='bench-publisher-secret-key-0123456789abcdef' -e MERCURE_SUBSCRIBER_JWT_KEY='bench-subscriber-secret-key-0123456789abcdef' -e MERCURE_EXTRA_DIRECTIVES='anonymous' dunglas/mercure
```

These keys are for local benchmarking only. A different hub URL or keys can be passed with `MERCURE_URL`, `MERCURE_PUBLISHER_KEY` and `MERCURE_SUBSCRIBER_KEY`. Stop the hub afterwards:

```bash
docker rm -f sync-bench-mercure
```

## Running

```bash
npm install
npm run bench
npm run bench:consistency
npm run bench:storm
npm run bench:live
npm run bench:writes
```

Run them one at a time on an otherwise idle machine: they measure time, and the clients, proxies and servers share the machine.
