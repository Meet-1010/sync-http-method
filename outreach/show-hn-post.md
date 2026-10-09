# Show HN Post

**Title:** Show HN: SYNC – one HTTP request to catch up many resources, per-resource results

---

If a client holds copies of several resources and needs to bring them current, HTTP gives you two standard options: GET everything again, or conditional GET, which returns the whole resource if any byte changed. Everything finer-grained is a custom API.

There is good prior work in this area, and I want to be upfront about it. Braid-HTTP lets a GET carry a `Parents` header and returns updates since that version, for one resource. Mercure and Events Query push updates over long-lived connections. JMAP has `/changes` with state tokens inside its own protocol. SYNC is a small proposal for one narrow slice: a stateless pull that names many resources in one request and returns an independent result for each.

```
SYNC /api HTTP/1.1
{"baselines": {"/users": "v42", "/posts": "v18", "/config": null},
 "accept": ["application/merge-patch+json", "application/json-patch+json"]}

-> /users: patch   /posts: 304   /config: snapshot   /gone: 404
```

A stale token for one resource doesn't fail the others, and the server falls back to a snapshot when it is smaller than the patch.

I measured it against full GET, conditional GET, and models of Braid-style and Mercure-style catch-up on real sockets with a simulated 40 ms RTT. The honest summary:

- With minimal headers and no compression, SYNC, Braid over HTTP/2, and a Mercure-style replay are within a few percent of each other.
- With realistic request headers and gzip, catching up 100 resources after one round of change took 6.7 KB with SYNC vs 36 KB for per-resource HTTP/2 requests and 90 KB over HTTP/1.1.
- For a single resource there is no consistent advantage.
- Over HTTP/1.1, request count dominates: ~750 ms vs ~100 ms at 100 resources.

The Braid and Mercure servers in the benchmark are my own minimal models of the drafts, not their reference implementations, so treat the comparison accordingly. The reference server (Node) uses a raw `net.createServer` because Node's HTTP parser rejects unknown methods before any middleware runs.

Repo with spec, security analysis, tests, and the benchmark (`npm run bench`): https://github.com/Meet-1010/sync-http-method

Interested in whether it makes more sense as a new method or as a profile of QUERY, and in comparisons against the real Braid and Mercure implementations.
