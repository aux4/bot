#### Description

`work` processes exactly **one** message and exits — the unit `aux4 bot
worker`'s loop repeats forever, and that a Lambda-style single invocation
can call once per trigger. It has two modes:

- **`--mode pull`** (default): self-leases the next eligible message from
  the work queue (`<queue.command> lease`, honoring `--group` exclusivity
  automatically — one message per chat at a time), processes it, and acks
  on success or nacks on a brain failure. aux4/queue's own `attempts` +
  `maxAttempts` (set on `queue create`) handle the retry count and
  dead-lettering — there is no additional in-process retry here.
- **`--mode push`**: the aux4/api route handler for `POST /bot/work`.
  Processes the `{channel,botId,event}` message given directly in the
  request body — there is no lease, because nothing was leased from a
  queue; the message arrived as a push (e.g. aux4/queue's pub/sub
  `--webhook` proxy, or any system that can POST JSON). Replies `200` on
  success, `502` on a brain failure.

Processing a message (either mode) does, in order: plugin `typing`
(best-effort) → load conversation history → plugin `download` per
attachment → run the brain command (`text in -> markdown out`) → claim the
**reply-once guard** (`reply:<channel>:<botId>:<event.key>`, before sending
anything — this is what makes a crash-and-redelivery of the same message
safe) → save conversation (sliding `threadTtl`) → plugin `format` → plugin
`send`.

**Caveat (push mode):** aux4/queue's webhook proxy (0.2.2) is
fire-and-forget — it does not inspect `/bot/work`'s response status or
retry on failure. A `502` here is correct and future-compatible, but
nothing acts on it today; durable delivery needs `--mode pull` against a
real work queue.

**Known gap (pull mode, long brains):** aux4/queue has no lease-renew/
heartbeat primitive, so a message being processed by a brain that outlives
`queue.visibility` can be redelivered to a second worker while the first is
still running. Set `queue.visibility` generously for slow brains until
aux4/queue adds one; `brainTimeout` is unset by default (unbounded) as of
this version.

#### Usage

```bash
aux4 bot work --mode pull --configFile config.yaml --config bot
aux4 bot work --mode push --configFile config.yaml --config bot   # wired as the POST /bot/work route, not run by hand
```

--mode        `pull` (self-lease) or `push` (process the request body directly) (default: `pull`)
--channels    Allowlisted channel names (JSON array)
--bots        Map of botId -> per-bot config (JSON object)
--defaults    Shared defaults merged under every bot (JSON object)
--db          Repository database for event dedupe + conversations (default: `.bot/state.db`)
--tmpDir      Working directory for downloaded attachments (default: `.bot/tmp`)
--queue       Work-queue config (`--mode pull` only): `{command, name, storage, db, visibility, maxAttempts, port, token}`

#### Example

```yaml
config:
  api:
    "POST /bot/work":
      command: aux4 bot work --mode push --configFile config.yaml --config bot
      public: true
```

```bash
aux4 bot work --mode pull --configFile config.yaml --config bot
```

```text
{"leased":false}
```
