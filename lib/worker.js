import { resolveBot, parseMaybeJson } from "./config.js";
import { claim, readRecord, writeRecord } from "./repository.js";
import { callPlugin } from "./plugin.js";
import { callProvider, resolveProvider } from "./provider.js";
import { buildContext, runBrain, runHook } from "./command.js";
import { readStdin, reply } from "./stdin.js";
import { logMessage } from "./messagelog.js";

// Keep-alive typing: how often (seconds) to re-raise the plugin's typing
// indicator while the brain runs, when `bot.typingInterval` is not set.
const DEFAULT_TYPING_INTERVAL_SECONDS = 20;

// progressMessage: how long (seconds) to wait before sending it, when
// `bot.progressMessageDelay` is not set.
const DEFAULT_PROGRESS_MESSAGE_DELAY_SECONDS = 15;

function log(...args) {
  process.stderr.write(`[bot worker] ${args.join(" ")}\n`);
}

/**
 * Normalize aux4/queue's `lease` response into one shape regardless of
 * which storage backend produced it: memory returns a single object with
 * `leaseId`; repository returns an array (empty array when nothing is
 * eligible) of objects keyed by `id` instead, with no `leaseId` at all.
 * This is pure JSON shape handling (duck-typing the response) — NOT a
 * branch on the configured `queue.storage` setting.
 */
export function normalizeLease(raw) {
  let obj = raw;
  if (Array.isArray(raw)) {
    obj = raw.length > 0 ? raw[0] : null;
  }
  if (!obj || typeof obj !== "object") {
    return { leaseId: "", id: "", group: "", attempts: 0, body: null };
  }
  return {
    leaseId: obj.leaseId || "",
    id: obj.id || "",
    group: obj.group || "",
    attempts: obj.attempts || 0,
    body: obj.body || null
  };
}

/**
 * action: lease-normalize — args: [rawLeaseJson]
 */
export async function leaseNormalize(args) {
  const [raw] = args;
  let parsed;
  try {
    parsed = JSON.parse(raw || "null");
  } catch {
    parsed = null;
  }
  reply(normalizeLease(parsed));
}

/**
 * Fire a per-bot `onMessage` hook, if configured: a command run for every
 * inbound message (the message JSON on stdin), completely independent of
 * the reply — NOT awaited on the reply's critical path, so a slow or
 * failing hook never delays or blocks the reply. Its failure is logged,
 * never thrown.
 */
function fireOnMessageHook(bot, msg) {
  if (!bot.onMessage) return;
  runHook(bot.onMessage, msg).catch(err => log(`onMessage hook failed: ${err.message}`));
}

/**
 * Keep-alive typing: while the brain runs, re-raise the plugin's typing
 * indicator every `bot.typingInterval` seconds (default 20s) — a single
 * typing call at the start of a long-running brain goes stale on most
 * platforms well before the reply is ready. Returns a timer handle (or
 * `null` when disabled via `typingInterval: 0`) to be cleared once the
 * brain settles.
 */
function startTypingKeepAlive(channel, event, bot) {
  const intervalSeconds =
    bot.typingInterval !== undefined && bot.typingInterval !== "" ? Number(bot.typingInterval) : DEFAULT_TYPING_INTERVAL_SECONDS;
  if (!intervalSeconds || intervalSeconds <= 0) return null;
  const timer = setInterval(() => {
    callPlugin(channel, "typing", { event, bot }).catch(err => log(`keep-alive typing failed: ${err.message}`));
  }, intervalSeconds * 1000);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

/**
 * Optional progress message: sent once, `bot.progressMessageDelay` seconds
 * (default 15s) after the brain starts, when `bot.progressMessage` is
 * configured — useful for a brain that legitimately takes a while and a
 * typing indicator alone isn't reassuring enough. Best-effort; logged (both
 * to stderr on failure and to the message log on success). Returns a timer
 * handle (or `null` when `progressMessage` is not set) to be cleared once
 * the brain settles, so it is never sent after the real reply.
 */
function startProgressMessage(channel, event, bot, db, botId) {
  if (!bot.progressMessage) return null;
  const delaySeconds =
    bot.progressMessageDelay !== undefined && bot.progressMessageDelay !== ""
      ? Number(bot.progressMessageDelay)
      : DEFAULT_PROGRESS_MESSAGE_DELAY_SECONDS;
  const timer = setTimeout(() => {
    callPlugin(channel, "send", { chatId: event.chatId, threadId: event.threadId, text: bot.progressMessage, bot })
      .then(() =>
        logMessage(db, bot, {
          channel,
          botId,
          chatId: event.chatId,
          threadId: event.threadId,
          direction: "out",
          text: bot.progressMessage,
          kind: "progress"
        })
      )
      .catch(err => log(`progress message failed: ${err.message}`));
  }, delaySeconds * 1000);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

/**
 * Process one message end-to-end: typing -> conversation state -> brain
 * (text in -> markdown out) -> plugin format -> plugin send, with a
 * reply-once claim guard so a crash-and-redelivery of the SAME message can
 * never double-send the final answer.
 *
 * Throws on a brain failure. The caller (`workPullProcess` below) decides
 * ack vs. nack from whether this throws — aux4/queue's own attempts counter
 * + maxAttempts handles the retry count and dead-lettering, so there is no
 * in-process retry loop here anymore (there was, before BOT-012A; it is
 * redundant now that failed messages are genuinely redelivered by the
 * queue).
 *
 * `ctx.isFinalAttempt` (true when this nack would reach queue.maxAttempts
 * and dead-letter the message) controls the restored `failureMessage`
 * reply: on a brain failure, if this is the final attempt and the bot has
 * `failureMessage` configured, it is sent to the chat (best-effort, never
 * blocks the nack) before the error is rethrown — so the user gets an
 * apology instead of silence right before the message is dead-lettered.
 *
 * An empty (whitespace-only) brain answer means no reply: nothing is sent,
 * the message is still acked (this does not throw), and the attempt is
 * logged in the message log as a `no-reply` entry instead of a sent message.
 */
export async function processMessage(msg, ctx) {
  const { channels, bots, defaults, db, tmpDir, isFinalAttempt } = ctx;

  const bot = resolveBot(channels, bots, defaults, msg.channel, msg.botId);
  if (!bot) {
    log(`unknown or de-configured bot ${msg.channel}/${msg.botId}, dropping`);
    return;
  }

  const event = msg.event || {};
  const convId = `${msg.channel}:${msg.botId}:${event.threadId || event.chatId}`;

  // Independent of the reply: never awaited on this critical path.
  fireOnMessageHook(bot, msg);

  await callPlugin(msg.channel, "typing", { event, bot }).catch(err => log(`typing failed: ${err.message}`));

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
      const downloaded = await callPlugin(msg.channel, "download", { file, bot, tmpDir });
      if (downloaded && downloaded.path) filePaths.push(downloaded.path);
    } catch (err) {
      log(`file download failed: ${err.message}`);
    }
  }

  const command = bot.command;
  // No hard default timeout as of BOT-012A: a brain command may legitimately
  // run for a long time. Set bot.brainTimeout (ms) to cap it; leave it unset
  // for unbounded. `workPullProcess` below renews the queue lease while this
  // runs, so a slow brain no longer risks losing its lease to a second
  // worker mid-run (see "Long-running brains" in README).
  const brainTimeout = bot.brainTimeout ? Number(bot.brainTimeout) : undefined;
  const context = buildContext(conversation, filePaths, {
    historyMaxTurns: bot.historyMaxTurns,
    historyCharBudget: bot.historyCharBudget
  });

  const typingKeepAlive = startTypingKeepAlive(msg.channel, event, bot);
  const progressTimer = startProgressMessage(msg.channel, event, bot, db, msg.botId);

  let answer;
  try {
    answer = await runBrain(command, event.text || "", {
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
  } catch (err) {
    if (typingKeepAlive) clearInterval(typingKeepAlive);
    if (progressTimer) clearTimeout(progressTimer);
    if (isFinalAttempt && bot.failureMessage) {
      await callPlugin(msg.channel, "send", {
        chatId: event.chatId,
        threadId: event.threadId,
        text: bot.failureMessage,
        bot
      }).catch(sendErr => log(`failureMessage send failed: ${sendErr.message}`));
    }
    throw err;
  }
  if (typingKeepAlive) clearInterval(typingKeepAlive);
  if (progressTimer) clearTimeout(progressTimer);

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

  conversation.history.push({ role: "user", text: event.text || "" });
  conversation.files = Array.from(new Set([...(conversation.files || []), ...filePaths]));

  const trimmedAnswer = (answer || "").trim();
  if (!trimmedAnswer) {
    // Empty brain output = no reply: nothing sent, still acked (we return
    // normally, not throw), logged as a no-reply entry.
    try {
      await writeRecord(db, "conversations", convId, conversation, bot.threadTtl);
    } catch (err) {
      log(`conversation save failed: ${err.message}`);
    }
    await logMessage(db, bot, {
      channel: msg.channel,
      botId: msg.botId,
      chatId: event.chatId,
      threadId: event.threadId,
      direction: "out",
      text: "",
      kind: "no-reply"
    });
    log(`empty brain output for ${convId}, not replying`);
    return;
  }

  conversation.history.push({ role: "assistant", text: answer });
  try {
    await writeRecord(db, "conversations", convId, conversation, bot.threadTtl);
  } catch (err) {
    log(`conversation save failed: ${err.message}`);
  }

  let text = answer;
  try {
    const formatted = await callPlugin(msg.channel, "format", { markdown: answer, bot });
    if (formatted && formatted.text) text = formatted.text;
  } catch (err) {
    log(`format failed, sending raw markdown: ${err.message}`);
  }

  let sendResult = null;
  try {
    sendResult = await callPlugin(msg.channel, "send", { chatId: event.chatId, threadId: event.threadId, text, bot });
  } catch (err) {
    log(`send failed: ${err.message}`);
  }
  const sendOk = !sendResult || sendResult.ok !== false;
  await logMessage(db, bot, {
    channel: msg.channel,
    botId: msg.botId,
    chatId: event.chatId,
    threadId: event.threadId,
    direction: "out",
    text,
    kind: sendOk ? "message" : "send-failed"
  });
}

// How often (as a fraction of queue.visibility) to renew the lease while the
// brain runs. A fraction well under 1 leaves comfortable margin between a
// missed/slow renew and the lease actually expiring.
const RENEW_FRACTION = 0.5;
const MIN_RENEW_INTERVAL_MS = 1000;

function startRenewHeartbeat(providerKey, queue, lease) {
  const visibilitySeconds = Number(queue.visibility) || 30;
  const intervalMs = Math.max(MIN_RENEW_INTERVAL_MS, Math.round(visibilitySeconds * RENEW_FRACTION * 1000));
  const timer = setInterval(() => {
    callProvider(providerKey, "renew", {
      name: queue.name || "",
      db: queue.db || "",
      port: queue.port || "",
      token: queue.token || "",
      leaseId: lease.leaseId || "",
      id: lease.id || "",
      visibility: queue.visibility || "30"
    }).catch(err => log(`lease renew failed (will retry): ${err.message}`));
  }, intervalMs);
  // Never let the heartbeat itself keep the process alive once the real
  // work is done.
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

/**
 * action: work-pull-process — invoked by package/.aux4's `pull` pipeline
 * after it has leased and normalized a message. Owns everything the DSL
 * cannot safely branch on itself: the "nothing eligible" empty check,
 * renewing the lease (heartbeat) while the brain runs, and the ack-vs-nack
 * decision once it is done. Always exits 0 (prints a small JSON summary) —
 * package/.aux4's `pull` command has nothing left to branch on.
 *
 * args: channels, bots, defaults, db, tmpDir, queue (JSON), normalizedLeaseJson
 */
export async function workPullProcess(args) {
  const [channels, bots, defaults, db, tmpDir, queueArg, leaseJson] = args;
  const queue = parseMaybeJson(queueArg, {}) || {};
  const lease = JSON.parse(leaseJson || "{}");

  if (!lease.leaseId && !lease.id) {
    reply({ leased: false });
    return;
  }

  const providerKey = resolveProvider(queue);
  const msg = lease.body || {};
  const maxAttempts = Number(queue.maxAttempts) || 0;
  const isFinalAttempt = maxAttempts > 0 && Number(lease.attempts || 0) + 1 >= maxAttempts;

  const ackNackFlags = {
    name: queue.name || "",
    db: queue.db || "",
    port: queue.port || "",
    token: queue.token || "",
    leaseId: lease.leaseId || "",
    id: lease.id || ""
  };

  const heartbeat = startRenewHeartbeat(providerKey, queue, lease);
  try {
    await processMessage(msg, { channels, bots, defaults, db, tmpDir, isFinalAttempt });
    clearInterval(heartbeat);
    await callProvider(providerKey, "ack", ackNackFlags);
    reply({ leased: true, result: "acked" });
  } catch (err) {
    clearInterval(heartbeat);
    log(`brain failed, nacking: ${err.message}`);
    await callProvider(providerKey, "nack", { ...ackNackFlags, maxAttempts: queue.maxAttempts || "0" }).catch(
      nackErr => log(`nack failed: ${nackErr.message}`)
    );
    reply({ leased: true, result: "nacked" });
  }
}

/**
 * action: work-push — the aux4/api route handler for `POST /bot/work`.
 * Reads the aux4/api event from stdin and treats event.rawBody (or
 * event.body) as the `{channel,botId,event}` message directly: there is no
 * lease/ack/nack on this path, because nothing was leased from a queue —
 * the message arrived as an HTTP push (e.g. aux4/queue's pub/sub
 * `--webhook` proxy, or any other system that can POST JSON).
 *
 * Replies 200 on success, 502 on a brain failure.
 *
 * CAVEAT (see README "Push mode"): aux4/queue's webhook proxy is
 * fire-and-forget as of 0.2.2 — it does not inspect the response status
 * code or retry on failure. A 502 here is correct and future-compatible,
 * but today nothing acts on it; true nack-on-failure for push delivery
 * needs a retrying sender upstream (tracked separately).
 *
 * args: channels, bots, defaults, db, tmpDir
 */
export async function workPush(args) {
  const [channels, bots, defaults, db, tmpDir] = args;

  let event;
  try {
    event = JSON.parse((await readStdin()) || "{}");
  } catch {
    event = {};
  }
  const rawBody = event.rawBody != null ? event.rawBody : event.body || "{}";

  let msg;
  try {
    msg = JSON.parse(rawBody || "{}");
  } catch {
    msg = {};
  }

  try {
    await processMessage(msg, { channels, bots, defaults, db, tmpDir });
    reply({ statusCode: 200, body: "{}" });
  } catch (err) {
    log(`work-push failed: ${err.message}`);
    reply({ statusCode: 502, body: JSON.stringify({ message: "processing failed" }) });
  }
}
