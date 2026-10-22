import assert from "node:assert/strict";
import { test } from "node:test";
import { text, markdown, richlink, attachment, voice, resolveContents } from "spectrum-ts";
import { sendContent } from "./send-reply.mjs";

function fakeSpace(target = { id: "p:0/target", space: { id: "space-1" }, content: { type: "text", text: "question" } }) {
  const sent = [];
  const lookedUp = [];
  return {
    id: "space-1", sent, lookedUp,
    async getMessage(id) { lookedUp.push(id); return target; },
    async send(builder) {
      const [content] = await resolveContents([builder]);
      sent.push(content);
      return { id: "sent-1" };
    },
  };
}

test("unsolicited sends stay top-level without a lookup", async () => {
  const space = fakeSpace();
  const result = await sendContent(space, text("notification"));
  assert.equal(result.id, "sent-1");
  assert.deepEqual(space.sent, [{ type: "text", text: "notification" }]);
  assert.deepEqual(space.lookedUp, []);
});

test("explicit target builds the SDK native reply content", async () => {
  const space = fakeSpace();
  const result = await sendContent(space, text("answer"), "p:0/target");
  assert.equal(result.id, "sent-1");
  assert.deepEqual(space.lookedUp, ["p:0/target"]);
  assert.equal(space.sent.length, 1);
  assert.equal(space.sent[0].type, "reply");
  assert.equal(space.sent[0].target.id, "p:0/target");
  assert.deepEqual(space.sent[0].content, { type: "text", text: "answer" });
});

for (const [name, target] of [
  ["missing", null],
  ["another space", { id: "p:0/target", space: { id: "space-2" }, content: { type: "text", text: "other" } }],
  ["another message", { id: "other", space: { id: "space-1" }, content: { type: "text", text: "other" } }],
]) {
  test(`rejects ${name} reply target without sending`, async () => {
    const space = fakeSpace(target);
    await assert.rejects(sendContent(space, text("answer"), "p:0/target"), { name: "ReplyTargetError" });
    assert.deepEqual(space.sent, []);
  });
}

test("lookup failure is explicit and never sends a top-level fallback", async () => {
  const space = fakeSpace();
  space.getMessage = async () => { throw new Error("upstream unavailable"); };
  await assert.rejects(sendContent(space, text("answer"), "p:0/target"), { name: "ReplyTargetError" });
  assert.deepEqual(space.sent, []);
});

test("media and its caption reply to the same target with a single lookup", async () => {
  const space = fakeSpace();
  const result = await sendContent(space, attachment(new Uint8Array([1, 2]), { name: "photo.png", mimeType: "image/png" }), "p:0/target", "caption");
  assert.equal(result.id, "sent-1");
  assert.deepEqual(space.lookedUp, ["p:0/target"]);
  assert.equal(space.sent.length, 2);
  assert.equal(space.sent[0].type, "reply");
  assert.equal(space.sent[0].content.type, "attachment");
  assert.equal(space.sent[1].type, "reply");
  assert.equal(space.sent[1].target, space.sent[0].target);
  assert.deepEqual(space.sent[1].content, { type: "text", text: "caption" });
});

test("caption failure after media success does not resend the media", async (t) => {
  const space = fakeSpace();
  const send = space.send.bind(space);
  let attempts = 0;
  space.send = async (builder) => {
    if (++attempts === 2) throw new Error("caption failed");
    return send(builder);
  };
  t.mock.method(console, "error", () => {});
  const result = await sendContent(space, text("media stand-in"), "p:0/target", "caption");
  assert.equal(result.id, "sent-1");
  assert.equal(attempts, 2);
  assert.equal(space.sent.length, 1);
});

for (const [name, builder] of [
  ["markdown", markdown("**answer**")],
  ["richlink", richlink("https://example.com")],
  ["voice", voice(new Uint8Array([1, 2]), { name: "note.m4a", mimeType: "audio/mp4" })],
]) {
  test(`${name} keeps native content inside the reply`, async () => {
    const space = fakeSpace();
    await sendContent(space, builder, "p:0/target");
    assert.equal(space.sent[0].type, "reply");
    assert.equal(space.sent[0].content.type, name);
  });
}
