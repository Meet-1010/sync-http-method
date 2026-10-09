# Concurrent writes

**Run at:** 2026-10-09T15:15:23.050Z on Node v26.8.1

All clients reach the server over a 40 ms round trip.

## Transfers between accounts

10 writers each make 20 transfers of one unit between two of 20 accounts (chosen at random) that start at 1000 each, while 5 readers keep reading every account. Every committed state totals 20000.

| Approach | Transfers per second | Retries | Undone debits | Final total | Reads with a wrong total | Bytes (KB) |
|---|---|---|---|---|---|---|
| HTTP: two PUTs with If-Match, undo on failure | 22.1 | 184 | 120 | 20000 | 220 of 240 (91.7%) | 1705 |
| SYNC: one atomic write of both accounts | 41.5 | 157 | 0 | 20000 | 0 of 490 (0.0%) | 1198 |

## Edits to one text document

10 writers each make 20 edits to one document of about 2.3 KB: each replaces up to 3 characters of the original text at a random place with a unique marker. Edits never touch earlier markers, so an acknowledged edit whose marker is missing from the final document was overwritten.

| Approach | Edits per second | Retries | Acknowledged edits lost | Bytes (KB) |
|---|---|---|---|---|
| HTTP: PUT the whole document with If-Match, retry on 412 | 10.8 | 900 | 0 of 200 | 6240 |
| HTTP: PUT the whole document, last writer wins | 109.1 | 0 | 180 of 200 | 1030 |
| SYNC: splice from the version held, merged by the server | 148.7 | 1 | 0 of 200 | 226 |

## How to read this

- **Transfers**: with separate requests, readers can see one account debited and the other not yet credited, and when the second write fails the first has to be undone by yet another request. An atomic write changes both or neither, and consistent reads see only committed states.
- **Edits**: a conditional PUT of the whole document fails whenever another writer got in first, and the whole document travels each time; without a condition, concurrent edits overwrite each other. SYNC sends only the edit and the server merges edits to different places; only edits that overlap are retried.
- Braid's merge types (for example braid-text) also merge concurrent text edits without retries; this benchmark compares SYNC with plain HTTP.
