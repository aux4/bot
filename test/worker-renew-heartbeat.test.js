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

test("startRenewHeartbeat keeps its cadence from the START of each renew, even when a renew is slow", async () => {
  const starts = [];
  const queue = { name: "q", visibility: "2" }; // interval = 1000ms (floor)
  const lease = { leaseId: "lease-cadence" };

  // Each renew takes 800ms. Measured from the end of each renew, the gap
  // between starts would be ~1800ms; measured from the start it is ~1000ms.
  const renewFn = async () => {
    starts.push(Date.now());
    await new Promise(resolve => setTimeout(resolve, 800));
  };

  const heartbeat = startRenewHeartbeat("memory", queue, lease, renewFn);
  await new Promise(resolve => setTimeout(resolve, 2300));
  await heartbeat.stop();

  assert.ok(starts.length >= 3, `expected at least 3 renews in 2.3s, got ${starts.length}`);
  const gap = starts[1] - starts[0];
  assert.ok(gap < 1400, `expected ~1000ms between renew starts, got ${gap}ms`);
});

test("startRenewHeartbeat stop() waits for a renew already in flight", async () => {
  let finished = false;
  const queue = { name: "q", visibility: "30" };
  const lease = { leaseId: "lease-inflight" };

  const renewFn = async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    finished = true;
  };

  const heartbeat = startRenewHeartbeat("memory", queue, lease, renewFn);
  await heartbeat.stop();

  assert.equal(finished, true, "stop() must not resolve before the in-flight renew settles (it would land after ack/nack)");
});
