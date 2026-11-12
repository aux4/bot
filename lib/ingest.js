import { readStdin, reply } from "./stdin.js";
import { resolveBot, parseMaybeJson } from "./config.js";
import { callPlugin } from "./plugin.js";
import { callProvider } from "./provider.js";
import { claim, release } from "./repository.js";

/**
 * aux4/api route handler for POST /{channel}/{bot}/webhook — the always-async
 * inbound path:
 *
 *   verify signature (plugin, over the byte-exact rawBody) -> claim(channel:bot:key)
 *   -> report what (if anything) needs to be enqueued
 *
 * Unlike the old pub/sub design, this function never calls `aux4 queue`
 * itself — enqueueing is composed in package/.aux4 (`aux4 queue send
 * --group <chatId>`), so the queue call lives in the DSL, not here. This
 * function only does the plugin/repository work the DSL can't: verifying
 * the signature, parsing the payload, and claiming dedupe ids.
 *
 * Unknown channel/bot -> clean 404. Signature rejected -> 401. A duplicate
 * delivery (claim fails because the event id is already seen) is silently
 * skipped — NOT an error — and the whole request still acks 200, because by
 * definition the platform already got a successful ack for it once.
 *
 * Returns `{statusCode, body, toSend}`. `toSend` is `[]` for every terminal
 * case (404/401/handshake/parse-error/all-duplicates); otherwise it holds
 * one `{id, group, msgBody}` per newly-claimed event in the batch, for
 * `ingestSend` to enqueue.
 *
 * args: channels, bots, defaults, db, dedupeTtl
 */
export async function ingestPrepare(args) {
  const [channelsArg, botsArg, defaultsArg, db, dedupeTtlArg] = args;
  const dedupeTtl = dedupeTtlArg || 300;

  let event;
  try {
    event = JSON.parse((await readStdin()) || "{}");
  } catch {
    event = {};
  }

  const channel = event.pathParameters && event.pathParameters.channel;
  const botId = event.pathParameters && event.pathParameters.bot;

  const bot = resolveBot(channelsArg, botsArg, defaultsArg, channel, botId);
  if (!bot) {
    return reply({ statusCode: 404, body: JSON.stringify({ message: "Not Found" }), toSend: [] });
  }

  // rawBody is byte-exact (aux4/api rawBody support, see BOT-009); fall back
  // to body for an older installed aux4/api.
  const rawBody = event.rawBody != null ? event.rawBody : event.body || "";

  let verifyResult;
  try {
    verifyResult = await callPlugin(channel, "verify", {
      method: "POST",
      headers: event.headers || {},
      query: event.queryStringParameters || {},
      rawBody,
      bot
    });
  } catch (err) {
    process.stderr.write(`[bot ingest] plugin ${channel} verify failed: ${err.message}\n`);
    return reply({ statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }), toSend: [] });
  }

  if (!verifyResult || typeof verifyResult !== "object" || !verifyResult.valid) {
    const statusCode = (verifyResult && verifyResult.statusCode) || 401;
    return reply({ statusCode, body: JSON.stringify({ message: "Unauthorized" }), toSend: [] });
  }

  // Some providers run their verification handshake over POST (e.g. Slack's
  // url_verification). When the plugin's verify step already produced the
  // full handshake body, short-circuit here instead of parsing events.
  if (verifyResult.challengeResponse !== undefined) {
    return reply({ statusCode: 200, body: String(verifyResult.challengeResponse), toSend: [] });
  }

  let parsed;
  try {
    parsed = await callPlugin(channel, "ingest-parse", {
      headers: event.headers || {},
      query: event.queryStringParameters || {},
      rawBody,
      bot
    });
  } catch (err) {
    process.stderr.write(`[bot ingest] plugin ${channel} ingest-parse failed: ${err.message}\n`);
    // Ack anyway — a malformed/unparseable payload is not something a retry
    // from the platform will fix, and we must not leave the webhook hanging.
    return reply({ statusCode: 200, body: "{}", toSend: [] });
  }

  const events = Array.isArray(parsed) ? parsed : [];

  const toSend = [];
  for (const evt of events) {
    if (!evt || !evt.key) continue;
    const id = `${channel}:${botId}:${evt.key}`;
    const ttl = evt.ttl || dedupeTtl;
    let claimed;
    try {
      claimed = await claim(db, "events", id, { channel, botId, kind: evt.kind }, ttl);
    } catch (err) {
      process.stderr.write(`[bot ingest] claim failed for ${id}: ${err.message}\n`);
      continue;
    }
    if (!claimed) continue; // duplicate delivery — already processed/queued once

    const group = String(evt.threadId || evt.chatId || "");
    toSend.push({ id, group, msgBody: { channel, botId, event: evt } });
  }

  return reply({ statusCode: 200, body: "{}", toSend });
}

/**
 * Releases the claim for an event whose enqueue failed, so the platform's
 * retry of the same event is not treated as a duplicate, and replies 502 so
 * the platform actually retries.
 */
async function ingestFail(db, id, sendReply = true) {
  try {
    await release(db, "events", id);
  } catch (err) {
    process.stderr.write(`[bot ingest] release failed for ${id}: ${err.message}\n`);
  }
  if (sendReply) {
    reply({ statusCode: 502, body: JSON.stringify({ message: "Enqueue failed, retry" }) });
  }
}

/**
 * Send one claimed event to the work queue via the validated provider
 * dispatch (`aux4 bot provider <queue.command> send ...` — see provider.js).
 * Returns true on success; on failure releases the event's claim (so a
 * platform retry is not treated as a duplicate) and returns false.
 */
async function sendOne(providerKey, queue, db, item) {
  try {
    const out = await callProvider(
      providerKey,
      "send",
      {
        name: queue.name || "",
        storage: queue.storage || "memory",
        db: queue.db || "",
        port: queue.port || "",
        token: queue.token || "",
        group: item.group || ""
      },
      item.msgBody
    );

    // memory storage always exits 0 and reports failures as JSON
    // ({"errors":N,"sent":N}); repository storage exits non-zero on a real
    // failure (caught below) and otherwise prints a bare id. Checking both
    // shapes covers either storage without this code branching on which
    // one is configured.
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object" && Number(parsed.errors) > 0) {
      await ingestFail(db, item.id, false);
      return false;
    }
    return true;
  } catch (err) {
    process.stderr.write(`[bot ingest] enqueue failed for ${item.id}: ${err.message}\n`);
    await ingestFail(db, item.id, false);
    return false;
  }
}

/**
 * Send every claimed event (0..N — a batched webhook payload may claim
 * several new events at once) to the work queue, then reply: the success
 * reply computed by `ingestPrepare` if every send succeeded, or a 502 if
 * any failed (claims for the failed ones are released above so the
 * platform's retry re-sends only those, not treated as duplicates — the
 * ones that already succeeded stay claimed and are skipped on retry).
 *
 * args: queue (JSON), db, toSend (JSON array), replyStatus, replyBody
 */
export async function ingestSend(args) {
  const [queueArg, db, toSendArg, replyStatus, replyBody] = args;
  const queue = parseMaybeJson(queueArg, {}) || {};
  const toSend = parseMaybeJson(toSendArg, []) || [];
  const providerKey = queue.command || "queue";

  if (!Array.isArray(toSend) || toSend.length === 0) {
    return reply({ statusCode: Number(replyStatus), body: replyBody !== undefined ? replyBody : "" });
  }

  let allSucceeded = true;
  for (const item of toSend) {
    const ok = await sendOne(providerKey, queue, db, item);
    if (!ok) allSucceeded = false;
  }

  if (allSucceeded) {
    return reply({ statusCode: Number(replyStatus), body: replyBody !== undefined ? replyBody : "" });
  }
  return reply({ statusCode: 502, body: JSON.stringify({ message: "Enqueue failed, retry" }) });
}

/**
 * Prints the final HTTP reply computed by `ingestPrepare` (or a literal
 * override). A tiny dedicated step so package/.aux4 never has to embed
 * hand-escaped JSON literals.
 *
 * args: statusCode, body
 */
export async function ingestReply(args) {
  const [statusCode, body] = args;
  reply({ statusCode: Number(statusCode), body: body !== undefined ? body : "" });
}
