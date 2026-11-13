import crypto from "crypto";
import { writeRecord, find } from "./repository.js";

// Persistent inbound+outbound message log, in the same repository `--db` as
// the rest of aux4/bot's state, isolated per channel+bot+chat by field
// filters (not id prefixes — the log is queried, not fetched by id). One
// record per message in the `messages` repository table. Retention is a
// per-bot setting (`bot.messageLogTtl`, seconds; defaults to 30 days;
// `"off"` disables logging entirely) — resolved the same way as every other
// bot field (defaults + per-bot override via `resolveBot`).

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Resolve the message log's ttl (seconds) from a merged bot config.
 * Returns `null` when logging is disabled (`messageLogTtl: "off"`), `0`
 * for "never expires", or a positive number of seconds otherwise.
 */
export function resolveLogTtl(bot) {
  const raw = bot && bot.messageLogTtl;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_TTL_SECONDS;
  if (String(raw).trim().toLowerCase() === "off") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_SECONDS;
}

function escapeSql(value) {
  return String(value === undefined || value === null ? "" : value).replace(/'/g, "''");
}

/**
 * Log one message (inbound or outbound). Best-effort: a logging failure is
 * written to stderr and never propagates, so it can never block a reply or
 * an ack. No-ops entirely when the bot's `messageLogTtl` resolves to `null`
 * ("off").
 */
export async function logMessage(db, bot, entry) {
  const ttl = resolveLogTtl(bot);
  if (ttl === null) return;

  // The id's leading millisecond timestamp is a secondary sort key: aux4/
  // repository's `createdAt` has only second resolution, so an inbound log
  // write and its outbound reply (or a no-reply) can tie on `createdAt`
  // when they land in the same second — sorting `id desc` after `createdAt
  // desc` breaks that tie in true chronological order instead of an
  // arbitrary one.
  const id = `msg:${Date.now()}:${crypto.randomUUID()}`;
  try {
    await writeRecord(
      db,
      "messages",
      id,
      {
        channel: entry.channel || "",
        botId: entry.botId || "",
        chatId: entry.chatId !== undefined && entry.chatId !== null ? String(entry.chatId) : "",
        threadId: entry.threadId !== undefined && entry.threadId !== null ? String(entry.threadId) : "",
        userId: entry.userId !== undefined && entry.userId !== null ? String(entry.userId) : "",
        direction: entry.direction,
        kind: entry.kind || "message",
        text: entry.text || ""
      },
      ttl > 0 ? ttl : undefined
    );
  } catch (err) {
    process.stderr.write(`[bot messagelog] write failed: ${err.message}\n`);
  }
}

/**
 * List recent chats for a bot (optionally narrowed to one channel): the
 * most recent message per distinct chatId, newest first. Scans a window of
 * recent messages (comfortably larger than `limit`) to find that many
 * distinct chats, rather than requiring a dedicated repository query.
 */
export async function listConversations(db, { channel, botId, limit }) {
  const max = Number(limit) > 0 ? Number(limit) : 20;
  const clauses = [`botId = '${escapeSql(botId)}'`];
  if (channel) clauses.push(`channel = '${escapeSql(channel)}'`);

  const rows = await find(db, "messages", {
    expr: clauses.join(" and "),
    sort: "createdAt desc, id desc",
    limit: Math.max(max * 20, 200),
    raw: true
  });

  const seen = new Map();
  const order = [];
  for (const row of rows) {
    const chatId = row.chatId || "";
    if (!chatId || seen.has(chatId)) continue;
    seen.set(chatId, {
      chatId,
      userId: row.userId || "",
      lastMessage: row.text || "",
      direction: row.direction || "",
      time: (row.__metadata && row.__metadata.createdAt) || ""
    });
    order.push(chatId);
    if (order.length >= max) break;
  }
  return order.map(id => seen.get(id));
}

/**
 * List message history for one chat, both directions, oldest first (a
 * chat transcript reads top-to-bottom).
 */
export async function listMessages(db, { channel, botId, chatId, limit }) {
  const max = Number(limit) > 0 ? Number(limit) : 50;
  const clauses = [`botId = '${escapeSql(botId)}'`, `chatId = '${escapeSql(chatId)}'`];
  if (channel) clauses.push(`channel = '${escapeSql(channel)}'`);

  const rows = await find(db, "messages", {
    expr: clauses.join(" and "),
    sort: "createdAt desc, id desc",
    limit: max,
    raw: true
  });

  return rows
    .map(row => ({
      direction: row.direction || "",
      text: row.text || "",
      userId: row.userId || "",
      kind: row.kind || "message",
      time: (row.__metadata && row.__metadata.createdAt) || ""
    }))
    .reverse();
}

/** action: conversations — args: [botId, channel, db, limit] */
export async function conversationsAction(args) {
  const [botId, channel, db, limit] = args;
  const rows = await listConversations(db, { channel, botId, limit });
  process.stdout.write(JSON.stringify(rows));
}

/** action: messages — args: [botId, chat, channel, db, limit] */
export async function messagesAction(args) {
  const [botId, chat, channel, db, limit] = args;
  const rows = await listMessages(db, { channel, botId, chatId: chat, limit });
  process.stdout.write(JSON.stringify(rows));
}
