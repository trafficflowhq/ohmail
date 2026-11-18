/**
 * THE READING COLUMN: the open conversation on the kit's reading sheet, its letters oldest first, the squares beside
 * them (along the head on a phone), the action panel at its foot. With nothing open, the blank. The read rule runs
 * here with the column's names; the visit is the list's where the list that opened the letter handed one.
 */
import type { EngineMessage } from "@ohmail/wire";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type WheelEvent,
} from "react";
import { Button, JumpBack } from "@ohmail/ui/base";
import { BlankColumn, ReadingHead, Sheet } from "@ohmail/ui/mail";
import {
  markSeenOver,
  useColumnVisit,
  useConversationBodies,
  useOpenConversation,
  useThreadWalk,
  type ThreadWalk,
} from "@ohmail/app-logic/reader";
import { useListVisit, useThreadRead } from "@ohmail/app-logic/reading";
import { scrollByHand } from "@ohmail/app-logic/session/programmatic-scroll";
import type { PaneProps } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useFrame } from "../frame/commands.js";
import { useMailboxWord, useOwnAddresses, usePress, useRoomHolds } from "../frame/room.js";
import { useText } from "../text/index.js";
import { ActionBar, type PanelRoom } from "./actions/ActionBar.js";
import { useVerbs } from "./actions/use-verbs.js";
import { Blank } from "./blank/Blank.js";
import { Contact, type ContactOf } from "./contact/Contact.js";
import { Letter } from "./Letter.js";
import { useParts } from "./parts.js";
import { READER_DOM, scrollerOf } from "./read-dom.js";
import { useLetterKeys, useReaderKeys } from "./keys.js";
import { Squares } from "./Squares.js";
import { Tags } from "./Tags.js";
import "./column.css";

export function Reader({ route, plan, keysHere }: PaneProps) {
  const tp = useText("place");
  /* The keyboard stood on the column's scroller when the letter it showed left: the next letter's takes it. */
  const keyboard = useRef(false);
  const blank = route.open === null;
  useEffect(() => {
    if (blank) keyboard.current = false;
  }, [blank]);
  if (route.open === null)
    return (
      <>
        <RestingKeys />
        <Blank />
      </>
    );
  /* The way back names where it goes, where the place has a word of its own. */
  const from = tp.has(route.place) ? tp(route.place) : "";
  return (
    <Conversation
      key={route.open}
      openId={route.open}
      phone={plan.device === "phone"}
      narrow={plan.device === "fold"}
      room={plan.device === "fold" && plan.pose === "land" ? "foldl" : plan.device}
      keysHere={keysHere}
      from={from}
      keyboard={keyboard}
    />
  );
}

/** With nothing open the letter's keys rest for want of a cursor, listed as the key sheet lists them. */
function RestingKeys() {
  useLetterKeys(true, null);
  return null;
}

const nameOf = (m: EngineMessage): string => m.from.name?.trim() || m.from.address;

function Conversation({
  openId,
  phone,
  keysHere,
  from,
  narrow,
  room,
  keyboard,
}: {
  openId: string;
  phone: boolean;
  /** The upright foldable's column: a letter's head prints its stamp short. */
  narrow: boolean;
  /** Where the panel stands: what it keeps behind More. */
  room: PanelRoom;
  keysHere: boolean;
  /** The place's word, for the way back; "" where it has none. */
  from: string;
  /** Whether the letter shown before this one held the keyboard on its scroller; this one's takes it then. */
  keyboard: MutableRefObject<boolean>;
}) {
  const t = useText("reader");
  const press = usePress();
  const shown = useOpenConversation(openId);
  /* A letter inside the room's own delete window is the person's act, not a letter gone: nothing is drawn. */
  const { held } = useRoomHolds();
  const heldHere = held.has(openId);
  const { messages, presentedIds } = shown;
  const opened = heldHere ? null : shown.opened;
  const state = heldHere ? "absent" : shown.state;
  useConversationBodies(opened === null ? null : openId, messages);
  const visit = useListVisit(openId);
  const markSeen = useMemo(() => markSeenOver(press), [press]);
  const column = useColumnVisit(opened, visit?.wiring ?? null, markSeen);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const columnRoot = useKeyboardStays(setRoot, keyboard);
  const scroller = useMemo(() => ({ current: scrollerOf(root) }), [root]);
  useThreadRead({ scroller, wiring: column.wiring ?? undefined, active: opened !== null, names: READER_DOM });
  /* An open is an open: the column's own visit is entered. A list's visit is the list's to enter. */
  const present = opened !== null;
  const enter = useRef(column.enter);
  enter.current = column.enter;
  useEffect(() => {
    if (present && column.owner === "column") enter.current();
  }, [present, column.owner]);
  const walk = useThreadWalk({
    scroller: scroller.current,
    messages,
    openedId: openId,
    channel: column.wiring?.walk,
    onEnter: column.enter,
    names: READER_DOM,
    anchor: true,
  });
  const verbs = useVerbs(opened, visit, column.owner === "column" ? column.wiring : null);
  const { reply } = useParts();
  const useReplyVerbs = reply === "none" ? noReplyVerbs : reply.useVerbs;
  const replyVerbs = useReplyVerbs();
  useReaderKeys(keysHere && opened !== null, { verbs, visit });
  const [person, setPerson] = useState<ContactOf | null>(null);
  const mailboxWord = useMailboxWord();
  const people = usePeople(messages);

  const back = phone ? <WayBack from={from} /> : undefined;
  /* Only a letter the engine tombstoned is said to be gone; one not here yet is a sheet with nothing said. */
  if (opened === null && state === "gone") return <GoneLetter phone={phone} back={back} />;
  if (opened === null) return <Sheet kind="reading" label={t("pane")} top={back} />;
  const look = column.wiring?.look ?? "dot";
  const squares =
    messages.length > 1 ? (
      <Squares messages={messages} walk={walk} axis={phone ? "head" : "column"} column={scroller.current} />
    ) : null;
  const reading = !(column.wiring?.previewing ?? false);
  /* A wheel beside the sheets scrolls them, as the person's own scroll. */
  const onWheel = (e: WheelEvent<HTMLDivElement>): void => {
    const sc = scroller.current;
    if (!sc || e.ctrlKey || sc.contains(e.target as Node)) return;
    const dy = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? sc.clientHeight : 1);
    if (dy !== 0) scrollByHand(sc, dy, { deltaY: e.deltaY, deltaMode: e.deltaMode });
  };
  return (
    <div className="rd-column" data-read-column="" ref={columnRoot} onWheel={onWheel}>
      <Sheet
        kind="reading"
        label={t("pane")}
        top={back}
        gutter={phone ? undefined : squares}
        head={
          <ReadingHead
            subject={shown.subject}
            people={messages.length > 1 ? people : []}
            names={messages.length > 1 ? people.map((p) => p.name).join(", ") : undefined}
            tags={opened.labels.length > 0 ? <Tags labels={opened.labels} /> : undefined}
            mailbox={mailboxWord(opened.mailboxId) ?? undefined}
            squares={phone ? squares : undefined}
          />
        }
        foot={<ActionBar verbs={verbs} room={room} keys={keysHere ? opened : null} reply={replyVerbs} />}
        jump={messages.length > 1 ? <WayToLatest walk={walk} last={messages.length - 1} /> : undefined}
      >
        {messages.map((m) => (
          <Letter
            key={m.id}
            message={m}
            opened={m.id === openId}
            unread={m.id === openId && visit !== null ? visit.unread : m.unread}
            look={look}
            reading={reading}
            presented={presentedIds.has(m.id)}
            narrow={narrow}
            onPerson={setPerson}
          />
        ))}
        {/* The reply, one more sheet after the conversation's last letter: `write`'s, where the shell handed it. */}
        {reply === "none" ? null : <reply.Sheet letters={messages.map((m) => m.id)} />}
      </Sheet>
      <Contact person={person} onClose={() => setPerson(null)} />
    </div>
  );
}

/**
 * THE KEYBOARD STAYS IN THE COLUMN FROM LETTER TO LETTER. Each letter draws a column of its own; where the keyboard
 * stood on the one that leaves (the arrows scroll it there), the next one's scroller takes it in the commit that
 * draws it, so the arrows go on scrolling what is read and never fall back to walking the list.
 */
function useKeyboardStays(
  onRoot: (el: HTMLDivElement | null) => void,
  keyboard: MutableRefObject<boolean>,
): (el: HTMLDivElement | null) => void {
  const root = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const here = scrollerOf(root.current);
    if (!keyboard.current || here === null) return;
    keyboard.current = false;
    const at = here.ownerDocument.activeElement;
    if (at === null || at === here.ownerDocument.body) here.focus({ preventScroll: true });
  });
  useLayoutEffect(
    () => () => {
      const mine = scrollerOf(root.current);
      keyboard.current = mine !== null && mine.ownerDocument.activeElement === mine;
    },
    [root, keyboard],
  );
  return useCallback(
    (el: HTMLDivElement | null) => {
      root.current = el;
      onRoot(el);
    },
    [onRoot],
  );
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

/** The way back to a conversation's latest message, standing while the column is far above it. */
function WayToLatest({ walk, last }: { walk: ThreadWalk; last: number }) {
  const t = useText("reader");
  return (
    <JumpBack
      label={t("latest")}
      to="end"
      shown={walk.endFar}
      onPress={() => {
        walk.jump(last);
      }}
    />
  );
}

/** A reader with no reply of `write`'s: the panel is always the letter's. */
const noReplyVerbs = (): null => null;

/** On a phone the column's way back, naming the place it returns to where the place has a word. */
function WayBack({ from }: { from: string }) {
  const t = useText("reader");
  const { commands } = useFrame();
  return from === "" ? (
    <Button kind="quiet" icon="back" label={t("back")} onPress={() => commands.open(null)} />
  ) : (
    <Button kind="two" icon="back" onPress={() => commands.open(null)}>
      {from}
    </Button>
  );
}

/**
 * A letter the engine tombstoned, said in the column's blank with the way to Trash where the shell mounts it. On a
 * phone the column is a page of its own: it keeps its way back.
 */
function GoneLetter({ phone, back }: { phone: boolean; back: ReactNode }) {
  const t = useText("reader");
  const { commands, host } = useFrame();
  const trash = host.features.places.trash;
  const blank = (
    <BlankColumn
      below={
        trash !== NONE && trash !== undefined ? (
          <div className="rd-gone-way">
            <Button kind="two" onPress={() => commands.go({ place: "trash" })}>
              {t("goneTrash")}
            </Button>
          </div>
        ) : undefined
      }
    >
      {t("goneShort")}
    </BlankColumn>
  );
  return phone ? (
    <Sheet kind="reading" label={t("pane")} top={back}>
      {blank}
    </Sheet>
  ) : (
    blank
  );
}
