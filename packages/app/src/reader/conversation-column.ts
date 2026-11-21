import { useKeyboardStays } from "./column-keyboard.js";
import type { EngineMessage } from "@ohmail/wire";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import {
  markSeenOver,
  useColumnVisit,
  useConversationBodies,
  useStoreLetterBody,
  useOpenConversation,
  useStoreLetter,
  useThreadWalk,
  type ConversationShown,
} from "@ohmail/app-logic/reader";
import { useTakeEntered } from "@ohmail/app-logic/place-list";
import { useReplyRunState } from "@ohmail/app-logic/piles";
import {
  useArchiveHit,
  useListBlank,
  useListVisit,
  useOffMirrorLetter,
  useThreadRead,
} from "@ohmail/app-logic/reading";
import type { Route } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useEntered, useFrame } from "../frame/commands.js";
import { useOwnGone } from "../frame/own-gone.js";
import { fragmentOf } from "../frame/route.js";
import { useMailboxWord, useOwnAddresses, usePress, useRoomHolds } from "../frame/room.js";
import { useVerbs } from "./actions/use-verbs.js";
import { useOpenCard } from "./contact/Contact.js";
import { useParts, useReplyVerbs } from "./parts.js";
import { READER_DOM, scrollerOf } from "./read-dom.js";
import { useSentInView } from "./sent-in-view.js";
import { useReaderKeys } from "./keys.js";

const nameOf = (m: EngineMessage): string => m.from.name?.trim() || m.from.address;

export function useConversationColumn(
  route: Route,
  openId: string,
  keysHere: boolean,
  keyboard: MutableRefObject<boolean>,
  phone: boolean,
) {
  const { commands, host } = useFrame();
  const press = usePress();
  const { shown, opened, state, offMirrorRow, fromStore } = useShownConversation(openId, route);
  const { messages, presentedIds } = shown;
  useConversationBodies(opened === null || offMirrorRow !== null || fromStore ? null : openId, messages);
  const storeBody = useStoreLetterBody(fromStore ? opened : null);
  const visit = useListVisit(openId);
  const markSeen = useMemo(() => markSeenOver(press), [press]);
  const column = useColumnVisit(opened, visit?.wiring ?? null, markSeen);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [columnRoot, columnEl] = useKeyboardStays(setRoot, keyboard);
  const scroller = useMemo(() => ({ current: scrollerOf(root) }), [root]);
  const under = useContentUnderHead(scroller.current, phone);
  useThreadRead({ scroller, wiring: column.wiring ?? undefined, active: opened !== null, names: READER_DOM });
  useOwnOpen(opened !== null, column);
  useTakeEntered(
    useEntered(),
    (id) => route.place === "search" && column.owner === "column" && opened?.id === id,
    column.enter,
  );
  const { reply } = useParts();
  const replyVerbs = useReplyVerbs();
  const run = useReplyRunState();
  const step = run?.at === openId ? run : null;
  const sentJoined = useSentInView({ openId, messages, replying: replyVerbs !== null, column: columnEl });
  const walk = useThreadWalk({
    scroller: scroller.current,
    messages,
    openedId: openId,
    channel: column.wiring?.walk,
    onEnter: column.enter,
    names: READER_DOM,
    anchor: true,
    wholeThread: route.wholeThread,
    standsDown: sentJoined,
  });
  const verbs = useVerbs(opened, visit, column.owner === "column" ? column.wiring : null);
  useReaderKeys(keysHere && opened !== null, { verbs, visit });
  const [person, onPerson, closeCard] = useOpenCard();
  const screeningId = useId();
  const canScreen =
    host.features.places.screener !== NONE ||
    (host.features.reader !== NONE && host.features.reader.Screening !== undefined);
  const screenSender = (anchor: HTMLElement) => {
    if (!opened) return;
    onPerson({
      name: nameOf(opened),
      displayName: opened.from.name,
      address: opened.from.address,
      anchor,
      slot: `${opened.id} screening`,
      messageId: opened.id,
      onSender: true,
      direct: true,
      cardId: screeningId,
    });
  };
  const screenByKey = () => {
    const letter = Array.from(root?.querySelectorAll<HTMLElement>("[data-conv-id]") ?? []).find(
      (element) => element.dataset.convId === openId,
    );
    letter?.querySelector<HTMLButtonElement>("button[data-sender-line]")?.click();
  };
  const mailboxWord = useMailboxWord();
  const people = usePeople(messages);
  return {
    commands,
    host,
    shown,
    opened,
    state,
    offMirrorRow,
    storeBody,
    messages,
    presentedIds,
    visit,
    column,
    reply,
    replyVerbs,
    step,
    walk,
    verbs,
    person,
    onPerson,
    closeCard,
    screeningId,
    canScreen,
    screenSender,
    screenByKey,
    mailboxWord,
    people,
    columnRoot,
    scroller,
    under,
  };
}

/** The sticky head fades into the letter once content starts passing under it. */
function useContentUnderHead(scroller: HTMLElement | null, phone: boolean): boolean {
  const [under, setUnder] = useState(false);
  useLayoutEffect(() => {
    if (!scroller || phone) return;
    const update = () => setUnder(scroller.scrollTop > 2);
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, [scroller, phone]);
  return !phone && under;
}

/**
 * THE CONVERSATION SHOWN for the address's letter: the mirror's, or the store's where the mirror's window no longer
 * holds it; nothing while the room's own delete window holds it.
 */
function useShownConversation(openId: string, route: Route) {
  /* A letter this tab took away itself is the person's act: never said gone as another app's. */
  const mirrored = useOpenConversation(openId, useOwnGone());
  /* A letter inside the room's own delete window is the person's act, not a letter gone: nothing is drawn. */
  const { held } = useRoomHolds();
  const heldHere = held.has(openId);
  /* A link to a letter the mirror's window no longer holds: the store is asked for it by id. Found, it is read off
     the mirror, alone and not presented (it loads no picture by itself); held by no store either, the link is
     dropped from the address in place, so the way back does not lead to it again. */
  const listed = useOffMirrorLetter(openId);
  const carried = useArchiveHit(openId);
  const offMirrorRow = !heldHere && mirrored.state === "absent" ? listed : null;
  const absent = mirrored.state === "absent" && !heldHere && offMirrorRow === null;
  const row = useListVisit(openId)?.row;
  const stored = useStoreLetter(openId, absent, row);
  const archive = absent && stored.state !== "missing" ? carried : null;
  const shown =
    offMirrorRow !== null
      ? offMirror(offMirrorRow.message)
      : stored.state === "found"
        ? offMirror(stored.message)
        : archive !== null
          ? offMirror(archive)
          : mirrored;
  const { host } = useFrame();
  const missing =
    absent && (stored.state === "missing" || (stored.state === "unavailable" && archive === null));
  useEffect(() => {
    if (missing) host.device.address.write(fragmentOf({ ...route, open: null }), "replace");
  }, [missing, host, route]);
  const opened = heldHere ? null : shown.opened;
  const state = heldHere ? "absent" : shown.state;
  return { shown, opened, state, offMirrorRow, fromStore: stored.state === "found" };
}

/** An open is an open where no list stands; under one, its visit is the list's, also before it lists the letter. */
function useOwnOpen(open: boolean, column: ReturnType<typeof useColumnVisit>): void {
  const ownOpen = useListBlank() === undefined && open;
  const enter = useRef(column.enter);
  enter.current = column.enter;
  useEffect(() => {
    if (ownOpen && column.owner === "column") enter.current();
  }, [ownOpen, column.owner]);
}

/** Who is in a conversation, oldest voice first: the account's own addresses are not among them. */
function usePeople(messages: readonly EngineMessage[]): { name: string; address: string }[] {
  const own = new Set(useOwnAddresses().map((a) => a.toLowerCase()));
  return [
    ...new Map(
      messages
        .filter((m) => !own.has(m.from.address.toLowerCase()))
        .map((m) => [m.from.address, { name: nameOf(m), address: m.from.address }]),
    ).values(),
  ];
}

/** A letter the store answered by id, as the column shows it: alone, read off no presented mirror. */
function offMirror(message: EngineMessage): ConversationShown {
  return {
    state: "letters",
    opened: message,
    messages: [message],
    subject: message.subject,
    presented: false,
    presentedIds: NOTHING_PRESENTED,
  };
}

const NOTHING_PRESENTED: ReadonlySet<string> = new Set();
