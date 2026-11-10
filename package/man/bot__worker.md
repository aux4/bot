#### Description

`worker` is the long-running consumer of the `bot.inbound` queue. For every
dequeued event it:

1. Calls the channel plugin's `typing` command (best-effort — a failure is
   logged, never fatal).
2. Loads the conversation's history, keyed by `<channel>:<botId>:<threadId ??
   chatId>`, from the shared repository.
3. Calls the plugin's `download` command once per attached file, collecting
   local paths.
4. Runs the bot's **brain** command — `text in → markdown out` — with the
   user's message as its positional argument and the capped conversation
   history + attachment paths on stdin. On failure or timeout
   (`brainTimeout`), retries with backoff up to `brainRetries` times.
5. Atomically claims the **reply-once guard** (`reply:<channel>:<botId>:<event.key>`)
   via `aux4 repository claim` **before** sending anything — this is what
   makes a crash-and-redelivery of the same event safe: the retry finds the
   reply slot already claimed and skips sending a second answer.
6. On success: saves the updated conversation (sliding `threadTtl`), calls
   the plugin's `format` command to convert the brain's Markdown into the
   channel's native text, then the plugin's `send` command to deliver it.
7. On brain failure after all retries: calls `format`/`send` with
   `failureMessage` instead, so the user is never left without a reply.

One `worker` process serves every configured channel and bot — each queued
message carries its own `channel`/`botId`, resolved per-message against the
current config. If a bot is removed from config after an event was already
queued, the worker drops the message (logged) instead of crashing.

The queue connection is held open and reconnects with exponential backoff
(500ms, doubling, capped at 15s) if the `aux4 queue` server restarts.

#### Usage

```bash
aux4 bot worker --configFile config.yaml --config bot
```

--channels   Allowlisted channel names (JSON array)
--bots       Map of botId -> per-bot config (JSON object)
--defaults   Shared defaults merged under every bot (JSON object)
--db         Repository database — local sqlite path or `libsql://` URL (default: `.bot/state.db`)
--tmpDir     Working directory for downloaded attachments (default: `.bot/tmp`)
--queueName  aux4/queue dispatch queue name (default: `bot.inbound`)
--queueUrl   aux4/queue server URL — only the port is used (default: `http://localhost:8430`)

#### Example

```bash
aux4 queue start --port 8430
aux4 bot worker --configFile config.yaml --config bot
```

```text
[bot worker] connecting to queue bot.inbound on port 8430
```
