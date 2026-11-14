/**
 * WHO RUNS A VERB ON THE OPEN LETTER. Where the list that opened it handed its visit, every verb takes the list's own
 * path (`visit.act`): the list lands its cursor and answers Undo as it does for its own rows. Otherwise the reader's
 * own runners, through the one press seam. Reply and Forward hand a draft to `write`; nothing is sent from here.
 */
import { useMemo } from "react";
import { isOwnVerb, markSeenOver, moveTargetsOf, runOwnVerb, type VerbWords } from "@ohmail/app-logic/reader";
import type { ListVisit, ThreadReadWiring } from "@ohmail/app-logic/reading";
import type { MessageAction, MoveTarget } from "@ohmail/app-logic/press/actions";
import type { EngineMessage } from "@ohmail/client-engine";
import { useFrame } from "../../frame/commands.js";
import { usePressWhereOn } from "../../frame/room.js";
import type { LinkedDraft } from "../../host/index.js";
import { useLocale, useText } from "../../text/index.js";

const prefixed = (prefix: string, subject: string): string =>
  subject.toLowerCase().startsWith(prefix.toLowerCase()) ? subject : `${prefix} ${subject}`;

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

export interface Verbs {
  /** Run `action` on the letter. */
  readonly act: (action: MessageAction) => void;
  /** No list's visit and no press seam here: the reader's own verbs cannot run. */
  readonly idle: boolean;
  /** The read slot's face: what a press does now. */
  readonly readSlot: "markRead" | "markUnread";
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
}

export function useVerbs(
  message: EngineMessage | null,
  visit: ListVisit | null,
  own: ThreadReadWiring | null,
): Verbs {
  /* The seam is taken only where an own verb may run: a list's visit runs every verb on the list's path. */
  const press = usePressWhereOn();
  const { commands } = useFrame();
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
  const readSlot = visit
    ? visit.readSet.length > 0
      ? "markRead"
      : "markUnread"
    : message?.unread
      ? "markRead"
      : "markUnread";
  const act = (action: MessageAction): void => {
    if (message === null) return;
    if (visit !== null) {
      visit.act(action);
      return;
    }
    if (action === "reply" || action === "reply_all" || action === "forward") {
      commands.write(draftFor(action, message));
      return;
    }
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
  const moves = visit !== null && message !== null ? moveTargetsOf(message) : [];
  /* Reply all is a verb of its own where the letter went to more than one person besides its sender. */
  const sender = message?.from.address.toLowerCase();
  const replyAll =
    message !== null &&
    new Set([...message.to, ...message.cc].map((p) => p.address.toLowerCase()).filter((a) => a !== sender))
      .size > 1;
  return {
    act,
    readSlot,
    idle: visit === null && press === null,
    tag,
    tagged: message?.labels ?? [],
    moves,
    replyAll,
  };
}
