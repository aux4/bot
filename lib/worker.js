import { resolveBot, queuePort } from "./config.js";
import { receiveStream } from "./queue.js";
import { claim, readRecord, writeRecord } from "./repository.js";
import { callPlugin } from "./plugin.js";
import { buildContext, runBrain } from "./command.js";

function log(...args) {
  process.stderr.write(`[bot worker] ${args.join(" ")}\n`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process a single dequeued event end-to-end: typing -> conversation state ->
 * brain (text in -> markdown out) -> plugin format -> plugin send, with a
 * retry-with-backoff around the brain call and a reply-once claim guard so a
 * crash-and-redelivery can never double-send the final answer.
 *
 * Exported for targeted testing with injected deps.
 */
export async function handleMessage(msg, ctx) {
  const { channels, bots, defaults, db, tmpDir, deps = {} } = ctx;

  const plugin = deps.callPlugin || callPlugin;
  const brain = deps.runBrain || runBrain;

  const bot = resolveBot(channels, bots, defaults, msg.channel, msg.botId);
  if (!bot) {
    log(`unknown or de-configured bot ${msg.channel}/${msg.botId}, dropping`);
    return;
  }

  const event = msg.event || {};
  const convId = `${msg.channel}:${msg.botId}:${event.threadId || event.chatId}`;

  await plugin(msg.channel, "typing", { event, bot }).catch(err => log(`typing failed: ${err.message}`));

  let conversation;
  try {
    conversation = (await readRecord(db, "conversations", convId)) || { history: [] };
  } catch (err) {
    log(`conversation load failed: ${err.message}`);
    conversation = { history: [] };
  }
  if (!Array.isArray(conversation.history)) conversation.history = [];

  const filePaths = [];
  for (const file of event.files || []) {
    try {
      const downloaded = await plugin(msg.channel, "download", { file, bot, tmpDir });
      if (downloaded && downloaded.path) filePaths.push(downloaded.path);
    } catch (err) {
      log(`file download failed: ${err.message}`);
    }
  }

  const command = bot.command;
  const brainTimeout = Number(bot.brainTimeout) || 120000;
  const maxRetries = bot.brainRetries !== undefined && bot.brainRetries !== "" ? Number(bot.brainRetries) : 2;
  const context = buildContext(conversation, filePaths, {
    historyMaxTurns: bot.historyMaxTurns,
    historyCharBudget: bot.historyCharBudget
  });

  let answer;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      answer = await brain(command, event.text || "", {
        context,
        env: {
          AUX4BOT_CHANNEL: msg.channel,
          AUX4BOT_BOT: msg.botId,
          AUX4BOT_CHAT_ID: String(event.chatId || ""),
          AUX4BOT_THREAD_ID: String(event.threadId || ""),
          AUX4BOT_FILES: filePaths.join(",")
        },
        timeout: brainTimeout
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      log(`brain attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxRetries) {
        await sleep(Math.min(500 * 2 ** attempt, 8000));
      }
    }
  }

  // Reply-once guard: claim this event's reply slot before sending anything.
  // On a worker crash-and-redelivery of the SAME event, the retry will find
  // the reply already claimed and skip sending a second answer.
  const replyId = `reply:${msg.channel}:${msg.botId}:${event.key || convId}`;
  let claimed;
  try {
    claimed = await claim(db, "events", replyId, {}, bot.replyTtl || 3600);
  } catch (err) {
    log(`reply claim failed: ${err.message}`);
    claimed = true; // fail open — better to risk a duplicate than to never reply
  }
  if (!claimed) {
    log(`reply already sent for ${replyId}, skipping`);
    return;
  }

  if (lastErr) {
    const failureText = bot.failureMessage || "Sorry — I hit an error handling that request.";
    let text = failureText;
    try {
      const formatted = await plugin(msg.channel, "format", { markdown: failureText, bot });
      if (formatted && formatted.text) text = formatted.text;
    } catch {
      // use the raw failureText
    }
    await plugin(msg.channel, "send", { chatId: event.chatId, threadId: event.threadId, text, bot }).catch(err =>
      log(`failure-message send failed: ${err.message}`)
    );
    return;
  }

  conversation.history.push({ role: "user", text: event.text || "" });
  conversation.history.push({ role: "assistant", text: answer });
  conversation.files = Array.from(new Set([...(conversation.files || []), ...filePaths]));
  try {
    await writeRecord(db, "conversations", convId, conversation, bot.threadTtl);
  } catch (err) {
    log(`conversation save failed: ${err.message}`);
  }

  let text = answer;
  try {
    const formatted = await plugin(msg.channel, "format", { markdown: answer, bot });
    if (formatted && formatted.text) text = formatted.text;
  } catch (err) {
    log(`format failed, sending raw markdown: ${err.message}`);
  }

  await plugin(msg.channel, "send", { chatId: event.chatId, threadId: event.threadId, text, bot }).catch(err =>
    log(`send failed: ${err.message}`)
  );
}

/**
 * Long-running consumer: keeps a persistent receive stream open, reconnecting
 * with backoff. Serves every configured channel+bot (each message carries
 * its own channel/botId).
 *
 * args: channels, bots, defaults, db, tmpDir, queueName, queueUrl
 */
export async function worker(args) {
  const [channels, bots, defaults, db, tmpDir, queueName, queueUrl] = args;
  const port = queuePort(queueUrl);
  const ctx = { channels, bots, defaults, db, tmpDir };

  let backoff = 500;
  const maxBackoff = 15000;

  const connect = () => {
    log(`connecting to queue ${queueName} on port ${port}`);
    const child = receiveStream(
      port,
      queueName,
      async msg => {
        backoff = 500;
        try {
          await handleMessage(msg, ctx);
        } catch (err) {
          log(`handleMessage error: ${err.message}`);
        }
      },
      err => log(`receive error: ${err.message}`)
    );

    child.on("close", () => {
      log(`receive stream closed; reconnecting in ${backoff}ms`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    });
  };

  connect();

  return new Promise(() => {});
}
