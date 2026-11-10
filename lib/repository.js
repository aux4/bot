import { execFile } from "child_process";

// Thin wrapper over the `aux4 repository` CLI. State lives in a shared sqlite
// (or libsql://) database, isolated per channel+bot by id prefixes.

function runAux4(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile("aux4", args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve((stdout || "").trim());
    });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Atomically claim an id — the race-free dedupe/reply-once primitive (see
 * aux4/repository BOT-002). Returns true when claimed, false when a live
 * record already held the id. Any other error propagates.
 */
export async function claim(db, repository, id, data, ttl) {
  const args = ["repository", "claim", "--db", db, "--repository", repository, "--id", id, "--data", JSON.stringify(data || {})];
  if (ttl !== undefined && ttl !== null && ttl !== "") {
    args.push("--ttl", String(ttl));
  }
  try {
    await runAux4(args);
    return true;
  } catch (err) {
    if (/already claimed/.test(String(err.stderr || err.message || ""))) {
      return false;
    }
    throw err;
  }
}

/**
 * Read a single record by id. Returns the record object (data merged with id)
 * or null when absent/expired. `aux4 repository read --id` returns a JSON array.
 */
export async function readRecord(db, repository, id) {
  const out = await runAux4(["repository", "read", "--db", db, "--repository", repository, "--id", id, "--raw", "true"]);
  if (!out) return null;
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    return parsed.length > 0 ? parsed[0] : null;
  }
  return parsed;
}

export async function writeRecord(db, repository, id, data, ttl) {
  const args = ["repository", "write", "--db", db, "--repository", repository, "--id", id, "--data", JSON.stringify(data)];
  if (ttl !== undefined && ttl !== null && ttl !== "") {
    args.push("--ttl", String(ttl));
  }
  await runAux4(args);
}

/**
 * Sweep expired records (ttl in the past) from EVERY repository table in the
 * database in one call. Returns the command's stdout (one "<table>: <n>
 * expired records removed" line per table).
 */
export async function clean(db) {
  return runAux4(["repository", "clean", "--db", db]);
}

export async function initRepository(db, repository) {
  await runAux4(["repository", "init", "--db", db, repository]);
}
