# Proposed Security Considerations for draft-toomim-httpbis-versions

Offered as a contribution to Section 10 of `draft-toomim-httpbis-versions-04`, which currently reads "XXX Todo". Section numbers below refer to that draft. Written to be dropped in and edited freely.

---

## 10. Security Considerations

### 10.1. Information Disclosed by Version IDs

Event IDs are visible to every party that sees a request or response, including intermediaries and, in browsers, page scripts. Depending on the Version-Type they can disclose more than the resource state:

- With the `peer-counter` Version-Type (Section 3.1), an ID of the form `<peer>-<counter>` reveals which peer made a change and how many events that peer has created. Observed over time, this reveals per-peer activity and editing volume, and can link activity across resources that share a peer ID.
- Time-ordered or sequential IDs reveal when changes occurred and how many occurred between two observations.
- A version that is a set of IDs (Section 2.1.2) reveals the shape of concurrent activity, including which peers were editing in parallel.

Deployments for which this matters SHOULD use peer IDs that are not linkable to user identities (for example, per-session random identifiers) and SHOULD treat Version and Parents values with the same confidentiality as the resource itself, including over TLS only.

### 10.2. Probing History with Version Requests

A `GET` carrying a `Version` or `Parents` header (Section 2.4) asks about a specific point in history. The response distinguishes "version exists" from "432 Version Not Found" (Section 2.5), and the `Current-Version` header (Section 2.6) reveals the frontier. A client that is allowed to read the current state may not be entitled to learn the existence, number, or timing of past versions, for example after a redaction.

Servers SHOULD apply the same authorization to historical versions as to current state and SHOULD consider whether history that was deleted or redacted for policy reasons must also stop being acknowledged. With guessable IDs, a prober can enumerate history by trying candidate IDs. Servers that need to resist this SHOULD rate-limit version requests per client. A 432 response and a 404 for an unauthorized resource SHOULD not be distinguishable to an unauthorized client.

### 10.3. Resource Exhaustion

Several mechanisms let a small request cause large work or output:

- A `GET` with an old `Parents` value (Section 2.3.4) can require the server to reconstruct and transmit a long range of history.
- A `Version` or `Parents` header naming a large set of IDs, as can arise for merges, requires set computations over the version DAG and can approach header size limits.
- Updates that reference unknown parents can force a server to retain or request missing history.

Servers SHOULD bound the number of IDs accepted in a `Version` or `Parents` header, the length of history they will reconstruct for one request, and the time spent computing ancestry, and SHOULD answer requests beyond those bounds with an error (or, where the semantics allow, with a snapshot of current state instead of a range of history).

### 10.4. Integrity of Client-Asserted History

In `PUT`, `POST`, and `PATCH` requests the client supplies the `Version` and `Parents` of its update (Section 2.3.3). A server that accepts these values unchecked can be led into an inconsistent history:

- An update can name parents that create a cycle, violating the requirement that no listed version be an ancestor of another, and that time form a DAG (Section 2.2).
- An update can reuse an Event ID that is already in use. With `peer-counter` IDs, a client can mint IDs under another peer's name, impersonating that peer within the history or causing a merge algorithm to discard or overwrite that peer's events.
- An update can name parents that the server has never seen.

Servers MUST verify that a new version's parents are known (or obtain them before applying it), MUST reject updates that would introduce a cycle or an ID collision, and SHOULD bind the peer component of `peer-counter` IDs to the authenticated identity of the client that created them. Where a recipient assigns IDs itself because the request has none (Section 2.1), it MUST ensure their uniqueness.

The fallback rule that a missing `Parents` header MAY be presumed to mean the recipient's current frontier (Section 2.1) can silently convert a stale write into an overwrite of concurrent changes. Servers handling updates from untrusted clients SHOULD require an explicit `Parents` header for writes.

### 10.5. Cache Poisoning through Versioning-Unaware Intermediaries

Section 4.1 describes how a legacy cache that ignores `Version` can store a historical response and later serve it as current. This is not only a correctness hazard but an attack: any party able to send requests through a shared cache can deliberately request an old version of a popular resource, causing the cache to serve stale, possibly superseded or retracted, content to everyone else.

Origin servers SHOULD send `Vary: version, parents` on every response for which the version headers affect the content (Section 4), not only when they believe legacy intermediaries are absent. Responses to requests for historical versions SHOULD additionally carry cache directives that prevent them from being reused as responses to requests without version headers. The client-side superset check of Section 4.1 detects the problem after the fact but does not prevent other clients from receiving the stale content.

### 10.6. Verifiable Version-Types

Some Version-Types promise a relationship between an ID and the content, such as content hashes for `git` (Section 3). A recipient MUST NOT rely on that relationship unless it verifies it, because a sender can label arbitrary content with any ID.

### 10.7. Resumable Uploads

When the `bytestream` modifier is used to resume uploads (Sections 3.1.2 and 5.3), the server learns the byte length of partial uploads and accepts appends at stated offsets. Servers MUST check that an appended range begins exactly at the current length for that version, MUST bound the total size of an upload, and SHOULD expire abandoned partial uploads. Partial uploads SHOULD be readable only by the uploader.
