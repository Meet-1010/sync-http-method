# Benchmarks

`comparative.js` measures one catch-up exchange: a client holding N stale resources brings them current after L rounds of server-side change. It compares SYNC with full GET, conditional GET, the real `braid-http` library, the real Mercure hub, and simple models of both. Results are in [`comparative-results.md`](comparative-results.md) (and `.json`).

Every run goes through a TCP proxy that counts bytes and connections and adds a 40 ms RTT, and each client's reconstructed state is checked against the server's.

## Running

```bash
npm install
npm run bench
```

Without a Mercure hub the "Mercure real" column is skipped with a warning. To include it, start the hub with Docker first:

```bash
docker run -d --name sync-bench-mercure -p 127.0.0.1:3480:80 -e SERVER_NAME=':80' -e GLOBAL_OPTIONS='auto_https off' -e MERCURE_PUBLISHER_JWT_KEY='bench-publisher-secret-key-0123456789abcdef' -e MERCURE_SUBSCRIBER_JWT_KEY='bench-subscriber-secret-key-0123456789abcdef' -e MERCURE_EXTRA_DIRECTIVES='anonymous' dunglas/mercure
```

These keys are for local benchmarking only. A different hub URL or keys can be passed with `MERCURE_URL`, `MERCURE_PUBLISHER_KEY` and `MERCURE_SUBSCRIBER_KEY`. A full run takes about 10 minutes.

Stop the hub afterwards:

```bash
docker rm -f sync-bench-mercure
```

## Reading the results

The caveats at the top of the results file matter: real Braid and Mercure run in their default configurations (no response compression), Braid's Node client runs over HTTP/1.1 here, and byte counts exclude TCP and TLS handshakes (connection counts are reported separately for that reason).
