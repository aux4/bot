# aux4/bot end-to-end, via the echo reference plugin (memory storage)

Exercises the full core pipeline over real HTTP, with no real chat platform:
`aux4 api` serves the webhook routes, `aux4 bot ingest` verifies the HMAC
signature over the byte-exact raw body, claims the event for dedupe, and
composes `aux4 queue send --group <chatId>` to enqueue it onto a real
`aux4 queue` work queue; a real `aux4 bot worker` self-leases messages one at
a time (`aux4 bot work --mode pull`), runs the brain (`echo`, so the reply
text equals the inbound text), and the `echo` plugin's `send`/`typing`
append observable lines to a local outbox file.

```file:config.yaml
config:
  port: 18740
  server:
    timeout: 20000
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
    dedupeTtl: 300
    queue:
      command: "aux4 queue"
      name: "bot.e2e.test"
      storage: "memory"
      db: ".queue.db"
      visibility: "30"
      maxAttempts: "3"
      port: "18741"
      token: ""
    defaults:
      threadTtl: 3600
      replyTtl: 3600
    bots:
      support:
        channel: echo
        secret: testsecret
        outbox: "test-outbox.ndjson"
        command: "node brain.js"
```

```afterAll
aux4 api stop 2>/dev/null
aux4 queue stop --port 18741 2>/dev/null
rm -f test-bot-state.db test-outbox.ndjson queue.log api.log worker.log .queue.db brain.js
rm -f .brain-marker-* e2e-sig*.txt e2e-body*.json
rm -rf test-bot-tmp .tmp
pkill -f "bot worker" 2>/dev/null
true
```

## Server startup

A `beforeAll` hook runs BEFORE `file:` fixtures materialize, so the queue,
api, and worker processes (which all need `config.yaml` on disk at startup)
are started here, in the first `execute` block, instead.

`brain.js` is written here with `cat > ... <<EOF` rather than a `file:`
block on purpose: `file:` fixtures are re-materialized before every nested
test in this suite, and the long-running `aux4 bot worker` started below
spawns `node brain.js` fresh on every leased message for the rest of the
run — a `file:` rewrite racing with that spawn intermittently truncated the
file mid-read (seen as a spurious nack). Writing it once, before the worker
starts, avoids the race.

### should start the queue, the api server, and the worker, and serve the GET handshake

```execute
rm -f test-bot-state.db test-outbox.ndjson .queue.db
rm -rf test-bot-tmp
rm -f .brain-marker-*
cat > brain.js <<'BRAINEOF'
import fs from "fs";

async function main() {
  const text = process.argv[2] || "";
  const chatId = process.env.AUX4BOT_CHAT_ID || "";

  if (text.startsWith("FAIL_ALWAYS")) {
    process.stderr.write("boom-always\n");
    process.exit(1);
  }

  if (text.startsWith("FAIL_ONCE")) {
    const marker = `.brain-marker-${chatId}`;
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, "1");
      process.stderr.write("boom-once\n");
      process.exit(1);
    }
  }

  console.log(text);
}

main();
BRAINEOF
nohup aux4 queue start --port 18741 >queue.log 2>&1 &
sleep 1
aux4 queue create --port 18741 --name bot.e2e.test --workQueue true --maxAttempts 3 >/dev/null
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

## POST ingest — claim, enqueue, self-leasing worker, reply (full pipeline)

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
sleep 2.5
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

## Per-chat ordering — two messages in one chat, processed in order, never in parallel

### both messages are replied to in the order they were sent

```timeout
15000
```

```execute
rm -f test-outbox.ndjson
for N in 1 2; do
  node -e '
  const c = require("crypto");
  const body = JSON.stringify({ events: [{ id: "evt-order-'"$N"'", chatId: "chat-order", text: "order-'"$N"'" }] });
  const sig = c.createHmac("sha256", "testsecret").update(body, "utf8").digest("hex");
  require("fs").writeFileSync("e2e-body.json", body);
  console.log(sig);
  ' > e2e-sig.txt
  curl -s -o /dev/null -X POST "http://localhost:18740/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: $(cat e2e-sig.txt)" --data-binary @e2e-body.json
done
sleep 8
rm -f e2e-sig.txt e2e-body.json
grep '"type":"message"' test-outbox.ndjson | sed -E 's/.*"text":"([^"]*)".*/\1/' | sed -E 's/\\n$//'
```

```expect
order-1
order-2
```

## Brain failure — nack, redeliver, succeed, reply

### a brain that fails once is nacked and redelivered, and eventually replies

```timeout
10000
```

```execute
rm -f test-outbox.ndjson .brain-marker-chat-retry
node -e '
const c = require("crypto");
const body = JSON.stringify({ events: [{ id: "evt-retry-1", chatId: "chat-retry", text: "FAIL_ONCE hello" }] });
const sig = c.createHmac("sha256", "testsecret").update(body, "utf8").digest("hex");
require("fs").writeFileSync("e2e-body.json", body);
console.log(sig);
' > e2e-sig.txt
curl -s -o /dev/null -X POST "http://localhost:18740/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: $(cat e2e-sig.txt)" --data-binary @e2e-body.json
sleep 5
rm -f e2e-sig.txt e2e-body.json .brain-marker-chat-retry
cat test-outbox.ndjson
```

```expect:partial
**{"type":"message","chatId":"chat-retry","text":"FAIL_ONCE hello*
```

## maxAttempts — a message that always fails ends up in the dead-letter queue

### after maxAttempts nacks, the message is dead-lettered and no longer leasable

```timeout
30000
```

```execute
rm -f test-outbox.ndjson
node -e '
const c = require("crypto");
const body = JSON.stringify({ events: [{ id: "evt-dlq-1", chatId: "chat-dlq", text: "FAIL_ALWAYS boom" }] });
const sig = c.createHmac("sha256", "testsecret").update(body, "utf8").digest("hex");
require("fs").writeFileSync("e2e-body.json", body);
console.log(sig);
' > e2e-sig.txt
curl -s -o /dev/null -X POST "http://localhost:18740/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: $(cat e2e-sig.txt)" --data-binary @e2e-body.json
sleep 20
rm -f e2e-sig.txt e2e-body.json
aux4 queue dlq --name bot.e2e.test --port 18741 | jq -r '.[0].body.event.text'
```

```expect
FAIL_ALWAYS boom
```

## POST ingest — enqueue failure releases the claim for retry

Simulates "the queue is not running" by pointing `bot.queue.port` at a port
nothing is listening on, so the DSL-composed `aux4 queue send` fails inside
ingest's enqueue step after the event has already been claimed.

### queue unreachable: enqueue fails, the claim is released, and the ack is 5xx

```file:config.yaml
config:
  port: 18740
  server:
    timeout: 20000
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
    dedupeTtl: 300
    queue:
      command: "aux4 queue"
      name: "bot.e2e.test"
      storage: "memory"
      db: ".queue.db"
      visibility: "30"
      maxAttempts: "3"
      port: "18799"
      token: ""
    defaults:
      threadTtl: 3600
      replyTtl: 3600
    bots:
      support:
        channel: echo
        secret: testsecret
        outbox: "test-outbox.ndjson"
        command: "node brain.js"
```

```execute
aux4 api stop 2>/dev/null
sleep 1
nohup aux4 api start --configFile config.yaml >api.log 2>&1 &
sleep 1
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
    timeout: 20000
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
    dedupeTtl: 300
    queue:
      command: "aux4 queue"
      name: "bot.e2e.test"
      storage: "memory"
      db: ".queue.db"
      visibility: "30"
      maxAttempts: "3"
      port: "18741"
      token: ""
    defaults:
      threadTtl: 3600
      replyTtl: 3600
    bots:
      support:
        channel: echo
        secret: testsecret
        outbox: "test-outbox.ndjson"
        command: "node brain.js"
```

```timeout
15000
```

```execute
aux4 api stop 2>/dev/null
sleep 1
nohup aux4 api start --configFile config.yaml >api.log 2>&1 &
sleep 1
rm -f test-outbox.ndjson
node -e '
const c = require("crypto");
const body = JSON.stringify({ events: [{ id: "evt-e2e-enqueue-fail", chatId: "chat-2", text: "should retry" }] });
const sig = c.createHmac("sha256", "testsecret").update(body, "utf8").digest("hex");
require("fs").writeFileSync("e2e-body2.json", body);
console.log(sig);
' > e2e-sig2.txt
curl -s -w "\nHTTP:%{http_code}\n" -X POST "http://localhost:18740/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: $(cat e2e-sig2.txt)" --data-binary @e2e-body2.json
sleep 2.5
cat test-outbox.ndjson
rm -f e2e-sig2.txt e2e-body2.json
```

```expect:partial
HTTP:200**{"type":"typing","chatId":"chat-2"}**{"type":"message","chatId":"chat-2","text":"should retry*
```
