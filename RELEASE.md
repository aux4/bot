# Release Notes

## 0.1.1

Review follow-ups from the BOT-003 dev review.

- **Fix: at-least-once enqueue.** `ingest` claims an event's dedupe id before
  enqueuing it onto `aux4/queue`. Previously, if the enqueue call failed
  (queue not running, no worker subscribed at that instant), the claim stayed
  — marking the event "seen" — while the webhook still acked `200`, so the
  platform never retried and the message was silently lost. `ingest` now
  releases the claim (deletes the dedupe record) on enqueue failure and acks
  `502` so the platform redelivers; the worker's reply-once guard still
  prevents a double reply on that redelivery.
- **Fix: `aux4 queue send` failure detection.** `aux4 queue send` always
  exits `0` and reports success/failure in its JSON stdout
  (`{"errors":N,"sent":N}`), including when the target port has nothing
  listening. `lib/queue.js`'s `sendMessage` now parses that output and
  rejects on a non-zero `errors` count — without this, ingest's
  claim-before-enqueue fix above could never detect the failure it exists to
  handle.
- Pinned `aux4/api@>=2.1.12` (byte-exact `event.rawBody`, required for HMAC
  signature verification) and `aux4/repository@>=1.3.4` (`repository claim`,
  the atomic dedupe/reply-once primitive) as explicit dependencies.
- README: removed a duplicated `## Configuration` section.

## 0.1.0

Initial release — generic multi-channel chatbot core: `GET`/`POST`
`/{channel}/{bot}/webhook` (verify → claim-dedupe → enqueue → ack) and
`aux4 bot worker` (typing → conversation state → brain → reply-once guard →
plugin send), plus `aux4 bot clean`. Channel plugins (WhatsApp, Slack, etc.)
extend the `bot` profile; ships with an in-repo `echo` reference plugin as
the end-to-end test fixture.
