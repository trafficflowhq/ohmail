/** The parts a shell handed `readerEntry`, for every view of the reader under it. */
import { createContext, useContext } from "react";
import { KEY_WRITING } from "@ohmail/app-logic/keys";
import type { ReaderParts } from "./ports.js";

export const PartsContext = createContext<ReaderParts | null>(null);

export function useParts(): ReaderParts {
  const parts = useContext(PartsContext);
  if (parts === null) throw new Error("a part of the reader was drawn outside its entry");
  return parts;
}

const noReply = (): null => null;

export function useReplyTarget(reply: ReaderParts["reply"]): string | null {
  const useTarget = reply === "none" ? noReply : (reply.useTarget ?? noReply);
  return useTarget();
}

export function useReplyVerbs(messageId?: string) {
  const { reply } = useParts();
  const useVerbs = reply === "none" ? noReply : reply.useVerbs;
  const verbs = useVerbs();
  const target = useReplyTarget(reply);
  return messageId === undefined || messageId === target ? verbs : null;
}

/** The writing surface belongs to the open reply, including when a key is pressed on one of its controls. */
export function InlineReply({
  reply,
  letters,
  keysHere,
}: {
  reply: ReaderParts["reply"];
  letters: readonly string[];
  keysHere: boolean;
}) {
  return reply === "none" ? null : (
    <div className="rd-reply" {...{ [KEY_WRITING]: "" }}>
      <reply.Sheet letters={letters} keysHere={keysHere} />
    </div>
  );
}
