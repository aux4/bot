# aux4/bot end-to-end, via the echo reference plugin

Exercises the full core pipeline over real HTTP, with no real chat platform:
`aux4 api` serves the webhook route, `aux4 bot ingest` verifies the HMAC
signature over the byte-exact raw body and claims/enqueues the event onto a
real `aux4 queue`, and a real `aux4 bot worker` process picks it up, runs the
brain (`echo`, so the reply text equals the inbound text), and the `echo`
plugin's `send`/`typing` append observable lines to a local outbox file.

```file:config.yaml
config:
  port: 18740
  server:
    timeout: 5000
  api:
    "GET /{channel}/{bot}/webhook":
      command: aux4 bot verify --configFile config.yaml --config bot
      public: true
    "POST /{channel}/{bot}/webhook":
      command: aux4 bot ingest --configFile config.yaml --config bot
      public: true
  bot:
    channels: ["echo"]
    db: "test-bot-state.db"
    tmpDir: "test-bot-tmp"
    queueName: "bot.e2e.test"
    queueUrl: "http://localhost:18741"
    dedupeTtl: 300
    defaults:
      threadTtl: 3600
      replyTtl: 3600
      brainTimeout: 5000
      brainRetries: 1
    bots:
      support:
        channel: echo
        secret: testsecret
        outbox: "test-outbox.ndjson"
        command: "echo"
```

```afterAll
aux4 api stop 2>/dev/null
aux4 queue stop --port 18741 2>/dev/null
pkill -f "bot.mjs worker" 2>/dev/null
rm -f test-bot-state.db test-outbox.ndjson queue.log api.log worker.log
rm -rf test-bot-tmp .tmp
true
```

## Server startup

A `beforeAll` hook runs BEFORE `file:` fixtures materialize, so the queue,
api, and worker processes (which all need `config.yaml` on disk at startup)
are started here, in the first `execute` block, instead.

### should start the queue, the api server, and the worker, and serve the GET handshake

```execute
rm -f test-bot-state.db test-outbox.ndjson
rm -rf test-bot-tmp
nohup aux4 queue start --port 18741 >queue.log 2>&1 &
sleep 1
aux4 queue create --port 18741 --name bot.e2e.test >/dev/null
nohup aux4 api start --configFile config.yaml >api.log 2>&1 &
sleep 1
nohup aux4 bot worker --configFile config.yaml --config bot >worker.log 2>&1 &
sleep 1
curl -s "http://localhost:18740/api/echo/support/webhook?challenge=hs-abc-123"
```

```expect
hs-abc-123
```

## GET verification handshake

### should 404 for an unconfigured channel

```execute
curl -s -o /dev/null -w "%{http_code}" "http://localhost:18740/api/whatsapp/support/webhook?challenge=x"
```

```expect
404
```

### should 404 for an unconfigured bot id

```execute
curl -s -o /dev/null -w "%{http_code}" "http://localhost:18740/api/echo/ghost/webhook?challenge=x"
```

```expect
404
```

## POST ingest — signature verification

### should reject a request with no signature header

```execute
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18740/api/echo/support/webhook" -H "Content-Type: application/json" --data-binary '{"events":[]}'
```

```expect
401
```

### should reject a request with a wrong signature

```execute
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18740/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: deadbeef" --data-binary '{"events":[]}'
```

```expect
401
```

## POST ingest — claim, enqueue, worker reply (full pipeline)

### a correctly-signed event is acked, processed, and replied

```execute
node -e '
const c = require("crypto");
const body = JSON.stringify({ events: [{ id: "evt-e2e-1", chatId: "chat-1", text: "hello from e2e" }] });
const sig = c.createHmac("sha256", "testsecret").update(body, "utf8").digest("hex");
require("fs").writeFileSync("e2e-body.json", body);
console.log(sig);
' > e2e-sig.txt
curl -s -w "\nHTTP:%{http_code}\n" -X POST "http://localhost:18740/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: $(cat e2e-sig.txt)" --data-binary @e2e-body.json
sleep 1.5
cat test-outbox.ndjson
rm -f e2e-sig.txt e2e-body.json
```

```expect:partial
HTTP:200**{"type":"typing","chatId":"chat-1"}**{"type":"message","chatId":"chat-1","text":"hello from e2e*
```

### a duplicate delivery of the same event id is acked but NOT reprocessed

```execute
node -e '
const c = require("crypto");
const body = JSON.stringify({ events: [{ id: "evt-e2e-1", chatId: "chat-1", text: "hello from e2e" }] });
const sig = c.createHmac("sha256", "testsecret").update(body, "utf8").digest("hex");
require("fs").writeFileSync("e2e-body.json", body);
console.log(sig);
' > e2e-sig.txt
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18740/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: $(cat e2e-sig.txt)" --data-binary @e2e-body.json)
sleep 1
rm -f e2e-sig.txt e2e-body.json
echo "ack:$HTTP lines:$(wc -l < test-outbox.ndjson | tr -d ' ')"
```

```expect
ack:200 lines:2
```

## POST ingest — enqueue failure releases the claim for retry

Simulates "the queue is not running" by pointing `bot.queueUrl` at a port
nothing is listening on, so `aux4 queue send` fails inside ingest's enqueue
step after the event has already been claimed.

### queue unreachable: enqueue fails, the claim is released, and the ack is 5xx

```file:config.yaml
config:
  port: 18740
  server:
    timeout: 5000
  api:
    "GET /{channel}/{bot}/webhook":
      command: aux4 bot verify --configFile config.yaml --config bot
      public: true
    "POST /{channel}/{bot}/webhook":
      command: aux4 bot ingest --configFile config.yaml --config bot
      public: true
  bot:
    channels: ["echo"]
    db: "test-bot-state.db"
    tmpDir: "test-bot-tmp"
    queueName: "bot.e2e.test"
    queueUrl: "http://localhost:18799"
    dedupeTtl: 300
    defaults:
      threadTtl: 3600
      replyTtl: 3600
      brainTimeout: 5000
      brainRetries: 1
    bots:
      support:
        channel: echo
        secret: testsecret
        outbox: "test-outbox.ndjson"
        command: "echo"
```

```execute
node -e '
const c = require("crypto");
const body = JSON.stringify({ events: [{ id: "evt-e2e-enqueue-fail", chatId: "chat-2", text: "should retry" }] });
const sig = c.createHmac("sha256", "testsecret").update(body, "utf8").digest("hex");
require("fs").writeFileSync("e2e-body2.json", body);
console.log(sig);
' > e2e-sig2.txt
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18740/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: $(cat e2e-sig2.txt)" --data-binary @e2e-body2.json
```

```expect
502
```

### redelivery, once the queue is reachable again, is processed — not treated as a duplicate

```file:config.yaml
config:
  port: 18740
  server:
    timeout: 5000
  api:
    "GET /{channel}/{bot}/webhook":
      command: aux4 bot verify --configFile config.yaml --config bot
      public: true
    "POST /{channel}/{bot}/webhook":
      command: aux4 bot ingest --configFile config.yaml --config bot
      public: true
  bot:
    channels: ["echo"]
    db: "test-bot-state.db"
    tmpDir: "test-bot-tmp"
    queueName: "bot.e2e.test"
    queueUrl: "http://localhost:18741"
    dedupeTtl: 300
    defaults:
      threadTtl: 3600
      replyTtl: 3600
      brainTimeout: 5000
      brainRetries: 1
    bots:
      support:
        channel: echo
        secret: testsecret
        outbox: "test-outbox.ndjson"
        command: "echo"
```

```execute
node -e '
const c = require("crypto");
const body = JSON.stringify({ events: [{ id: "evt-e2e-enqueue-fail", chatId: "chat-2", text: "should retry" }] });
const sig = c.createHmac("sha256", "testsecret").update(body, "utf8").digest("hex");
require("fs").writeFileSync("e2e-body2.json", body);
console.log(sig);
' > e2e-sig2.txt
curl -s -w "\nHTTP:%{http_code}\n" -X POST "http://localhost:18740/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: $(cat e2e-sig2.txt)" --data-binary @e2e-body2.json
sleep 1.5
cat test-outbox.ndjson
rm -f e2e-sig2.txt e2e-body2.json
```

```expect:partial
HTTP:200**{"type":"typing","chatId":"chat-2"}**{"type":"message","chatId":"chat-2","text":"should retry*
```
