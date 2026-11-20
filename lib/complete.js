import { resolveBot } from "./config.js";
import { claim, readRecord, release, writeRecord } from "./repository.js";
import { callPlugin } from "./plugin.js";
import { readStdin, reply } from "./stdin.js";
import { logMessage } from "./messagelog.js";

function fail(message) {
  throw new Error(message);
}

function suppliedCorrelationMatches(input, request) {
  const pairs = [
    ["channel", request.channel],
    ["botId", request.botId],
    ["chatId", request.chatId],
    ["threadId", request.threadId],
    ["conversationId", request.conversationId],
    ["messageId", request.messageId]
  ];
  return pairs.every(([key, expected]) => input[key] === undefined || String(input[key]) === String(expected));
}

/**
 * Complete a previously dispatched callback request.  The callback supplies
 * only the opaque request id and result.  Stored routing is authoritative;
 * caller-supplied channel/chat fields are accepted only as matching
 * correlation assertions and are never used for delivery.
 */
export async function completeCommand(args) {
  const [channelsArg, botsArg, defaultsArg, db] = args;
  let input;
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {
    fail("completion input must be JSON");
  }

  const requestId = String(input.requestId || "");
  if (!/^req:[a-f0-9]{64}$/.test(requestId)) fail("invalid requestId");
  if (!Object.prototype.hasOwnProperty.call(input, "status")) fail("status is required");
  if (input.status !== "completed" && input.status !== "failed") fail("invalid completion status");

  const request = await readRecord(db, "requests", requestId);
  if (!request) fail("unknown requestId");
  if (!suppliedCorrelationMatches(input, request)) fail("completion correlation mismatch");

  if (request.status === "completed") {
    reply({ accepted: true, duplicate: true });
    return;
  }

  if (input.status === "failed") {
    await writeRecord(db, "requests", requestId, { ...request, status: "failed" }, request.replyTtl || undefined);
    reply({ accepted: true });
    return;
  }

  if (typeof input.reply !== "string") fail("reply is required for completed status");
  const bot = resolveBot(channelsArg, botsArg, defaultsArg, request.channel, request.botId);
  if (!bot) fail("request bot is no longer configured");

  const replyId = `reply:${request.channel}:${request.botId}:${request.eventKey || request.conversationId}`;
  let claimed;
  try {
    claimed = await claim(db, "events", replyId, { requestId }, bot.replyTtl || 3600);
  } catch (err) {
    // Fail closed: a repository claim error must never become an outbound
    // send, since the callback may be retried safely by its caller.
    throw new Error(`completion claim failed: ${err.message}`);
  }
  if (!claimed) {
    reply({ accepted: true, duplicate: true });
    return;
  }

  let text = input.reply.trim();
  try {
    const formatted = await callPlugin(request.channel, "format", { markdown: input.reply, bot });
    if (formatted && formatted.text) text = formatted.text;
  } catch (err) {
    process.stderr.write(`[bot complete] format failed, sending raw markdown: ${err.message}\n`);
  }

  try {
    const sendResult = await callPlugin(request.channel, "send", {
      chatId: request.chatId,
      threadId: request.threadId,
      text,
      bot
    });
    if (sendResult && sendResult.ok === false) throw new Error(sendResult.error || "send refused");
  } catch (err) {
    await release(db, "events", replyId).catch(releaseErr => {
      process.stderr.write(`[bot complete] reply claim release failed: ${releaseErr.message}\n`);
    });
    throw err;
  }

  const conversation = (await readRecord(db, "conversations", request.conversationId)) || { history: [] };
  if (!Array.isArray(conversation.history)) conversation.history = [];
  conversation.history.push({ role: "user", text: request.text || "" });
  conversation.history.push({ role: "assistant", text: input.reply });
  await writeRecord(db, "conversations", request.conversationId, conversation, bot.threadTtl);
  await logMessage(db, bot, {
    channel: request.channel,
    botId: request.botId,
    chatId: request.chatId,
    threadId: request.threadId,
    direction: "out",
    text,
    kind: "message"
  });
  await writeRecord(db, "requests", requestId, { ...request, status: "completed" }, bot.replyTtl || undefined);
  reply({ accepted: true });
}
