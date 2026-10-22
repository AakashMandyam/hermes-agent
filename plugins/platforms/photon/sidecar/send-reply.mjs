export class ReplyTargetError extends Error {
  constructor(cause) {
    super("reply target unavailable in this space", { cause });
    this.name = "ReplyTargetError";
  }
}

export class MessageNotDeliveredError extends Error {
  constructor() {
    super("SDK send returned no delivered message");
    this.name = "MessageNotDeliveredError";
  }
}

// Guard the provider action before Spectrum applies its destination-space hint
// (and before its message cache can bypass the native membership check).
export async function withNativeReplyTargets(provider) {
  const { definePlatform } = await import("spectrum-ts");
  const definition = provider.__definition;
  return definePlatform(definition.name, {
    ...definition,
    actions: {
      ...definition.actions,
      async getMessage(ctx, space, id) {
        const remote = ctx.client.find((entry) => entry.phone === space.phone)?.client;
        if (!remote) throw new ReplyTargetError();
        const nativeId = id.replace(/^p:\d+\//, "");
        const native = await remote.messages.get(nativeId);
        if (native?.guid !== nativeId || !native.chatGuids?.includes(space.id)) {
          throw new ReplyTargetError();
        }
        return definition.actions.getMessage(ctx, space, id);
      },
    },
  });
}

// The guarded provider validates native chatGuids, not target.space's SDK hint.
async function resolveReplyTarget(space, replyTo) {
  if (!replyTo) return undefined;
  let target;
  try {
    target = await space.getMessage(replyTo);
  } catch (cause) {
    throw new ReplyTargetError(cause);
  }
  if (!target || target.id !== replyTo || target.space?.id !== space.id) {
    throw new ReplyTargetError();
  }
  return target;
}

export async function sendContent(space, content, replyTo, caption) {
  // index.mjs must apply the compatibility patch before the SDK is imported.
  const { reply, text } = await import("spectrum-ts");
  const target = await resolveReplyTarget(space, replyTo);
  const wrap = (value) => target ? reply(value, target) : value;
  const result = await space.send(wrap(content));
  if (!result?.id) throw new MessageNotDeliveredError();
  // Media has already delivered. Never propagate a caption error and cause a resend.
  if (caption && typeof caption === "string") {
    try {
      const delivered = await space.send(wrap(text(caption)));
      if (!delivered?.id) throw new MessageNotDeliveredError();
    } catch (error) {
      console.error("photon-sidecar: attachment sent but caption failed:", error);
    }
  }
  return result;
}
