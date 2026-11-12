import { resolveBot } from "./config.js";
import { claim, readRecord, writeRecord } from "./repository.js";
import { callPlugin } from "./plugin.js";
import { buildContext, runBrain } from "./command.js";
import { readStdin, reply } from "./stdin.js";

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
 * Process one message end-to-end: typing -> conversation state -> brain
 * (text in -> markdown out) -> plugin format -> plugin send, with a
 * reply-once claim guard so a crash-and-redelivery of the SAME message can
 * never double-send the final answer.
 *
 * Throws on a brain failure. The caller (package/.aux4's `work-pull`
 * pipeline, via `&&`/`||`) treats a non-zero exit here as "nack this
 * message" — aux4/queue's own attempts counter + maxAttempts handles the
 * retry count and dead-lettering, so there is no in-process retry loop
 * here anymore (there was, before BOT-012A; it is redundant now that
 * failed messages are genuinely redelivered by the queue).
 */
export async function processMessage(msg, ctx) {
  const { channels, bots, defaults, db, tmpDir } = ctx;

  const bot = resolveBot(channels, bots, defaults, msg.channel, msg.botId);
  if (!bot) {
    log(`unknown or de-configured bot ${msg.channel}/${msg.botId}, dropping`);
    return;
  }

  const event = msg.event || {};
  const convId = `${msg.channel}:${msg.botId}:${event.threadId || event.chatId}`;

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
  // for unbounded.
  //
  // KNOWN GAP: aux4/queue has no lease-renew/heartbeat primitive today, so a
  // self-leased message (`aux4 bot work-pull`) being processed by a brain
  // that outlives `queue.visibility` CAN be redelivered to a second worker
  // while the first is still running — there is no way for this process to
  // extend its own lease mid-run. Filed as a follow-up for aux4/queue (a
  // `queue extend`/`queue lease --renew` primitive); until it exists, set
  // `queue.visibility` generously for slow brains. See README.
  const brainTimeout = bot.brainTimeout ? Number(bot.brainTimeout) : undefined;
  const context = buildContext(conversation, filePaths, {
    historyMaxTurns: bot.historyMaxTurns,
    historyCharBudget: bot.historyCharBudget
  });

  const answer = await runBrain(command, event.text || "", {
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
  conversation.history.push({ role: "assistant", text: answer });
  conversation.files = Array.from(new Set([...(conversation.files || []), ...filePaths]));
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

  await callPlugin(msg.channel, "send", { chatId: event.chatId, threadId: event.threadId, text, bot }).catch(err =>
    log(`send failed: ${err.message}`)
  );
}

/**
 * action: work-pull-process — invoked by package/.aux4's `work-pull`
 * pipeline after it has leased and normalized a message. Processes it;
 * throws (non-zero exit) on brain failure so the DSL nacks instead of acks.
 *
 * args: channels, bots, defaults, db, tmpDir, normalizedLeaseJson
 */
export async function workPullProcess(args) {
  const [channels, bots, defaults, db, tmpDir, leaseJson] = args;
  const lease = JSON.parse(leaseJson || "{}");
  const msg = lease.body || {};
  await processMessage(msg, { channels, bots, defaults, db, tmpDir });
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
