/**
 * THE READING COLUMN: the open conversation on the kit's reading sheet, its letters oldest first, the squares beside
 * them (along the head on a phone), the action panel at its foot. With nothing open, the blank. The read rule runs
 * here with the column's names; the visit is the list's where the list that opened the letter handed one.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type WheelEvent } from "react";
import { Button } from "@ohmail/ui/base";
import { BlankColumn, ReadingHead, Sheet } from "@ohmail/ui/mail";
import {
  markSeenOver,
  useColumnVisit,
  useConversationBodies,
  useOpenConversation,
  useThreadWalk,
} from "@ohmail/app-logic/reader";
import { useListVisit, useThreadRead } from "@ohmail/app-logic/reading";
import { scrollByHand } from "@ohmail/app-logic/session/programmatic-scroll";
import type { EngineMessage } from "@ohmail/client-engine";
import type { PaneProps } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useFrame } from "../frame/commands.js";
import { useMailboxWord, usePress, useRoomHolds } from "../frame/room.js";
import { useText } from "../text/index.js";
import { ActionBar, type PanelRoom } from "./actions/ActionBar.js";
import { useVerbs } from "./actions/use-verbs.js";
import { Blank } from "./blank/Blank.js";
import { Contact, type ContactOf } from "./contact/Contact.js";
import { Letter } from "./Letter.js";
import { useParts } from "./parts.js";
import { READER_DOM, scrollerOf } from "./read-dom.js";
import { useReaderKeys } from "./keys.js";
import { Squares } from "./Squares.js";
import { Tags } from "./Tags.js";
import "./column.css";

export function Reader({ route, plan, keysHere }: PaneProps) {
  const tp = useText("place");
  if (route.open === null) return <Blank />;
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
    />
  );
}

const nameOf = (m: EngineMessage): string => m.from.name?.trim() || m.from.address;

function Conversation({
  openId,
  phone,
  keysHere,
  from,
  narrow,
  room,
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
  useReaderKeys(keysHere && opened !== null, root, { verbs, visit });
  const [person, setPerson] = useState<ContactOf | null>(null);
  const mailboxWord = useMailboxWord();

  const back = phone ? <WayBack from={from} /> : undefined;
  /* Only a letter the engine tombstoned is said to be gone; one not here yet is a sheet with nothing said. */
  if (opened === null && state === "gone") return <GoneLetter phone={phone} back={back} />;
  if (opened === null) return <Sheet kind="reading" label={t("pane")} top={back} />;
  const look = column.wiring?.look ?? "dot";
  const squares =
    messages.length > 1 ? (
      <Squares messages={messages} walk={walk} axis={phone ? "head" : "column"} column={scroller.current} />
    ) : null;
  const people = [
    ...new Map(messages.map((m) => [m.from.address, { name: nameOf(m), address: m.from.address }])).values(),
  ];
  const reading = !(column.wiring?.previewing ?? false);
  /* A wheel beside the sheets scrolls them, as the person's own scroll. */
  const onWheel = (e: WheelEvent<HTMLDivElement>): void => {
    const sc = scroller.current;
    if (!sc || e.ctrlKey || sc.contains(e.target as Node)) return;
    const dy = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? sc.clientHeight : 1);
    if (dy !== 0) scrollByHand(sc, dy, { deltaY: e.deltaY, deltaMode: e.deltaMode });
  };
  return (
    <div className="rd-column" data-read-column="" ref={setRoot} onWheel={onWheel}>
      <Sheet
        kind="reading"
        label={t("pane")}
        top={back}
        gutter={phone ? undefined : squares}
        head={
          <ReadingHead
            subject={opened.subject}
            people={messages.length > 1 ? people : []}
            names={messages.length > 1 ? people.map((p) => p.name).join(", ") : undefined}
            tags={opened.labels.length > 0 ? <Tags labels={opened.labels} /> : undefined}
            mailbox={mailboxWord(opened.mailboxId) ?? undefined}
            squares={phone ? squares : undefined}
          />
        }
        foot={<ActionBar verbs={verbs} room={room} reply={replyVerbs} />}
      >
        {messages.map((m) => (
          <Letter
            key={m.id}
            message={m}
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
