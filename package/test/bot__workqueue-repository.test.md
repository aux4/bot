# aux4/bot end-to-end, via the echo reference plugin (repository storage)

Same pipeline as `bot__echo-e2e.test.md` (verify -> claim dedupe -> `aux4
queue send --group <chatId>` -> self-leasing `aux4 bot worker` -> ack/nack),
but with `bot.queue.storage: repository` — every queue command talks
directly to a sqlite file, with no `aux4 queue start` server process. The
bot's own `.aux4`/code is unchanged between storage modes; only the
`queue:` config block differs, confirming the "bot code must not branch on
storage" requirement.

```file:config.yaml
config:
  port: 18750
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
    db: "repo-bot-state.db"
    tmpDir: "repo-bot-tmp"
    dedupeTtl: 300
    queue:
      command: "queue"
      name: "bot_repo_test"
      storage: "repository"
      db: "repo-queue.db"
      visibility: "30"
      maxAttempts: "3"
      port: "18420"
      token: ""
    defaults:
      threadTtl: 3600
      replyTtl: 3600
    bots:
      support:
        channel: echo
        secret: testsecret
        outbox: "repo-outbox.ndjson"
        command: "node brain.js"
```

```afterAll
aux4 api stop 2>/dev/null
rm -f repo-bot-state.db repo-outbox.ndjson repo-queue.db api.log worker.log brain.js
rm -f .brain-marker-* e2e-sig*.txt e2e-body*.json
rm -rf repo-bot-tmp .tmp
pkill -f "bot worker" 2>/dev/null
pkill -f "bot work --mode pull" 2>/dev/null
true
```

## Server startup

`brain.js` is written once with a heredoc (not `file:`) for the same reason
as in `bot__echo-e2e.test.md`: it is re-read on every leased message for the
rest of the run, and `file:` fixtures are re-materialized before every
nested test, which raced with the spawn.

### should start the api server and the worker, and serve the GET handshake

```execute
rm -f repo-bot-state.db repo-outbox.ndjson repo-queue.db
rm -rf repo-bot-tmp
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
aux4 queue create --storage repository --db repo-queue.db --name bot_repo_test --maxAttempts 3 >/dev/null
nohup aux4 api start --configFile config.yaml >api.log 2>&1 &
sleep 1
nohup aux4 bot worker --configFile config.yaml --config bot >worker.log 2>&1 &
sleep 1
curl -s "http://localhost:18750/api/echo/support/webhook?challenge=hs-repo-123"
```

```expect
hs-repo-123
```

## POST ingest — claim, enqueue, self-leasing worker, reply (full pipeline)

### a correctly-signed event is acked, processed, and replied

```execute
node -e '
const c = require("crypto");
const body = JSON.stringify({ events: [{ id: "evt-repo-1", chatId: "chat-repo-1", text: "hello repo" }] });
const sig = c.createHmac("sha256", "testsecret").update(body, "utf8").digest("hex");
require("fs").writeFileSync("e2e-body.json", body);
console.log(sig);
' > e2e-sig.txt
curl -s -w "\nHTTP:%{http_code}\n" -X POST "http://localhost:18750/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: $(cat e2e-sig.txt)" --data-binary @e2e-body.json
sleep 2.5
cat repo-outbox.ndjson
rm -f e2e-sig.txt e2e-body.json
```

```expect:partial
HTTP:200**{"type":"typing","chatId":"chat-repo-1"}**{"type":"message","chatId":"chat-repo-1","text":"hello repo*
```

### a duplicate delivery of the same event id is acked but NOT reprocessed

```execute
node -e '
const c = require("crypto");
const body = JSON.stringify({ events: [{ id: "evt-repo-1", chatId: "chat-repo-1", text: "hello repo" }] });
const sig = c.createHmac("sha256", "testsecret").update(body, "utf8").digest("hex");
require("fs").writeFileSync("e2e-body.json", body);
console.log(sig);
' > e2e-sig.txt
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18750/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: $(cat e2e-sig.txt)" --data-binary @e2e-body.json)
sleep 1
rm -f e2e-sig.txt e2e-body.json
echo "ack:$HTTP lines:$(wc -l < repo-outbox.ndjson | tr -d ' ')"
```

```expect
ack:200 lines:2
```

## Per-chat ordering — two messages in one chat, processed in order, never in parallel

### both messages are replied to in the order they were sent

```timeout
20000
```

```execute
rm -f repo-outbox.ndjson
for N in 1 2; do
  node -e '
  const c = require("crypto");
  const body = JSON.stringify({ events: [{ id: "evt-repo-order-'"$N"'", chatId: "chat-repo-order", text: "repo-order-'"$N"'" }] });
  const sig = c.createHmac("sha256", "testsecret").update(body, "utf8").digest("hex");
  require("fs").writeFileSync("e2e-body.json", body);
  console.log(sig);
  ' > e2e-sig.txt
  curl -s -o /dev/null -X POST "http://localhost:18750/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: $(cat e2e-sig.txt)" --data-binary @e2e-body.json
  sleep 1.1
done
sleep 8
rm -f e2e-sig.txt e2e-body.json
grep '"type":"message"' repo-outbox.ndjson | sed -E 's/.*"text":"([^"]*)".*/\1/' | sed -E 's/\\n$//'
```

```expect
repo-order-1
repo-order-2
```

## Brain failure — nack, redeliver, succeed, reply

### a brain that fails once is nacked and redelivered, and eventually replies

```execute
rm -f repo-outbox.ndjson .brain-marker-chat-repo-retry
node -e '
const c = require("crypto");
const body = JSON.stringify({ events: [{ id: "evt-repo-retry-1", chatId: "chat-repo-retry", text: "FAIL_ONCE hello repo" }] });
const sig = c.createHmac("sha256", "testsecret").update(body, "utf8").digest("hex");
require("fs").writeFileSync("e2e-body.json", body);
console.log(sig);
' > e2e-sig.txt
curl -s -o /dev/null -X POST "http://localhost:18750/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: $(cat e2e-sig.txt)" --data-binary @e2e-body.json
sleep 3
rm -f e2e-sig.txt e2e-body.json .brain-marker-chat-repo-retry
cat repo-outbox.ndjson
```

```expect:partial
**{"type":"message","chatId":"chat-repo-retry","text":"FAIL_ONCE hello repo*
```

## maxAttempts — a message that always fails ends up in the dead-letter queue

### after maxAttempts nacks, the message is dead-lettered and no longer leasable

```timeout
30000
```

```execute
rm -f repo-outbox.ndjson
node -e '
const c = require("crypto");
const body = JSON.stringify({ events: [{ id: "evt-repo-dlq-1", chatId: "chat-repo-dlq", text: "FAIL_ALWAYS boom repo" }] });
const sig = c.createHmac("sha256", "testsecret").update(body, "utf8").digest("hex");
require("fs").writeFileSync("e2e-body.json", body);
console.log(sig);
' > e2e-sig.txt
curl -s -o /dev/null -X POST "http://localhost:18750/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: $(cat e2e-sig.txt)" --data-binary @e2e-body.json
sleep 20
rm -f e2e-sig.txt e2e-body.json
aux4 queue dlq --storage repository --db repo-queue.db --name bot_repo_test --maxAttempts 3 | jq -r '.[0].body.event.text'
```

```expect
FAIL_ALWAYS boom repo
```
