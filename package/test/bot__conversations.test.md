# aux4 bot conversations

Lists a bot's most recently active chats from the persistent message log:
one entry per distinct chat, newest first.

```afterAll
rm -f conv-test.db conv-outbox.ndjson
```

## listing recent chats

### three chats, newest first, one entry per chat even with multiple messages in one of them

```execute
rm -f conv-test.db conv-outbox.ndjson
aux4 bot send support --to chat-a --text "first" --bots '{"support":{"channel":"echo","outbox":"conv-outbox.ndjson"}}' --db conv-test.db >/dev/null
sleep 1
aux4 bot send support --to chat-b --text "second" --bots '{"support":{"channel":"echo","outbox":"conv-outbox.ndjson"}}' --db conv-test.db >/dev/null
sleep 1
aux4 bot send support --to chat-a --text "third, same chat again" --bots '{"support":{"channel":"echo","outbox":"conv-outbox.ndjson"}}' --db conv-test.db >/dev/null
sleep 1
aux4 bot send support --to chat-c --text "fourth" --bots '{"support":{"channel":"echo","outbox":"conv-outbox.ndjson"}}' --db conv-test.db >/dev/null
aux4 bot conversations support --db conv-test.db
```

```expect:partial
[{"chatId":"chat-c","userId":"","lastMessage":"fourth","direction":"out","time":"*?"},{"chatId":"chat-a","userId":"","lastMessage":"third, same chat again","direction":"out","time":"*?"},{"chatId":"chat-b","userId":"","lastMessage":"second","direction":"out","time":"*?"}]
```

### --limit caps how many chats are returned

```execute
aux4 bot conversations support --db conv-test.db --limit 1
```

```expect:partial
[{"chatId":"chat-c"*
```

### a bot id with no logged messages returns an empty list

```execute
aux4 bot conversations ghost --db conv-test.db
```

```expect
[]
```
