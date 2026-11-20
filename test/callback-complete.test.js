import test from "node:test";
import assert from "node:assert/strict";
import { completeRequest } from "../lib/complete.js";

const requestId = `req:${"a".repeat(64)}`;
const baseRequest = {
  requestId,
  messageId: requestId,
  agentConversationId: "123e4567-e89b-52d3-a456-426614174000",
  conversationId: "whatsapp:support:+15551234",
  channel: "echo",
  botId: "support",
  chatId: "+15551234",
  threadId: "",
  eventKey: "provider-event-1",
  text: "hello",
  status: "pending",
  callbackTtl: 129600
};

function harness({ request = baseRequest, claim = () => true, send = () => ({ ok: true }) } = {}) {
  const records = new Map([[requestId, { ...request }]]);
  const sent = [];
  const writes = [];
  const repository = {
    read: async (_db, table, id) => {
      if (table === "conversations") return records.get(`conversation:${id}`) || null;
      return records.get(id) || null;
    },
    write: async (_db, table, id, data) => {
      writes.push({ table, id, data });
      records.set(table === "conversations" ? `conversation:${id}` : id, { ...data });
    },
    claim: async (...args) => claim(...args),
    release: async () => {},
    send: async (_channel, operation, payload) => {
      if (operation === "format") return { text: payload.markdown.toUpperCase() };
      const result = await send(payload);
      if (result && result.ok !== false) sent.push(payload);
      return result;
    },
    log: async () => {}
  };
  return { records, sent, writes, repository };
}

const config = {
  channels: ["echo"],
  bots: { support: { channel: "echo" } },
  defaults: {}
};

test("complete sends once and persists history", async () => {
  const h = harness();
  const result = await completeRequest({ requestId, status: "completed", reply: "answer" }, { ...config, db: "test", repository: h.repository });
  assert.deepEqual(result, { accepted: true });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, "ANSWER");
  assert.equal(h.writes.filter(w => w.table === "conversations").length, 1);
  assert.equal(h.records.get(requestId).status, "completed");
});

test("completed callback is idempotent and pending duplicate is rejected", async () => {
  const h = harness();
  h.records.set(requestId, { ...baseRequest, status: "completed" });
  assert.deepEqual(await completeRequest({ requestId, status: "completed", reply: "answer" }, { ...config, db: "test", repository: h.repository }), { accepted: true, duplicate: true });
  assert.equal(h.sent.length, 0);

  const pending = harness({ claim: async () => false });
  await assert.rejects(() => completeRequest({ requestId, status: "completed", reply: "answer" }, { ...config, db: "test", repository: pending.repository }), /already in progress/);
  assert.equal(pending.sent.length, 0);
});

test("unknown and mismatched correlations are rejected before send", async () => {
  const h = harness();
  await assert.rejects(() => completeRequest({ requestId: `req:${"b".repeat(64)}`, status: "completed", reply: "x" }, { ...config, db: "test", repository: h.repository }), /unknown requestId/);
  await assert.rejects(() => completeRequest({ requestId, status: "completed", reply: "x", conversationId: "wrong" }, { ...config, db: "test", repository: h.repository }), /correlation mismatch/);
  assert.equal(h.sent.length, 0);
});

test("claim failure is fail-closed and provider failure releases the claim", async () => {
  const claimFailure = harness({ claim: async () => { throw new Error("db unavailable"); } });
  await assert.rejects(() => completeRequest({ requestId, status: "completed", reply: "x" }, { ...config, db: "test", repository: claimFailure.repository }), /claim failed/);
  assert.equal(claimFailure.sent.length, 0);

  let released = 0;
  const sendFailure = harness({ send: async () => { throw new Error("provider down"); } });
  sendFailure.repository.release = async () => { released++; };
  await assert.rejects(() => completeRequest({ requestId, status: "completed", reply: "x" }, { ...config, db: "test", repository: sendFailure.repository }), /provider down/);
  assert.equal(released, 1);
  assert.equal(sendFailure.sent.length, 0);
});
