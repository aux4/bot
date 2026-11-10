import { execFile } from "child_process";

// Dispatches to a channel plugin's command: `aux4 bot <channel> <subcommand>`.
// A plugin is any installed aux4 package that adds a `<channel>` command to
// the `bot` profile (routing to its own `<channel>` profile) implementing the
// six-command contract: verify, ingest-parse, send, typing, download, format.
// See package/README.md "Writing a channel plugin".
//
// The core never imports a plugin's code directly — plugins are reached only
// through the aux4 CLI surface, exactly like the webhook route reaches `bot`
// itself, so a plugin can be written in any language aux4 can shell out to.

/**
 * Invoke `aux4 bot <channel> <subcommand>`, writing `input` (an object) as
 * JSON to stdin and parsing stdout as JSON. Rejects on a non-zero exit.
 */
export function callPlugin(channel, subcommand, input, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["bot", channel, subcommand];
    const opts = { maxBuffer: 16 * 1024 * 1024 };
    if (timeoutMs) opts.timeout = timeoutMs;
    const child = execFile("aux4", args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      const out = (stdout || "").trim();
      if (!out) return resolve(null);
      try {
        resolve(JSON.parse(out));
      } catch {
        // Not every plugin command needs to return JSON (verify's handshake
        // reply is often plain text) — hand back the raw string instead of
        // failing the whole call.
        resolve(out);
      }
    });
    child.stdin.write(JSON.stringify(input === undefined ? {} : input));
    child.stdin.end();
  });
}
