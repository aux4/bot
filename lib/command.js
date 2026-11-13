import { spawn } from "child_process";

/**
 * Tokenize a command string into argv, honoring simple single/double quoting.
 */
export function tokenize(commandStr) {
  const tokens = [];
  let current = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < commandStr.length; i++) {
    const ch = commandStr[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === " " || ch === "\t") {
      if (has) {
        tokens.push(current);
        current = "";
        has = false;
      }
    } else {
      current += ch;
      has = true;
    }
  }
  if (has) tokens.push(current);
  return tokens;
}

/**
 * Cap conversation history to the most recent turns, bounded by a max-turn
 * count and/or a character budget. The most recent turns are always kept.
 */
export function capHistory(history, opts = {}) {
  let turns = Array.isArray(history) ? history.slice() : [];

  const maxTurns = opts.historyMaxTurns;
  if (maxTurns !== undefined && maxTurns !== null && maxTurns !== "" && Number(maxTurns) >= 0) {
    const n = Number(maxTurns);
    if (turns.length > n) {
      turns = turns.slice(turns.length - n);
    }
  }

  const charBudget = opts.historyCharBudget;
  if (charBudget !== undefined && charBudget !== null && charBudget !== "" && Number(charBudget) > 0) {
    const budget = Number(charBudget);
    const lens = turns.map(t => `${t.role || "user"}: ${t.text || ""}`.length + 1);
    let total = lens.reduce((s, n) => s + n, 0);
    let start = 0;
    while (start < turns.length - 1 && total > budget) {
      total -= lens[start];
      start++;
    }
    turns = turns.slice(start);
  }

  return turns;
}

/**
 * Assemble the stdin context passed to the brain command: prior conversation
 * history (optionally capped) plus the list of downloaded attachment paths.
 */
export function buildContext(conversation, filePaths, opts = {}) {
  const parts = [];
  const history = capHistory((conversation && conversation.history) || [], opts);
  if (history.length > 0) {
    parts.push("# Conversation so far");
    for (const turn of history) {
      parts.push(`${turn.role || "user"}: ${turn.text || ""}`);
    }
  }
  if (filePaths && filePaths.length > 0) {
    parts.push("");
    parts.push("# Attached files");
    for (const p of filePaths) {
      parts.push(`- ${p}`);
    }
  }
  return parts.join("\n");
}

/**
 * Run a per-bot hook command (currently just `onMessage`): writes `input`
 * as JSON to stdin, waits for exit. No stdout capture — a hook's output, if
 * any, is discarded; only a non-zero exit is treated as failure. Callers
 * fire this without awaiting it on the reply's critical path (see
 * worker.js) so a slow or failing hook never blocks or delays the reply.
 */
export function runHook(commandStr, input) {
  return new Promise((resolve, reject) => {
    const tokens = tokenize(commandStr);
    if (tokens.length === 0) {
      return reject(new Error("empty command"));
    }
    const [cmd, ...rest] = tokens;
    const child = spawn(cmd, rest, { stdio: ["pipe", "ignore", "pipe"] });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", d => (stderr += d));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        const err = new Error(`hook command exited with code ${code}`);
        err.stderr = stderr;
        return reject(err);
      }
      resolve();
    });

    child.stdin.write(JSON.stringify(input === undefined ? {} : input));
    child.stdin.end();
  });
}

/**
 * Run the configured brain command: positional arg = user text, stdin =
 * context, env carries extra metadata. Resolves with stdout (Markdown).
 *
 * When `timeout` (ms) elapses, the child's whole process group is killed
 * (SIGKILL) and the promise rejects with an error carrying `timedOut:true`.
 */
export function runBrain(commandStr, text, { context, env, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const tokens = tokenize(commandStr);
    if (tokens.length === 0) {
      return reject(new Error("empty command"));
    }
    const [cmd, ...rest] = tokens;
    const args = [...rest, text];
    const child = spawn(cmd, args, {
      env: Object.assign({}, process.env, env || {}),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer = null;

    const ms = Number(timeout);
    if (ms && ms > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
      }, ms);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("error", err => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", code => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        const err = new Error(`command timed out after ${ms}ms`);
        err.timedOut = true;
        err.stderr = stderr;
        return reject(err);
      }
      if (code !== 0) {
        const err = new Error(`command exited with code ${code}`);
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });

    if (context !== undefined && context !== null && context !== "") {
      child.stdin.write(context);
    }
    child.stdin.end();
  });
}
