# aux4 bot send

An ad hoc, proactive message to a chat — NOT tied to an inbound event.
Resolves the bot's own channel from `bots.<botId>.channel`, formats the text
through that channel plugin, sends it, and logs it as outbound in the
message log on success.

```afterAll
rm -f send-test.db send-outbox.ndjson
rm -rf send-test-tmp
```

## sending to a known bot

### formats and sends through the bot's own channel plugin, and is logged as outbound

```execute
rm -f send-test.db send-outbox.ndjson
aux4 bot send support --to chat-send-1 --text "**hi there**" --bots '{"support":{"channel":"echo","secret":"testsecret","outbox":"send-outbox.ndjson"}}' --db send-test.db
cat send-outbox.ndjson
```

```expect:partial
{"ok":true}**{"type":"message","chatId":"chat-send-1","text":"**hi there**"}
```

### the sent message shows up in the message log

```execute
aux4 bot messages support --chat chat-send-1 --db send-test.db
```

```expect:partial
[{"direction":"out","text":"**hi there**","userId":"","kind":"manual","time":"*?"}]
```

### the chat shows up in the conversations list

```execute
aux4 bot conversations support --db send-test.db
```

```expect:partial
[{"chatId":"chat-send-1","userId":"","lastMessage":"**hi there**","direction":"out","time":"*?"}]
```

## sending to an unknown bot id

### fails loudly instead of silently dropping the message

```execute
aux4 bot send ghost --to chat-x --text hello --bots '{"support":{"channel":"echo"}}' --db send-test.db || true
```

```error:partial
Unknown or de-configured bot id: ghost*
```
