# Release Notes

## 0.2.9

- **`db: "cloud"` works for bot state and `--provider repository`'s queue
  `db`.** The literal value `cloud` resolves to the Turso database the
  aux4.cloud `turso:database` capability already provides to this machine
  (via `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`), exactly the value
  aux4/repository's own `--db` now accepts. No code change in this package
  — `db` was already forwarded as-is to `aux4 repository`/`aux4 queue`.

## 0.2.7

Fixes two regressions in the 0.2.6 renew heartbeat that made sqs/cloud leases
expire mid-run and stalled dead-lettering.

- **Fixed cadence.** The next renew is scheduled from the start of the
  previous one, not its end. A renew on sqs/cloud can take seconds, so
  waiting a full interval after it finished stretched the gap past the
  lease's own visibility and let a second worker take the message.
- **No renew after ack/nack.** `stop()` now waits for a renew that is already
  running before the worker acks or nacks. A late renew used to re-hide a
  just-nacked sqs message, delaying its retry and its move to the DLQ.

## 0.2.6

Fixes the lease-renew heartbeat occasionally missing its window on a short
`queue.visibility`, which could redeliver a still-processing message to a
second worker mid-run.

- **Immediate first renew.** `startRenewHeartbeat` now renews right after
  the lease is acquired, not only after waiting out a full interval — the
  gap between leasing a message and the first renew is never a full
  interval wide.
- **Quick retry on a failed renew.** A renew that fails is retried quickly
  (up to 3 times, about a second apart) instead of waiting for the next
  normal interval, which on a short visibility was most of the way to
  losing the lease outright.
- **Documented minimum visibility.** `queue.visibility` below ~10 seconds
  logs a warning — every renew spawns a process (and, for `--provider
  sqs`/`cloud`, a further dispatcher + provider + `aws` CLI chain
  underneath it), so a very short visibility leaves little margin for a
  slow renew under load. The configured value is never silently changed.
- Added `test/worker-renew-heartbeat.test.js` (`node --test`), proving the
  first renew fires before any interval could have elapsed and that a
  failed renew retries quickly. All 47 `.test.md` integration tests
  (including the existing long-running-brain renew scenario) pass
  unmodified.

## 0.2.5

BOT-012 part B: persistent message log, ad hoc sends, keep-alive typing +
progressMessage, a per-bot `onMessage` hook, and empty-brain-output = no
reply.

- **Persistent message log.** Every inbound and outbound message is
  written to a `messages` repository table in the same `--db` as the rest
  of the bot's state. Retention is per-bot: `bot.messageLogTtl` (default
  2592000s / 30 days; `"off"` disables logging for that bot). Browse it
  with two new read-only commands: `aux4 bot conversations <botId>`
  (recent chats: chatId, user, last message, time) and `aux4 bot messages
  <botId> --chat <chatId>` (full history, both directions, oldest first).
  Expired entries are swept by `aux4 bot clean`, same as every other table.
- **`aux4 bot send <botId> --to <chatId> --text <text>`** — an ad hoc,
  proactive message, not tied to an inbound event. Formats + sends through
  the bot's own channel plugin (channel resolved from `bots.<botId>.channel`
  — only `botId` is positional, since aux4 core does not reliably bind two
  positional `arg: true` variables on one command), logs as outbound on
  success. A plugin may refuse (returning `{ok:false, error}`, e.g.
  WhatsApp outside its 24h free-form session window — see aux4/bot-meta)
  instead of sending; `send` fails loudly (stderr + exit 1) on a refusal or
  a send error, unlike the worker's own best-effort reply send.
- **Empty brain output = no reply.** If the brain's answer is empty or
  whitespace-only, nothing is sent — the message still acks normally, and
  the attempt is logged as a `no-reply` entry instead of a sent message.
- **Per-bot `onMessage` hook.** `bot.onMessage`, when set, is a command run
  for every inbound message (the message JSON on stdin), independent of the
  reply — fire-and-forget, never awaited on the reply's critical path, so
  its failure never blocks or delays the reply.
- **Keep-alive typing + optional progressMessage.** While the brain runs,
  the plugin's `typing` indicator is re-raised every `bot.typingInterval`
  seconds (default 20; `0` disables). If `bot.progressMessage` is set, it
  is sent once (and logged) after `bot.progressMessageDelay` seconds
  (default 15) if the brain is still running by then.
- `brainTimeout` stays optional and unset by default (unbounded) — no
  change from BOT-012A/REWORK; explicitly re-verified as part of this item.

## 0.2.2

BOT-012 (REWORK of BOT-012A): removes the remaining shell scripting from
`package/.aux4`, restores `failureMessage`, adds the lease-renew heartbeat,
and makes a work queue's `--webhook` push retry-safe (all via BOT-011's
aux4/queue 0.2.3 + aux4/repository 1.3.9).

- **No shell scripting left in `package/.aux4`.** The `if [ "${queue.command}"
  = ... ]; then ... fi` validation (ingest, work-pull) and the `[ -z ... ]
  && ... || ...` ack/nack branch (work-pull) are gone, replaced by a
  validated dynamic-subcommand dispatch: `aux4 bot provider value(queue.command)
  <op> ...`, routing to a new `bot:provider:queue` (and placeholder
  `bot:provider:queue-sqs`, ready for BOT-017) profile. An unlisted
  `queue.command` key now fails closed ("Command not found") instead of a
  custom shell error message — and that allowlist lives in exactly ONE
  place (the two leaf profiles), not duplicated in a separate JS array.
  `lib/ingest.js`'s own `ALLOWED_QUEUE_COMMANDS` check is gone for the same
  reason — `sendOne` now dispatches through the same `aux4 bot provider`
  path (`lib/provider.js`) as everything else.
- **`queue.command`'s value changed from a full command string (`"aux4
  queue"`) to a short provider key (`"queue"`).** Existing configs must
  update this one field; everything else is unchanged. This is a breaking
  config-shape change (no backward-compat guarantee on this field, unlike
  `aux4/todo`).
- **Restored the `failureMessage` reply.** When a message's final nack
  would dead-letter it (`attempts + 1 >= queue.maxAttempts`), and the bot
  has `failureMessage` configured, it is sent to the chat (best-effort)
  before the nack — so the user gets an apology instead of silence right
  before the message is dead-lettered.
- **Added a lease-renew heartbeat.** While the brain runs, `pull` (the
  renamed `work-pull`) periodically calls the new `aux4 queue renew`
  primitive (every half of `queue.visibility`) to extend the lease, so a
  brain that legitimately runs longer than `queue.visibility` is no longer
  redelivered to a second worker mid-run. This closes the "Known gap" from
  0.2.0.
- **A work queue's `--webhook` push is now retry-safe**, for free, via
  aux4/queue 0.2.3 (BOT-011): it pushes through lease/ack/nack instead of
  fire-and-forget, so a failing push is retried and eventually dead-lettered
  instead of silently dropped. The pub/sub (non-work) webhook caveat from
  0.2.0 is unchanged and still applies to a plain pub/sub queue.
- **`--storage repository` queue names may contain a dash or a dot now**
  (`bot-inbox`, `bot.inbox`) — the 0.2.0 "Known limitation" about SQL
  identifiers is resolved in aux4/queue 0.2.3, not worked around in bot code.
- The ack/nack decision, the empty-lease check, and the renew heartbeat all
  moved into `lib/worker.js`'s `workPullProcess` (not `package/.aux4`):
  aux4's own templating cannot safely branch on a value that may be empty,
  the same limitation that already justified `ingestSend`'s per-item send
  loop staying in JS since 0.1.1.
- Bumped `aux4/queue@>=0.2.3` dependency pin.
- 4 new tests (failureMessage, long-running-brain-renew-prevents-redelivery,
  2 push-mode retry-safety tests); all 25 previously-shipped tests pass
  unmodified (29/29 total). `aux4 lint run --strict true` clean; `grep -nE
  'if \[|\[ -z|\[ -n|then |; fi|\$\(|case ' package/.aux4` returns nothing.

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
