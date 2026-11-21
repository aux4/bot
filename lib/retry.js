import { leaseNext, workPullProcess, requestContext } from "./worker.js";
import { parseMaybeJson } from "./config.js";
import { reply } from "./stdin.js";

function integer(value, fallback, min, max, name) {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Invalid retry ${name}`);
  return number;
}

// Retry only through the canonical worker: its leases, nack attempt counter,
// reply guards and agent message IDs remain authoritative. No new queue state.
export async function retryWork(options, {
  work,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => performance.now()
}) {
  const expected = integer(options.expected, 0, 0, 100000, "expected");
  const attempts = integer(options.attempts, 6, 1, 10, "attempts");
  const delay = integer(options.delay, 1000, 0, 10000, "delay");
  const maxDelay = integer(options.maxDelay, 15000, 0, 30000, "maxDelay");
  const budget = integer(options.budget, 240000, 1, 240000, "budget");
  const maxMessages = integer(options.maxMessages, 100, 1, 1000, "maxMessages");
  const deadline = now() + budget;
  const failed = new Set();
  const report = { processed: 0, attempts: 0, retries: 0, failed: 0, exhausted: false, reason: "empty" };
  let streak = 0;
  const stop = reason => ({ ...report, failed: failed.size, exhausted: true, reason });

  while (true) {
    if (now() >= deadline) return stop("time-budget");
    if (report.processed >= maxMessages) return stop("message-limit");
    report.attempts += 1;
    let result;
    try { result = await work(); } catch {
      // Child errors can contain credentials/URLs; only aggregate counts escape.
      result = { error: true };
    }
    if (result?.leased === true && result.result === "acked" && result.id) {
      failed.delete(result.id);
      report.processed += 1;
      streak = 0;
      continue;
    }
    if (result?.leased === true && result.result === "nacked" && result.id) failed.add(result.id);
    if (result?.leased === false && report.processed >= expected && failed.size === 0) {
      return { ...report, failed: 0 };
    }
    streak += 1;
    if (streak >= attempts) return stop("retry-limit");
    const remaining = deadline - now();
    if (remaining <= 0) return stop("time-budget");
    report.retries += 1;
    await wait(Math.min(delay * 2 ** (streak - 1), maxDelay, remaining));
  }
}

// args: canonical worker's six config values, then bounded retry settings.
export async function workRetry(args) {
  const queue = parseMaybeJson(args[5], {}) || {};
  const [expected, attempts, delay, maxDelay, budget, maxMessages] = args.slice(6);
  const report = await retryWork({ expected, attempts, delay, maxDelay, budget, maxMessages }, {
    work: async () => {
      const lease = await leaseNext(queue);
      const result = await workPullProcess([...args.slice(0, 6), JSON.stringify(lease)], { emit: false });
      return { ...result, id: lease.id || (lease.body ? requestContext(lease.body).requestId : "") };
    }
  });
  reply(report);
  if (report.exhausted) {
    process.stderr.write(`Bot work retries exhausted (${report.reason}); inspect the queue and dead letters\n`);
    process.exitCode = 1;
  }
}
