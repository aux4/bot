import { readStdin, reply } from "./stdin.js";
import { resolveBot, queuePort } from "./config.js";
import { callPlugin } from "./plugin.js";
import { claim } from "./repository.js";
import { sendMessage } from "./queue.js";

/**
 * aux4/api route handler for POST /{channel}/{bot}/webhook — the always-async
 * inbound path:
 *
 *   verify signature (plugin, over the byte-exact rawBody) -> claim(channel:bot:key)
 *   -> enqueue -> ack 200
 *
 * Unknown channel/bot -> clean 404. Signature rejected -> 401. A duplicate
 * delivery (claim fails because the event id is already seen) is silently
 * skipped — NOT an error — and the whole request still acks 200, because by
 * definition the platform already got a successful ack for it once.
 *
 * args: channels, bots, defaults, db, queueName, queueUrl, dedupeTtl
 */
export async function ingest(args) {
  const [channelsArg, botsArg, defaultsArg, db, queueName, queueUrl, dedupeTtlArg] = args;
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
    return reply({ statusCode: 404, body: JSON.stringify({ message: "Not Found" }) });
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
    return reply({ statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) });
  }

  if (!verifyResult || typeof verifyResult !== "object" || !verifyResult.valid) {
    const statusCode = (verifyResult && verifyResult.statusCode) || 401;
    return reply({ statusCode, body: JSON.stringify({ message: "Unauthorized" }) });
  }

  // Some providers run their verification handshake over POST (e.g. Slack's
  // url_verification). When the plugin's verify step already produced the
  // full handshake body, short-circuit here instead of parsing events.
  if (verifyResult.challengeResponse !== undefined) {
    return reply({ statusCode: 200, body: String(verifyResult.challengeResponse) });
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
    return reply({ statusCode: 200, body: "{}" });
  }

  const events = Array.isArray(parsed) ? parsed : [];
  const port = queuePort(queueUrl);

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

    try {
      await sendMessage(port, queueName, { channel, botId, event: evt });
    } catch (err) {
      process.stderr.write(`[bot ingest] enqueue failed for ${id}: ${err.message}\n`);
    }
  }

  return reply({ statusCode: 200, body: "{}" });
}
