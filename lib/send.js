import { resolveBotById } from "./config.js";
import { callPlugin } from "./plugin.js";
import { logMessage } from "./messagelog.js";

/**
 * action: send — `aux4 bot send <botId> --to <chatId> --text <text>`. An ad
 * hoc, proactive message, NOT tied to an inbound event: format the text
 * through the bot's own channel plugin (read from `bots.<botId>.channel`,
 * same as every other field), then send it. Logged as outbound in the
 * message log on success.
 *
 * Only `botId` is positional — aux4 core does not reliably bind two
 * positional (`arg: true`) variables on one command (confirmed against
 * `aux4 jobs attach`'s own two-positional command; its own lint flags this
 * as `multiple-args`), so the channel is resolved from the bot's own config
 * instead of being a second positional argument.
 *
 * A plugin's `send` may refuse (returning `{ok:false, error}`, e.g.
 * WhatsApp outside its 24h free-form session window) or fail outright
 * (non-zero exit) — either way this command fails loudly (stderr + exit 1),
 * unlike the worker's own best-effort reply send, because here a human (or
 * script) is directly waiting on the result.
 *
 * args: botId, to, text, bots, defaults, db
 */
export async function sendCommand(args) {
  const [botId, to, text, botsArg, defaultsArg, db] = args;

  const bot = resolveBotById(botsArg, defaultsArg, botId);
  if (!bot || !bot.channel) {
    process.stderr.write(`Unknown or de-configured bot id: ${botId}\n`);
    process.exitCode = 1;
    return;
  }
  const channel = bot.channel;

  let outText = text || "";
  try {
    const formatted = await callPlugin(channel, "format", { markdown: outText, bot });
    if (formatted && formatted.text) outText = formatted.text;
  } catch (err) {
    process.stderr.write(`[bot send] format failed, sending raw text: ${err.message}\n`);
  }

  let result;
  try {
    result = await callPlugin(channel, "send", { chatId: to, text: outText, bot });
  } catch (err) {
    process.stderr.write(`${String(err.stderr || err.message || "send failed").trim()}\n`);
    process.exitCode = 1;
    return;
  }

  if (!result || result.ok === false) {
    const reason = (result && result.error) || "send refused";
    process.stderr.write(`${reason}\n`);
    process.exitCode = 1;
    return;
  }

  await logMessage(db, bot, { channel, botId, chatId: to, direction: "out", text: outText, kind: "manual" });
  process.stdout.write(JSON.stringify({ ok: true }));
}
