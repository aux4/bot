import { execFile } from "child_process";

// Dispatches directly to aux4/queue's own --provider dispatch (memory,
// repository, sqs, cloud, ...) — there is no bot-side allowlist anymore.
// aux4/queue itself fails with a clear "install aux4/queue-<provider>"
// message for an unknown or not-installed provider; adding a new backend
// (e.g. aux4/queue-cloud) never requires a change in this package.

/**
 * Invoke `aux4 queue <op> --provider <providerKey> --flag value ...`,
 * writing `stdinInput` to stdin when given. Rejects on a non-zero exit
 * (including aux4/queue's own "install aux4/queue-<provider>" error for an
 * unknown or not-installed providerKey).
 */
export function callProvider(providerKey, op, flags = {}, stdinInput) {
  return new Promise((resolve, reject) => {
    const args = ["queue", op, "--provider", providerKey];
    for (const [key, value] of Object.entries(flags)) {
      if (value === undefined || value === null || value === "") continue;
      args.push(`--${key}`, String(value));
    }
    const opts = { maxBuffer: 16 * 1024 * 1024 };
    const child = execFile("aux4", args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve((stdout || "").trim());
    });
    if (stdinInput !== undefined) {
      child.stdin.write(typeof stdinInput === "string" ? stdinInput : JSON.stringify(stdinInput));
    }
    child.stdin.end();
  });
}

/**
 * Resolve the queue.provider key from a parsed `queue` config object,
 * accepting the pre-BOT-020 `queue.command`/`queue.storage` shape as a
 * backward-compatible alias for one version:
 *   - queue.provider is used as-is when set (current shape).
 *   - queue.command === "queue-sqs" maps to provider "sqs" (the old
 *     dedicated aux4/queue-sqs dispatch key).
 *   - queue.storage (memory|repository) maps straight across, since those
 *     are already valid aux4/queue --provider values.
 *   - defaults to "memory" when nothing is set, matching aux4/queue's own
 *     default.
 */
export function resolveProvider(queue = {}) {
  if (queue.provider) return queue.provider;
  if (queue.command === "queue-sqs") return "sqs";
  if (queue.storage) return queue.storage;
  return "memory";
}
