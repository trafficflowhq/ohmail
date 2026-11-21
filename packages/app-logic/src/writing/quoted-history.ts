import { bodyOf, threadOf, type OhmailEngine } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";
import { writtenDateTime } from "../text/format.js";

export async function loadQuotedHistory(
  engine: OhmailEngine,
  messageId: string,
  forward: boolean,
): Promise<string[]> {
  const reader = engine.read();
  const mirrored = reader.get<EngineMessage>("message", messageId);
  const parent = mirrored ?? engine.verbRead().get<EngineMessage>("message", messageId);
  if (!parent || engine.messageIsGone(messageId)) return [];
  if (!mirrored && parent.body === undefined) {
    if (!forward && parent.sensitivity?.no_forward === true) return [];
    const body = await engine.readBodyOffMirror(messageId);
    return body.state === "ready" && !body.withheld && !engine.messageIsGone(messageId)
      ? [quote(parent, body.text)]
      : [];
  }
  const thread = forward ? [] : threadOf(reader, messageId);
  const index = thread.findIndex((message) => message.id === messageId);
  const history = (index < 0 ? [parent] : thread.slice(0, index + 1).reverse()).filter(
    (message) => forward || message.sensitivity?.no_forward !== true,
  );
  await engine.hydrateBodies(
    history.map((message) => message.id),
    { urgent: true },
  );
  return history.flatMap((message) => {
    if (engine.messageIsGone(message.id)) return [];
    const body = bodyOf(engine.read(), message);
    if (body.state !== "full") return [];
    return [quote(message, body.text)];
  });
}

function quote(message: EngineMessage, text: string): string {
  const from = message.from.name || message.from.address;
  const date = message.time ?? writtenDateTime(message);
  return `${from}${date ? ` · ${date}` : ""}\n${text}`;
}
