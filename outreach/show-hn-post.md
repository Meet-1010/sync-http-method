# Show HN Post

**Title:** Show HN: SYNC – a new HTTP method for delta state sync

---

Every time a client needs to update its local state from a server, it faces the same bad choices: GET the full resource again (wasteful), set up WebSockets (protocol switch, stateful, not REST-compatible), or use some proprietary delta token your API invented (not portable, not standard).

HTTP has had this gap since 1.0. No standard method lets a client say: "I know my state. Send me only what changed." Here's what the three existing approaches look like on the wire versus what SYNC does:

```
# GET + ETag — binary all-or-nothing
Client: "Send /users if changed since ETag abc"
Server: "Changed? Here's all 10,000 rows. Not changed? 304."

# RFC 3229 — server chooses the diff baseline (and nobody implemented it)
Client: "Send me a delta if you can"
Server: "Here's a diff from some version I picked"

# SYNC — client declares exact state, server returns minimal delta
Client: "I am at { /users: v42, /posts: v18, /config: v7 }"
Server: "Here's exactly what changed since each of those — nothing more"
```

I built a reference implementation and wrote up a formal Internet-Draft.

**What's in the repo:**
- Node.js server (raw TCP `net.createServer` to bypass the llhttp method whitelist)
- Client library with version vector tracking
- 21 passing tests
- Bandwidth benchmark: 96% reduction vs GET polling on a 100-item feed with 3% change rate
- IETF Internet-Draft spec (spec/SYNC-method-draft.md)
- Security analysis (spec/SECURITY-ANALYSIS.md)

The `net.createServer` part is the interesting implementation detail — Node's HTTP parser rejects unknown methods before they reach Express, so you have to intercept at the TCP layer, buffer the bytes, detect the method string in the first line, and route accordingly.

https://github.com/Meet-1010/sync-http-method

Curious if others have hit this gap in their own work, and whether the IETF angle is worth pursuing.
