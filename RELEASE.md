# Release Notes

## 0.2.0

BOT-012A: durable work-queue delivery (replaces pub/sub), per-chat
serialization, single-message/push unit, both aux4/queue storage modes.

- **Replaced pub/sub with aux4/queue's durable work-queue mode.** `ingest`
  now claims the dedupe id and then composes `<queue.command> send --group
  <chatId>` in `package/.aux4` (not a JS subprocess wrapper — `lib/queue.js`
  is gone). Removed `aux4/queue@>=0.2.2` pub/sub-only usage.
- **New `aux4 bot work`** — processes exactly one message and exits.
  `--mode pull` (default) self-leases from the queue and acks on success /
  nacks on a brain failure (no more in-process retry/backoff — aux4/queue's
  own `attempts`/`maxAttempts` drive redelivery and dead-lettering).
  `--mode push` is the new `POST /bot/work` route: processes a message
  given directly in the request body, no lease (fed by e.g. aux4/queue's
  pub/sub `--webhook` proxy — fire-and-forget as of 0.2.2, no retry on that
  path yet).
- **`aux4 bot worker`** is now a loop around `work --mode pull`, not a
  persistent pub/sub `receive` stream.
- **Per-chat serialization** comes from aux4/queue's own `--group`
  exclusivity (set from `chatId`/`threadId` on send) — true regardless of
  how many workers are running.
- **New `bot.queue` config**: `{command, name, storage, db, visibility,
  maxAttempts, port, token}`. `storage: memory|repository` and `command`
  (default `aux4 queue`, allowlisted — `aux4 queue-sqs` is the other
  planned option) are forwarded straight through; bot code never branches
  on which one is configured. Tested against both storage modes.
- **`brainTimeout` is now unset by default** (unbounded) instead of
  120000ms, since a long-running brain is no longer bounded by an
  in-process retry loop. `brainRetries`/`failureMessage` are no longer
  used — see README "Known limitations".
- Known limitation: `queue.name` must be a valid SQL identifier
  (alphanumeric/underscore) when `storage: repository` — a dot or dash
  fails with a SQL syntax error (aux4/queue does not quote the generated
  table name). No bot code works around this; use e.g. `bot_inbox`.
- Known gap: no lease-renew/heartbeat primitive exists in aux4/queue yet, so
  a self-leased message can be redelivered while a slow brain is still
  running on the original lease — tracked separately as a follow-up for
  aux4/queue.
- Bumped `aux4/queue@>=0.2.2` dependency pin.

## 0.1.1

Review follow-ups from the BOT-003 dev review.

- **Fix: at-least-once enqueue.** `ingest` claims an event's dedupe id before
  enqueuing it onto `aux4/queue`. Previously, if the enqueue call failed
  (queue not running, no worker subscribed at that instant), the claim stayed
  — marking the event "seen" — while the webhook still acked `200`, so the
  platform never retried and the message was silently lost. `ingest` now
  releases the claim (deletes the dedupe record) on enqueue failure and acks
  `502` so the platform redelivers; the worker's reply-once guard still
  prevents a double reply on that redelivery.
- **Fix: `aux4 queue send` failure detection.** `aux4 queue send` always
  exits `0` and reports success/failure in its JSON stdout
  (`{"errors":N,"sent":N}`), including when the target port has nothing
  listening. `lib/queue.js`'s `sendMessage` now parses that output and
  rejects on a non-zero `errors` count — without this, ingest's
  claim-before-enqueue fix above could never detect the failure it exists to
  handle.
- Pinned `aux4/api@>=2.1.12` (byte-exact `event.rawBody`, required for HMAC
  signature verification) and `aux4/repository@>=1.3.4` (`repository claim`,
  the atomic dedupe/reply-once primitive) as explicit dependencies.
- README: removed a duplicated `## Configuration` section.

## 0.1.0

Initial release — generic multi-channel chatbot core: `GET`/`POST`
`/{channel}/{bot}/webhook` (verify → claim-dedupe → enqueue → ack) and
`aux4 bot worker` (typing → conversation state → brain → reply-once guard →
plugin send), plus `aux4 bot clean`. Channel plugins (WhatsApp, Slack, etc.)
extend the `bot` profile; ships with an in-repo `echo` reference plugin as
the end-to-end test fixture.
