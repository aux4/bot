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
    ["conversationId", request.agentConversationId || request.conversationId],
    ["messageId", request.messageId]
  ];
  return pairs.every(([key, expected]) => input[key] === undefined || String(input[key]) === String(expected));
}

/** Injectable completion primitive used by the CLI and by package tests. */
export async function completeRequest(input, { channels, bots, defaults, db, repository = {} } = {}) {
  const read = repository.read || readRecord;
  const write = repository.write || writeRecord;
  const claimReply = repository.claim || claim;
  const releaseReply = repository.release || release;
  const sendPlugin = repository.send || callPlugin;
  const log = repository.log || logMessage;

  const requestId = String(input.requestId || "");
  if (!/^req:[a-f0-9]{64}$/.test(requestId)) fail("invalid requestId");
  if (!Object.prototype.hasOwnProperty.call(input, "status")) fail("status is required");
  if (input.status !== "completed" && input.status !== "failed") fail("invalid completion status");

  const request = await read(db, "requests", requestId);
  if (!request) fail("unknown requestId");
  if (!suppliedCorrelationMatches(input, request)) fail("completion correlation mismatch");

  if (request.status === "completed") return { accepted: true, duplicate: true };
  if (request.status === "completing") fail("completion already in progress");

  if (input.status === "failed") {
    await write(db, "requests", requestId, { ...request, status: "failed" }, request.callbackTtl || 129600);
    return { accepted: true };
  }

  if (typeof input.reply !== "string") fail("reply is required for completed status");
  const bot = resolveBot(channels, bots, defaults, request.channel, request.botId);
  if (!bot) fail("request bot is no longer configured");

  const replyId = `reply:${request.channel}:${request.botId}:${request.eventKey || request.conversationId}`;
  let claimed;
  try {
    claimed = await claimReply(db, "events", replyId, { requestId }, request.callbackTtl || 129600);
  } catch (err) {
    throw new Error(`completion claim failed: ${err.message}`);
  }
  if (!claimed) {
    const current = await read(db, "requests", requestId);
    if (current && current.status === "completed") return { accepted: true, duplicate: true };
    fail("completion already in progress");
  }

  let text = input.reply.trim();
  try {
    const formatted = await sendPlugin(request.channel, "format", { markdown: input.reply, bot });
    if (formatted && formatted.text) text = formatted.text;
  } catch (err) {
    process.stderr.write(`[bot complete] format failed, sending raw markdown: ${err.message}\n`);
  }

  try {
    const sendResult = await sendPlugin(request.channel, "send", {
      chatId: request.chatId,
      threadId: request.threadId,
      text,
      bot
    });
    if (sendResult && sendResult.ok === false) throw new Error(sendResult.error || "send refused");
  } catch (err) {
    await releaseReply(db, "events", replyId).catch(releaseErr => {
      process.stderr.write(`[bot complete] reply claim release failed: ${releaseErr.message}\n`);
    });
    throw err;
  }

  const conversation = (await read(db, "conversations", request.conversationId)) || { history: [] };
  if (!Array.isArray(conversation.history)) conversation.history = [];
  conversation.history.push({ role: "user", text: request.text || "" });
  conversation.history.push({ role: "assistant", text: input.reply });
  await write(db, "conversations", request.conversationId, conversation, bot.threadTtl);
  await log(db, bot, {
    channel: request.channel,
    botId: request.botId,
    chatId: request.chatId,
    threadId: request.threadId,
    direction: "out",
    text,
    kind: "message"
  });
  await write(db, "requests", requestId, { ...request, status: "completed" }, request.callbackTtl || 129600);
  return { accepted: true };
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

  const result = await completeRequest(input, {
    channels: channelsArg,
    bots: botsArg,
    defaults: defaultsArg,
    db
  });
  reply(result);
}
