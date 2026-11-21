# aux4/bot

A generic, multi-channel chatbot core for aux4. It owns the always-async webhook
lifecycle — verify, dedupe, enqueue, ack, work, reply — and delegates both the
**platform transport** (verify a signature, send a message, show typing, download
a file, format text) and the **brain** ("answer the question") to pluggable
pieces, so the same core serves WhatsApp, Telegram, Slack, Messenger, or a
custom channel without any core code changes.

- The **brain** is a configured CLI command: `text in -> markdown out` (same
  contract as [aux4/slackbot](https://hub.aux4.io/r/public/packages/aux4/slackbot)).
- The **transport** is a **channel plugin** — an aux4 package (or in-package
  profile) implementing six commands: `verify`, `ingest-parse`, `send`,
  `typing`, `download`, `format`. See [Writing a channel plugin](#writing-a-channel-plugin).

> **Scope — v1:** webhook-only inbound (`GET`/`POST /{channel}/{bot}/webhook`).
> Pull-based sources (Telegram `getUpdates`, Slack Socket Mode) feeding the
> same queue are a later phase. This package ships with one reference/test
> channel, `echo` (a loopback fixture, not a real platform) — a real channel
> (WhatsApp, Telegram, Slack, Messenger) is a separate plugin package.

## Installation

```bash
aux4 aux4 pkger install aux4/bot
```

## Architecture

```text
Platform ─GET/POST /{channel}/{bot}/webhook─▶ aux4/api → aux4 bot verify|ingest
    verify (GET):  resolve {channel}/{bot} (allowlist) · plugin verify (handshake) · ack
    ingest (POST): resolve {channel}/{bot} (allowlist) · plugin verify (HMAC over rawBody)
                   · plugin ingest-parse → normalized events · claim(channel:bot:key) dedupe
                   · aux4 queue send --provider <queue.provider> --group <chatId> · ack 200  < all before any reply is sent
                              │
                     aux4/queue work queue (durable: ack/nack/lease, per-group exclusivity)
                              │
       aux4 bot worker (loop around 'work --mode pull': lease -> process -> ack/nack)
        work: plugin typing → load conversation state → plugin download (attachments)
              → run the bot's brain command → reply-once claim(reply:key)
              → plugin format → plugin send
                (brain failure -> nack -> aux4/queue redelivers; maxAttempts -> dead-lettered)

   Alternatively, 'aux4 bot work --mode push' is the POST /bot/work route handler:
   processes a message given directly in the request body, no lease — e.g. fed by
   aux4/queue's pub/sub --webhook proxy (fire-and-forget today, see "Push mode" below).
```

Every state write — dedupe claims, the reply-once guard, conversation history,
and a plugin's own `installations` bookkeeping — goes through
[aux4/repository](https://hub.aux4.io/r/public/packages/aux4/repository),
local sqlite or a remote Turso/libSQL database via `--db`. The dedupe and
reply-once guards use `aux4 repository claim`, which is **race-free**: two
concurrent deliveries of the same event id can never both win.

Delivery itself goes through [aux4/queue](https://hub.aux4.io/r/public/packages/aux4/queue)'s
**work queue** mode (`create --workQueue true` / repository storage): every
message is leased by exactly one worker at a time, a failed brain nacks for
redelivery, and `queue.maxAttempts` dead-letters a message that keeps
failing. aux4/bot's own code never branches on which provider is configured
— it just forwards `queue.*` straight through to `aux4 queue <op> --provider
value(queue.provider)` (default `memory`; see [Work queue config](#work-queue-config)
below).

A full deployment runs these processes:

1. `aux4 queue start` (memory storage only — repository storage has no server process).
2. `aux4 api start` — serves `GET/POST /{channel}/{bot}/webhook` (and, if configured, `POST /bot/work`) → `aux4 bot verify`/`aux4 bot ingest`/`aux4 bot work`.
3. `aux4 cron start` (optional) — schedules the periodic `aux4 bot clean` TTL sweep.
4. `aux4 bot worker` — leases from the queue and replies.

```bash
aux4 queue start --port 8420
aux4 api start --configFile config.yaml
aux4 bot worker --configFile config.yaml --config bot
```

## Configuration

`config.bot` holds shared infrastructure and defaults at the top level, and
per-bot identity/brain under `bots.<botId>`. The `{channel}` and `{bot}` route
segments select, respectively, the plugin and the entry under `bots`.

```yaml
config:
  # aux4/api routes (one api serves every channel+bot; {channel}/{bot} select the rest)
  api:
    "GET /{channel}/{bot}/webhook":
      command: aux4 bot verify --configFile config.yaml --config bot
      public: true
    "POST /{channel}/{bot}/webhook":
      command: aux4 bot ingest --configFile config.yaml --config bot
      public: true

  bot:
    # shared infrastructure (one api / queue / worker for every channel+bot)
    channels: ["echo"]                 # allowlist — a {channel} path segment not in this list 404s
    db: "./.bot/state.db"               # repository sqlite file, a libsql:// URL, or the literal "cloud" (dedupe + reply-once + conversations + installations)
    tmpDir: "./.bot/tmp"                # worker's attachment download scratch space
    dedupeTtl: 300                      # fallback event-dedupe window (seconds) when a plugin event has no ttl
    queue:                              # work-queue config — see "Work queue config" below
      provider: "memory"
      name: "bot-inbox"
      db: ".bot/queue.db"
      visibility: "30"
      maxAttempts: "5"
      port: "8420"
      token: ""

    # defaults inherited by every bot unless overridden
    defaults:
      threadTtl: 86400                  # sliding conversation-state expiry (seconds)
      replyTtl: 3600                    # reply-once guard window (seconds)
      callbackTtl: 129600               # callback request/reply lifetime (36h); applies only to replyMode: callback
      brainTimeout: ""                  # brain command timeout (ms); unset = unbounded (see "Long-running brains")
      historyMaxTurns: 20               # cap conversation history passed to the brain
      failureMessage: "Sorry — I hit an error handling that request."  # sent once, on the final failed attempt, before dead-lettering
      messageLogTtl: 2592000            # message log retention (seconds); default 30 days; "off" disables logging (see "Message log")
      typingInterval: 20                # keep-alive: re-raise typing every N seconds while the brain runs; 0 disables
      progressMessage: ""               # optional message sent once if the brain is still running after progressMessageDelay
      progressMessageDelay: 15          # seconds to wait before sending progressMessage
      onMessage: ""                     # optional command run for every inbound message, independent of the reply (see "onMessage hook")

    bots:
      support:
        channel: echo                  # which plugin handles this bot (must be in `channels`)
        secret: ${ECHO_SIGNING_SECRET} # plugin-specific — the echo plugin HMACs the raw body with this
        outbox: "./.bot/echo-outbox.ndjson"  # plugin-specific — where the echo plugin "delivers" replies
        command: "cat"                 # the brain: any CLI, text in -> markdown out
        # replyMode: callback           # optional: brain completes with `aux4 bot complete`; stdout is ignored
```

Fields under a bot entry besides `channel` and `command` are **opaque to the
core** — they are forwarded to the plugin's commands as-is (`bot.secret`,
`bot.outbox` above are echo-plugin-specific; a WhatsApp plugin would instead
expect e.g. `bot.phoneNumberId`/`bot.accessToken`). This is what lets a new
channel plug in without any core schema change.

## Work queue config

`bot.queue.provider` selects the queue backend and is forwarded straight
through to [aux4/queue](https://hub.aux4.io/r/public/packages/aux4/queue)'s
own `--provider` flag (`aux4 queue <op> --provider value(queue.provider) ...`)
— there is no bot-side allowlist anymore. `aux4/queue` itself fails closed
with a clear `install aux4/queue-<provider>` error for an unknown or
not-installed provider, so adding a new backend (e.g.
[aux4/queue-sqs](https://hub.aux4.io/r/public/packages/aux4/queue-sqs) or
[aux4/queue-cloud](https://hub.aux4.io/r/public/packages/aux4/queue-cloud))
is just installing that plugin — no change to this package.

```yaml
queue:
  provider: "memory"      # memory, repository, sqs, cloud, or any other installed aux4/queue-<provider> plugin
  name: "bot-inbox"       # queue name — dashes/dots are fine under memory/repository (aux4/queue >=0.2.3)
  db: ".bot/queue.db"     # repository provider only — sqlite path, libsql:// URL, or the literal "cloud"
  visibility: "30"        # lease visibility timeout, seconds
  maxAttempts: "5"        # nacks before a message is dead-lettered (0 = unlimited; ignored by some providers)
  port: "8420"            # memory provider only
  token: ""               # memory provider only
```

**`db: "cloud"` (bot state and `--provider repository`'s `db`):** the
literal value `cloud` is not a local file — it resolves to the Turso
database that the aux4.cloud `turso:database` capability already provides
to this machine (via `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`), the same
value accepted by [aux4/repository](https://hub.aux4.io/r/public/packages/aux4/repository)'s
own `--db`. Nothing in this package's code branches on `cloud` specifically
— `db` is forwarded as-is to `aux4 repository`/`aux4 queue`, which is what
actually resolves it. Using it without that environment set up fails fast
with a clear error instead of silently writing to a local file.

**Backward compatibility (one version):** the pre-0.2.0 shape
`queue: {command: "queue", storage: "memory"}` (or `command: "queue-sqs"`)
still works — `command`/`storage` are read as aliases for `provider` when
`provider` itself is not set. Switching providers needs no bot code change
either way — see aux4/queue for the full
`create`/`send`/`lease`/`ack`/`nack`/`dlq`/`renew` contract and each
provider's own tradeoffs.

**Push mode:** `POST /bot/work` → `aux4 bot work --mode push` processes a
message given directly in the request body, with no lease — useful for
feeding the bot from a system that can only push. Since aux4/queue 0.2.3, a
**work queue's** `--webhook` push is retry-safe (it goes through
lease/ack/nack: a 502 from this route nacks the delivery, redelivered and
eventually dead-lettered instead of silently dropped). A **pub/sub**
(non-work) queue's `--webhook` is still fire-and-forget by design, since it
never holds a lease to nack — use a work queue for durability.

```yaml
api:
  "POST /bot/work":
    command: aux4 bot work --mode push --configFile config.yaml --config bot
    public: true
```

**Long-running brains:** while the brain runs, `--mode pull` renews the
lease every half of `queue.visibility` via `aux4 queue renew` — a brain
that legitimately runs longer than `queue.visibility` is no longer
redelivered to a second worker mid-run. The first renew fires immediately
when the lease is acquired, not after waiting a full interval, so the gap
between leasing a message and the first renew is never a full interval
wide. A renew that fails (a transient error from the queue provider) is
retried quickly (up to 3 times, about a second apart) instead of waiting
for the next normal interval before trying again.

**Note:** every renew spawns a process (`aux4 queue renew`, and for
`--provider sqs`/`cloud` a further dispatcher + provider + `aws` CLI chain
underneath it). `queue.visibility` below ~10 seconds is risky — a renew
that takes longer than expected under load has very little margin before
the lease expires on its own, even with the immediate-renew and quick-retry
behavior above; a worker logs a warning when `queue.visibility` is set
below this. Prefer a visibility of 10 seconds or more for any queue a
`--mode pull` worker leases from. `brainTimeout` is unset by default
(unbounded); set it to cap a brain that may hang instead of just running
long.

## Claim-based dedupe and the reply-once guard

Two things must never happen twice: processing the same inbound event, and
sending the same reply. Both are enforced with
[`aux4 repository claim`](https://hub.aux4.io/r/public/packages/aux4/repository) —
a single atomic "insert only if not already (live-)held" write, not a
read-then-write check (which would race under concurrent webhook deliveries).

- **Inbound dedupe:** `ingest` claims `<channel>:<botId>:<event.key>` before
  enqueuing. A duplicate delivery (the platform retrying because an earlier
  ack was slow/lost) finds the id already claimed, is silently skipped, and
  the request still acks 200 — the platform already got a 200 for it once.
- **Reply-once guard:** the `worker` claims `reply:<channel>:<botId>:<event.key>`
  **before** calling the plugin's `send`. If the worker crashes after
  claiming the inbound event but before replying and is redelivered the same
  message, the reply claim still protects against sending twice.

Both claims carry a ttl (`dedupeTtl` / `defaults.replyTtl`) and are swept by
`aux4 bot clean` once expired — after the window, the same event id COULD be
reprocessed; size the ttl to comfortably exceed the platform's own retry
window.

## Conversation state

Per-conversation history is kept under a key of `threadId` falling back to
`chatId` (`<channel>:<botId>:<threadId ?? chatId>`), with a **sliding** ttl
(`defaults.threadTtl` / `bots.<id>.threadTtl`) — every turn refreshes the
expiry, so an idle conversation ages out but an active one does not. History
is capped before being handed to the brain (`historyMaxTurns` /
`historyCharBudget`), same knobs as aux4/slackbot.

## The brain

The brain is any CLI command: it receives the user's message as a positional
argument and the capped conversation history + any downloaded attachment
paths on stdin, and must print a Markdown answer to stdout. The worker
converts that Markdown via the plugin's `format` command before calling
`send` — a channel with no markdown support (like `echo`) can just pass it
through unchanged; a channel with its own markup (e.g. Slack mrkdwn) converts
it there.

If the brain command fails or times out (`brainTimeout`), the worker nacks
the message instead of replying — aux4/queue redelivers it (in pull mode)
and `queue.maxAttempts` dead-letters it after repeated failures. There is no
in-process retry/backoff anymore (there was, before durable queueing); a
message that keeps failing no longer gets a `failureMessage` reply either —
see Known limitations.

### Callback reply mode

Set `replyMode: callback` for a generic remote agent brain. Before starting
the brain, the worker stores an opaque request id and the channel, bot, chat,
thread, message, and conversation correlation in the bot database. The brain
receives stable `AUX4BOT_REQUEST_ID`, `AUX4BOT_MESSAGE_ID`, and
`AUX4BOT_CONVERSATION_ID` environment variables. These are opaque identifiers;
the conversation id is UUID-shaped and does not reveal channel, bot, or chat
routing. Its stdout is not delivered.

The authenticated agent invokes `aux4 bot complete` with JSON on stdin, such
as `{"requestId":"req:<opaque>","status":"completed","reply":"..."}`.
The command resolves routing only from the stored request, formats and sends
the reply, updates conversation/message history once, and returns a compact
receipt. Duplicate callbacks and queue redeliveries are accepted without a
second send. Unknown or mismatched correlations are rejected, and repository
claim failures fail closed.

Callback requests default to a 36-hour lifetime (`callbackTtl: 129600`) so a
provider retry window does not cause the model to run again after the normal
reply ttl. A crash after the provider accepts a reply but before the durable
request status is written is intentionally at-most-once: the reply claim
prevents a second send, and a later callback is reported as in progress rather
than falsely acknowledged as completed. The claim is retained even when the
provider call throws because a timeout may follow provider acceptance;
operators can inspect and reconcile that request from the repository log.

**Empty brain output means no reply.** If the brain's answer is empty or
whitespace-only, nothing is sent to the chat — the message still acks
normally (this is not a failure), and the attempt is logged in the message
log as a `no-reply` entry instead of a sent message. Useful for a brain
that deliberately stays silent on some inputs (e.g. a message it decides
not to answer).

## Keep-alive typing and progressMessage

While the brain runs, the plugin's `typing` indicator is re-raised every
`typingInterval` seconds (default `20`) — a single typing call at the start
goes stale on most platforms well before a slow brain finishes. Set
`typingInterval: 0` to disable.

```yaml
bots:
  support:
    typingInterval: 20       # default: 20 (seconds); 0 disables
    progressMessage: ""      # optional; sent once if the brain is still running
    progressMessageDelay: 15 # seconds to wait before sending progressMessage; default: 15
```

If `progressMessage` is set, it is sent once (via the plugin's `send`,
then logged in the message log) after `progressMessageDelay` seconds,
**only if the brain is still running by then** — a brain that finishes
first never triggers it. Useful for a brain that legitimately takes a
while and a typing indicator alone isn't reassuring enough.

## Per-bot onMessage hook

`bot.onMessage`, when set, is a command run for **every** inbound message
— independent of the reply. The full `{channel, botId, event}` message is
written to its stdin as JSON.

```yaml
bots:
  support:
    onMessage: "aux4 my-analytics log-inbound"
```

It runs fire-and-forget: it is never awaited on the reply's critical path,
so a slow or failing hook (non-zero exit) never delays, blocks, or nacks
the reply. Its failure is logged, nothing more. Use it for side effects
that must see every inbound message regardless of how (or whether) the bot
replies — analytics, audit logging, triggering an external workflow — not
for anything the reply itself depends on.

## Message log

Every inbound and outbound message — including a `no-reply` entry for an
empty brain output, a `progress` entry for a sent `progressMessage`, and a
`manual` entry for an `aux4 bot send` — is written to a persistent message
log in the same repository `--db` as the rest of aux4/bot's state.
Retention is per-bot:

```yaml
bots:
  support:
    messageLogTtl: 2592000   # default: 2592000 (30 days), in seconds; "off" disables logging entirely
```

Browse it with two read-only commands:

```bash
# recent chats: chatId, user, last message, time — newest first
aux4 bot conversations support --configFile config.yaml --config bot

# full history for one chat, both directions, oldest first
aux4 bot messages support --chat 15551234567 --configFile config.yaml --config bot
```

Expired entries (past `messageLogTtl`) are swept by `aux4 bot clean`, same
as every other repository table this package manages.

## Sending an ad hoc message

`aux4 bot send` sends a message that is **not** a reply to an inbound
event — a proactive notification, for example:

```bash
aux4 bot send support --to 15551234567 --text "Your order has shipped!" --configFile config.yaml --config bot
```

It resolves the bot's own channel from `bots.<botId>.channel`, runs the
text through that channel plugin's `format` then `send`, and logs it as
outbound in the message log on success. A plugin may refuse instead of
sending — for example, WhatsApp's Cloud API only allows a free-form message
within 24 hours of the user's last message; outside that window the
WhatsApp plugin (see
[aux4/bot-meta](https://hub.aux4.io/r/public/packages/aux4/bot-meta))
refuses with a clear error pointing at `aux4 bot whatsapp send-template`
instead. Either way, `send` fails loudly (stderr + exit `1`) — unlike the
worker's own best-effort reply send — because here something is directly
waiting on the result.

## Writing a channel plugin

A channel plugin is any installed aux4 package that adds a `<channel>`
command to the `bot` profile, routing (`profile:bot:<channel>`) to its own
`bot:<channel>` profile of six commands (the `bot:` prefix follows aux4's
nested-profile naming convention — see `/aux4-command`). Because aux4 merges
profiles of the same name across every installed package, this is the same
extension mechanism
[aux4/oauth-app](https://hub.aux4.io/r/public/packages/aux4/oauth-app) uses
for its provider plugins — see that package for the pattern, or this
package's own in-repo `echo` channel (`package/.aux4`, `lib/echo.js`) for a
complete worked example.

The core never imports a plugin's code — it only ever shells out to
`aux4 bot <channel> <command>`, so a plugin can be written in any language
aux4 can invoke. Every plugin command receives a single JSON object on
stdin and must print a single JSON object (or, for `verify`'s handshake
body, a plain string) to stdout.

| Command | Called by | Input (stdin JSON) | Output (stdout JSON) |
|---|---|---|---|
| `verify` | `bot verify` (GET) and `bot ingest` (POST) | `{method, headers, query, rawBody, bot}` | `{valid, body?, statusCode?, challengeResponse?}` |
| `ingest-parse` | `bot ingest` | `{headers, query, rawBody, bot}` | `[{key, kind, chatId, userId, text, files, threadId?, ttl?}, ...]` |
| `typing` | `bot worker` (at the start of handling an event) | `{event, bot}` | `{ok}` (best-effort; errors are logged, not fatal) |
| `download` | `bot worker` (once per attached file) | `{file, bot, tmpDir}` | `{path}` (local filesystem path) |
| `format` | `bot worker` (before `send`) | `{markdown, bot}` | `{text}` |
| `send` | `bot worker`, `bot send` | `{chatId, threadId, text, bot}` | `{ok}`, or `{ok:false, error}` to refuse (see below) |

Notes:

- **`verify` is signature verification, not a Slack/Meta-specific check** —
  implement whatever scheme the platform uses (HMAC, shared secret header,
  signed JWT, …) over the **byte-exact `rawBody`** the core hands you (see
  [aux4/api's `event.rawBody`](https://hub.aux4.io/r/public/packages/aux4/api) —
  a re-serialized body is not guaranteed byte-identical to what the platform
  signed). For a GET handshake, respond `{valid:true, body:"<challenge>"}`.
  For a platform that runs its handshake over POST (Slack's
  `url_verification`), return `{valid:true, challengeResponse:"<challenge>"}`
  from the SAME `verify` call the ingest route makes — `ingest` short-circuits
  on `challengeResponse` before ever calling `ingest-parse`.
- **`ingest-parse`'s `key` must be a stable, unique id** for the event — it is
  what the core's dedupe claim keys on. Use the platform's own event/message
  id when it has one.
- **Everything on `bot` besides `channel`/`command`/`outbox`-shaped config is
  yours** — the core only reads `channel` and `command`; every other field
  under a bot's config entry is handed to your plugin commands verbatim.
- A plugin that needs its own persistent install/auth bookkeeping (e.g. a
  multi-workspace OAuth install flow) can use the shared `installations`
  repository table (`aux4 repository write/read/claim --repository
  installations --db <the same db>`) — the core creates and sweeps it but
  never interprets its contents.
- **`send` may refuse** by returning `{ok:false, error:"<reason>"}` instead
  of throwing, when the platform itself would reject the message for a
  reason the caller should see (e.g. WhatsApp's 24h free-form session
  window). `bot worker`'s own best-effort reply send just logs the refusal
  and moves on; `aux4 bot send` surfaces `error` to stderr and exits `1`.

## Example: the `echo` reference plugin

`echo` is included in this package purely to exercise and demonstrate the
core end-to-end — it is a loopback, not a real chat platform. Its `verify`
HMACs the raw body with `bot.secret`; its `send`/`typing` append an
observable NDJSON line to `bot.outbox` instead of calling a real API.

```bash
echo '{"events":[{"id":"evt1","chatId":"c1","text":"hello"}]}' > body.json
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','mysecret').update(require('fs').readFileSync('body.json')).digest('hex'))")
curl -X POST "http://localhost:8080/api/echo/support/webhook" \
  -H "Content-Type: application/json" -H "x-echo-signature: $SIG" \
  --data-binary @body.json
```

A running `aux4 bot worker` picks the event up, runs the configured brain
command, and appends the formatted reply to `bot.outbox`.

## Sweeping expired state (clean)

```bash
aux4 bot clean --configFile config.yaml --config bot
```

Removes every expired record (dedupe claims, reply-once guards, conversation
state, and a plugin's own `installations` rows) across every repository
table the database holds. Schedule it periodically (e.g. via `aux4 cron`),
same as aux4/slackbot's `clean`.

## Known limitations

- **Push mode on a pub/sub (non-work) queue has no retry/durability** — see
  "Push mode" above. A work queue's `--webhook` push IS retry-safe
  (aux4/queue >=0.2.3); only a plain pub/sub queue's webhook is
  fire-and-forget by design.
- **No dead-letter notification hook.** `failureMessage` is sent once, on
  the final failed attempt, right before the message is dead-lettered —
  but there is no further notification once it actually reaches `aux4
  queue dlq` (e.g. a webhook to alert an operator). `onMessage` fires on
  *inbound* messages only, not on dead-lettering — a dedicated
  dead-letter hook is tracked separately.
- **Additional providers are separate packages.** `queue.provider: "sqs"` (or
  `"cloud"`) works once [aux4/queue-sqs](https://hub.aux4.io/r/public/packages/aux4/queue-sqs)
  (or [aux4/queue-cloud](https://hub.aux4.io/r/public/packages/aux4/queue-cloud)) is installed
  alongside `aux4/queue` — this package has no list of providers to keep in sync.

## License

Apache-2.0

Queue leasing distinguishes an empty queue from an execution failure. The
provider’s documented exit-4 empty response returns `{"leased":false}`.
Authentication, connection, database and malformed-response errors fail the
command; they are not reported as an empty queue. Diagnostics omit provider
credentials and response bodies. This does not add an automatic retry scheduler.

## Bounded retries in one invocation

`aux4 bot retry-work` drains queued work through existing leases, ack/nack and
reply deduplication. Default backoff is 1, 2, 4, 8, then 15 seconds, up to six
consecutive failed or unexpectedly empty attempts. Pass `--expected` from the
`enqueued` metadata returned by `bot ingest` to protect newly queued work.

Persisted queue `maxAttempts` still controls dead-letter eligibility. Retry,
time and message limits return failure explicitly. The time budget stops new
attempts; in-flight work retains its configured timeout. This is not a daemon
or scheduler and cannot recover after process or VM termination.
