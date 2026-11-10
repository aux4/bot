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
                   · enqueue · ack 200                                    < all before any reply is sent
                              │
                    aux4/queue (bot.inbound)
                              │
   aux4 bot worker (single long-running consumer for every channel+bot)
    worker: plugin typing → load conversation state → plugin download (attachments)
            → run the bot's brain command → reply-once claim(reply:key)
            → plugin format → plugin send          (retry+backoff around the brain call)
```

Every state write — dedupe claims, the reply-once guard, conversation history,
and a plugin's own `installations` bookkeeping — goes through
[aux4/repository](https://hub.aux4.io/r/public/packages/aux4/repository),
local sqlite or a remote Turso/libSQL database via `--db`. The dedupe and
reply-once guards use `aux4 repository claim`, which is **race-free**: two
concurrent deliveries of the same event id can never both win.

A full deployment runs these processes:

1. `aux4 queue start` — the in-memory dispatch bus.
2. `aux4 api start` — serves `GET/POST /{channel}/{bot}/webhook` → `aux4 bot verify`/`aux4 bot ingest`.
3. `aux4 cron start` (optional) — schedules the periodic `aux4 bot clean` TTL sweep.
4. `aux4 bot worker` — consumes the queue and replies.

```bash
aux4 queue start --port 8430
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
    db: "./.bot/state.db"               # repository sqlite file (dedupe + reply-once + conversations + installations)
    tmpDir: "./.bot/tmp"                # worker's attachment download scratch space
    queueName: "bot.inbound"            # dispatch queue name
    queueUrl: "http://localhost:8430"   # queue server (localhost; only the port is used)
    dedupeTtl: 300                      # fallback event-dedupe window (seconds) when a plugin event has no ttl

    # defaults inherited by every bot unless overridden
    defaults:
      threadTtl: 86400                  # sliding conversation-state expiry (seconds)
      replyTtl: 3600                    # reply-once guard window (seconds)
      brainTimeout: 120000              # brain command timeout (ms)
      brainRetries: 2                   # retry attempts on brain failure, with backoff
      historyMaxTurns: 20               # cap conversation history passed to the brain
      failureMessage: "Sorry — I hit an error handling that request."

    bots:
      support:
        channel: echo                  # which plugin handles this bot (must be in `channels`)
        secret: ${ECHO_SIGNING_SECRET} # plugin-specific — the echo plugin HMACs the raw body with this
        outbox: "./.bot/echo-outbox.ndjson"  # plugin-specific — where the echo plugin "delivers" replies
        command: "cat"                 # the brain: any CLI, text in -> markdown out
```

Fields under a bot entry besides `channel` and `command` are **opaque to the
core** — they are forwarded to the plugin's commands as-is (`bot.secret`,
`bot.outbox` above are echo-plugin-specific; a WhatsApp plugin would instead
expect e.g. `bot.phoneNumberId`/`bot.accessToken`). This is what lets a new
channel plug in without any core schema change.

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

If the brain command fails or times out (`brainTimeout`), the worker retries
with backoff up to `brainRetries` times, then delivers `failureMessage`
instead of leaving the user without a reply.

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
| `send` | `bot worker` | `{chatId, threadId, text, bot}` | `{ok}` |

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

## Configuration

```yaml
config:
  api:
    "GET /{channel}/{bot}/webhook":
      command: aux4 bot verify --configFile config.yaml --config bot
      public: true
    "POST /{channel}/{bot}/webhook":
      command: aux4 bot ingest --configFile config.yaml --config bot
      public: true
  bot:
    channels: ["echo"]
    db: "./.bot/state.db"
    tmpDir: "./.bot/tmp"
    queueName: "bot.inbound"
    queueUrl: "http://localhost:8430"
    dedupeTtl: 300
    defaults:
      threadTtl: 86400
      replyTtl: 3600
      brainTimeout: 120000
      brainRetries: 2
      historyMaxTurns: 20
      failureMessage: "Sorry — I hit an error handling that request."
    bots:
      support:
        channel: echo
        secret: ${ECHO_SIGNING_SECRET}
        outbox: "./.bot/echo-outbox.ndjson"
        command: "cat"
```

## License

Apache-2.0
