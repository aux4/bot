#### Description

`send` sends an ad hoc, proactive message to a chat — NOT tied to an
inbound event. It resolves the bot's own channel straight from
`bots.<botId>.channel` (the same opaque per-bot config every other command
reads), runs the text through that channel plugin's `format` command, then
its `send` command, and logs the result as outbound in the persistent
message log on success.

Only `botId` is a positional argument — aux4 core does not reliably bind
two positional (`arg: true`) variables on one command, so the channel is
resolved from the bot's own config instead of being a second positional.

A plugin's `send` may refuse instead of sending — returning `{ok:false,
error}` — when the channel has a rule this message would violate (for
example, WhatsApp's Cloud API only allows a free-form message within 24
hours of the user's last message; outside that window a plugin should
refuse with a clear message pointing at a template-based alternative, e.g.
`aux4 bot whatsapp send-template`). It may also fail outright (non-zero
exit, e.g. a transport error). Either way, `send` fails loudly — stderr +
exit `1` — because here a human or script is directly waiting on the
result, unlike the worker's own best-effort reply send.

#### Usage

```bash
aux4 bot send <botId> --to <chatId> --text <text> --configFile config.yaml --config bot
```

--botId    Bot id, as configured under `bots.<id>` (positional)
--to       Destination chat id
--text     Markdown text to send
--bots     Map of botId -> per-bot config (JSON object)
--defaults Shared defaults merged under every bot (JSON object)
--db       Repository database for bot state — message log (default: `.bot/state.db`)

#### Example

```bash
aux4 bot send support --to 15551234567 --text "Your order has shipped!" --configFile config.yaml --config bot
```

```text
{"ok":true}
```

A refusal (e.g. outside WhatsApp's 24h session window):

```text
WhatsApp blocked this message: outside the 24h customer session window. Use "aux4 bot whatsapp send-template" to re-engage this chat with a pre-approved template.
```

(exits `1`)
