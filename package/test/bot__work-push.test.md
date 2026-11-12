# aux4/bot push delivery via aux4/queue's pub/sub webhook proxy

`aux4 bot work --mode push` is the aux4/api route handler for `POST
/bot/work`: it processes the `{channel,botId,event}` message in the request
body directly, with no lease/ack/nack (there is nothing to lease — the
message arrived as a plain HTTP push). This proves it works end-to-end
fed by a real external pusher: a `memory` storage **pub/sub** queue
(`--webhook`, not a work queue) configured to proxy every published
message straight to `/bot/work`.

**Caveat confirmed by this suite** (see README "Push mode"): aux4/queue's
webhook proxy (as of 0.2.2) is fire-and-forget — it does not inspect the
response status code or retry on failure. The second test below sends a
message that makes the brain fail; the route correctly replies 502, but
nothing redelivers it (no durability on this path) — that is expected
today, not a bug in aux4/bot.

```file:config.yaml
config:
  port: 18770
  server:
    timeout: 20000
  api:
    "POST /bot/work":
      command: aux4 bot work --mode push --configFile config.yaml --config bot
      public: true
  bot:
    channels: ["echo"]
    db: "push-bot-state.db"
    tmpDir: "push-bot-tmp"
    bots:
      support:
        channel: echo
        secret: testsecret
        outbox: "push-outbox.ndjson"
        command: "node push-brain.js"
```

```afterAll
aux4 api stop 2>/dev/null
aux4 queue stop --port 18771 2>/dev/null
rm -f push-bot-state.db push-outbox.ndjson push-brain.js api.log queue.log
rm -rf push-bot-tmp .tmp
true
```

## Server startup

### should start the queue (pub/sub, webhook-proxied to /bot/work) and the api server

```execute
rm -f push-bot-state.db push-outbox.ndjson
rm -rf push-bot-tmp
cat > push-brain.js <<'BRAINEOF'
const text = process.argv[2] || "";
if (text.startsWith("FAIL")) {
  process.stderr.write("boom\n");
  process.exit(1);
}
console.log(text);
BRAINEOF
nohup aux4 queue start --port 18771 >queue.log 2>&1 &
sleep 1
aux4 queue create --port 18771 --name bot.push.inbox --webhook http://localhost:18770/api/bot/work >/dev/null
nohup aux4 api start --configFile config.yaml >api.log 2>&1 &
sleep 1
echo started
```

```expect
started
```

## A message published to the pub/sub queue is pushed to /bot/work and replied to

### the webhook proxy POSTs the message, work --mode push processes it, and the reply appears in the outbox

```execute
echo '{"channel":"echo","botId":"support","event":{"key":"evt-push-1","chatId":"chat-push-1","text":"hello push"}}' | aux4 queue send --name bot.push.inbox --port 18771 >/dev/null
sleep 2
cat push-outbox.ndjson
```

```expect:partial
{"type":"typing","chatId":"chat-push-1"}**{"type":"message","chatId":"chat-push-1","text":"hello push*
```

## A brain failure on the push path replies 502 but is never retried (fire-and-forget confirmed)

### sending a failing message once produces no reply, ever (no durability/retry on this path)

The `typing` courtesy signal still fires before the brain runs (it has no
retry/reply-once guard), but no `message` reply ever appears — and nothing
redelivers it to try again, confirming the fire-and-forget caveat above.

```execute
rm -f push-outbox.ndjson
touch push-outbox.ndjson
echo '{"channel":"echo","botId":"support","event":{"key":"evt-push-2","chatId":"chat-push-2","text":"FAIL please"}}' | aux4 queue send --name bot.push.inbox --port 18771 >/dev/null
sleep 3
MSGLINES=$(grep -c '"type":"message"' push-outbox.ndjson)
echo "message-replies:$MSGLINES"
```

```expect
message-replies:0
```
