"use client";

/**
 * THE NEW READER'S PARTS ON THE WEB, read from the composition that stands above the panes: the ONE file door and
 * the ONE picture door today's shell holds, its one look at a file, today's reply editor through `write`'s port, and
 * today's invitation note and event under each letter. Nothing here keeps state of its own, and no file of
 * `packages/app` imports it. It leaves when the composition above the panes is lifted.
 */
import { createContext, useCallback, useContext, useMemo, type Context } from "react";
import type { ReaderEntry } from "@ohmail/app/host";
import { readerEntryFrom, type ReaderParts, type ReaderReply } from "@ohmail/app/reader";
import { letterBody } from "@ohmail/app/reader/body";
import { useMirror } from "@ohmail/app-logic/reader";
import type { EngineMessage, EntityReader } from "@ohmail/client-engine";
import type { AttachmentsChrome } from "./attachments";
import { useDrawnBody } from "./body-slice";
import { InvitationNote } from "./InvitationNote";
import { useMessageChrome, type MessageChrome } from "./message-chrome";
import { MessageEvents } from "./MessageEvents";
import type { RemoteImagesChrome } from "./remote-images";
import { TodaysReplyEditor } from "./TodaysReplyEditor";

/** What the composition feeds the reader's parts: the ONE instance of each door, and the shell's one look. */
export interface TodaysReaderFeed {
  /** The one file door; undefined where the host cannot open files (the port's word is "none"). */
  readonly attachments: AttachmentsChrome | undefined;
  /** The one picture door; undefined where the host cannot fetch a picture. */
  readonly remoteImages: RemoteImagesChrome | undefined;
  /** Today's look at a file, over the whole app: `(messageId, attachmentId) => setPreviewFor(…)`. Never absent. */
  readonly look: (messageId: string, attachmentId: string) => void;
  /**
   * Today's Reply, a toggle (the one composer's `toggleReply`): the same verb on the editor it opened closes it and
   * keeps the draft; another letter, or Reply all over a plain reply, opens.
   */
  readonly toggleReply: (messageId: string, all?: boolean) => void;
}

export const TodaysReaderFed: Context<TodaysReaderFeed | null> = createContext<TodaysReaderFeed | null>(null);

function useTodaysReaderFed(): TodaysReaderFeed {
  const fed = useContext(TodaysReaderFed);
  if (fed === null) throw new Error("the reader was seated with no composition above");
  return fed;
}

/** A letter of the conversation on screen, as the panes present it, else the mirror's row; null where neither has it. */
function letterOf(chrome: MessageChrome, mirror: EntityReader | null, id: string): EngineMessage | null {
  return (
    chrome.conversationOf(id).find((m) => m.id === id) ?? mirror?.get<EngineMessage>("message", id) ?? null
  );
}

/**
 * Reply, Reply all and Forward, as today's bar answers them: inside the thread, never a page of their own. The
 * panel's Reply and its key are a toggle; a letter's own menu re-opens ("reply to THIS letter" is not a toggle).
 */
function useTodaysAnswer(): (messageId: string, how: "reply" | "reply_all" | "forward", from?: "menu") => void {
  const chrome = useMessageChrome();
  const { toggleReply } = useTodaysReaderFed();
  const { mirror } = useMirror();
  return useCallback(
    (messageId, how, from) => {
      if (how !== "forward") {
        if (from === "menu" && chrome.openReply) chrome.openReply(messageId, how === "reply_all");
        else toggleReply(messageId, how === "reply_all");
        return;
      }
      /* Forward takes what the row's open took where a row opened the conversation, else the letter itself. */
      const letter = letterOf(chrome, mirror, messageId);
      const target = letter !== null && chrome.forwardTargetOf ? chrome.forwardTargetOf(letter) : letter;
      chrome.forward?.(target?.id ?? messageId, target ?? undefined);
    },
    [chrome, mirror, toggleReply],
  );
}

/** The reply's sheet: today's editor, while the letter it answers is one of the conversation's. */
function TodaysReplySheet({ letters }: { readonly letters: readonly string[] }) {
  const chrome = useMessageChrome();
  const { mirror } = useMirror();
  const answered = chrome.replyTo;
  const replyTarget = answered !== null && letters.includes(answered) ? letterOf(chrome, mirror, answered) : null;
  return replyTarget === null ? null : <TodaysReplyEditor replyTarget={replyTarget} />;
}

/** Today's reply editor carries its own controls: the reading sheet's panel stays the letter's. */
const noReplyVerbs = (): null => null;

export const todaysReply: ReaderReply = { Sheet: TodaysReplySheet, useOpen: useTodaysAnswer, useVerbs: noReplyVerbs };

/**
 * What today's reader says of a letter's invitation, found by the letter's id: the note where its event cannot be
 * shown (read off the body's text as drawn, and only when that text is the whole body), then the event once.
 */
export function TodaysLetterNotes({ messageId }: { readonly messageId: string }) {
  const chrome = useMessageChrome();
  const { mirror } = useMirror();
  const letter = letterOf(chrome, mirror, messageId);
  const body = useDrawnBody(letter);
  return (
    <>
      <InvitationNote
        message={letter}
        text={body?.text}
        full={body?.state === "full"}
        className="msg-body-state"
      />
      <MessageEvents messageId={messageId} />
    </>
  );
}

/** The reader's parts, read again in every render: a door changes identity while it fetches. */
export function useTodaysReaderParts(): ReaderParts {
  const { attachments, remoteImages, look } = useTodaysReaderFed();
  return useMemo(
    () => ({
      body: letterBody,
      files: attachments ?? "none",
      pictures: remoteImages ?? "none",
      look,
      /* No note of the sent copy yet: every mount hands none until the shells' parts say it. */
      sentCopy: "none",
      reply: todaysReply,
      invitation: TodaysLetterNotes,
    }),
    [attachments, remoteImages, look],
  );
}

/** The reader a web host hands the frame at the seat: made once, its parts read in each render. */
export const todaysReader: ReaderEntry = readerEntryFrom(useTodaysReaderParts);
