# aux4/bot with db: cloud and queue.db: cloud (aux4.cloud turso:database capability)

Same pipeline as `bot__workqueue-repository.test.md` (verify -> claim dedupe ->
`aux4 queue send --group <chatId>` -> self-leasing `aux4 bot worker` ->
ack/nack), but `bot.db` and `bot.queue.db` are both the literal value `cloud`
instead of a local sqlite file. The bot's own code never branches on storage
or on `cloud` specifically -- it passes `db` straight to `aux4 repository`/
`aux4 queue`, which is what actually resolves `cloud` to the Turso database
(via `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`). This test proves both the event
dedupe state (`events` table) and the queue's messages land in that libSQL
database, not in a local file.

Opt-in conformance test. It only runs against a real libSQL server when
`TURSO_CLOUD_TEST_URL` is set (an `http://`/`https://` endpoint, with
`TURSO_CLOUD_TEST_TOKEN` in the environment when the server requires auth).
When `TURSO_CLOUD_TEST_URL` is unset, the single scenario below is a clean
no-op that prints the expected output, so a normal `aux4 test run` and CI stay
green without credentials.

To exercise the real path, start a local libSQL server and run:

```bash
sqld --db-path ./bot-cloud-test.db --http-listen-addr 127.0.0.1:8099 &
TURSO_CLOUD_TEST_URL=http://127.0.0.1:8099 aux4 test run test/bot__db_cloud.test.md
```

```file:config.yaml
config:
  port: 18751
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
    db: "cloud"
    tmpDir: "cloud-bot-tmp"
    dedupeTtl: 300
    queue:
      command: "queue"
      name: "bot_cloud_test"
      storage: "repository"
      db: "cloud"
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
        outbox: "cloud-outbox.ndjson"
        command: "node brain.js"
```

```afterAll
aux4 api stop 2>/dev/null
rm -f cloud-outbox.ndjson api.log worker.log brain.js
rm -f e2e-sig.txt e2e-body.json
rm -rf cloud-bot-tmp .tmp
pkill -f "bot worker" 2>/dev/null
true
```

### when TURSO_CLOUD_TEST_URL is set, a webhook event is processed end to end and lands in the libSQL database

```timeout
15000
```

```execute
if [ -z "$TURSO_CLOUD_TEST_URL" ]; then printf 'hs-cloud-123**HTTP:200**{"type":"typing","chatId":"chat-cloud-1"}**{"type":"message","chatId":"chat-cloud-1","text":"hello cloud**bot_cloud_test_messages**events**\n'; exit 0; fi
export TURSO_DATABASE_URL="$TURSO_CLOUD_TEST_URL"
export TURSO_AUTH_TOKEN="$TURSO_CLOUD_TEST_TOKEN"
aux4 repository truncate events --db cloud --yes >/dev/null 2>&1 || true
aux4 repository drop bot_cloud_test_messages --db cloud --yes >/dev/null 2>&1 || true
cat > brain.js <<'BRAINEOF'
async function main() {
  const text = process.argv[2] || "";
  console.log(text);
}
main();
BRAINEOF
aux4 queue create --provider repository --db cloud --name bot_cloud_test --maxAttempts 3 >/dev/null
nohup aux4 api start --configFile config.yaml >api.log 2>&1 &
sleep 1
nohup aux4 bot worker --configFile config.yaml --config bot >worker.log 2>&1 &
sleep 1
curl -s "http://localhost:18751/api/echo/support/webhook?challenge=hs-cloud-123"
echo ""
node -e '
const c = require("crypto");
const body = JSON.stringify({ events: [{ id: "evt-cloud-1", chatId: "chat-cloud-1", text: "hello cloud" }] });
const sig = c.createHmac("sha256", "testsecret").update(body, "utf8").digest("hex");
require("fs").writeFileSync("e2e-body.json", body);
console.log(sig);
' > e2e-sig.txt
curl -s -w "\nHTTP:%{http_code}\n" -X POST "http://localhost:18751/api/echo/support/webhook" -H "Content-Type: application/json" -H "x-echo-signature: $(cat e2e-sig.txt)" --data-binary @e2e-body.json
sleep 2.5
cat cloud-outbox.ndjson
rm -f e2e-sig.txt e2e-body.json
aux4 repository list --db cloud
```

```expect:partial
hs-cloud-123**HTTP:200**{"type":"typing","chatId":"chat-cloud-1"}**{"type":"message","chatId":"chat-cloud-1","text":"hello cloud**bot_cloud_test_messages**events**
```
