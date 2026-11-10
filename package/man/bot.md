#### Description

`aux4 bot` is the entry point for the generic multi-channel chatbot core. It
owns the always-async webhook lifecycle (verify → claim-dedupe → enqueue →
ack → work → reply-once → reply) and delegates platform transport (signature
verification, sending, typing, downloading, formatting) to a **channel
plugin**, and the "answer the question" step to a configured **brain** CLI
command.

Subcommands:

- **`verify`** — aux4/api route handler for `GET /{channel}/{bot}/webhook`
  (platform verification handshake). Internal; wired via config, not run
  directly.
- **`ingest`** — aux4/api route handler for `POST /{channel}/{bot}/webhook`
  (verify signature → claim dedupe → enqueue → ack). Internal; wired via
  config, not run directly.
- **`worker`** — long-running queue consumer: typing → conversation state →
  brain → reply-once claim → format → send, with retry-with-backoff around
  the brain call.
- **`clean`** — sweeps expired dedupe claims, reply-once guards,
  conversation state, and plugin installation rows.
- **`echo`** — the in-repo reference/test channel plugin (not a real
  platform).

See the package [README](https://hub.aux4.io/r/public/packages/aux4/bot) for
the full configuration shape, the claim-based dedupe design, and how to write
a channel plugin.

#### Usage

```bash
aux4 bot worker --configFile config.yaml --config bot
aux4 bot clean --configFile config.yaml --config bot
```

#### Example

```bash
aux4 queue start --port 8430
aux4 api start --configFile config.yaml
aux4 bot worker --configFile config.yaml --config bot
```
