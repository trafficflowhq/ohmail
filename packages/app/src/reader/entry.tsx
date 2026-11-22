/**
 * THE READER'S ENTRY: a shell imports it, hands it today's parts, and puts the answer in `features.reader`. Made
 * once per shell (at module scope), so the column's component never changes identity and never mounts again.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useState, type ReactNode } from "react";
import {
  isProtected,
  useConversationBodies,
  useLetterBody,
  useThreadWalk,
  type ConversationShown,
} from "@ohmail/app-logic/reader";
import type { MessageClip } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import type { ReaderEntry } from "../host/index.js";
import { useOpenCard } from "./contact/Contact.js";
import { Contact } from "./contact/Screening.js";
import { Letter, LetterHead } from "./Letter.js";
import { LetterActions } from "./actions/ActionBar.js";
import { InlineReply, PartsContext } from "./parts.js";
import { useAnsweredInPlace } from "./answered-in-place.js";
import type { LetterNotice, ReaderParts } from "./ports.js";
import { Reader } from "./Reader.js";
import { Squares } from "./Squares.js";
import { READER_DOM } from "./read-dom.js";

const ignoreControls = (): void => {};

function StreamConversation({
  children,
  messages,
  openedId,
  scroller,
  onEnter,
}: {
  children: ReactNode;
  messages: readonly EngineMessage[];
  openedId: string;
  scroller: HTMLElement | null;
  onEnter: () => void;
}) {
  const walk = useThreadWalk({ scroller, messages, openedId, onEnter, names: READER_DOM });
  return (
    <div className="rd-stream-conversation" data-thread={messages.length > 1 || undefined}>
      <div className="rd-stream-squares">
        {messages.length > 1 && (
          <Squares messages={messages} walk={walk} place="column" column={scroller} waitForFit={false} />
        )}
      </div>
      <div className="rd-stream-letters">{children}</div>
    </div>
  );
}

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
  const Actions: ReaderEntry["Actions"] = ({ keysHere = false, ...props }) => {
    const parts = useParts();
    return (
      <PartsContext.Provider value={parts}>
        <LetterActions {...props} keysHere={keysHere} />
      </PartsContext.Provider>
    );
  };
  function useInlineReply(items: readonly EngineMessage[]) {
    const { reply } = useParts();
    const { host, conversations } = useAnsweredInPlace(reply, items);
    if (conversations.size === 0) return null;
    const members = host === null ? undefined : conversations.get(host)?.messages;
    return {
      messageId: host,
      conversations,
      sheet: (keysHere: boolean) =>
        members && <InlineReply reply={reply} letters={members.map((m) => m.id)} keysHere={keysHere} />,
    };
  }
  const PreviewHead = previewHeadOf(useParts);
  function OpenCard({
    message,
    opened,
    clip,
    markUnread,
    conversation,
    scroller = null,
    onEnter = ignoreControls,
  }: {
    message: EngineMessage;
    opened: boolean;
    clip?: MessageClip;
    markUnread?: (id: string) => void;
    conversation?: ConversationShown;
    scroller?: HTMLElement | null;
    onEnter?: () => void;
  }) {
    const parts = useParts();
    const [person, onPerson, close] = useOpenCard();
    useConversationBodies(conversation ? message.id : null, conversation?.messages ?? []);
    const members = conversation?.messages ?? [message];
    const letters = members.map((m) => (
      <Letter
        key={m.id}
        message={m}
        clip={m.id === message.id ? clip : undefined}
        markUnread={m.id === message.id ? markUnread : undefined}
        opened={opened && m.id === message.id}
        previewSelection={message.id}
        streamCard="open"
        unread={m.unread}
        look="dot"
        reading
        presented={conversation?.presentedIds.has(m.id) ?? true}
        onPerson={onPerson}
        card={person?.slot ?? null}
      />
    ));
    return (
      <PartsContext.Provider value={parts}>
        <StreamConversation messages={members} openedId={message.id} scroller={scroller} onEnter={onEnter}>
          {letters}
        </StreamConversation>
        <Contact person={person} onClose={close} />
      </PartsContext.Provider>
    );
  }
  const PreviewBody: NonNullable<ReaderEntry["PreviewBody"]> = ({ message, children }) => {
    const Body = useParts().body;
    const body = useLetterBody(message, false);
    if (isProtected(message) || !body.html) return children;
    return (
      <Body
        messageId={message.id}
        text={body.text}
        html={body.html}
        subject={message.subject}
        scheme="light"
        owner={null}
        remoteLoaded={false}
        imageProxy={null}
        loadTrackingPixels={false}
        onNotice={ignoreControls}
        onControls={ignoreControls}
      />
    );
  };
  return { Reading, Actions, PreviewHead, PreviewBody, OpenCard, useInlineReply, useHeldParts: useParts };
}

/** The entry over parts that never change: a test's, a states page's. */
export function readerEntry(parts: ReaderParts): ReaderEntry {
  return readerEntryFrom(() => parts);
}

function previewHeadOf(useParts: () => ReaderParts): NonNullable<ReaderEntry["PreviewHead"]> {
  const PreviewHead: NonNullable<ReaderEntry["PreviewHead"]> = ({
    message,
    hideBodyNotice,
    selection,
    markUnread,
  }) => {
    const parts = useParts();
    const [person, onPerson, close] = useOpenCard();
    const [notice, setNotice] = useState<LetterNotice | null>(null);
    const body = useLetterBody(message, false);
    const html = hideBodyNotice || isProtected(message) ? null : body.html;
    const Body = parts.body;
    return (
      <PartsContext.Provider value={parts}>
        <LetterHead
          message={message}
          unread={false}
          notice={html ? notice : null}
          copy={null}
          narrow={false}
          onPerson={onPerson}
          card={person?.slot ?? null}
          preview
          selection={selection}
          markUnread={markUnread}
        />
        {html ? (
          <Body
            noticeOnly
            messageId={message.id}
            text={body.text}
            html={html}
            subject={message.subject}
            scheme="light"
            owner={null}
            remoteLoaded={false}
            imageProxy={null}
            loadTrackingPixels={false}
            onNotice={setNotice}
            onControls={ignoreControls}
          />
        ) : null}
        <Contact person={person} onClose={close} />
      </PartsContext.Provider>
    );
  };
  return PreviewHead;
}
