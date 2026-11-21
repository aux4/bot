# Bounded queue retries

```afterAll
rm -f retry-empty.db retry-empty.db-wal retry-empty.db-shm retry-state.db retry-state.db-wal retry-state.db-shm retry-queue.db retry-queue.db-wal retry-queue.db-shm retry-brain-count retry-outbox.ndjson retry-report.json
```

## an empty queue exits without waiting when no new work is expected

```execute
aux4 bot retry-work --queue '{"provider":"repository","name":"retry_empty","db":"retry-empty.db","visibility":30}'
```

```expect:json
{
  "processed": 0,
  "attempts": 1,
  "retries": 0,
  "failed": 0,
  "exhausted": false,
  "reason": "empty"
}
```

## expected work is not silently dropped after repeated empty leases

```execute
aux4 bot retry-work --queue '{"provider":"repository","name":"retry_empty","db":"retry-empty.db","visibility":30}' --expected 1 --attempts 2 --delay 0
```

```error:partial
Bot work retries exhausted
```

## a failed brain retries and sends exactly one reply

```file:retry-config.yaml
config:
  retry:
    channels: [echo]
    db: retry-state.db
    queue:
      provider: repository
      name: retry_inbox
      db: retry-queue.db
      visibility: 30
      maxAttempts: 5
    bots:
      support:
        channel: echo
        command: node retry-brain.mjs
        outbox: retry-outbox.ndjson
```

```file:retry-brain.mjs
import fs from "node:fs";
const calls = fs.existsSync("retry-brain-count") ? Number(fs.readFileSync("retry-brain-count", "utf8")) + 1 : 1;
fs.writeFileSync("retry-brain-count", String(calls));
if (calls === 1) process.exitCode = 1;
else process.stdout.write("recovered");
```

```execute
rm -f retry-brain-count retry-outbox.ndjson retry-report.json retry-state.db retry-queue.db
echo '{"channel":"echo","botId":"support","event":{"key":"retry-1","chatId":"retry-chat","text":"hello"}}' | aux4 queue send --provider repository --db retry-queue.db --name retry_inbox --group retry-chat
aux4 bot retry-work --configFile retry-config.yaml --config retry --expected 1 --attempts 3 --delay 0 >retry-report.json
node --input-type=module -e '
import fs from "node:fs";
import assert from "node:assert/strict";
const report = JSON.parse(fs.readFileSync("retry-report.json","utf8"));
assert.equal(report.processed,1);
assert.equal(report.retries,1);
assert.equal(report.exhausted,false);
assert.equal(fs.readFileSync("retry-brain-count","utf8"),"2");
const replies = fs.readFileSync("retry-outbox.ndjson","utf8").trim().split("\n").map(JSON.parse).filter(row=>row.type==="message");
assert.equal(replies.length,1);
assert.equal(replies[0].text,"recovered");
console.log("failed attempt recovered automatically; one reply");
'
```

```expect:partial
failed attempt recovered automatically; one reply
```
