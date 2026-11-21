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

Processing a message (either mode) does, in order: fire the per-bot
`onMessage` hook, if configured (fire-and-forget — never awaited on this
path, so a slow or failing hook never delays or blocks the reply; see
"onMessage hook" below) → plugin `typing` (best-effort) → load conversation
history → plugin `download` per attachment → run the brain command (`text
in -> markdown out`), with a keep-alive `typing` re-raised periodically and
an optional one-shot `progressMessage` while it runs (see "Keep-alive
typing and progressMessage" below) → claim the **reply-once guard**
(`reply:<channel>:<botId>:<event.key>`, before sending anything — this is
what makes a crash-and-redelivery of the same message safe) → save
conversation (sliding `threadTtl`) → **if the brain's answer is empty or
whitespace-only, stop here: nothing is sent, the message still acks
normally, and the attempt is logged as a `no-reply` entry** (see "Message
log" below) → otherwise plugin `format` → plugin `send` → log the outbound
message.

**onMessage hook:** `bot.onMessage`, when set, is a command run for every
inbound message, independent of the reply — the full `{channel, botId,
event}` message is written to its stdin as JSON. It runs fire-and-forget
(not awaited): its own failure (non-zero exit) is logged and never blocks,
delays, or nacks the reply.

**Keep-alive typing and progressMessage:** while the brain runs, the
plugin's `typing` indicator is re-raised every `bot.typingInterval` seconds
(default `20`; set `0` to disable) so it never goes stale on a slow brain.
If `bot.progressMessage` is set, it is sent once — via plugin `send`, then
logged — after `bot.progressMessageDelay` seconds (default `15`) if the
brain is still running by then.

**Message log:** every inbound and outbound message (including a
`no-reply` on empty brain output) is written to the persistent message log
(`aux4 bot conversations`/`aux4 bot messages`), retained per
`bot.messageLogTtl` (default 30 days; `"off"` disables logging for that
bot). See `bot__conversations.md`/`bot__messages.md`.

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

Queue leasing distinguishes an empty queue from an execution failure. The
provider’s documented exit-4 empty response returns `{"leased":false}`.
Authentication, connection, database and malformed-response errors fail the
command; they are not reported as an empty queue. Diagnostics omit provider
credentials and response bodies. This does not add an automatic retry scheduler.
