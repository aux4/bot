// Config resolution helpers for aux4/bot.
// Pure functions — safe to unit-test without any queue/repository/plugin access.

/**
 * aux4/config passes object/array values to commands as JSON strings.
 * This normalizes a value that may already be an object or a JSON string.
 */
export function parseMaybeJson(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Expand ${ENV_VAR} references in a string against process.env. aux4/config
 * does not substitute env references nested inside object values (they
 * arrive as literal JSON), so this is resolved here instead — lets a bot
 * config write e.g. `secret: ${BOT_SIGNING_SECRET}`.
 */
export function expandEnv(value, env = process.env) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => (env[name] !== undefined ? env[name] : ""));
}

/**
 * Resolve a bot's merged config (defaults + per-bot overrides), checking the
 * channel allowlist along the way. Returns null when the channel is not
 * allowlisted, the bot id is unknown, or the bot's configured channel does
 * not match the {channel} path segment — any of these must look like a plain
 * 404 to the caller, not a 401 or 500 (never leak which part failed).
 *
 * @param {object|string} channels  allowlisted channel names (array or JSON string)
 * @param {object|string} bots      map keyed by botId (or JSON string)
 * @param {object|string} defaults  shared defaults (or JSON string)
 * @param {string} channel          the {channel} path segment
 * @param {string} botId            the {bot} path segment
 * @param {object} [env]            environment (injectable for tests)
 */
export function resolveBot(channels, bots, defaults, channel, botId, env = process.env) {
  const channelList = parseMaybeJson(channels, []) || [];
  if (!Array.isArray(channelList) || !channelList.includes(channel)) {
    return null;
  }

  const botMap = parseMaybeJson(bots, {}) || {};
  const defaultMap = parseMaybeJson(defaults, {}) || {};

  if (!botId || !Object.prototype.hasOwnProperty.call(botMap, botId)) {
    return null;
  }

  const bot = botMap[botId] || {};
  if (bot.channel !== channel) {
    return null;
  }

  const merged = Object.assign({}, defaultMap, bot, { botId, channel });
  for (const key of Object.keys(merged)) {
    merged[key] = expandEnv(merged[key], env);
  }
  return merged;
}
