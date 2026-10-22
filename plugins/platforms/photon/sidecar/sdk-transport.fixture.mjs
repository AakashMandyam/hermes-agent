// Real sidecar + pinned SDK; only the native transport is in memory.
import http from "node:http";
import { createInterface } from "node:readline";
import { registerHooks } from "node:module";
import { imessage } from "spectrum-ts/providers/imessage";
import { NotFoundError } from "@photon-ai/advanced-imessage/grpc";
import { UnsupportedError } from "spectrum-ts";

const sdk = import.meta.resolve("spectrum-ts");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== "spectrum-ts") return next(specifier, context);
    // Avoid cloud project discovery; provider creation and all dispatch stay real.
    const source = `export * from ${JSON.stringify(sdk)};
      import { Spectrum as realSpectrum } from ${JSON.stringify(sdk)};
      export const Spectrum = (options) => realSpectrum({ ...options,
        projectId: undefined, projectSecret: undefined, telemetry: false });`;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});
globalThis.fetch = async () => { throw new Error("network forbidden in SDK transport fixture"); };
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const calls = [];
let captionFailure;
const destination = "any;+;destination-room";
const phone = "+15555550123";
const native = (guid, chat = destination, value = "question") => ({
  guid, chatGuids: [chat], isFromMe: true,
  dateCreated: new Date("2026-01-01T00:00:00Z"),
  sender: { address: phone }, content: { text: value, attachments: [] },
});
const streams = new Map();
function queue(name) {
  const values = [];
  let wake;
  let ended = false;
  const stream = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (values.length) return Promise.resolve({ value: values.shift(), done: false });
      if (ended) return Promise.resolve({ done: true });
      return new Promise((resolve) => { wake = resolve; });
    },
    push(value) {
      if (wake) { const resolve = wake; wake = null; resolve({ value, done: false }); }
      else values.push(value);
    },
    async close() { ended = true; wake?.({ done: true }); },
    async return() { await this.close(); return { done: true }; },
  };
  streams.set(name, stream);
  return stream;
}
const remote = {
  messages: {
    subscribeEvents: () => queue("messages"),
    async get(id) {
      calls.push({ op: "get", id });
      if (!["original-guid", "poll-guid", "foreign-guid"].includes(id)) throw new NotFoundError("not found");
      return native(id, id === "foreign-guid" ? "any;+;foreign-room" : destination);
    },
    async sendText(chat, text, options) {
      calls.push({ op: "sendText", chat, text, options });
      if (text === "caption" && captionFailure === "unsupported") {
        throw UnsupportedError.action("caption", "imessage");
      }
      if (text === "caption" && captionFailure === "error") throw new Error("caption failed");
      return native(`sent-${calls.length}`, chat, text);
    },
    async sendAttachment(chat, bytes, options) {
      calls.push({ op: "sendAttachment", chat, options });
      return native(`sent-${calls.length}`, chat, "");
    },
  },
  polls: {
    subscribeEvents: () => queue("polls"),
    async get() {
      return { pollMessageGuid: "poll-guid", title: "Choose", options: [{ optionIdentifier: "choice-id", text: "Yes" }, { optionIdentifier: "no-id", text: "No" }] };
    },
    async create(chat, title, options) {
      calls.push({ op: "pollCreate", chat, title, options });
      return this.get();
    },
  },
  groups: { subscribeEvents: () => queue("groups") },
  attachments: { async upload() { calls.push({ op: "upload" }); return { attachment: { guid: "attachment-1" } }; } },
  async close() { for (const stream of streams.values()) await stream.close(); },
};
const originalConfig = imessage.config;
imessage.config = (...args) => {
  const provider = originalConfig(...args);
  provider.__definition = { ...provider.__definition, lifecycle: {
    ...provider.__definition.lifecycle, createClient: async () => [{ phone, client: remote }],
  } };
  return provider;
};
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.once("listening", () => output({ ready: true, port: this.address().port }));
  return listen.apply(this, args);
};
createInterface({ input: process.stdin }).on("line", (line) => {
  try {
    const command = JSON.parse(line);
    if (command.op === "captionFailure") captionFailure = command.kind;
    if (command.op === "emit") {
      const base = { sequence: 42, chatGuid: destination, actor: { address: "user-1" },
        isFromMe: false, occurredAt: new Date(123) };
      if (command.kind === "reaction") streams.get("messages").push({ ...base,
        type: "message.reactionAdded", messageGuid: "original-guid", reaction: { kind: "like" } });
      else streams.get("polls").push({ ...base, type: "poll.changed", pollMessageGuid: "poll-guid",
        delta: { type: "voted", optionIdentifier: "choice-id" } });
    }
    output({ calls });
  } catch (error) { output({ error: String(error) }); }
});
await import("./index.mjs");
