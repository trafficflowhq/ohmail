/**
 * WHO RUNS A VERB ON THE OPEN LETTER. Where the list that opened it handed its visit, every verb takes the list's own
 * path (`visit.act`): the list lands its cursor and answers Undo as it does for its own rows. Otherwise the reader's
 * own runners, through the one press seam. Reply and Forward open `write`'s reply where the shell handed one, before
 * anything else; otherwise they hand a draft to the place `write`. Nothing is sent from here.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useContext, useMemo } from "react";
import {
  isOwnVerb,
  markSeenOver,
  moveTargetsOf,
  readerZone,
  readIsItsRelease,
  resurfaceHorizonsIn,
  runOwnVerb,
  type VerbWords,
} from "@ohmail/app-logic/reader";
import { ListMoveContext, type ListVisit, type ThreadReadWiring } from "@ohmail/app-logic/reading";
import type { MessageAction, MoveTarget } from "@ohmail/app-logic/press/actions";
import { useFrame } from "../../frame/commands.js";
import { useOwnAddresses, usePressWhereOn, useResurfaceTime } from "../../frame/room.js";
import type { LinkedDraft } from "../../host/index.js";
import { useLocale, useText } from "../../text/index.js";
import { useParts } from "../parts.js";

type Answer = (messageId: string, how: "reply" | "reply_all" | "forward", from?: "menu") => void;
const noAnswer = (): Answer | null => null;
type Drafter = (messageId: string) => void;
const noDrafter = (): Drafter | null => null;

/** `write`'s open for an answer, or null where the shell handed none (the same hook on every render of an entry). */
export function useAnswer(): Answer | null {
  const { reply } = useParts();
  const useOpen: () => Answer | null = reply === "none" ? noAnswer : reply.useOpen;
  return useOpen();
}

const prefixed = (prefix: string, subject: string): string =>
  subject.toLowerCase().startsWith(prefix.toLowerCase()) ? subject : `${prefix} ${subject}`;

/** `write`'s Draft reply for a letter, or null where the shell's composition has no drafter (the same hook every render). */
export function useDrafter(): Drafter | null {
  const { reply } = useParts();
  const useDraft: () => Drafter | null = reply === "none" ? noDrafter : (reply.useDraft ?? noDrafter);
  return useDraft();
}

/** The draft an answer starts from: the address it goes to and the subject it carries. */
export function draftFor(action: "reply" | "reply_all" | "forward", m: EngineMessage): LinkedDraft {
  if (action === "forward")
    return { to: [], cc: [], bcc: [], subject: prefixed("Fwd:", m.subject), body: "" };
  const cc =
    action === "reply_all"
      ? [...m.to, ...m.cc].map((p) => p.address).filter((a) => a !== m.from.address)
      : [];
  return { to: [m.from.address], cc, bcc: [], subject: prefixed("Re:", m.subject), body: "" };
}

/**
 * Reply all is a verb of its own where someone besides the sender and the account has the letter: the account's own
 * addresses are the room's, the one set the send reads its audience with. Until the room knows them, where the
 * letter went to more than one person besides its sender.
 */
export function hasReplyAll(message: EngineMessage | null, ownAddresses: readonly string[]): boolean {
  const sender = message?.from.address.toLowerCase();
  const people = [...(message?.to ?? []), ...(message?.cc ?? [])].map((p) => p.address.toLowerCase());
  const others = new Set(people.filter((a) => a !== sender));
  const mine = new Set(ownAddresses.map((a) => a.toLowerCase()));
  return mine.size > 0 ? [...others].some((a) => !mine.has(a)) : others.size > 1;
}

export interface Verbs {
  /** Run `action` on the letter. */
  readonly act: (action: MessageAction) => void;
  /** No list's visit and no press seam here: the reader's own verbs cannot run. */
  readonly idle: boolean;
  /**
   * The read slot's face: what a press does now. Null on a letter that came back, where a list's visit stands: its
   * read is its release, which the list's row offers as Done, and the plain directions are not offered beside it.
   */
  readonly readSlot: "markRead" | "markUnread" | null;
  /**
   * How many letters the read slot's press marks read: the list's read set of the open conversation (0 where no list's
   * visit stands, where the press marks the open letter alone). The slot says the count where it is more than one.
   */
  readonly readCount: number;
  /** Put a tag on the letter or take it off, through the room's seam; null where no seam stands. */
  readonly tag: ((tagId: string, on: boolean) => void) | null;
  /** The letter's tags, by id. */
  readonly tagged: readonly string[];
  /**
   * The places the letter may be moved to. Only where a list's visit stands: a move to a place writes the sender's
   * routing, which runs on the list's path; the reader has no runner of its own for it.
   */
  readonly moves: readonly MoveTarget[];
  /** More than one person besides the sender has the letter: Reply all is a verb of its own. */
  readonly replyAll: boolean;
  /** Draft reply on the letter, behind More; null where no drafter stands. */
  readonly draft: (() => void) | null;
  /**
   * The pile the letter is filed in, of the three the panel's Later, Park and Resurface put it in and take it out of;
   * null in none (a letter brought back to the top is in none of them).
   */
  readonly filed: "reply_later" | "set_aside" | "bubbled_up" | null;
}

export function useVerbs(
  message: EngineMessage | null,
  visit: ListVisit | null,
  own: Pick<ThreadReadWiring, "onMarkUnread"> | null,
): Verbs {
  /* The seam is taken only where an own verb may run: a list's visit runs every verb on the list's path. */
  const press = usePressWhereOn();
  const listMove = useContext(ListMoveContext);
  const { commands } = useFrame();
  const answer = useAnswer();
  const drafter = useDrafter();
  /* The account's resurface hour, as the shell handed it to the room: what the quick return books at. */
  const hour = useResurfaceTime();
  const t = useText("reader");
  const locale = useLocale();
  const words: VerbWords = useMemo(
    () => ({
      queued: t("toast.queued"),
      aside: t("toast.aside"),
      unqueued: t("toast.unqueued"),
      unparked: t("toast.unparked"),
      resurfaces: (when) => t("toast.resurfaces", { when }),
      resurfaceNow: t("toast.resurfaceNow"),
    }),
    [t],
  );
  const whenLabel = useMemo(() => {
    const f = new Intl.DateTimeFormat(locale, {
      weekday: "long",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    return (iso: string) => f.format(new Date(iso));
  }, [locale]);
  const readSlot =
    visit && message !== null && readIsItsRelease(message)
      ? null
      : visit
        ? visit.readSet.length > 0
          ? "markRead"
          : "markUnread"
        : message?.unread
          ? "markRead"
          : "markUnread";
  const act = (asked: MessageAction): void => {
    if (message === null) return;
    let action = asked;
    if (answer !== null && (action === "reply" || action === "reply_all" || action === "forward")) {
      answer(message.id, action);
      return;
    }
    if (visit !== null) {
      visit.act(action);
      return;
    }
    if (listMove && action.startsWith("move:")) {
      listMove(message, action.slice("move:".length) as MoveTarget);
      return;
    }
    if (action === "reply" || action === "reply_all" || action === "forward") {
      commands.write(draftFor(action, message));
      return;
    }
    /* The quick return (`b` on a letter with no booking), where no list's visit runs it: tomorrow at the account's
       hour, minted at the press, as the chooser's own Tomorrow is. */
    if (action === "resurface")
      action = `resurface:${resurfaceHorizonsIn(new Date(), hour.stored, readerZone()).tomorrow.iso}`;
    if (!isOwnVerb(action) || press === null) return;
    if (action === "unread" && !message.unread && own !== null) {
      // The column's own Mark unread: the visit keeps it unread and holds it for the rest of the visit.
      own.onMarkUnread(message.id);
      return;
    }
    if (action === "unread" && !message.unread) {
      void markSeenOver(press)([message.id], true);
      return;
    }
    const acted = runOwnVerb(press, words, action, message, whenLabel);
    /* The person's own Delete leaves the letter, as today's reader does; its Undo brings it back on reopening. */
    if (action === "delete" && acted) commands.open(null);
  };
  const tag =
    press === null || message === null
      ? null
      : (tagId: string, on: boolean) =>
          void press.mutateAndReport(
            { kind: "tag_assign", messageId: message.id, tagId, assigned: on },
            null,
          );
  const moves = (visit !== null || listMove !== null) && message !== null ? moveTargetsOf(message) : [];
  const replyAll = hasReplyAll(message, useOwnAddresses());
  const pile = message?.triage?.state;
  const filed = pile === "reply_later" || pile === "set_aside" || pile === "bubbled_up" ? pile : null;
  return {
    act,
    readSlot,
    readCount: visit?.readSet.length ?? 0,
    idle: visit === null && press === null,
    tag,
    tagged: message?.labels ?? [],
    moves,
    replyAll,
    draft: drafter !== null && message !== null ? () => drafter(message.id) : null,
    filed,
  };
}
