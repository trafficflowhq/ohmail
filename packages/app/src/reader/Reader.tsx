/**
 * THE READING COLUMN: the open conversation on the kit's reading sheet, its letters oldest first, the squares beside
 * them (in the bar over the column on a phone, where they stay while the letters scroll), the action panel at its
 * foot. With nothing open, the blank. The read rule runs here with the column's names; the visit is the list's where
 * the list that opened the letter handed one.
 */
import { useConversationColumn } from "./conversation-column.js";
import type { EngineMessage } from "@ohmail/wire";
import { memo, useEffect, useLayoutEffect, useRef, type MutableRefObject, type WheelEvent } from "react";
import { JumpBack } from "@ohmail/ui/base";
import { Sheet } from "@ohmail/ui/mail";
import { baseSubject, isForwardedByUs, isProtected, type ThreadWalk } from "@ohmail/app-logic/reader";
import { scrollByHand } from "@ohmail/app-logic/session/programmatic-scroll";
import type { PaneProps, Route } from "../frame/contract.js";
import { useText } from "../text/index.js";
import { useNewEvent } from "../calendar/use-new-event.js";
import { NONE } from "../host/index.js";
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
      key={route.wholeThread ? `thread:${route.open}` : route.open}
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
  const t = useText("reader");
  const later = useText("later");
  const {
    commands,
    host,
    shown: { messages, presentedIds, subject: shownSubject },
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
    screeningId,
    canScreen,
    screenSender,
    screenByKey,
    mailboxWord,
    people,
    columnRoot,
    scroller,
    under,
  } = useConversationColumn(route, openId, keysHere, keyboard, phone);
  useHeadingStepBack(scroller, phone, opened !== null);
  const back = phone ? readerBack(from, t("back"), () => commands.open(null)) : undefined;
  const calendarAction = useCalendarAction(opened, host.features.calendar !== NONE);
  /* Only a letter the engine tombstoned is said to be gone; one not here yet is a sheet with nothing said. */
  if (opened === null && state === "gone") return <GoneLetter back={back} />;
  if (opened === null) return <Sheet kind="reading" label={t("pane")} back={back} />;
  const place = phone ? "top" : narrow ? "heading" : "column";
  const squares = messages.length > 1 && (
    <Squares messages={messages} walk={walk} place={place} column={scroller.current} />
  );
  const latest = phone && messages.length > 1 ? messages.at(-1) : undefined;
  const eachSubject = readSubjectDisplay(host.session.scope) === "each";
  const subject = baseSubject(shownSubject);
  const screeningDialog = canScreen ? { id: screeningId, open: person?.cardId === screeningId } : undefined;
  return (
    <div
      className="rd-column"
      data-read-column=""
      ref={columnRoot}
      onWheel={(event) => scrollConversation(event, scroller.current)}
      role={step ? "dialog" : undefined}
      aria-modal={step ? true : undefined}
      aria-label={step ? later("run.label") : undefined}
    >
      <Sheet
        kind="reading"
        extendTop={!phone}
        flushFoot
        manualScrollAnchor={route.wholeThread}
        label={t("pane")}
        back={back}
        top={phone ? squares : undefined}
        gutter={place === "column" ? squares : undefined}
        head={
          <RunReadingHead
            run={step}
            under={under}
            squares={narrow ? squares : undefined}
            subject={eachSubject ? undefined : shownSubject}
            {...facesOf(messages.length > 1 ? people : [])}
            tags={opened.labels.length > 0 ? <Tags labels={opened.labels} /> : undefined}
            mailbox={mailboxWord(opened.mailboxId) ?? undefined}
          />
        }
        foot={
          <ActionBar
            key={openId}
            verbs={verbs}
            conversation={messages.length > 1}
            room={room}
            keys={keysHere ? opened : null}
            reply={replyVerbs}
            run={step}
            onScreen={canScreen ? screenSender : undefined}
            onScreenKey={canScreen ? screenByKey : undefined}
            screeningDialog={screeningDialog}
            onCalendar={calendarAction}
          />
        }
        jump={messages.length > 1 ? <WayToLatest walk={walk} last={messages.length - 1} /> : undefined}
      >
        {messages.map((m, index) => (
          <ConversationLetter
            key={m.id}
            message={m}
            showSubject={
              eachSubject ||
              (messages.length > 1 && separateSubject(m, subject, phone && index === messages.length - 1))
            }
            offMirrorBody={offMirrorRow?.body ?? storeBody?.body}
            retryBody={offMirrorRow?.retry ?? storeBody?.retry}
            opened={m.id === openId}
            previewSelection={`${route.place}:${openId}`}
            unread={m.id === openId && visit !== null ? visit.unread : m.unread}
            subject={m === latest ? m.subject || shownSubject : undefined}
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

/** Let the subject's last line remain as the rest of the heading scrolls away. */
function useHeadingStepBack(scroller: MutableRefObject<HTMLElement | null>, phone: boolean, ready: boolean) {
  useLayoutEffect(() => {
    const port = scroller.current;
    const head = port?.querySelector<HTMLElement>(".oh-readinghead");
    const short = head?.querySelector<HTMLElement>(".oh-readinghead-short");
    if (!port || !head || !short || phone) return;
    const squares = head.querySelector<HTMLElement>(".oh-readinghead-sub > .oh-readsquares");
    const room = port.ownerDocument.defaultView?.matchMedia?.("(max-height: 899px)");
    if (!room) return;
    let up = 0;
    const update = () =>
      head.toggleAttribute("data-back", room.matches && up > 0 && port.scrollTop >= up - 1);
    const measure = () => {
      const squaresTop = squares
        ? squares.getBoundingClientRect().top - head.getBoundingClientRect().top
        : head.offsetHeight;
      up = room.matches ? Math.max(0, Math.min(head.offsetHeight - short.offsetHeight, squaresTop)) : 0;
      head.style.setProperty("--oh-head-squares", `${squares?.offsetWidth ?? 0}px`);
      head.style.setProperty("--oh-head-up", `${up}px`);
      update();
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(head);
    if (squares) observer?.observe(squares);
    room.addEventListener("change", measure);
    port.addEventListener("scroll", update, { passive: true });
    measure();
    return () => {
      observer?.disconnect();
      room.removeEventListener("change", measure);
      port.removeEventListener("scroll", update);
      head.style.removeProperty("--oh-head-up");
      head.style.removeProperty("--oh-head-squares");
      head.removeAttribute("data-back");
    };
  }, [scroller, phone, ready]);
}

function readerBack(from: string, fallback: string, onPress: () => void): ReadingBack {
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
  if (!sc || e.ctrlKey || sc.contains(e.target as Node)) return;
  const dy = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? sc.clientHeight : 1);
  if (dy !== 0) scrollByHand(sc, dy, { deltaY: e.deltaY, deltaMode: e.deltaMode });
}

function separateSubject(message: EngineMessage, subject: string, lastOnPhone: boolean): boolean {
  return baseSubject(message.subject) !== subject || isForwardedByUs(message) || lastOnPhone;
}
