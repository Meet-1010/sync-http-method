# Show HN Post

**Title:** Show HN: SYNC – catch up many HTTP resources in one QUERY request

---

If a client holds copies of several resources and needs to bring them current, HTTP gives you two standard options: GET everything again, or conditional GET, which re-sends the whole resource if any byte changed. Anything finer-grained is a custom API.

SYNC is a small format for the new HTTP QUERY method (RFC 10008): you send the versions you hold for many resources in one request, and get an independent result per resource (a patch, "unchanged", or the full resource).

```
QUERY /sync
Content-Type: application/sync-baseline+json

{"baselines": {"/users": "v42", "/posts": "v18", "/config": null}}

-> /users: patch   /posts: 304   /config: full   /gone: 404
```

It started as a proposal for a brand-new HTTP method. On the IETF HTTP list, Julian Reschke asked how that differed from QUERY, and the honest answer was "it doesn't", so it is now a QUERY format. That also means it runs on stock Node and in browsers, and QUERY responses are cacheable.

There is good prior work here: Braid-HTTP (per-resource versions, subscriptions, merging), Mercure (pub/sub with replay), Events Query, JMAP. SYNC covers one narrow slice: a stateless pull for many resources at once. I benchmarked it against the real braid-http library and the real Mercure hub, catching up 100 resources after one round of change:

- Minimal headers, no compression: SYNC 21.9 KB, Mercure 23.6 KB, Braid 58.9 KB (100 connections).
- Realistic headers + gzip: SYNC 5.2 KB, Mercure 25.1 KB, Braid 108.5 KB. Part of that is that Braid and Mercure don't compress by default.
- Braid's whole-item patches win when many changes pile up; for a single resource there is no consistent winner.

`npm install sync-http-method` gives you `createSyncClient(url).sync([...])` for the browser or Node and `syncHandler({ store })` for Express or any Node server.

Spec, security analysis, benchmark and paper: https://github.com/Meet-1010/sync-http-method

I'd welcome criticism of the format, and comparisons in browsers and over TLS, which I haven't measured.
