#### Description

`complete` accepts a callback from a configured brain in `replyMode:
callback`. The request id is the only routing key accepted from the caller;
the bot resolves channel, chat, and thread from the durable request created
before the brain started. A completed request is idempotent and returns a
duplicate receipt without sending again. Values are never read from the
request back into the callback caller.

#### Usage

```bash
printf '%s' '{"requestId":"req:<opaque>","status":"completed","reply":"answer"}' |
  aux4 bot complete --channels '["whatsapp"]' --bots '<json>' --db cloud
```

--channels  Allowlisted channel names
--bots      Map of bot ids to channel configuration
--defaults  Shared bot defaults
--db        Repository database containing callback requests

The accepted status values are `completed` and `failed`. A failed completion
is recorded and causes the awaiting worker invocation to nack. Unknown ids,
correlation mismatches, and repository claim failures are rejected before any
provider send.

#### Example

```text
{"accepted":true}
```
