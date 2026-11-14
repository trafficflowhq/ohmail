/** A stream keeps the conversation under its letter while its editor or its own send belongs to this visit. */
import { useRef } from "react";
import type { EngineMessage } from "@ohmail/wire";
import { useEngineOrNull } from "@ohmail/app-logic/engine";
import { conversationShown, useMirror, type ConversationShown } from "@ohmail/app-logic/reader";
import { usePresentedMirror } from "@ohmail/app-logic/reading";
import { keepInPlace, streamHostOf } from "@ohmail/app-logic/streams";
import { inlineForwardKey } from "@ohmail/app-logic/writing/mail-send";
import { useReplyTarget } from "./parts.js";
import type { ReaderParts } from "./ports.js";

const noSend = () => () => "idle" as const;
const neverGone = () => false;
interface Answer {
  membersBefore: readonly string[];
  lanes: Set<string>;
}

export function useAnsweredInPlace(reply: ReaderParts["reply"], items: readonly EngineMessage[]) {
  const target = useReplyTarget(reply);
  const usePhase = reply === "none" ? noSend : (reply.useSendPhase ?? noSend);
  const phase = usePhase();
  const engine = useEngineOrNull();
  const { mirror } = useMirror();
  const presented = usePresentedMirror();
  const visit = useRef({ engine, answers: new Map<string, Answer>() });
  if (visit.current.engine !== engine) visit.current = { engine, answers: new Map() };
  const { answers } = visit.current;
  const conversations = new Map<string, ConversationShown>();
  let host: string | null = null;
  if (mirror && presented && (target !== null || answers.size > 0)) {
    const ids = new Set(items.map((m) => m.id));
    const shown = (id: string) => conversationShown(mirror, presented, id, neverGone);
    host = streamHostOf(
      target,
      (id) => ids.has(id),
      (id) => shown(id).messages,
      (id) => answers.has(id),
    );
    if (host !== null && target !== null) {
      const conversation = shown(host);
      conversations.set(host, conversation);
      const answer = answers.get(host) ?? {
        membersBefore: conversation.messages.map((m) => m.id),
        lanes: new Set<string>(),
      };
      answer.lanes.add(target).add(inlineForwardKey(target));
      answers.set(host, answer);
    }
    for (const [id, answer] of answers) {
      if (id === host) continue;
      const c = ids.has(id) ? shown(id) : null;
      if (c && keepInPlace(c.messages, answer.membersBefore, [...answer.lanes].map(phase)))
        conversations.set(id, c);
      else answers.delete(id);
    }
  }
  return { host, conversations };
}
