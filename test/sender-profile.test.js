import test from "node:test";
import assert from "node:assert/strict";
import { senderProfile } from "../lib/sender.js";
import { requestContext } from "../lib/worker.js";

test("only the optional display name crosses the brain boundary", () => {
  assert.deepEqual(senderProfile({ displayName: "  Ada\nLovelace\u0000 ", token: "private", verified: true, userId: "phone" }), { displayName: "Ada Lovelace" });
  for (const input of [null, {}, {displayName: 42}, {displayName:"  "}]) assert.deepEqual(senderProfile(input), {});
  assert.equal(senderProfile({displayName:"a".repeat(1000)}).displayName.length, 200);
});
test("profile changes preserve the conversation and dedupe identities", () => {
  const msg = {channel:"whatsapp",botId:"support",event:{key:"evt",chatId:"chat",sender:{displayName:"Ada"}}};
  assert.deepEqual(requestContext(msg),requestContext({...msg,event:{...msg.event,sender:{displayName:"Grace"}}}));
});



test("opaque participant ID survives without introducing identity authority",()=>{
  assert.deepEqual(senderProfile({displayName:"Alice",id:"a".repeat(64),token:"private",role:"owner"}),{displayName:"Alice",id:"a".repeat(64)});
  assert.equal(senderProfile({displayName:"Alice",id:"phone-or-email"}).id,undefined);
});
