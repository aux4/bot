#### Description

`conversations` lists a bot's most recently active chats from the
persistent message log: `chatId`, `userId`, `lastMessage`, which
`direction` that last message was (`in`/`out`), and `time` — one entry per
distinct chat, newest first.

It scans a window of recent messages (comfortably larger than `--limit`)
to find that many distinct chats, so an extremely idle chat buried deep in
the log may not surface if `--limit` is small — raise `--limit` to see
further back.

A bot id with no logged messages (or every message aged out past its
`messageLogTtl`) returns `[]`, not an error.

#### Usage

```bash
aux4 bot conversations <botId> [--channel <channel>] [--limit 20] --configFile config.yaml --config bot
```

--botId    Bot id, as configured under `bots.<id>` (positional)
--channel  Narrow to one channel plugin (default: every channel this bot has logged messages on)
--db       Repository database for bot state — message log (default: `.bot/state.db`)
--limit    Maximum number of chats to return (default: `20`)

#### Example

```bash
aux4 bot conversations support --configFile config.yaml --config bot
```

```json
[
  { "chatId": "15551234567", "userId": "15551234567", "lastMessage": "Thanks!", "direction": "in", "time": "2026-11-12 10:03:21" },
  { "chatId": "15557654321", "userId": "15557654321", "lastMessage": "Your order has shipped!", "direction": "out", "time": "2026-11-12 09:58:04" }
]
```
