# aux4/bot persistent message log — retention (messageLogTtl)

Retention is per-bot, resolved the same way as every other bot field
(`defaults.messageLogTtl` + a per-bot override): a plain number of seconds,
defaulting to 30 days when unset, or the literal string `"off"` to disable
logging entirely for that bot.

```afterAll
rm -f msglog-test.db msglog-outbox.ndjson
```

## default retention (unset messageLogTtl)

### a bot with no messageLogTtl configured still logs normally

```execute
rm -f msglog-test.db msglog-outbox.ndjson
aux4 bot send plainbot --to chat-plain --text "logged by default" --bots '{"plainbot":{"channel":"echo","outbox":"msglog-outbox.ndjson"}}' --db msglog-test.db >/dev/null
aux4 bot messages plainbot --chat chat-plain --db msglog-test.db
```

```expect:partial
[{"direction":"out","text":"logged by default"*?}]
```

## messageLogTtl: "off" disables logging

### the message is still sent, but never written to the log

```execute
aux4 bot send offbot --to chat-off --text "never logged" --bots '{"offbot":{"channel":"echo","outbox":"msglog-outbox.ndjson","messageLogTtl":"off"}}' --db msglog-test.db
aux4 bot messages offbot --chat chat-off --db msglog-test.db
aux4 bot conversations offbot --db msglog-test.db
```

```expect
{"ok":true}[][]
```

## a custom numeric messageLogTtl expires the log entry on its own schedule

### a short ttl ages the entry out of conversations/messages without an explicit clean

```execute
aux4 bot send ttlbot --to chat-ttl --text "short-lived" --bots '{"ttlbot":{"channel":"echo","outbox":"msglog-outbox.ndjson","messageLogTtl":1}}' --db msglog-test.db >/dev/null
aux4 bot messages ttlbot --chat chat-ttl --db msglog-test.db
```

```expect:partial
[{"direction":"out","text":"short-lived"*?}]
```

### once the ttl elapses, the entry no longer shows up

```execute
sleep 2
aux4 bot messages ttlbot --chat chat-ttl --db msglog-test.db
aux4 bot conversations ttlbot --db msglog-test.db
```

```expect
[][]
```
