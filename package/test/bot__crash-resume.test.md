# aux4/bot crash/resume — exactly-once delivery across a worker restart (repository storage)

Repository storage is durable by construction: a leased message lives as a
row in a sqlite file, not in a process's memory, so killing the worker
mid-brain and starting a fresh one is exactly "restart" — no special resume
state is needed. This test proves the end-to-end guarantee: a message whose
worker is killed while the brain is still running is picked up by the next
worker and replied to exactly once (no missing reply, no duplicate reply).

```file:config.yaml
config:
  port: 18760
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
    db: "crash-bot-state.db"
    tmpDir: "crash-bot-tmp"
    dedupeTtl: 300
    queue:
      command: "aux4 queue"
      name: "bot_crash_test"
      storage: "repository"
      db: "crash-queue.db"
      visibility: "3"
      maxAttempts: "5"
      port: "18420"
      token: ""
    defaults:
      threadTtl: 3600
      replyTtl: 3600
    bots:
      support:
        channel: echo
        secret: testsecret
        outbox: "crash-outbox.ndjson"
        command: "node crash-brain.js"
```

```afterAll
aux4 api stop 2>/dev/null
pkill -f "bot worker" 2>/dev/null
pkill -f "crash-brain.js" 2>/dev/null
rm -f crash-bot-state.db crash-outbox.ndjson crash-queue.db crash-brain.js api.log worker1.log worker2.log
rm -f e2e-sig.txt e2e-body.json
rm -rf crash-bot-tmp .tmp
true
```

## Server startup

`crash-brain.js` is written once with a heredoc (not `file:`) for the same
reason as the other e2e suites: it is re-read on every leased message, and
`file:` fixtures are re-materialized before every nested test, which races
with that.

### should start the api server, serve the GET handshake, and accept the slow message

```timeout
20000
```

```execute
rm -f crash-bot-state.db crash-outbox.ndjson crash-queue.db
rm -rf crash-bot-tmp
cat > crash-brain.js <<'BRAINEOF'
async function main() {
  const text = process.argv[2] || "";
  if (text.startsWith("SLEEP:")) {
    const ms = parseInt(text.split(":")[1], 10) || 4000;
    await new Promise(r => setTimeout(r, ms));
  }
  console.log(text);
}
main();
BRAINEOF
nohup aux4 api start --configFile config.yaml >api.log 2>&1 &
sleep 1
curl -s "http://localhost:18760/api/echo/support/webhook?challenge=hs-crash-123"
echo
node -e '
const c = require("crypto");
const body = JSON.stringify({ events: [{ id: "evt-crash-1", chatId: "chat-crash", text: "SLEEP:5000" }] });
const sig = c.createHmac("sha256", "testsecret").update(body, "utf8").digest("hex");
require("fs").writeFileSync("e2e-body.json", body);
console.log(sig);
' > e2e-sig.txt
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18760/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: $(cat e2e-sig.txt)" --data-binary @e2e-body.json
rm -f e2e-sig.txt e2e-body.json
```

```expect:partial
hs-crash-123**200
```

## Kill mid-brain, restart, verify exactly-once delivery

### a worker killed while the brain is running never replies twice, and the restarted worker finishes the job

```timeout
20000
```

```execute
nohup aux4 bot worker --configFile config.yaml --config bot >worker1.log 2>&1 &
sleep 1
pkill -9 -f "crash-brain.js" 2>/dev/null
pkill -9 -f "bot worker" 2>/dev/null
sleep 1
touch crash-outbox.ndjson
BEFORE=$(grep -c '"type":"message"' crash-outbox.ndjson)
echo "replies-before-restart:$BEFORE"
sleep 3
nohup aux4 bot worker --configFile config.yaml --config bot >worker2.log 2>&1 &
sleep 8
pkill -f "bot worker" 2>/dev/null
AFTER=$(grep -c '"type":"message"' crash-outbox.ndjson)
echo "replies-after-restart:$AFTER"
```

```expect
replies-before-restart:0
replies-after-restart:1
```
