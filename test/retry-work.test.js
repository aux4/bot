import test from "node:test";
import assert from "node:assert/strict";
import { retryWork } from "../lib/retry.js";

const ack = id => ({ leased: true, result: "acked", id });
const nack = id => ({ leased: true, result: "nacked", id });
const empty = { leased: false };
async function scenario(sequence, options = {}) {
  let time = 0;
  let calls = 0;
  const delays = [];
  const report = await retryWork(options, {
    work: async () => {
      const result = sequence[calls++] ?? empty;
      if (result instanceof Error) throw result;
      return result;
    },
    wait: async ms => { delays.push(ms); time += ms; },
    now: () => time
  });
  return { report, calls, delays };
}

test("a transient lease error retries and then acknowledges work", async () => {
  const { report, delays } = await scenario([new Error("private provider response"), ack("one"), empty], { expected: 1 });
  assert.equal(report.processed, 1);
  assert.equal(report.retries, 1);
  assert.equal(report.exhausted, false);
  assert.deepEqual(delays, [1000]);
  assert.ok(!JSON.stringify(report).includes("private"));
});

test("a new enqueue is not abandoned on an empty lease", async () => {
  const { report, delays } = await scenario([empty, empty, ack("one"), empty], { expected: 1 });
  assert.equal(report.processed, 1);
  assert.equal(report.exhausted, false);
  assert.deepEqual(delays, [1000, 2000]);
});

test("an empty queue without expected new work exits immediately", async () => {
  const { report, calls, delays } = await scenario([empty]);
  assert.equal(report.exhausted, false);
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test("a nacked message retries through the same worker and later recovers", async () => {
  const { report } = await scenario([nack("one"), ack("one"), ack("two"), empty], { expected: 2 });
  assert.equal(report.processed, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.exhausted, false);
});

test("a failed or dead-lettered message cannot be hidden by a subsequent empty lease", async () => {
  const { report, calls } = await scenario([nack("one"), empty, empty], { attempts: 3 });
  assert.equal(report.exhausted, true);
  assert.equal(report.reason, "retry-limit");
  assert.equal(report.failed, 1);
  assert.equal(calls, 3);
});

test("processing a different message does not erase an unresolved failure", async () => {
  const { report } = await scenario([nack("one"), ack("two"), empty, empty], { attempts: 2 });
  assert.equal(report.failed, 1);
  assert.equal(report.exhausted, true);
});

test("backoff covers a visibility window and stays capped", async () => {
  const { report, delays } = await scenario([...Array.from({ length: 5 }, () => new Error("unavailable")), ack("one"), empty], { expected: 1 });
  assert.equal(report.exhausted, false);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000]);
});

test("time and message budgets stop additional attempts", async () => {
  const timed = await scenario([empty], { expected: 1, budget: 500 });
  assert.equal(timed.calls, 1);
  assert.equal(timed.report.reason, "time-budget");
  assert.deepEqual(timed.delays, [500]);
  const capped = await scenario([ack("one"), ack("two")], { maxMessages: 1 });
  assert.equal(capped.calls, 1);
  assert.equal(capped.report.reason, "message-limit");
});

test("invalid retry settings fail before leasing anything", async () => {
  for (const options of [{ attempts: 0 }, { attempts: 11 }, { expected: -1 }, { budget: 0 }, { maxDelay: -1 }, { delay: "bad" }]) {
    await assert.rejects(retryWork(options, { work: async () => { throw new Error("must not run"); } }), /Invalid retry/);
  }
});
