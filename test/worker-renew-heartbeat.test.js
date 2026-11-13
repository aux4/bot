import { test } from "node:test";
import assert from "node:assert/strict";
import { startRenewHeartbeat } from "../lib/worker.js";

// Regression test for the renew heartbeat missing its lease window on a
// short --visibility: the first renew must fire immediately when the lease
// is acquired, not after waiting out a full interval.

test("startRenewHeartbeat renews immediately, before the first interval elapses", async () => {
  const calls = [];
  const queue = { name: "q", visibility: "30" }; // interval = 15000ms
  const lease = { leaseId: "lease-1" };

  const renewFn = async flags => {
    calls.push(flags);
  };

  const heartbeat = startRenewHeartbeat("memory", queue, lease, renewFn);

  // The first renew is fired synchronously (as a microtask), not scheduled
  // behind a 15s timer -- give it a tick to resolve, nothing more.
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls.length, 1, "expected exactly one renew call before any interval could have elapsed");
  assert.equal(calls[0].leaseId, "lease-1");
  assert.equal(calls[0].visibility, "30");

  heartbeat.stop();
});

test("startRenewHeartbeat retries quickly (not a full interval) after a failed renew", async () => {
  let attempts = 0;
  const queue = { name: "q", visibility: "30" };
  const lease = { leaseId: "lease-2" };

  const renewFn = async () => {
    attempts += 1;
    if (attempts < 2) {
      throw new Error("transient failure");
    }
  };

  const heartbeat = startRenewHeartbeat("memory", queue, lease, renewFn);

  // The quick retry is spaced ~1s apart (QUICK_RETRY_MS), far short of the
  // 15s normal interval derived from visibility 30 -- waiting just over 1s
  // is enough to observe the retry if the fix is in place.
  await new Promise(resolve => setTimeout(resolve, 1200));

  assert.equal(attempts, 2, "expected a quick retry well under the 15s normal interval");

  heartbeat.stop();
});

test("startRenewHeartbeat warns but does not change the configured visibility below the recommended minimum", async () => {
  const calls = [];
  const queue = { name: "q", visibility: "3" };
  const lease = { leaseId: "lease-3" };

  const renewFn = async flags => {
    calls.push(flags);
  };

  const heartbeat = startRenewHeartbeat("memory", queue, lease, renewFn);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls[0].visibility, "3", "a short visibility is respected, not silently clamped");

  heartbeat.stop();
});
