# IETF httpbis Mailing List Post

**To:** ietf-http-wg@w3.org
**Subject:** [httpbis] Proposal: SYNC — a new HTTP method for delta state synchronization

---

All,

I'd like to raise a proposal for a new HTTP method: SYNC.

**The problem.** HTTP's existing methods do not allow a client to declare its current resource state and receive only the changes since that state. GET returns the full resource. Conditional GET (ETags + `If-None-Match`) is binary — either the full resource or nothing. RFC 3229 attempted delta encoding but the server chose the diff baseline, not the client, and it was essentially never deployed. WebSockets solve the real-time push problem but require a protocol upgrade and impose persistent connection semantics that are incompatible with REST architecture. For the common case — a client with prior state that needs to synchronize periodically — none of these is adequate.

**What SYNC does.** A SYNC request carries a *version vector* in its body: a JSON object mapping resource identifiers to version tokens. The server computes the JSON Patch (RFC 6902) delta from each declared version to current state and returns it. If the client is already current, the server returns `204 No Content`.

```http
SYNC /api/data HTTP/1.1
Content-Type: application/sync-vector+json

{
  "version_vector": { "/users": "v42", "/posts": "v18" },
  "resources": ["/users", "/posts"]
}
```

SYNC is safe (no server mutation) and idempotent. It fits the standard HTTP request-response model and requires no protocol upgrade.

**Why existing methods fall short.**

- GET: returns full resource every time regardless of prior client state.
- Conditional GET: binary; no delta encoding.
- RFC 3229: server-chosen baseline, not client-declared; no significant adoption.
- WebSockets/SSE: protocol switch; inappropriate for periodic pull-based sync.

**Implementation and spec.** A reference implementation is available at https://github.com/Meet-1010/sync-http-method — Node.js server and client, 21 passing tests. A full Internet-Draft following RFC 7841 conventions is at spec/SYNC-method-draft.md in the repository.

**Benchmark result.** In a simulation with a 100-item JSON feed at a 3% per-cycle change rate over 50 rounds, SYNC transferred 22.5 KB versus 509.3 KB for GET polling — a 96% bandwidth reduction. Details at benchmarks/results.md.

**Ask.** Looking for feedback on whether this fits the scope of httpbis and whether an Internet-Draft submission under the name `draft-chauhan-httpbis-sync-method` would be appropriate. Also interested in whether the working group sees unresolved design questions that should be addressed before submission — particularly around version token format normalization and behavior under HTTP/2 and HTTP/3.

Thanks,
Meet Chauhan
