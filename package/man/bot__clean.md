#### Description

`clean` removes every expired record (ttl in the past) from every repository
table the configured database holds — the inbound event dedupe claims, the
reply-once guards, the sliding-ttl conversation state, and any
`installations` rows a channel plugin keeps for its own OAuth/install
bookkeeping. It is a thin wrapper over `aux4 repository clean --db <db>`,
which sweeps all tables in one call.

Run it periodically (e.g. via `aux4 cron` on an hourly schedule) so claimed
ids older than their ttl window are freed for reuse and the database does
not grow unbounded.

#### Usage

```bash
aux4 bot clean --configFile config.yaml --config bot
```

--db   Repository database — local sqlite path or `libsql://` URL (default: `.bot/state.db`)

#### Example

```bash
aux4 bot clean --configFile config.yaml --config bot
```

```text
events: 3 expired records removed
conversations: 1 expired records removed
installations: 0 expired records removed
```
