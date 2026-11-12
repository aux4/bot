#### Description

`provider` is the validated dynamic-subcommand dispatch every queue
operation (`ingest`'s send, `pull`'s lease/ack/nack/renew) routes through
to reach the configured queue backend (`queue.command`). It is internal —
not meant to be called directly — but documented here because it is the
**single place** the queue-provider allowlist lives.

`aux4 bot provider <command> <op> ...` resolves `<command>` to an internal
profile (`bot:provider:<command>`): an unlisted `<command>` simply fails to
resolve ("Command not found") instead of running arbitrary config text as
a shell command. Today's allowlist:

- **`queue`** (default) — dispatches to `aux4 queue <op> ...`.
- **`queue-sqs`** — placeholder for aux4/queue-sqs (BOT-017); allowlisted
  and dispatches correctly, but its leaf commands are not implemented yet
  and return a clear "not implemented" error.

Adding a third backend only ever means adding one leaf profile
(`bot:provider:<name>` in `package/.aux4`) with the same five operations
below — no other bot code changes, and `lib/provider.js`'s `callProvider`
helper (used by both `ingest` and `pull`) never changes either.

Each provider leaf implements exactly these five operations, with the same
flag names regardless of backend:

- **`send`** — enqueue a message (body via stdin)
- **`lease`** — lease the next eligible message
- **`renew`** — extend a still-live lease (heartbeat)
- **`ack`** — acknowledge (complete) a leased message
- **`nack`** — release a leased message for immediate redelivery

#### Usage

```bash
aux4 bot provider <command> <op> --name <queue-name> --storage <memory|repository> ...
```

--command   The provider key (`queue` or `queue-sqs`), from `queue.command`

See `aux4 queue lease`/`renew`/`ack`/`nack`/`send` for the per-operation
flags — the `queue` provider forwards them unchanged.

#### Example

```bash
aux4 bot provider queue lease --name bot-inbox --storage memory --port 8420 --visibility 30
```

```text
{"id":"msg-1","leaseId":"lease-1","group":"","attempts":0,"body":{"channel":"echo","botId":"support","event":{...}}}
```

An unlisted provider key fails closed:

```bash
aux4 bot provider sqs-typo lease --name bot-inbox
```

```text
Command not found
```
