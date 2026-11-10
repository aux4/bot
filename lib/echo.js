import fs from "fs";
import path from "path";
import crypto from "crypto";

// The `echo` channel: a minimal, fully self-contained reference plugin used
// both as documentation-by-example and as the in-repo test fixture that
// exercises aux4/bot core end-to-end (verify -> ingest-parse -> claim ->
// queue -> worker -> format -> send) without depending on any real external
// platform.
//
// It implements the full six-command plugin contract:
//   verify, ingest-parse, send, typing, download, format
//
// Transport: instead of talking to a real chat platform, `send`/`typing`
// append an observable NDJSON line to `bot.outbox` (a file path supplied in
// the per-bot config) so a test can assert on what the worker delivered.
// `verify` implements a real HMAC-SHA256 signature check over the raw body
// (bot.secret), so the ingest route's "verify signature over rawBody" path
// is genuinely exercised, not stubbed out.

function readStdin() {
  return new Promise(resolve => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function reply(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function header(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function appendOutbox(outbox, entry) {
  if (!outbox) return;
  fs.mkdirSync(path.dirname(outbox), { recursive: true });
  fs.appendFileSync(outbox, JSON.stringify(entry) + "\n");
}

/**
 * verify — HMAC-SHA256 over the raw body, header `x-echo-signature`, using
 * bot.secret. A GET query `challenge` param is echoed back as the handshake
 * response (mirrors a real platform's verification ping) when present.
 */
export async function verify() {
  const input = JSON.parse((await readStdin()) || "{}");
  const { method, headers, query, rawBody, bot } = input;

  if (method === "GET" && query && query.challenge) {
    return reply({ valid: true, body: query.challenge });
  }

  const secret = bot && bot.secret;
  const signature = header(headers, "x-echo-signature");
  if (!secret) {
    return reply({ valid: false, statusCode: 500 });
  }
  if (!signature) {
    return reply({ valid: false, statusCode: 401 });
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody || "", "utf8")
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  return reply({ valid, statusCode: valid ? 200 : 401 });
}

/**
 * ingest-parse — the echo wire format is a JSON object with an `events`
 * array: [{ id, chatId, userId, text, threadId?, files? }]. Normalizes each
 * into the core's generic event shape.
 */
export async function ingestParse() {
  const input = JSON.parse((await readStdin()) || "{}");
  let payload = {};
  try {
    payload = JSON.parse(input.rawBody || "{}");
  } catch {
    payload = {};
  }

  const events = Array.isArray(payload.events) ? payload.events : [];
  const normalized = events.map(e => ({
    key: String(e.id),
    kind: e.kind || "message",
    chatId: e.chatId,
    userId: e.userId,
    text: e.text,
    files: e.files || [],
    threadId: e.threadId,
    ttl: 300
  }));

  reply(normalized);
}

/** typing — appends an observable {type:"typing"} line to the outbox. */
export async function typing() {
  const input = JSON.parse((await readStdin()) || "{}");
  const { event, bot } = input;
  appendOutbox(bot && bot.outbox, { type: "typing", chatId: event && event.chatId });
  reply({ ok: true });
}

/**
 * download — the echo wire format carries file content inline
 * ({ name, content }); "downloading" just writes it under tmpDir.
 */
export async function download() {
  const input = JSON.parse((await readStdin()) || "{}");
  const { file, tmpDir } = input;
  if (!file || !file.name) {
    return reply({ path: null });
  }
  const dir = tmpDir || ".";
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, file.name);
  fs.writeFileSync(filePath, file.content || "");
  reply({ path: filePath });
}

/** format — markdown passthrough (echo has no native rich-text format). */
export async function format() {
  const input = JSON.parse((await readStdin()) || "{}");
  reply({ text: input.markdown || "" });
}

/** send — appends an observable {type:"message"} line to the outbox. */
export async function send() {
  const input = JSON.parse((await readStdin()) || "{}");
  const { chatId, threadId, text, bot } = input;
  appendOutbox(bot && bot.outbox, { type: "message", chatId, threadId, text });
  reply({ ok: true });
}
