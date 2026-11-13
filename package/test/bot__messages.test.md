# aux4 bot messages

Lists message history for one chat, both directions, oldest first, from the
persistent message log.

```afterAll
rm -f msgs-test.db msgs-outbox.ndjson
```

## listing a chat's history

### oldest first, across multiple sends

```execute
rm -f msgs-test.db msgs-outbox.ndjson
aux4 bot send support --to chat-hist --text "one" --bots '{"support":{"channel":"echo","outbox":"msgs-outbox.ndjson"}}' --db msgs-test.db >/dev/null
sleep 1
aux4 bot send support --to chat-hist --text "two" --bots '{"support":{"channel":"echo","outbox":"msgs-outbox.ndjson"}}' --db msgs-test.db >/dev/null
sleep 1
aux4 bot send support --to chat-hist --text "three" --bots '{"support":{"channel":"echo","outbox":"msgs-outbox.ndjson"}}' --db msgs-test.db >/dev/null
aux4 bot messages support --chat chat-hist --db msgs-test.db
```

```expect:partial
[{"direction":"out","text":"one","userId":"","kind":"manual","time":"*?"},{"direction":"out","text":"two","userId":"","kind":"manual","time":"*?"},{"direction":"out","text":"three","userId":"","kind":"manual","time":"*?"}]
```

### --limit caps how many messages are returned (the most recent ones)

```execute
aux4 bot messages support --chat chat-hist --db msgs-test.db --limit 1
```

```expect:partial
[{"direction":"out","text":"three"*?}]
```

### a chat with no logged messages returns an empty list

```execute
aux4 bot messages support --chat chat-nonexistent --db msgs-test.db
```

```expect
[]
```
