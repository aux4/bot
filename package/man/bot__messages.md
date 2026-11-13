#### Description

`messages` lists message history for one chat, both directions (inbound
and outbound), oldest first — a chat transcript reads top-to-bottom — from
the persistent message log.

Each entry carries `direction` (`in`/`out`), `text`, `userId`, `kind`
(`message` for a normal inbound/outbound message, `no-reply` for an empty
brain output that was never sent, `progress` for a `progressMessage`,
`manual` for an `aux4 bot send`, or `send-failed` when the worker's own
reply send failed), and `time`.

A chat with no logged messages (or every message aged out past its
`messageLogTtl`) returns `[]`, not an error.

#### Usage

```bash
aux4 bot messages <botId> --chat <chatId> [--limit 50] --configFile config.yaml --config bot
```

--botId    Bot id, as configured under `bots.<id>` (positional)
--chat     Chat id to show history for
--channel  Narrow to one channel plugin (default: every channel this bot has logged messages on)
--db       Repository database for bot state — message log (default: `.bot/state.db`)
--limit    Maximum number of messages to return — the most recent ones (default: `50`)

#### Example

```bash
aux4 bot messages support --chat 15551234567 --configFile config.yaml --config bot
```

```json
[
  { "direction": "in", "text": "What's the status of my order?", "userId": "15551234567", "kind": "message", "time": "2026-11-12 10:02:55" },
  { "direction": "out", "text": "Your order has shipped!", "userId": "", "kind": "message", "time": "2026-11-12 10:03:02" },
  { "direction": "in", "text": "Thanks!", "userId": "15551234567", "kind": "message", "time": "2026-11-12 10:03:21" }
]
```
