import test from "node:test";
import assert from "node:assert/strict";
import { leaseNext } from "../lib/worker.js";

const queue = { provider: "repository", name: "inbox", db: "cloud", visibility: 30, maxAttempts: 5 };

test("documented repository and memory empty results are normal", async () => {
  for (const stdout of ["[]", "{}", "[]\n", "{}\n"]) {
    const lease = await leaseNext(queue, async () => { throw Object.assign(new Error("empty"), { code: 4, stdout, stderr: "" }); });
    assert.equal(lease.id, "");
    assert.equal(lease.leaseId, "");
  }
});

test("provider errors cannot be silently acknowledged as an empty queue", async () => {
  for (const error of [
    { code: 1, stdout: "", stderr: "connection refused" },
    { code: 4, stdout: "", stderr: "SQLITE_BUSY: database locked" },
    { code: 4, stdout: "[]", stderr: "Forbidden" },
    { code: 1, stdout: "{}", stderr: "unauthorized" }
  ]) {
    await assert.rejects(leaseNext(queue, async () => { throw Object.assign(new Error("command with private token"), error); }), /Queue lease failed/);
  }
});

test("diagnostics do not disclose provider credentials or response bodies", async () => {
  const secret = "fixture-secret-never-log";
  await assert.rejects(leaseNext(queue, async () => {
    throw Object.assign(new Error(secret), { code: 1, stdout: secret, stderr: `Forbidden token=${secret}` });
  }), error => error.message.includes("authentication") && !error.message.includes(secret));
});

test("malformed successful responses are errors, not an empty queue", async () => {
  for (const output of ["", "garbage", "null", '{"error":"failed"}', "[{}]"]) {
    await assert.rejects(leaseNext(queue, async () => output), /Queue lease returned/);
  }
});

test("valid leases and provider dispatch keep their existing shape", async () => {
  for (const output of ['[{"id":"record-1","body":{"event":{}},"attempts":2}]', '{"leaseId":"lease-1","body":{"event":{}}}']) {
    const lease = await leaseNext(queue, async (provider, operation, flags) => {
      assert.equal(provider, "repository");
      assert.equal(operation, "lease");
      assert.equal(flags.db, "cloud");
      assert.equal(flags.visibility, 30);
      return output;
    });
    assert.ok(lease.id || lease.leaseId);
    assert.deepEqual(lease.body, { event: {} });
  }
  for (const output of ["[]", "{}"]) assert.equal((await leaseNext(queue, async () => output)).id, "");
  await leaseNext({ ...queue, visibility: 0, maxAttempts: 0 }, async (_provider, _operation, flags) => {
    assert.equal(flags.visibility, 0);
    assert.equal(flags.maxAttempts, 0);
    return "[]";
  });
});
