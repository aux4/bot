import { execFile } from "child_process";

// Dispatches to the configured queue backend through the SAME validated
// dynamic-subcommand allowlist package/.aux4 uses for every other caller
// (`aux4 bot provider <key> <op>`, routing to profile bot:provider:<key>) —
// there is deliberately no separate JS-side allowlist here. An unconfigured
// or misspelled `queue.command` key simply fails to resolve ("Command not
// found") instead of silently shelling out to an arbitrary string. Adding a
// new backend (e.g. BOT-017's aux4/queue-sqs) only ever means adding one leaf
// profile in package/.aux4 — this file never changes.

/**
 * Invoke `aux4 bot provider <providerKey> <op> --flag value ...`, writing
 * `stdinInput` to stdin when given. Rejects on a non-zero exit (including
 * "Command not found" for an unlisted providerKey).
 */
export function callProvider(providerKey, op, flags = {}, stdinInput) {
  return new Promise((resolve, reject) => {
    const args = ["bot", "provider", providerKey, op];
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
