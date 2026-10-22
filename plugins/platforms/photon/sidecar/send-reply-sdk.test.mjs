import assert from "node:assert/strict";
import { test } from "node:test";
import { Spectrum, text, poll, reply } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { sendContent, withNativeReplyTargets } from "./send-reply.mjs";

const destination = "any;+;destination-room";
const phone = "+15555550123";

// Only the native transport is in-memory. Lookup, cache, wrapping, reply
// dispatch and UnsupportedError handling all run through the pinned SDK.
async function sdkTransport(t, chatGuids = [destination], guarded = true) {
  const calls = [];
  const native = {
    guid: "foreign-guid", chatGuids, isFromMe: false,
    dateCreated: new Date("2026-01-01T00:00:00Z"),
    sender: { address: "+15555550124" },
    content: { text: "question", attachments: [] },
  };
  const remote = {
    messages: {
      async get(id) { calls.push({ op: "get", id }); return native; },
      async sendText(chat, value, options) {
        calls.push({ op: "sendText", chat, value, options });
        return { ...native, guid: "sent-1", isFromMe: true, chatGuids: [chat], content: { text: value, attachments: [] } };
      },
    },
    polls: { async create() { return { pollMessageGuid: native.guid }; } },
    async close() {},
  };
  const provider = imessage.config();
  provider.__definition = {
    ...provider.__definition,
    lifecycle: { ...provider.__definition.lifecycle, createClient: async () => [{ phone, client: remote }] },
  };
  const platform = guarded ? await withNativeReplyTargets(provider) : imessage;
  const app = await Spectrum({ providers: [guarded ? platform.config() : provider], telemetry: false });
  t.after(() => app.stop());
  const space = await platform(app).space.get(destination);
  return { app, space, calls, native, remote };
}

test("native foreign chat is rejected even when SDK rewrites target.space", async (t) => {
  const unguarded = await sdkTransport(t, ["any;+;foreign-room"], false);
  const target = await unguarded.space.getMessage("foreign-guid");
  assert.equal(target.space.id, destination); // the ineffective old check
  const { space, calls } = await sdkTransport(t, ["any;+;foreign-room"]);
  await assert.rejects(sendContent(space, text("answer"), "foreign-guid"), { name: "ReplyTargetError" });
  assert.equal(calls.filter((call) => call.op === "sendText").length, 0);
});

test("native membership permits a reply and is checked even after caching", async (t) => {
  const { space, calls, native } = await sdkTransport(t, ["any;+;other-room", destination]);
  const sent = await sendContent(space, text("answer"), "foreign-guid");
  assert.equal(sent.id, "sent-1");
  assert.deepEqual(calls.filter((call) => call.op === "sendText"), [
    { op: "sendText", chat: destination, value: "answer", options: { replyTo: "foreign-guid" } },
  ]);
  native.chatGuids = [];
  await assert.rejects(sendContent(space, text("must not send"), "foreign-guid"), { name: "ReplyTargetError" });
  assert.equal(calls.filter((call) => call.op === "sendText").length, 1);
});

test("SDK-swallowed unsupported cached poll reply is not delivery success", async (t) => {
  const { space, native, calls } = await sdkTransport(t);
  native.guid = "poll-guid";
  await space.send(poll("Choose", ["Yes", "No"]));
  const target = await space.getMessage("poll-guid");
  assert.equal(target.content.type, "poll");
  assert.equal(await space.send(reply(text("SDK reproduction"), target)), undefined);
  await assert.rejects(sendContent(space, text("answer"), "poll-guid"), { name: "MessageNotDeliveredError" });
  assert.equal(calls.filter((call) => call.op === "sendText").length, 0);
});
