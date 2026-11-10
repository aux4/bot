#### Description

Internal aux4/api route handler for `POST /{channel}/{bot}/webhook` — the
always-async inbound path. Not meant to be run directly; it is wired into
`config.api` and invoked by `aux4 api start`/`aux4 api handle`.

Steps, in order:

1. Resolve `{channel}`/`{bot}` against the `channels` allowlist and the
   `bots` map. Unknown → 404.
2. Call the channel plugin's `verify` command with the byte-exact raw request
   body (`event.rawBody`) so a signature check (HMAC or otherwise) is
   computed over exactly what the platform sent. Rejected → 401.
3. If the plugin's verify response carries `challengeResponse` (a platform
   that runs its handshake over POST, e.g. Slack's `url_verification`),
   respond with it directly and stop — `ingest-parse` is never called for a
   handshake request.
4. Call the plugin's `ingest-parse` command to turn the raw body into zero or
   more normalized events: `{key, kind, chatId, userId, text, files,
   threadId?, ttl?}`.
5. For each event, atomically **claim** `<channel>:<botId>:<event.key>` via
   `aux4 repository claim` (ttl = the event's own `ttl`, falling back to
   `dedupeTtl`). A duplicate delivery — the id already claimed — is silently
   skipped, not an error.
6. Enqueue every newly claimed event onto `queueName` for the worker to pick
   up.
7. Ack `200 {}` — always, once steps 1–3 have passed, regardless of how many
   events were duplicates. The response time to the platform never depends on
   how long the brain takes to answer.

#### Usage

```yaml
config:
  api:
    "POST /{channel}/{bot}/webhook":
      command: aux4 bot ingest --configFile config.yaml --config bot
      public: true
```

--channels    Allowlisted channel names (JSON array)
--bots        Map of botId -> per-bot config (JSON object)
--defaults    Shared defaults merged under every bot (JSON object)
--db          Repository database — local sqlite path or `libsql://` URL (default: `.bot/state.db`)
--queueName   aux4/queue dispatch queue name (default: `bot.inbound`)
--queueUrl    aux4/queue server URL — only the port is used (default: `http://localhost:8430`)
--dedupeTtl   Fallback event-dedupe window in seconds, when a plugin event carries no ttl of its own (default: `300`)

#### Example

```text
POST /api/echo/support/webhook  (valid signature, new event id)  ->  200 {}
POST /api/echo/support/webhook  (same event id again)             ->  200 {}  (skipped, not re-enqueued)
POST /api/echo/support/webhook  (invalid signature)                ->  401
```
