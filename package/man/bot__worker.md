#### Description

`worker` is a long-running loop around `aux4 bot work --mode pull`: lease
the next eligible message from the work queue, process it, ack on success
or nack on a brain failure, and repeat forever with a fixed poll interval
whenever nothing is eligible. One `worker` process serves every configured
channel and bot — each leased message carries its own `channel`/`botId`,
resolved per-message against the current config. If a bot is removed from
config after a message was already queued, the worker drops the message
(logged) instead of crashing.

aux4/queue's own `--group` exclusivity (set on `send`, keyed on chatId —
see `bot__ingest.md`) is what guarantees two messages for the same
conversation are never leased, and therefore never processed, at the same
time — even if multiple workers are running.

See `bot__work.md` for what processing one message actually does (typing,
conversation load, brain, reply-once guard, format, send) — `worker` adds
nothing on top of `work --mode pull` except the loop.

#### Usage

```bash
aux4 bot worker --configFile config.yaml --config bot
```

--channels      Allowlisted channel names (JSON array)
--bots          Map of botId -> per-bot config (JSON object)
--defaults      Shared defaults merged under every bot (JSON object)
--db            Repository database for event dedupe + conversations — local sqlite path or `libsql://` URL (default: `.bot/state.db`)
--tmpDir        Working directory for downloaded attachments (default: `.bot/tmp`)
--pollInterval  Seconds to sleep between lease attempts, every attempt (hit or idle) (default: `1`)
--queue         Work-queue config: `{command, name, storage, db, visibility, maxAttempts, port, token}`

#### Example

```bash
aux4 queue start --port 8420
aux4 bot worker --configFile config.yaml --config bot
```

```text
[bot worker] conversation load failed: ...   (benign — first message for a new conversation)
```
