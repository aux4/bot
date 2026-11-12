#### Description

`work` processes exactly **one** message and exits — the unit `aux4 bot
worker`'s loop repeats forever, and that a Lambda-style single invocation
can call once per trigger. It dispatches via a validated dynamic subcommand
(`aux4 bot value(mode) ...`) to one of two internal commands:

- **`pull`** (default): self-leases the next eligible message from the
  work queue via `aux4 bot provider` (honoring `--group` exclusivity
  automatically — one message per chat at a time), processes it — renewing
  the lease every half of `queue.visibility` while the brain runs (see
  "Long-running brains" below) — and acks on success or nacks on a brain
  failure. aux4/queue's own `attempts` + `maxAttempts` (set on `queue
  create`) handle the retry count and dead-lettering — there is no
  additional in-process retry here. On a final (dead-lettering) failure,
  sends `bot.failureMessage` to the chat first, if configured.
- **`push`**: the aux4/api route handler for `POST /bot/work`. Processes
  the `{channel,botId,event}` message given directly in the request body —
  there is no lease, because nothing was leased from a queue; the message
  arrived as a push (a work queue's own retry-safe `--webhook`, aux4/queue
  >=0.2.3, or any system that can POST JSON). Replies `200` on success,
  `502` on a brain failure.

Processing a message (either mode) does, in order: plugin `typing`
(best-effort) → load conversation history → plugin `download` per
attachment → run the brain command (`text in -> markdown out`) → claim the
**reply-once guard** (`reply:<channel>:<botId>:<event.key>`, before sending
anything — this is what makes a crash-and-redelivery of the same message
safe) → save conversation (sliding `threadTtl`) → plugin `format` → plugin
`send`.

**Push mode retry-safety depends on the webhook's queue.** A **work**
queue's `--webhook` push goes through lease/ack/nack (a `502` here nacks,
redelivered and eventually dead-lettered); a plain **pub/sub** queue's
`--webhook` is still fire-and-forget by design (it never holds a lease).

**Long-running brains (pull mode):** `pull` renews the lease every half of
`queue.visibility` via `aux4 queue renew` while the brain runs, so a brain
that legitimately outlives `queue.visibility` is not redelivered to a
second worker mid-run. `brainTimeout` is unset by default (unbounded); set
it to cap a brain that may hang instead of just running long.

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
