import crypto from "crypto";
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

// Exit 4 with the documented empty payload is a normal empty queue. A
// transport/auth/database failure must not turn into {leased:false}.
export async function leaseNext(queue, invoke = callProvider) {
  const flags = {};
  for (const key of ["name", "db", "port", "token", "visibility", "maxAttempts"]) {
    flags[key] = queue[key] ?? "";
  }
  let raw;
  try {
    raw = await invoke(resolveProvider(queue), "lease", flags);
  } catch (error) {
    const output = String(error.stdout || "").trim();
    if (Number(error.code) === 4 && !String(error.stderr || "").trim() && (output === "[]" || output === "{}")) {
      return normalizeLease(null);
    }
    // Do not expose the child command, queue token, URL or provider response.
    const detail = String(error.stderr || "");
    const category = /unauthori[sz]ed|forbidden|authentication/i.test(detail) ? "authentication"
      : /locked|SQLITE_BUSY/i.test(detail) ? "database-busy"
      : /timed? ?out|ECONN|connection|network/i.test(detail) ? "connection"
      : /not installed|unknown provider/i.test(detail) ? "provider"
      : "provider-error";
    throw new Error(`Queue lease failed (${category}); message remains queued`);
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("Queue lease returned invalid JSON"); }
  if ((Array.isArray(value) && value.length === 0) ||
      (value && !Array.isArray(value) && typeof value === "object" && Object.keys(value).length === 0)) {
    return normalizeLease(null);
  }
  const lease = normalizeLease(value);
  if (!lease.id && !lease.leaseId) throw new Error("Queue lease returned an invalid message");
  return lease;
}

export async function workPull(args) {
  const queue = parseMaybeJson(args[5], {}) || {};
  const lease = await leaseNext(queue);
  await workPullProcess([...args.slice(0, 6), JSON.stringify(lease)]);
}

/**
 * Stable identifiers for a queued inbound event.  The request id is opaque
 * and contains no provider data; routing is kept in the request record in
 * the bot's repository instead of being accepted back from a callback.
 */
export function requestContext(msg) {
  const event = msg && msg.event ? msg.event : {};
  const channel = String((msg && msg.channel) || "");
  const botId = String((msg && msg.botId) || "");
  const eventKey = String(event.key || `${event.threadId || event.chatId || ""}:${event.timestamp || event.text || ""}`);
  const digest = crypto.createHash("sha256").update(`${channel}\0${botId}\0${eventKey}`).digest("hex");
  const requestId = `req:${digest}`;
  const conversationId = `${channel}:${botId}:${event.threadId || event.chatId}`;
  // The agent must not learn provider/channel routing. Encode the stable
  // conversation key as a deterministic UUID-shaped opaque identifier.
  const conversationDigest = crypto.createHash("sha256").update(conversationId).digest();
  conversationDigest[6] = (conversationDigest[6] & 0x0f) | 0x50;
  conversationDigest[8] = (conversationDigest[8] & 0x3f) | 0x80;
  const agentConversationId = [
    conversationDigest.subarray(0, 4).toString("hex"),
    conversationDigest.subarray(4, 6).toString("hex"),
    conversationDigest.subarray(6, 8).toString("hex"),
    conversationDigest.subarray(8, 10).toString("hex"),
    conversationDigest.subarray(10, 16).toString("hex")
  ].join("-");
  return {
    requestId,
    messageId: requestId,
    conversationId,
    agentConversationId,
    channel,
    botId,
    chatId: event.chatId !== undefined && event.chatId !== null ? String(event.chatId) : "",
    threadId: event.threadId !== undefined && event.threadId !== null ? String(event.threadId) : "",
    eventKey,
    text: event.text || ""
  };
}

export function isCallbackMode(bot) {
  return String(bot && bot.replyMode || "").toLowerCase() === "callback";
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
  const request = requestContext(msg);

  // A callback request is claimed before the brain starts.  This is both the
  // durable correlation record and the redelivery guard: a completed request
  // never runs the brain a second time.  Claim errors fail closed so a
  // transient repository failure cannot turn into a duplicate model call.
  const callbackMode = isCallbackMode(bot);
  if (callbackMode) {
    const callbackTtl = Number(bot.callbackTtl) > 0 ? Number(bot.callbackTtl) : 129600;
    let requestRecord = await readRecord(db, "requests", request.requestId);
    if (requestRecord && requestRecord.status === "completed") return;
    if (!requestRecord) {
      const claimed = await claim(
        db,
        "requests",
        request.requestId,
        { ...request, status: "pending", callbackTtl },
        callbackTtl
      );
      if (!claimed) requestRecord = await readRecord(db, "requests", request.requestId);
      if (!claimed && !requestRecord) throw new Error("callback request claim could not be read");
    } else if (requestRecord.status === "failed") {
      // A failed callback is retryable through the queue; refresh the state
      // before invoking the brain again, preserving the original routing.
      await writeRecord(db, "requests", request.requestId, { ...requestRecord, ...request, status: "pending", callbackTtl }, callbackTtl);
    }
  }

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
        AUX4BOT_FILES: filePaths.join(","),
        ...(callbackMode
          ? {
              AUX4BOT_REQUEST_ID: request.requestId,
              AUX4BOT_MESSAGE_ID: request.messageId,
              AUX4BOT_CONVERSATION_ID: request.agentConversationId
            }
          : {})
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

  if (callbackMode) {
    const completed = await readRecord(db, "requests", request.requestId);
    if (!completed || completed.status !== "completed") {
      const reason = completed && completed.status === "failed"
        ? "callback agent reported failure"
        : "callback completion was not received";
      throw new Error(reason);
    }
    return;
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

// A visibility below this is risky: every renew spawns an `aux4 queue renew`
// process (and, for sqs/cloud, the 6-hop dispatcher + queue-cloud +
// queue-sqs + two aws CLI calls underneath it), so a visibility too short to
// comfortably outlast one of those round trips under load can miss its
// window even with the immediate-renew + quick-retry fix below. This is a
// warning only -- it does NOT change `queue.visibility` (the lease itself
// was already leased/renewed at that value by the time this code runs); the
// configured value is respected either way. See README "Long-running
// brains" for the documented recommendation.
const MIN_VISIBILITY_SECONDS = 10;

// On a failed renew, how many quick retries to attempt (spaced
// QUICK_RETRY_MS apart, capped at the normal interval) before falling back
// to waiting a full interval -- missing one renew used to mean waiting the
// entire next interval before trying again, which is most of the way to
// losing the lease on a short visibility.
const MAX_QUICK_RETRIES = 3;
const QUICK_RETRY_MS = 1000;

/**
 * Starts renewing `lease` while the caller's brain runs. Renews immediately
 * (before the first interval even elapses) so the window between "lease
 * acquired" and "first renew" is never a full interval wide, then renews
 * every `intervalMs` (half of `queue.visibility`, floored at
 * MIN_RENEW_INTERVAL_MS) after that. A failed renew retries quickly (up to
 * MAX_QUICK_RETRIES, QUICK_RETRY_MS apart) instead of waiting a full
 * interval, since a slow/flaky single renew is exactly the case this
 * heartbeat exists to cover. Returns `{ stop() }` -- call `stop()` once the
 * brain settles (ack/nack path), not `clearInterval` (this is no longer a
 * single timer).
 */
// `renewFn` is injectable (defaults to the real `callProvider` "renew" call)
// purely for testability -- see test/worker-renew-heartbeat.test.js, which
// proves the first renew fires before the first interval without waiting
// out a real interval.
export function startRenewHeartbeat(providerKey, queue, lease, renewFn) {
  const doRenew =
    renewFn ||
    ((flags) => callProvider(providerKey, "renew", flags));
  const visibilitySeconds = Number(queue.visibility) || 30;
  if (visibilitySeconds < MIN_VISIBILITY_SECONDS) {
    log(
      `queue visibility ${visibilitySeconds}s is below the recommended minimum of ` +
        `${MIN_VISIBILITY_SECONDS}s -- every renew spawns a process, so a very short visibility risks ` +
        `missing its own renew window under load; consider raising it`
    );
  }
  const intervalMs = Math.max(MIN_RENEW_INTERVAL_MS, Math.round(visibilitySeconds * RENEW_FRACTION * 1000));
  const quickRetryMs = Math.min(intervalMs, QUICK_RETRY_MS);

  let stopped = false;
  let timer = null;
  // The renew currently running, if any. stop() waits for it so a renew can
  // never land AFTER the caller's ack/nack: on sqs a late ChangeMessageVisibility
  // would re-hide a just-nacked message and stall its redelivery.
  let inFlight = null;

  function schedule(delayMs, retryCount) {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = attemptRenew(retryCount);
    }, Math.max(0, delayMs));
    // Never let the heartbeat itself keep the process alive once the real
    // work is done.
    if (typeof timer.unref === "function") timer.unref();
  }

  async function attemptRenew(retryCount) {
    if (stopped) return;
    // Cadence is measured from the START of each renew, not its end: a renew
    // can take seconds on sqs/cloud (several processes + aws CLI calls), and
    // waiting a full interval after it finishes would stretch the gap past
    // the lease's own visibility.
    const startedAt = Date.now();
    try {
      await doRenew({
        name: queue.name || "",
        db: queue.db || "",
        port: queue.port || "",
        token: queue.token || "",
        leaseId: lease.leaseId || "",
        id: lease.id || "",
        visibility: String(visibilitySeconds)
      });
      schedule(intervalMs - (Date.now() - startedAt), 0);
    } catch (err) {
      if (retryCount < MAX_QUICK_RETRIES) {
        log(`lease renew failed (quick retry ${retryCount + 1}/${MAX_QUICK_RETRIES}): ${err.message}`);
        schedule(quickRetryMs, retryCount + 1);
      } else {
        log(`lease renew failed (giving up quick retries, resuming normal interval): ${err.message}`);
        schedule(intervalMs - (Date.now() - startedAt), 0);
      }
    }
  }

  // Renew immediately, before the first interval, so the window between
  // "lease acquired" and "first renew" is never a full interval wide.
  inFlight = attemptRenew(0);

  return {
    // Stops future renews and resolves once any renew already in flight has
    // settled. Await it before ack/nack.
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight.catch(() => {});
    }
  };
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
    await heartbeat.stop();
    await callProvider(providerKey, "ack", ackNackFlags);
    reply({ leased: true, result: "acked" });
  } catch (err) {
    await heartbeat.stop();
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
