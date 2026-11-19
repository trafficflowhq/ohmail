/**
 * THE READER'S ENTRY: a shell imports it, hands it today's parts, and puts the answer in `features.reader`. Made
 * once per shell (at module scope), so the column's component never changes identity and never mounts again.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useConversationBodies, type ConversationShown } from "@ohmail/app-logic/reader";
import type { MessageClip } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import type { ReaderEntry } from "../host/index.js";
import { Contact, useOpenCard } from "./contact/Contact.js";
import { Letter } from "./Letter.js";
import { LetterActions } from "./actions/ActionBar.js";
import { InlineReply, PartsContext } from "./parts.js";
import { useAnsweredInPlace } from "./answered-in-place.js";
import type { ReaderParts } from "./ports.js";
import { Reader } from "./Reader.js";

/**
 * The entry over parts a shell reads in each render: its doors change identity while they fetch, and a column whose
 * component is made once still draws the door as it stands now. `useParts` is a hook, called first in each render.
 */
export function readerEntryFrom(useParts: () => ReaderParts): ReaderEntry {
  function Reading(pane: PaneProps) {
    const parts = useParts();
    return (
      <PartsContext.Provider value={parts}>
        <Reader {...pane} />
      </PartsContext.Provider>
    );
  }
  const Actions: ReaderEntry["Actions"] = ({ messageId, keysHere = false, markUnread }) => {
    const parts = useParts();
    return (
      <PartsContext.Provider value={parts}>
        <LetterActions messageId={messageId} keysHere={keysHere} markUnread={markUnread} />
      </PartsContext.Provider>
    );
  };
  function useInlineReply(keyLetter: string | null, items: readonly EngineMessage[]) {
    const { reply } = useParts();
    const { host, conversations } = useAnsweredInPlace(reply, items);
    if (conversations.size === 0) return null;
    const members = host === null ? undefined : conversations.get(host)?.messages;
    return {
      messageId: host,
      conversations,
      sheet: members && (
        <InlineReply reply={reply} letters={members.map((m) => m.id)} keysHere={keyLetter === host} />
      ),
    };
  }
  function OpenCard({
    message,
    opened,
    clip,
    conversation,
  }: {
    message: EngineMessage;
    opened: boolean;
    clip?: MessageClip;
    conversation?: ConversationShown;
  }) {
    const parts = useParts();
    const [person, onPerson, close] = useOpenCard();
    useConversationBodies(conversation ? message.id : null, conversation?.messages ?? []);
    return (
      <PartsContext.Provider value={parts}>
        {(conversation?.messages ?? [message]).map((m) => (
          <Letter
            key={m.id}
            message={m}
            clip={m.id === message.id ? clip : undefined}
            opened={opened && m.id === message.id}
            unread={m.unread}
            look="dot"
            reading
            presented={conversation?.presentedIds.has(m.id) ?? true}
            onPerson={onPerson}
            card={person?.slot ?? null}
          />
        ))}
        <Contact person={person} onClose={close} />
      </PartsContext.Provider>
    );
  }
  return { Reading, Actions, OpenCard, useInlineReply };
}

/** The entry over parts that never change: a test's, a states page's. */
export function readerEntry(parts: ReaderParts): ReaderEntry {
  return readerEntryFrom(() => parts);
}
