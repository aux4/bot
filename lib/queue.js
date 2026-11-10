import { execFile, spawn } from "child_process";

// Thin wrapper over the `aux4 queue` CLI (in-memory pub/sub bus).
// `queue` is localhost-only and addressed by --port.

/**
 * Send one message (JSON) to a queue. Resolves when accepted.
 *
 * `aux4 queue send` always exits 0 — including when the target port has
 * nothing listening (connection refused) or the queue name doesn't exist —
 * and instead reports the outcome in its JSON stdout as
 * `{"errors":N,"sent":N}`. A non-zero `errors` count must be treated as a
 * rejection here, or callers (ingest's claim-before-enqueue path) would
 * never see the failure and silently ack a message that was never enqueued.
 */
export function sendMessage(port, name, message) {
  return new Promise((resolve, reject) => {
    const args = ["queue", "send", "--port", String(port), "--name", name];
    const child = execFile("aux4", args, (err, stdout, stderr) => {
      const out = (stdout || "").trim();
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      let result;
      try {
        result = JSON.parse(out);
      } catch {
        result = null;
      }
      if (result && typeof result === "object" && Number(result.errors) > 0) {
        return reject(new Error(`queue send reported ${result.errors} error(s): ${stderr || out}`));
      }
      resolve(out);
    });
    child.stdin.write(JSON.stringify(message) + "\n");
    child.stdin.end();
  });
}

/**
 * Open a persistent receive stream and invoke onMessage(obj) for every NDJSON
 * line. Returns the child process (kill it to stop). Queue is fan-out pub/sub:
 * only messages published while connected are delivered, so keep this open.
 */
export function receiveStream(port, name, onMessage, onError) {
  const args = ["queue", "receive", "--port", String(port), "--name", name];
  const child = spawn("aux4", args, { stdio: ["ignore", "pipe", "pipe"] });

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      Promise.resolve(onMessage(obj)).catch(err => {
        if (onError) onError(err);
      });
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", data => {
    if (onError) onError(new Error(String(data).trim()));
  });

  return child;
}
