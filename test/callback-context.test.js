import test from "node:test";
import assert from "node:assert/strict";
import { requestContext, isCallbackMode } from "../lib/worker.js";

test("callback request context is stable and opaque", () => {
  const msg = {
    channel: "whatsapp",
    botId: "support",
    event: { key: "provider-event-1", chatId: "+15551234", threadId: "thread-1", text: "hello" }
  };
  const first = requestContext(msg);
  const second = requestContext(structuredClone(msg));
  assert.deepEqual(first, second);
  assert.match(first.requestId, /^req:[a-f0-9]{64}$/);
  assert.equal(first.conversationId, "whatsapp:support:thread-1");
  assert.equal(first.chatId, "+15551234");
  assert.ok(!first.requestId.includes("provider-event-1"));
});

test("different authenticated event identity produces a different request", () => {
  const base = { channel: "whatsapp", botId: "support", event: { key: "evt-1", chatId: "chat" } };
  assert.notEqual(requestContext(base).requestId, requestContext({ ...base, event: { ...base.event, key: "evt-2" } }).requestId);
});

test("callback mode is opt-in and leaves stdout mode unchanged", () => {
  assert.equal(isCallbackMode({ replyMode: "callback" }), true);
  assert.equal(isCallbackMode({ replyMode: "CALLBACK" }), true);
  assert.equal(isCallbackMode({}), false);
  assert.equal(isCallbackMode({ replyMode: "stdout" }), false);
});
