import { readStdin, reply } from "./stdin.js";
import { resolveBot } from "./config.js";
import { callPlugin } from "./plugin.js";

/**
 * aux4/api route handler for GET /{channel}/{bot}/webhook — the platform's
 * verification handshake (e.g. a challenge-response ping). Delegates the
 * actual check to the channel plugin's `verify` command; unknown
 * channel/bot is a clean 404 (never leaks which part is wrong).
 *
 * args: channels, bots, defaults
 */
export async function verify(args) {
  const [channelsArg, botsArg, defaultsArg] = args;

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

  let result;
  try {
    result = await callPlugin(channel, "verify", {
      method: "GET",
      headers: event.headers || {},
      query: event.queryStringParameters || {},
      rawBody: event.rawBody,
      bot
    });
  } catch (err) {
    process.stderr.write(`[bot verify] plugin ${channel} verify failed: ${err.message}\n`);
    return reply({ statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) });
  }

  if (!result || typeof result !== "object" || !result.valid) {
    const statusCode = (result && result.statusCode) || 401;
    return reply({ statusCode, body: JSON.stringify({ message: statusCode === 404 ? "Not Found" : "Unauthorized" }) });
  }

  return reply({ statusCode: 200, body: result.body !== undefined ? String(result.body) : "OK" });
}
