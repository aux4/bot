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
rm -f .push-brain-marker-*
rm -rf push-bot-tmp .tmp
true
```

Note: BOT-011 (aux4/queue >=0.2.3) made a **work queue's** `--webhook` push
retry-safe (lease/ack/nack instead of fire-and-forget) — see the "retry-safe
push" section below. The caveat above is specifically about a **pub/sub**
(non-work) queue's webhook, which is unaffected and still fire-and-forget by
design (it never holds a lease to nack).

## Server startup

### should start the queue (pub/sub, webhook-proxied to /bot/work) and the api server

```execute
rm -f push-bot-state.db push-outbox.ndjson
rm -rf push-bot-tmp
cat > push-brain.js <<'BRAINEOF'
import fs from "fs";
const text = process.argv[2] || "";
const chatId = process.env.AUX4BOT_CHAT_ID || "";

if (text.startsWith("FAIL_ONCE")) {
  const marker = `.push-brain-marker-${chatId}`;
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, "1");
    process.stderr.write("boom-once\n");
    process.exit(1);
  }
} else if (text.startsWith("FAIL")) {
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

## Retry-safe push: a work queue's --webhook retries a failing push until it succeeds

Unlike the pub/sub queue above, a **work queue** (`--workQueue true`) with
`--webhook` configured pushes through aux4/queue's own lease/ack/nack: a
502 from `/bot/work` nacks the delivery (redelivered, attempts incremented)
instead of being silently dropped.

### a push that fails once is retried by the queue itself and eventually replies

```execute
rm -f push-outbox.ndjson .push-brain-marker-chat-push-retry
touch push-outbox.ndjson
aux4 queue create --port 18771 --name bot.push.workqueue --workQueue true --maxAttempts 3 --webhook http://localhost:18770/api/bot/work >/dev/null
echo '{"channel":"echo","botId":"support","event":{"key":"evt-push-retry-1","chatId":"chat-push-retry","text":"FAIL_ONCE please"}}' | aux4 queue send --name bot.push.workqueue --port 18771 >/dev/null
sleep 3
grep -c '"type":"message"' push-outbox.ndjson
rm -f .push-brain-marker-chat-push-retry
```

```expect
1
```

### a push that always fails is retried to maxAttempts and then dead-lettered, never silently dropped

```execute
rm -f push-outbox.ndjson
touch push-outbox.ndjson
echo '{"channel":"echo","botId":"support","event":{"key":"evt-push-dlq-1","chatId":"chat-push-dlq","text":"FAIL always"}}' | aux4 queue send --name bot.push.workqueue --port 18771 >/dev/null
sleep 3
aux4 queue dlq --name bot.push.workqueue --port 18771 | jq '[.[] | {attempts}]'
```

```expect
[
  {
    "attempts": 3
  }
]
```
