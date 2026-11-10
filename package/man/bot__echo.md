#### Description

`echo` is the channel plugin shipped in-repo with aux4/bot — a loopback
fixture used to exercise and demonstrate the core end-to-end, **not a real
chat platform**. It implements the full six-command plugin contract
(`verify`, `ingest-parse`, `typing`, `download`, `format`, `send`); see the
package README's "Writing a channel plugin" section for the contract every
real channel plugin (WhatsApp, Telegram, Slack, Messenger, …) must implement.

- **`verify`** — HMAC-SHA256 over the raw request body using the bot's
  `secret`, compared against the `x-echo-signature` header. A GET request
  carrying a `challenge` query parameter is echoed back as the handshake
  response.
- **`ingest-parse`** — the echo wire format is `{"events":[{id, chatId,
  userId, text, threadId?, files?}, ...]}`; each element is normalized into
  the core's generic event shape (`key` = `id`, `ttl` fixed at 300s).
- **`typing`** / **`send`** — instead of calling a real API, both append an
  observable NDJSON line (`{type:"typing", ...}` / `{type:"message", ...}`)
  to the bot's configured `outbox` file, so a test (or a human) can assert on
  what the worker actually delivered.
- **`download`** — the echo wire format carries file content inline
  (`{name, content}`); "downloading" just writes it to `tmpDir`.
- **`format`** — Markdown passthrough (echo has no native rich-text format).

These subcommands are invoked by the core (`aux4 bot verify`/`ingest`/
`worker`) and are not meant to be run directly.

#### Usage

```yaml
config:
  bot:
    channels: ["echo"]
    bots:
      support:
        channel: echo
        secret: ${ECHO_SIGNING_SECRET}
        outbox: "./.bot/echo-outbox.ndjson"
        command: "cat"
```

#### Example

```bash
echo '{"events":[{"id":"evt1","chatId":"c1","text":"hello"}]}' > body.json
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','mysecret').update(require('fs').readFileSync('body.json')).digest('hex'))")
curl -X POST "http://localhost:8080/api/echo/support/webhook" \
  -H "Content-Type: application/json" -H "x-echo-signature: $SIG" \
  --data-binary @body.json
```

```text
200 {}
```

A running `aux4 bot worker` then appends the reply to `./.bot/echo-outbox.ndjson`.
