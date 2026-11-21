#### Description

Process eligible queued messages through the canonical bot worker, retrying lease
errors and nacked work with bounded exponential backoff. The queue still owns
visibility, attempt counts and dead-letter eligibility. Existing callback and
reply deduplication remain active on every attempt.

Use `--expected` with the `enqueued` field returned by `bot ingest`. A new message
is retried even when the first lease unexpectedly finds nothing. Status-only or
duplicate webhooks with no new work can exit immediately on an empty queue.

An exhausted retry, time or message budget exits nonzero with a summary. The time
budget stops new attempts; it does not cancel an in-flight model call. This command
does not schedule another invocation after the process or VM terminates.

#### Usage

```bash
aux4 bot retry-work --configFile config.yaml --config bot --expected 1
```

The normal `channels`, `bots`, `defaults`, `db`, `tmpDir` and `queue` options match
`bot work`. Retry options are `expected` (0), `attempts` (6 consecutive misses or
failures), `delay` (1000 ms), `maxDelay` (15000 ms), `budget` (240000 ms before
starting more attempts), and `maxMessages` (100).

#### Example

```bash
aux4 bot retry-work --configFile config.yaml --config bot --expected 1
```

```json
{"processed":1,"attempts":3,"retries":1,"failed":0,"exhausted":false,"reason":"empty"}
```
