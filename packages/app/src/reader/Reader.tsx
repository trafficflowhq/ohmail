/**
 * THE READING COLUMN: the open conversation on the kit's reading sheet, its letters oldest first, the squares beside
 * them (in the bar over the column on a phone, where they stay while the letters scroll), the action panel at its
 * foot. With nothing open, the blank. The read rule runs here with the column's names; the visit is the list's where
 * the list that opened the letter handed one.
 */
import { useConversationColumn } from "./conversation-column.js";
import type { EngineMessage } from "@ohmail/wire";
import { memo, useEffect, useRef, type MutableRefObject, type WheelEvent } from "react";
import { JumpBack } from "@ohmail/ui/base";
import { Sheet } from "@ohmail/ui/mail";
import { baseSubject, isForwardedByUs, isProtected, type ThreadWalk } from "@ohmail/app-logic/reader";
import { scrollByHand } from "@ohmail/app-logic/session/programmatic-scroll";
import type { FrameCommands, PaneProps, Route } from "../frame/contract.js";
import { useText, useTextLookup } from "../text/index.js";
import { useNewEvent } from "../calendar/use-new-event.js";
import { NONE } from "../host/index.js";
import { useReaderOpen } from "../frame/commands.js";
import { useOwnAddresses } from "../frame/room.js";
import { ActionBar, type PanelRoom } from "./actions/ActionBar.js";
import { RunReadingHead } from "./actions/ReplyRun.js";
import { Blank, GoneLetter, type ReadingBack } from "./blank/Blank.js";
import { Contact } from "./contact/Screening.js";
import { Letter } from "./Letter.js";
import { InlineReply } from "./parts.js";
import { useLetterKeys } from "./keys.js";
import { Squares } from "./Squares.js";
import { readSubjectDisplay } from "./subject-display.js";
import { Tags } from "./Tags.js";
import "./column.css";

const ConversationLetter = memo(Letter);

export function Reader({ route, plan, keysHere }: PaneProps) {
  const tp = useText("place");
  const search = useText("search");
  const drafts = useText("drafts");
  const readerOpen = useReaderOpen();
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
  const from =
    route.words.draftReturnLetter === route.open
      ? drafts("title")
      : route.place === "search"
        ? search("title")
        : tp.has(route.place)
          ? tp(route.place)
          : "";
  return (
    <Conversation
      key={`${readerOpen}:${route.wholeThread ? "thread" : "message"}:${route.open}`}
      route={route}
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

interface ConversationProps {
  /** Where the column stands: a link the store does not answer either is dropped from it. */
  route: Route;
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
}

function Conversation({ route, openId, phone, keysHere, from, narrow, room, keyboard }: ConversationProps) {
  const text = useTextLookup();
  const view = useConversationColumn(route, openId, keysHere, keyboard, phone);
  const {
    commands,
    host,
    shown: { presentedIds, subject: shownSubject },
    messages,
    newestFirst,
    opened,
    state,
    offMirrorRow,
    storeBody,
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
    scroller,
  } = view;
  const back = phone ? readerBack(from, text("reader")("back"), commands, route) : undefined;
  const calendarAction = useCalendarAction(opened, host.features.calendar !== NONE);
  if (opened === null && state === "gone") return <GoneLetter back={back} />;
  if (opened === null) return <Sheet kind="reading" label={text("reader")("pane")} back={back} />;
  const threaded = messages.length > 1;
  const squares = threaded && (
    <Squares
      messages={messages}
      walk={walk}
      place={phone ? "top" : narrow ? "heading" : "column"}
      column={scroller.current}
    />
  );
  const latest = newestFirst ? 0 : messages.length - 1;
  const eachSubject = readSubjectDisplay(host.session.scope) === "each";
  const subject = baseSubject(shownSubject);
  return (
    <div
      className="rd-column"
      data-read-column=""
      data-reader-actions={replyVerbs === null && step === null ? "" : undefined}
      ref={view.columnRoot}
      onWheel={(event) => scrollConversation(event, scroller.current)}
      role={step ? "dialog" : undefined}
      aria-modal={step ? true : undefined}
      aria-label={step ? text("later")("run.label") : undefined}
    >
      <Sheet
        kind="reading"
        extendTop={!phone}
        flushFoot
        manualScrollAnchor={threaded}
        label={text("reader")("pane")}
        back={back}
        top={phone ? squares : undefined}
        gutter={!phone && !narrow ? squares : undefined}
        head={
          <RunReadingHead
            run={step}
            under={view.under}
            squares={narrow ? squares : undefined}
            subject={eachSubject ? undefined : shownSubject}
            {...facesOf(threaded ? view.people : [])}
            tags={opened.labels.length > 0 ? <Tags labels={opened.labels} /> : undefined}
            mailbox={view.mailboxWord(opened.mailboxId) ?? undefined}
          />
        }
        foot={
          <ActionBar
            key={openId}
            verbs={verbs}
            conversation={threaded}
            room={room}
            keys={keysHere ? opened : null}
            reply={replyVerbs}
            run={step}
            onScreen={view.canScreen ? view.screenSender : undefined}
            onScreenKey={view.canScreen ? view.screenByKey : undefined}
            screeningDialog={view.screeningDialog}
            onCalendar={calendarAction}
          />
        }
        jump={squares && <WayToLatest walk={walk} index={latest} newestFirst={newestFirst} />}
      >
        {messages.map((m, index) => (
          <ConversationLetter
            key={m.id}
            message={m}
            onBodyLayout={walk.refreshLayout}
            showSubject={eachSubject || (threaded && separateSubject(m, subject, phone && index === latest))}
            compactSubject={eachSubject}
            offMirrorBody={offMirrorRow?.body ?? storeBody?.body}
            retryBody={offMirrorRow?.retry ?? storeBody?.retry}
            opened={m.id === openId}
            current={index === (walk.here < 0 ? latest : walk.here)}
            previewSelection={`${route.place}:${openId}`}
            unread={m.id === openId && visit !== null ? visit.unread : m.unread}
            subject={phone && threaded && index === latest ? m.subject || shownSubject : undefined}
            look={column.wiring?.look ?? "dot"}
            reading={!column.wiring?.previewing}
            presented={presentedIds.has(m.id)}
            narrow={narrow}
            onPerson={onPerson}
            card={person?.slot ?? null}
          />
        ))}
        <InlineReply reply={reply} letters={messages.map((m) => m.id)} keysHere={keysHere} />
      </Sheet>
      <Contact person={person} onClose={closeCard} />
    </div>
  );
}

function readerBack(from: string, fallback: string, commands: FrameCommands, route: Route): ReadingBack {
  const onPress = () => {
    if (route.words.draftReturnLetter === route.open) commands.go({ place: "drafts", open: null });
    else commands.open(null);
  };
  return { word: from || undefined, label: from || fallback, onPress };
}

function useCalendarAction(letter: EngineMessage | null, enabled: boolean) {
  const own = useOwnAddresses();
  const allowed =
    enabled && letter !== null && letter.sensitivity?.sensitive !== true && !isProtected(letter);
  const create = useNewEvent(
    allowed
      ? {
          title: letter.subject,
          guests: letterGuests(letter, own),
        }
      : undefined,
  );
  return allowed && create ? () => create() : undefined;
}

function letterGuests(letter: EngineMessage, own: readonly string[]) {
  const seen = new Set(own.map((address) => address.toLowerCase()));
  return [letter.from, ...letter.to, ...letter.cc].flatMap(({ address, name }) => {
    const key = address.trim().toLowerCase();
    if (!key.includes("@") || seen.has(key)) return [];
    seen.add(key);
    return [{ address: address.trim(), name: name ?? null }];
  });
}

/** The way back to a conversation's latest message, standing while the column is far from it. */
function WayToLatest({
  walk,
  index,
  newestFirst,
}: {
  walk: ThreadWalk;
  index: number;
  newestFirst: boolean;
}) {
  const t = useText("reader");
  return (
    <JumpBack
      label={t("latest")}
      to={newestFirst ? "top" : "end"}
      shown={walk.latestFar}
      onPress={() => {
        walk.jump(index);
      }}
    />
  );
}

/** The faces a conversation's head stands, as the studio's byline does (`ui.faces(voices, 4)`); the rest are counted. */
const FACES = 4;

/** The head's people: four faces, the count of the rest, and every name; nobody for a single letter. */
function facesOf(people: readonly { name: string; address: string }[]) {
  return {
    people: people.slice(0, FACES),
    peopleMore: people.length > FACES ? `+${people.length - FACES}` : undefined,
    names: people.length > 0 ? people.map((p) => p.name).join(", ") : undefined,
  };
}

/** A wheel beside the sheets scrolls them as the person's own scroll. */
function scrollConversation(e: WheelEvent<HTMLDivElement>, sc: HTMLElement | null): void {
  // Portaled menus and suggestions scroll independently of the conversation.
  const target = e.target as Element;
  if (
    !sc ||
    e.ctrlKey ||
    !e.currentTarget.contains(target) ||
    sc.contains(target) ||
    target.closest?.("[data-popover]")
  )
    return;
  const dy = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? sc.clientHeight : 1);
  if (dy !== 0) scrollByHand(sc, dy, { deltaY: e.deltaY, deltaMode: e.deltaMode });
}

function separateSubject(message: EngineMessage, subject: string, lastOnPhone: boolean): boolean {
  return baseSubject(message.subject) !== subject || isForwardedByUs(message) || lastOnPhone;
}
