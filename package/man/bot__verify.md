#### Description

Internal aux4/api route handler for `GET /{channel}/{bot}/webhook` — the
platform's verification handshake. Not meant to be run directly; it is wired
into `config.api` and invoked by `aux4 api start`/`aux4 api handle`.

Resolves `{channel}`/`{bot}` against the `channels` allowlist and the `bots`
map; an unknown channel or bot id is a clean 404 (never a 401/500, so a
misconfigured route never leaks which part failed). When resolved, delegates
to the channel plugin's `verify` command, passing the request method,
headers, query parameters, and raw body. The plugin's response becomes the
HTTP response: `{valid:true, body}` → 200 with `body` as the response (e.g.
an echoed challenge token); `{valid:false, statusCode}` → that status (401
by default).

#### Usage

```yaml
config:
  api:
    "GET /{channel}/{bot}/webhook":
      command: aux4 bot verify --configFile config.yaml --config bot
      public: true
```

#### Example

A platform's verification ping (`?challenge=abc123`) reaching a configured
`echo` bot gets the challenge echoed back:

```text
GET /api/echo/support/webhook?challenge=abc123  ->  200 "abc123"
```
