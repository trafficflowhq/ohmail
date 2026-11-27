import type { ReplyRunState } from "@ohmail/app-logic/piles/reply-run";
/**
 * The reading view, as a component two hosts mount: the pushed `/message/[id]` route (one
 * pane) and the list-detail's reading pane (two panes — the iPad, the unfolded Duo, Android
 * expanded). Same facts, same verbs either way: why the message landed here (the routing
 * rationale chip), what was blocked (the spy-pixel count), what is protected (redaction dots,
 * nothing behind them). Opening marks read through the engine and asks the full body; the
 * verbs are `MessageActions`, which places itself by posture. The scroll position is written
 * to `pane-memory` per message, so a fold that remounts this tree resumes where the reader
 * was — continuity as data, not as tree position.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { router, useIsFocused } from "expo-router";
import { JUNK_REFILL_BOUND_MS, type WorldAttachment, type WorldEarlier, type WorldMail } from "../state/live";
import { invitationNote, junkLeaving, mailboxStatusOf, withheldNote } from "./body-note";
import { attachmentFaultNote, type AttachmentFault } from "./attachment-fault-note";
import {
  ActivityIndicator, Animated, AppState, Easing, KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, useWindowDimensions, View,
  type NativeScrollEvent, type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { mailSize } from "../theme/mail";
import { MailAvatar } from "./MailAvatar";
import { MailboxChip } from "./MailboxChip";
import { useBodyStamp, useFilesStamp, useWorld, useWorldToast } from "../state/world";
import { openConfirmedLink } from "../mail/frame-nav";
import { beginMark, endMark } from "../engine/ui-marks";
import { shareAttachmentBytes } from "../mail/open-attachment-native";
import { Button, Chip, Panel, Screen, Scroller, Tap, TagChip, Txt, useListInsets } from "./base";
import { DetailBar, PaneTop } from "./chrome";
import { Icon } from "./Icon";
import { BodyPages } from "./BodyPages";
import { HistoryFold, HistoryRow } from "./HistoryFold";
import { MailFoundEvents, useMailFoundEvents } from "./MailFoundEvents";
import { EventCards } from "./EventCard";
import { MailBodyFrame } from "./MailBodyFrame";
import { FadeOut } from "./FadeOut";
import { replyOpen, type InlineComposeOpen } from "./compose-route";
import { ComposeSheet, MessageActions, useReaderVerbMode } from "./MessageActions";
import { keyboardLift, useKeyboardHeight } from "./keyboard-lift";
import { SurfaceBoundary } from "./ErrorBoundary";
import { EmptiedLetter } from "./EmptiedLetter";
import { AttachmentPreview, type PreviewFile } from "./AttachmentPreview";
import { hasPaneScroll, panePlaceOf, paneScrollOf, recordPanePlace, recordPaneScroll } from "./pane-memory";
import { createOpenAnchor, placeAt, placeY, type OpenAnchor } from "./open-anchor";
import {
  THREAD_READ_FADE_MS, THREAD_TOP_LINES, THREAD_UNREAD_BACK_MS, createPhoneThreadRead,
} from "./reader-seen";
import { standsInOhboxMail } from "./pane-routes";
import { readSlotMarksUnread } from "./read-slot";
import { onReaderCover, readerSees, setReaderWindowFocused } from "./reader-cover";
import { createSentReveal, onReplySend } from "./sent-reveal";
import { Sheet, SheetRow } from "./Sheet";
import { useBottomChromeExtent } from "./bottom-chrome";
import {
  MARK_HOLD_MS, RAIL_HIT_SLOP, RAIL_MORE, RAIL_PITCH, RAIL_TOP, arrivalsToAsk, markUnreadOffered, openedBodyFinal, railItemsMemo, readerChromeOverlap, slotOf,
  readerGroups, replyMemberId, type RailItem,
} from "./reader-marks";
import { endIdleVisit, hideVisit, showVisit, visitKnew, visitRecordFor } from "./visit-records";
import { MARK_RING, MarkRing, MarkSheet, MarkSquare, ringRest, useMarkHold, useSquaresWindow, type MarkHold } from "./MarkSquare";
import {
  bindThreadJump, clearThreadPlace, publishThreadPlace, takeThreadPending, threadPending, threadPlace,
} from "../state/thread-place";

/** No squares: one array, so a reader without them never re-publishes the strip. */
const NO_RAIL: RailItem[] = [];

/** The window width below which the reader's from-line puts the address under the name. */
export const FROM_LINE_SPLIT_DP = 360;

export function MessageReader({
  id: addressedId,
  inPane = false,
  selectMember = false,
  wholeThread = false,
  runReply,
  onClose,
}: {
  id: string;
  /** A message explicitly selected to read its full body from a thread. */
  selectMember?: boolean;
  wholeThread?: boolean;
  runReply?: ReplyRunState;
  /** Mounted beside its list — no back bar of its own; the pane or the rail carries Back. */
  inPane?: boolean;
  /** Leaves the reader: `router.back()` on the route, clearing the selection in a pane. */
  onClose?: () => void;
}) {
  const t = useTheme();
  const w = useWorld();
  /* Below 360 dp the address takes its own line under the name (`FROM_LINE_SPLIT_DP`). */
  const window = useWindowDimensions();
  const narrowFrom = window.width < FROM_LINE_SPLIT_DP;
  // The reader draws the body, so it subscribes to it: a body landing redraws this pane alone.
  useBodyStamp();
  const m = w.message(addressedId, wholeThread);
  const id = m?.id ?? addressedId;
  // …and to its files and events: a list or a calendar part landing redraws the tiles and cards.
  useFilesStamp(m ? [m.id, ...m.earlier.map((h) => h.id)] : [id]);
  /* The rail carries Back where it carries the verbs (the closed Duo, the unfolded landscape):
     a detail bar above it would stand Back twice. */
  const verbMode = useReaderVerbMode(inPane);
  const railBack = verbMode === "rail";
  const bare = inPane || railBack;
  const phoneSheet = t.mail === true && !bare && verbMode === "compact";
  const found = useMailFoundEvents(m, phoneSheet);
  const eventWords = found?.rows.find((row) => row.sourceWords)?.sourceWords ?? undefined;
  const [reply, setReply] = useState<{ reader: string; world: string; message: WorldMail; open: InlineComposeOpen } | null>(
    () => runReply && m ? { reader: id, world: w.worldKey, message: m, open: replyOpen(w.actions.keptReply(m.id), "reply") } : null,
  );
  const inline = reply?.reader === id && reply.world === w.worldKey ? reply : null;
  const replyKeyboardHeight = useKeyboardHeight(inline !== null);
  const { bottom: bottomInset } = useSafeAreaInsets();
  const replyKeyboardLift = keyboardLift(Platform.OS, replyKeyboardHeight, bottomInset);
  const replyDockMax = replyKeyboardHeight === 0 ? "76%"
    : window.height - (Platform.OS === "android" ? replyKeyboardLift : replyKeyboardHeight) < 360 ? "85%" : "78%";
  const closeReply = () => setReply(null);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  /** "Show as text" — this reading's own choice, per message; a new open renders rich again. */
  const [textFor, setTextFor] = useState<string | null>(null);
  /** An emptied letter's text, loaded from the mail server for this view only (`EmptiedLetter`). */
  const [liveText, setLiveText] = useState<{ id: string; text: string } | null>(null);
  const toast = useWorldToast();

  // The open: mark read (watched — the engine owns the overlay and the rollback),
  // hydrate the full text + conversation + file list.
  //
  // KEYED ON THE WORLD, not just the id: `openMessage` is identity-stable by design (so
  // mirror versions cannot re-fire this), which means a route restored while the session is
  // still booting would otherwise open against the empty world's no-op and never re-run
  // when the session goes live — an unread message under an indefinitely loading snippet.
  const openMessage = w.actions.openMessage;
  const releaseAttachments = w.actions.releaseAttachments;
  const worldKey = w.worldKey;
  useEffect(() => {
    if (id) openMessage(id);
    // AND THE LEAVING RELEASES. The engine holds this message's file list, its inline pictures
    // and every Blob a tile press fetched until somebody drops them, and the phone mints no
    // object URL whose revocation would do it — so the reader owes the release the web seam's
    // cleanup owes, keyed on the same id it opened. Re-entering the message re-asks.
    return () => {
      if (id) releaseAttachments(id);
    };
  }, [id, openMessage, releaseAttachments, worldKey]);
  /* …AND ITS ROW'S PLACE: the open row stands in New while this reader shows it (`openMessage`
     holds it), and leaving files it at the top of Earlier — its read was an open read. */
  const leaveMessage = w.actions.leaveMessage;
  useEffect(() => () => {
    if (id) leaveMessage(id);
  }, [id, leaveMessage]);

  /* A VERDICT'S HUSK MOVED OUT OF JUNK: the mirror sheds it on the move's own changes, and the
     reader asks again then, once per husk seen; past the engine's bound it says the text could
     not be read. The web reader's rule (`useJunkRefill`), on this door's hydrate. */
  const hydrateMessage = w.actions.hydrateMessage;
  const leaving = m !== undefined && m !== null && junkLeaving(m);
  const shed = m?.bodyState === "snippet" || m?.bodyState === "loading";
  /* THE OPEN MARK ENDS HERE: the first commit showing this message's body in a terminal state (the web's
     `endOpen` rule) — a snippet or a body still loading is not the open a person waited for. */
  const bodyState = m?.bodyState;
  useEffect(() => {
    if (bodyState !== undefined && bodyState !== "snippet" && bodyState !== "loading") endMark("open", id);
  }, [id, bodyState]);
  const [refillExpired, setRefillExpired] = useState(false);
  const owedFor = useRef<string | null>(null);
  useEffect(() => {
    setRefillExpired(false);
    if (!leaving) return;
    owedFor.current = id;
    const timer = setTimeout(() => setRefillExpired(true), JUNK_REFILL_BOUND_MS);
    return () => clearTimeout(timer);
  }, [id, leaving]);
  useEffect(() => {
    if (!shed || owedFor.current !== id) return;
    owedFor.current = null;
    hydrateMessage(id);
  }, [id, shed, hydrateMessage]);

  /* THE THREAD-READ RULE — one record per visit, entered at the mount (a phone reader is an open):
     each member, and in the Ohbox the opened message too, turns read once its top — its sender line
     and its first lines — has been on screen for the dwell, and goes out then as one glance
     (`reader-seen.ts`). In the Ohbox the reader also wears the presentation: the time order, the
     tint, the rail of squares and Mark unread in ⋯. The record lives outside this tree
     (`visit-records.ts`): a fold remounts the reader, and the visit — what was kept unread in it —
     goes on. */
  const markGlanced = w.actions.markGlanced;
  const glance = useRef(markGlanced);
  glance.current = markGlanced;
  const record = visitRecordFor(id, Date.now());
  useEffect(() => {
    showVisit(id, Date.now());
    return () => hideVisit(id);
  }, [id]);
  const inOhbox = m ? standsInOhboxMail(m) : false;
  /* AN ARRIVAL NEVER MOVES THE READER: the anchor and the kept place stand in the members the visit knew;
     a member drawn below later is not. Known in render, before the new panel's layout reports. */
  const ids = m ? [id, ...m.earlier.map((h) => h.id)] : [];
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const knewRef = useRef<Set<string> | null>(null);
  knewRef.current = m ? visitKnew(id, () => ids, Date.now()) : null;
  const arrivedRef = useRef(false);
  arrivedRef.current = m ? readerGroups(m).below.some((h) => knewRef.current?.has(h.id) === false) : false;
  const padRef = useRef(0);
  const normalFoot = useListInsets().paddingBottom;
  padRef.current = inline === null ? normalFoot : mailSize.inset;
  /* A REPLY THAT ARRIVES INTO THE OPEN READER is asked its text, as the open asked every member it
     found: a snippet is never ready, and the rule could not read it however long it was on screen. */
  const hydrateHeld = w.actions.hydrateHeld;
  const asked = useRef<Set<string> | null>(null);
  const memberIds = m ? m.earlier.map((h) => h.id).join(" ") : null;
  useEffect(() => {
    if (!m) return;
    if (asked.current === null) {
      asked.current = new Set(m.earlier.map((h) => h.id)); // the open asked these
      return;
    }
    const fresh = arrivalsToAsk(m.earlier, asked.current);
    if (fresh.length > 0) hydrateHeld(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberIds, hydrateHeld]);
  /* A MEMBER WHOSE HTML HOLDS NO WORDS draws its files alone, its embedded pictures among them: its
     list is asked whatever its flag says (a picture the html names by `cid:` clears the flag). */
  const filesDoor = useRef(w.actions);
  filesDoor.current = w.actions;
  const wordless = m ? m.earlier.filter((h) => h.wordless === true).map((h) => h.id).join(" ") : "";
  useEffect(() => {
    if (wordless === "") return;
    const door = filesDoor.current;
    const ids = wordless.split(" ");
    for (const mid of ids) door.holdFiles([mid]);
    return () => { for (const mid of ids) door.releaseFiles([mid]); };
  }, [wordless, worldKey]);
  /** The message whose frame has its document's height (`MailBodyFrame`'s `onFinal`). */
  const [frameFinalFor, setFrameFinalFor] = useState<string | null>(null);
  /** The opened html message's quoted history: where its frame found one, and whether it is open. */
  const [frameHistory, setFrameHistory] = useState<{ id: string; at: "trailing" | "leading" } | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const framed = m != null && m.html != null && m.html !== "" && textFor !== m.id;
  const facts = useRef<{
    inOhbox: boolean; unread: (mid: string) => boolean; ready: (mid: string) => boolean; has: (mid: string) => boolean;
  }>({
    inOhbox, unread: () => false, ready: () => false, has: () => false,
  });
  facts.current = {
    inOhbox,
    has: (mid) => mid === m?.id || (m?.earlier.some((h) => h.id === mid) ?? false),
    unread: (mid) => (mid === m?.id ? m.unread === true : m?.earlier.some((h) => h.id === mid && !h.seen) ?? false),
    ready: (mid) => (mid === m?.id
      ? openedBodyFinal(m, { framed, final: frameFinalFor === m.id })
      : m?.earlier.find((h) => h.id === mid)?.ready === true),
  };
  const [here, setHere] = useState<string | null>(null);
  /* A body's first lines, in its own type: the opened message reads at the reader's size, a member at the stream's. */
  const lineOf = useRef({ opened: t.type.readerBody.lineHeight ?? 29, member: t.type.streamBody.lineHeight ?? 25 });
  lineOf.current = { opened: t.type.readerBody.lineHeight ?? 29, member: t.type.streamBody.lineHeight ?? 25 };
  /* Another screen over this reader (a pushed route, another tab over the pane) hides it: it reads nothing then. */
  const screenShown = useIsFocused();
  useEffect(() => {
    if (screenShown && id !== addressedId) router.setParams(inPane ? { open: id } : { id });
  }, [addressedId, id, inPane, screenShown]);
  const shown = useRef(screenShown);
  shown.current = screenShown;
  /** The anchor on its way to a place: the view shows no place the person chose, so it reads nothing. */
  const anchorRef = useRef<OpenAnchor | null>(null);
  /* THE CONVERSATION'S SQUARES, and A STRIP PRESS THIS OPEN CARRIES: the Ohbox row's
     square pressed with no reader mounted opened the row and left that member pending
     (`thread-place.ts`); this reader lands on it. Read once per opened id, taken in an effect. */
  const railOf = useMemo(railItemsMemo, []);
  const railItems = m ? railOf(m) : NO_RAIL;
  const newestId = railItems.at(-1)?.id ?? id;
  /* A held square's sheet: the rail's, dropped by the reader's own drag too. */
  const markHold = useMarkHold();
  const landing = useRef<{ for: string; id: string | null } | null>(null);
  if (m && landing.current?.for !== id) {
    const p = threadPending();
    landing.current = { for: id, id: p !== null && railItems.some((it) => it.id === p) ? p : null };
  }
  const landingId = landing.current?.for === id ? landing.current.id : null;
  const opening = useRef<{ for: string; target: string | null }>({ for: id, target: null });
  if (opening.current.for !== id) opening.current = { for: id, target: null };
  if (opening.current.target === null && (selectMember || railItems.length > 0)) {
    opening.current.target = selectMember ? id : newestId;
  }
  const openingId = opening.current.target ?? id;
  const handed = useRef<string | null>(null);
  const seen = useMemo(
    () => createPhoneThreadRead({
      record,
      openedId: () => (facts.current.inOhbox ? id : null),
      unread: (mid) => facts.current.unread(mid),
      ready: (mid) => facts.current.ready(mid),
      onRead: (ids) => glance.current(ids),
      lines: (mid) => THREAD_TOP_LINES * (mid === id ? lineOf.current.opened : lineOf.current.member),
      /* In sight: its screen in front, the app in the foreground, its window focused, and no sheet or composer over it.
         AppState stays active under a Modal and under the notification shade (`reader-cover.ts`). */
      active: () => shown.current && readerSees(AppState.currentState) && anchorRef.current?.settling !== true,
      onHere: setHere,
      start: paneScrollOf(`msg:${id}`),
      knew: (mid) => mid === id || (knewRef.current?.has(mid) ?? true),
    }),
    [id, record],
  );
  useEffect(() => () => seen.dispose(), [seen]);
  /* THE LANDING PIN: a fresh open rings the message it opens at (or the strip's pressed member) until
     the person's first scroll (a drag, or any scroll the app did not ask for) — the anchor's own scrolls are the app's, and the walk would ring a
     neighbour of a short opened message. A remount that resumes a remembered place walks from there. */
  const freshOpen = useMemo(() => !hasPaneScroll(`msg:${id}`), [id]);
  useEffect(() => {
    if (landingId !== null) {
      takeThreadPending(landingId);
      seen.pin(landingId);
    } else if (freshOpen && handed.current !== id) {
      seen.pin(openingId);
    }
  }, [seen, id, landingId, freshOpen, openingId]);
  /* Back in the foreground, the window focused again, a sheet gone: look again (nothing is read while
     the app is away, its window blurred — Android's shade — or a modal stands over the reader). */
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") seen.poke(); });
    const blur = AppState.addEventListener("blur", () => setReaderWindowFocused(false));
    const focus = AppState.addEventListener("focus", () => setReaderWindowFocused(true));
    const off = onReaderCover(() => seen.poke());
    /* Nobody tracks the focus once the reader is gone: the next one starts focused (it was opened by a touch). */
    return () => { sub.remove(); blur.remove(); focus.remove(); off(); setReaderWindowFocused(true); };
  }, [seen]);
  /* A read state, a body or the scope changed: look again (one look per frame however often). */
  useEffect(() => { seen.poke(); });
  /* The read zone ends where the floating bar begins. */
  const chromeExtent = useBottomChromeExtent();
  const chromeOver = readerChromeOverlap(verbMode, chromeExtent);
  useEffect(() => { seen.chrome(chromeOver); }, [seen, chromeOver]);
  const scrollRef = useRef<ScrollView>(null);
  /** The message whose ⋯ sheet is open, or `null`. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [openedEndY, setOpenedEndY] = useState(0);
  /* THE SCROLL'S PLACE. The remembered offset is where this mount STARTS, once — a fresh value each
     render made the scroll view jump back to a stale offset on any re-render (the rail's jumps landed
     short); the reader then learns where it stands from every scroll, drag end, fling end and its
     own jumps. */
  const scrollKey = `msg:${id}`;
  const startAt = useMemo(() => ({ x: 0, y: paneScrollOf(scrollKey) }), [scrollKey]);
  /* THE PLACE: the message under the view's top and how far into it, or the content's end (`pane-memory`).
     A new width aims at it again, never at the offset. It moves with the person's scroll and a landing, not with an aim. */
  const place = useMemo(() => ({ current: panePlaceOf(scrollKey) }), [scrollKey]);
  const stand = (y: number): void => {
    recordPaneScroll(scrollKey, y);
    const a = anchorRef.current;
    if (a !== null && (!a.holding || a.settled)) {
      const p = placeAt(seen.layout(id), y, knewBox());
      /* Only the person's own scroll keeps the content's end; a landing keeps its message. */
      const q = p === null || !p.end || !a.holding || place.current?.end === true ? p : { id: p.id, dy: p.dy, h: p.h };
      if (q !== null) { place.current = q; recordPanePlace(scrollKey, q); }
    } else if (a !== null && place.current === null) {
      /* The open stands clamped at the end, short of its message's top: a remount (one pane to two) aims at that top again. */
      const mid = landingOf() ?? opening.current.target ?? id;
      const top = seen.topOf(mid);
      const at = openTarget();
      const h = seen.layout(id).find((x) => x.id === mid)?.height ?? 0;
      if (top !== null && at !== null) recordPanePlace(scrollKey, { id: mid, dy: at - top, h });
    }
    seen.onScroll(y, jumpEnd.current !== null || anchorRef.current?.moving === true);
  };
  const box = useRef({ content: 0, view: 0 });
  /** Each member panel's height, as laid out. */
  const memberH = useRef(new Map<string, number>());
  /** The extent as the visit knew it: the content ends at its known foot plus the column's bottom padding. */
  const knewBox = (): { content: number; view: number } => {
    const b = box.current;
    const foot = arrivedRef.current ? seen.knewFoot() : null;
    return foot === null ? b : { content: Math.min(b.content, foot + padRef.current), view: b.view };
  };
  /** An animated jump's last frames may never reach `onScroll`: once it is done, the reader stands where it ends. */
  const jumpEnd = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (jumpEnd.current) clearTimeout(jumpEnd.current); }, []);
  const shouldLand = useRef(false);
  /* Until the anchor has placed the opened message the column is not drawn: its first frame stands at
     the oldest member, and would flash it. A bound in case no layout ever places it. */
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setPlaced(true), ANCHOR_PLACE_BOUND_MS);
    return () => clearTimeout(t);
  }, []);
  /* Keep the opened position while the bodies above it reflow. A posture remount resumes the saved place. */
  const standRef = useRef(stand);
  standRef.current = stand;
  shouldLand.current = railItems.length > 0 && railItems[0]?.id !== openingId;
  /** The strip's pressed member this open lands on, if any. */
  const landingOf = (): string | null => {
    const l = landing.current;
    return l !== null && l.for === id && handed.current !== id ? l.id : null;
  };
  /** Where the open aims: the pressed member, the kept place, or the opened message's top less its air. */
  const openTarget = (): number | null => {
    const l = landingOf();
    if (l !== null) return seen.scrollFor(l, arrivedRef.current ? knewBox().content : undefined);
    if (place.current !== null) {
      const y = placeY(seen.layout(id), place.current, knewBox());
      /* A kept place whose message left the conversation gives way to the open's own landing. */
      if (y !== null || place.current.end === true || facts.current.has(place.current.id)) return y;
    }
    const top = shouldLand.current ? seen.topOf(opening.current.target ?? id) : null;
    return top === null ? null : top - 8;
  };
  const anchor = useMemo(
    () => createOpenAnchor({
      holding: !hasPaneScroll(scrollKey) || place.current !== null,
      applies: () => landingOf() !== null || place.current !== null || shouldLand.current,
      target: () => openTarget(),
      extent: () => knewBox(),
      scrollTo: (y) => { seen.asked(y); scrollRef.current?.scrollTo({ y, animated: false }); },
      stand: (y) => standRef.current(y),
      onPlaced: () => {
        setPlaced(true);
        /* A strip landing that needed no scroll sent no report: keep it, as `stand()` keeps a clamped one, for the next mount. */
        const l = landingOf();
        const top = l === null ? null : seen.topOf(l);
        const y = l === null ? null : seen.scrollFor(l);
        if (l === null || top === null || y === null || hasPaneScroll(scrollKey) || panePlaceOf(scrollKey) !== null) return;
        recordPaneScroll(scrollKey, startAt.y);
        recordPanePlace(scrollKey, { id: l, dy: y - top, h: seen.layout(id).find((x) => x.id === l)?.height ?? 0 });
      },
      onSettle: () => seen.poke(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seen, scrollKey],
  );
  anchorRef.current = anchor;
  useEffect(() => () => anchor.dispose(), [anchor]);
  /** The widths the view and its content were laid out at: a new one reflows every panel. */
  const widths = useRef({ view: 0, content: 0 });
  const widthSeen = (which: "view" | "content", width: number): void => {
    const was = widths.current[which];
    widths.current[which] = width;
    if (was > 0 && width > 0 && Math.abs(width - was) >= 1) { anchor.rearm(); seen.restart(); }
  };
  /** The person's drag or square: a reply sent before it moves nothing (`sent-reveal.ts`). */
  const revealHand = useRef<() => void>(() => undefined);
  const handOver = (): void => {
    revealHand.current();
    handed.current = id;
    /* The person's own scroll or press: what is drawn now is what the visit knows. */
    for (const mid of idsRef.current) knewRef.current?.add(mid);
    anchor.handOver();
    if (jumpEnd.current) { clearTimeout(jumpEnd.current); jumpEnd.current = null; }
  };
  /* A SQUARE PRESSED — the rail's or the list row's strip: that message's top to the walk's reading
     line, its square ringed until the person scrolls. */
  const jump = (mid: string): void => {
    handOver();
    seen.pin(mid);
    const y = seen.scrollFor(mid);
    if (y === null) return;
    const at = Math.min(y, Math.max(0, box.current.content - box.current.view));
    seen.asked(at);
    const end = (): void => stand(at);
    scrollRef.current?.scrollTo({ y, animated: !t.reduceMotion });
    if (t.reduceMotion) end();
    else jumpEnd.current = setTimeout(() => { jumpEnd.current = null; end(); }, RAIL_JUMP_SETTLE_MS);
  };
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  /* A MEMBER THE PHONE CANNOT DRAW AS WORDS opens alone, its html in the opened message's frame: a
     fresh open (the list row's press), read by that open's own rule, never by its card being on screen. */
  const openMember = (mid: string): void => {
    beginMark("open", mid);
    endIdleVisit(mid);
    router.push({ pathname: "/message/[id]", params: { id: mid, member: "1" } });
  };
  const pressSquare = (mid: string): void => {
    if (m?.earlier.some((h) => h.id === mid && h.wordless === true)) openMember(mid);
    else jump(mid);
  };
  /* WHERE THE PERSON STOPPED, for the list row's strip: this conversation's squares and the ring, kept
     after the reader goes. Another open replaces them; one without squares leaves no row ringed. While
     this reader shows squares, a strip press jumps it. */
  const hasRail = railItems.length > 0;
  useEffect(() => {
    if (!m || !inOhbox) return;
    if (hasRail) publishThreadPlace(railItems, here);
    else if (!threadPlace()?.items.some((it) => it.id === id)) clearThreadPlace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railItems, here, id, inOhbox, m === undefined || m === null]);
  useEffect(() => (hasRail && inOhbox ? bindThreadJump((mid) => jumpRef.current(mid)) : undefined), [hasRail, inOhbox]);

  /* THE REPLY THE PERSON SENT from the composer over this reader, shown once it is drawn (`sent-reveal.ts`): the
     one arrival that moves the reader. It answers the person's own act, so the anchor lets go as for theirs. */
  const mailRef = useRef(m);
  mailRef.current = m;
  const chromeRef = useRef(chromeOver);
  chromeRef.current = chromeOver;
  const glide = (y: number): void => {
    handOver(); // the reveal is already spent: this lets the anchor go
    seen.asked(y);
    scrollRef.current?.scrollTo({ y, animated: !t.reduceMotion });
    if (t.reduceMotion) stand(y);
    else jumpEnd.current = setTimeout(() => { jumpEnd.current = null; stand(y); }, RAIL_JUMP_SETTLE_MS);
  };
  const glideRef = useRef(glide);
  glideRef.current = glide;
  const reveal = useMemo(
    () => createSentReveal({
      members: () => (mailRef.current?.earlier ?? []).map((h) => ({ id: h.id, mine: h.mine === true, ready: h.ready === true })),
      measure: (mid) => {
        const top = seen.topOf(mid);
        const height = memberH.current.get(mid);
        return top === null || height === undefined ? null : { top, height };
      },
      view: () => ({ y: paneScrollOf(scrollKey), height: box.current.view, chrome: chromeRef.current, content: box.current.content }),
      inSight: () => shown.current && readerSees(AppState.currentState),
      scrollTo: (y) => glideRef.current(y),
    }),
    [seen],
  );
  revealHand.current = reveal.hand;
  useEffect(() => () => reveal.dispose(), [reveal]);
  const sendingFrom = useRef<string | null>(null);
  useEffect(() => onReplySend((n) => {
    if (n.phase === "pressed" && (n.parentId === id || n.parentId === newestId)) {
      sendingFrom.current = n.parentId;
      reveal.pressed();
    } else if (n.phase === "sent" && n.parentId === sendingFrom.current) {
      sendingFrom.current = null;
      reveal.sent();
    }
  }), [reveal, id, newestId]);
  useEffect(() => onReaderCover(() => reveal.poke()), [reveal]);
  useEffect(() => { reveal.poke(); });

  if (!m) {
    return (
      <Screen fullWindow={!inPane}>
        {bare ? <PaneTop /> : <DetailBar />}
        <Scroller>
          <Txt variant="note" tone="ink3" style={{ padding: 20 }}>
            {Copy.messageGone}
          </Txt>
        </Scroller>
      </Screen>
    );
  }

  // `withheld` is checked BEFORE the failure arm and never folded into it: the storage cap is an
  // answer the server gave, so "reopen to try again" would be false. See `Copy.storageEmptied`.
  // Per MARKER, and a verdict's husk outside the spam pile is text on its way — `withheldNote`.
  // Emptied for space: its own block, with Load it now (`EmptiedLetter`), in place of the note.
  const emptied = !m.protected && m.bodyState === "withheld" && !junkLeaving(m)
    && (m.bodyWithheld ?? "storage_cap") === "storage_cap";
  const loaded = emptied && liveText !== null && liveText.id === m.id ? liveText.text : null;
  const bodyNote =
    !m.protected && (m.bodyState === "snippet" || m.bodyState === "loading")
      ? Copy.liveBodyLoading
      : !m.protected && m.bodyState === "withheld" && !emptied
        ? withheldNote(m, refillExpired, mailboxStatusOf(w.mailboxes.all, m.mailboxId))
        : !m.protected && m.bodyState === "failed"
          ? Copy.liveBodyFailed
          : null;

  // A meeting invitation whose event cannot be shown — an OWA stub, or the header fact.
  const invitation = invitationNote(m);

  /** Continuity: the offset survives the remounts a posture change forces (`pane-memory`). */
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => anchor.reached(e.nativeEvent.contentOffset.y);
  const { above, below } = readerGroups(m);
  const replyId = replyMemberId(m, selectMember);
  const unplaced = shouldLand.current && anchor.holding && !placed;
  /** The opened html message's history row, when its frame found a history. */
  const openedHistory = frameHistory !== null && frameHistory.id === m.id ? frameHistory.at : null;
  const historyRow = (
    <HistoryRow open={historyFor === m.id} onToggle={() => setHistoryFor(historyFor === m.id ? null : m.id)} />
  );
  const memberEnd = (h: WorldEarlier) => <View style={{ height: 0 }} onLayout={(e) => seen.panelEnd(h.id, e.nativeEvent.layout.y)} />;
  /** A member's panel, above or below the opened message: its header, its body, its own files. */
  const memberPanel = (h: WorldEarlier, group: "above" | "below") => (
    <Panel key={h.id} radius={t.radius.card} style={{ padding: 18 }}
      onLayout={(e) => {
        seen.panel(h.id, group, e.nativeEvent.layout.y, e.nativeEvent.layout.height);
        memberH.current.set(h.id, e.nativeEvent.layout.height);
        anchor.layout();
        reveal.layout();
      }}
      {...(h.wordless ? { onPress: () => openMember(h.id) } : {})}>
      {inOhbox ? (
        <ReadTint unread={!h.seen} style={{ top: 0, left: 0, right: 0, bottom: 0, borderRadius: t.radius.card }} />
      ) : null}
      {/* Its sender line, drawn as the opened message's: who wrote it, then its title. */}
      <View
        style={{ flexDirection: "row", alignItems: "baseline", gap: 9 }}
        onLayout={(e) => seen.panelHeader(h.id, e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
      >
        {/* An unread member wears the list row's unread dot — where no tint says it. */}
        {h.seen || inOhbox ? null : (
          <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: t.c.accent, alignSelf: "center" }} />
        )}
        <Txt variant="button" style={{ flexShrink: 0, maxWidth: "60%" }} numberOfLines={1}>
          {h.sender}
        </Txt>
        {narrowFrom || !h.address ? null : (
          <Txt variant="caption" tone="ink3" numberOfLines={1} style={{ flexShrink: 1, minWidth: 0 }}>
            {h.address}
          </Txt>
        )}
        <View style={{ flex: 1 }} />
        {inOhbox && markUnreadOffered({ read: h.seen, own: h.mine === true })
          ? <MoreDots onPress={() => setMenuFor(h.id)} expanded={menuFor === h.id} /> : null}
        <Txt variant="caption" tone="ink3" tabular style={{ flexShrink: 0 }}>
          {h.time}
        </Txt>
      </View>
      {narrowFrom && h.address ? (
        <Txt variant="caption" tone="ink3" numberOfLines={1}>
          {h.address}
        </Txt>
      ) : null}
      <Txt variant="rowSubject" style={{ marginTop: 4 }}>
        {h.face ?? h.subject}
      </Txt>
      <EventCards events={h.events} style={{ marginTop: 10, marginBottom: 0 }} />
      {/* Where its body starts and ends: its first lines, with the header, are the read rule's top. */}
      <View style={{ height: 0, marginTop: 10 }} onLayout={(e) => seen.panelBody(h.id, e.nativeEvent.layout.y)} />
      {/* Its quoted history folds; its end is where its own words end, above the row. */}
      <HistoryFold foldKey={h.id} html={h.html} subject={h.subject} end={h.wordless ? null : memberEnd(h)}>
        {h.wordless ? (
          <Tap accessibilityRole="button" onPress={() => openMember(h.id)} style={{ minHeight: 44, justifyContent: "center" }}>
            <Txt variant="streamBody" tone="accent">{Copy.readerMemberAsPage}</Txt>
          </Tap>
        ) : <BodyPages variant="streamBody" tone="ink2" text={h.body} />}
      </HistoryFold>
      {/* Each member's own files: the reader's open asked for its list. */}
      <AttachmentTiles m={h} />
      {/* No words: its files are its body, so its end is below them. */}
      {h.wordless ? memberEnd(h) : null}
    </Panel>
  );

  const rail = railItems.length > 0 ? (
    <ReaderRail items={railItems} here={here} over={chromeOver} onJump={pressSquare} marks={markHold} horizontal={phoneSheet} />
  ) : null;

  return (
    <Screen fullWindow={!inPane}>
      {/* A message in one of the user's OWN folders is titled by that folder's leaf — the
          place-name fallback would say "Ohbox" about mail that is not there. A History message
          is titled History for the same reason: it presents in no pile, so `place` falls to the
          Ohbox default and would name a place this mail is not in. The row's own chip states
          where it actually is (`MailRow`, off `historyPlace`). Mail the server is HOLDING AT THE
          GATE is the third: `Place` has no Screener value, so it fell to the same Ohbox default
          over the very mail the reader is being asked to decide about (`gateHeld`). History
          first — a dormant sender's held mail is in both, and History is the surface it was
          opened from. In a PANE the list is beside this view, so the bar and its Back yield. */}
      {bare ? <PaneTop /> : (
        <DetailBar
          title={runReply ? Copy.replyLater : m.historyPlace ? Copy.history : m.gateHeld ? Copy.screener : m.folderLeaf ?? placeName(m.place)}
          backCapsule={phoneSheet}
          back={runReply?.exit}
          right={phoneSheet ? rail : undefined}
        />
      )}
      {runReply ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 14, paddingBottom: 6, alignItems: "center" }}>
          <Txt variant="rowSender">{Copy.replyRunStart}</Txt>
          <Txt variant="meta" tone="ink2" style={{ flex: 1 }}>{Copy.replyRunProgress(runReply.step, runReply.total)}</Txt>
        </View>
      ) : null}
      {/* The reader's top edge: text scrolled under the bar ends in canvas, not in sliced glyphs.
          A zero-height row drawn above the scroller, so it takes no room and no touch. A pane's
          `PaneTop` draws its own. */}
      {bare ? null : (
        <View pointerEvents="none" style={{ height: 0, zIndex: 1 }}>
          <FadeOut color={t.c.canvas} height={10} edge="top" />
        </View>
      )}
      {/* `.msg{padding:20px 20px 40px}` in the ≤900px block — the message needs
          air above the from-line, or the back bar reads as part of the mail. */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" enabled={inline !== null && Platform.OS === "ios"}>
      <View style={{ flex: 1, paddingBottom: replyKeyboardLift }}>
      <View style={{ flex: 1, flexDirection: "row" }}>
      {/* The rail follows the letters in time order. */}
      {phoneSheet ? null : rail}
      <Scroller
        key={scrollKey}
        scrollRef={scrollRef}
        avoidKeyboard={inline === null && t.mail}
        keyboardShouldPersistTaps="handled"
        contentStyle={[
          phoneSheet ? { paddingLeft: 0, paddingRight: 0 } : { paddingHorizontal: 0 },
          inline ? { paddingBottom: mailSize.inset } : null,
        ]}
        contentOffset={startAt}
        onScroll={onScroll}
        onScrollBeginDrag={() => { handOver(); seen.pin(null); markHold.drop(); }}
        onScrollEndDrag={onScroll}
        onMomentumScrollEnd={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={(cw, h) => { box.current.content = h; seen.content(h); widthSeen("content", cw); anchor.layout(); }}
        onLayout={(e) => {
          box.current.view = e.nativeEvent.layout.height;
          seen.viewport(e.nativeEvent.layout.height);
          widthSeen("view", e.nativeEvent.layout.width);
          anchor.layout();
          reveal.layout();
        }}
      >
        <View
          style={{
            paddingHorizontal: phoneSheet ? mailSize.inset : 20,
            paddingTop: phoneSheet ? mailSize.inset : 18,
            opacity: unplaced ? 0 : 1,
          }}
          onLayout={(e) => { seen.offset("padded", e.nativeEvent.layout.y); anchor.layout(); }}
        >
          {/* The members older than the addressed message stand above it. */}
          {above.length > 0 ? (
            <View style={{ marginBottom: 34, gap: 12 }} onLayout={(e) => { seen.offset("above", e.nativeEvent.layout.y); anchor.layout(); }}>
              {above.map((h) => memberPanel(h, "above"))}
            </View>
          ) : null}
          <View
            style={phoneSheet ? {
              paddingHorizontal: 20,
              paddingTop: 24,
              paddingBottom: 32,
              borderRadius: mailSize.sheetRadius,
              backgroundColor: t.c.panel,
              borderWidth: 1,
              borderColor: m.unread ? t.c.accentSoft : t.c.panel,
            } : undefined}
            onLayout={(e) => { seen.offset("opened", e.nativeEvent.layout.y, e.nativeEvent.layout.height); anchor.layout(); }}
          >
          {/* The opened message's unread tint, under its section (the Ohbox only). */}
          {inOhbox ? (
            <ReadTint unread={m.unread === true} edge={!phoneSheet} style={phoneSheet
              ? { top: 0, left: 0, right: 0, bottom: 0, borderRadius: mailSize.sheetRadius }
              : { top: -18, left: -20, right: -20, height: openedEndY + 32 }} />
          ) : null}
          {/* THE NAME IS THE FACT, THE ADDRESS THE DETAIL: the address yields first, and below 360 dp
              it takes its own line under the name, so a name is the last thing to truncate. */}
          <View
            style={{ flexDirection: "row", alignItems: phoneSheet ? "center" : "baseline", gap: phoneSheet ? 12 : 9 }}
            onLayout={(e) => seen.openedFrom(e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
          >
            {phoneSheet ? <MailAvatar person={m.from} unread={m.unread} surface={inOhbox && m.unread ? t.c.unreadWash : t.c.panel} /> : null}
            <View style={{ flex: 1, minWidth: 0, flexDirection: phoneSheet ? "column" : "row", gap: phoneSheet ? 0 : 9 }}>
              <Txt variant="rowSender" style={phoneSheet ? undefined : { flexShrink: 0, maxWidth: "60%" }} numberOfLines={1}>
                {m.from.name}
              </Txt>
              {phoneSheet || !narrowFrom ? (
                <Txt variant="caption" tone="ink2" numberOfLines={1} style={{ flexShrink: 1, minWidth: 0 }}>
                  {m.from.address}
                </Txt>
              ) : null}
            </View>
            {/* Mark unread has one home: where the bar's read slot offers it, the head has no ⋯. */}
            {!phoneSheet && inOhbox && markUnreadOffered({ read: !m.unread, own: m.ownMail === true })
              && (verbMode === "rail" || !readSlotMarksUnread(m))
              ? <MoreDots onPress={() => setMenuFor(m.id)} expanded={menuFor === m.id} /> : null}
            {phoneSheet && (m.recipients || m.html || (inOhbox && !m.unread && !m.ownMail))
              ? <MoreDots onPress={() => setMenuFor(m.id)} expanded={menuFor === m.id} /> : null}
            <Txt variant="caption" tone="ink2" tabular style={{ flexShrink: 0 }}>
              {m.time}
            </Txt>
          </View>
          {!phoneSheet && narrowFrom ? (
            <Txt variant="caption" tone="ink3" numberOfLines={1}>
              {m.from.address}
            </Txt>
          ) : null}
          {phoneSheet && m.recipients && (m.recipients.to.length > 0 || m.recipients.cc.length > 0) ? (
            <View style={{ paddingLeft: mailSize.avatar + 12, marginTop: 5, gap: 4 }}>
              <Tap accessibilityRole="button" accessibilityLabel={Copy.readerRecipientDetails}
                accessibilityState={{ expanded: detailsFor === m.id }} onPress={() => setDetailsFor(detailsFor === m.id ? null : m.id)}>
                <Txt variant="caption" tone="ink2" numberOfLines={1}>
                  {Copy.readerToLine(m.recipients.to.map((person) =>
                    w.mailboxes.ownAddresses.some((own) => own.toLowerCase() === person.address.toLowerCase())
                      ? Copy.readerMarkYou : person.name || person.address).join(", "))}
                  {m.recipients.cc.length > 0 ? ` · ${Copy.readerCcLine(m.recipients.cc.map((person) => person.name || person.address).join(", "))}` : ""}
                  {" "}<Txt variant="caption" style={{ textDecorationLine: "underline" }}>{Copy.readerDetailsShort}</Txt>
                </Txt>
              </Tap>
              {detailsFor === m.id ? (
                <View style={{ gap: 3 }}>
                  {m.recipients.to.length ? <Txt variant="caption" tone="ink2">
                    {Copy.forwardTo}{" · "}{m.recipients.to.map((person) => person.address).join(", ")}
                  </Txt> : null}
                  {m.recipients.cc.length ? <Txt variant="caption" tone="ink2">
                    {Copy.composeCc}{" · "}{m.recipients.cc.map((person) => person.address).join(", ")}
                  </Txt> : null}
                </View>
              ) : null}
            </View>
          ) : null}
          {/* THE IDENTITY FACT, under the address it is about — always drawn, never folded away, behind
              the shield the sender detail and the web draw. A check the provider failed comes first. */}
          {m.senderFailed ? (
            <View style={{ flexDirection: "row", gap: 6, marginTop: 6, alignItems: "flex-start" }}>
              <View style={{ marginTop: 2 }}>
                <Icon name="shield" size={13} color={t.c.accentInk} />
              </View>
              <Txt variant="note" tone="ink" style={{ flex: 1 }} testID="reader-sender-failed">
                {Copy.senderCheckFailed(m.from.address)}
              </Txt>
            </View>
          ) : m.senderCheck ? (
            <View style={{ flexDirection: "row", gap: 6, marginTop: 6, alignItems: "flex-start" }}>
              <View style={{ marginTop: 2 }}>
                <Icon name="shield" size={13} color={t.c.accentInk} />
              </View>
              <Txt variant="note" tone="ink" style={{ flex: 1 }} testID="reader-sender-check">
                {m.senderCheck.domainShared
                  ? Copy.senderCheckImpersonationShared(m.senderCheck.brand, m.senderCheck.domain)
                  : Copy.senderCheckImpersonation(m.senderCheck.brand, m.senderCheck.domain)}
              </Txt>
            </View>
          ) : m.senderUnverified ? (
            <View style={{ flexDirection: "row", gap: 6, marginTop: 6, alignItems: "flex-start" }}>
              <View style={{ marginTop: 2 }}>
                <Icon name="shield" size={13} color={t.c.accentInk} />
              </View>
              <Txt variant="note" tone="ink" style={{ flex: 1 }} testID="reader-sender-unverified">
                {Copy.senderCheckUnverified(m.senderUnverified.brand)}
              </Txt>
            </View>
          ) : null}

          <Txt variant="h2" style={{ marginTop: 14, marginBottom: 14 }}>
            {m.subject}
          </Txt>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, alignItems: "center", marginBottom: m.rationale || m.trackerNote || m.amount || m.mailboxLabel || m.tags?.length ? 20 : 0 }}>
            {m.rationale ? (
              <Chip icon="route" style={{ maxWidth: "100%" }}>
                {m.rationale}
              </Chip>
            ) : null}
            {m.trackerNote ? <Chip icon="shield">{m.trackerNote}</Chip> : null}
            {m.amount ? <Chip>{m.amount}</Chip> : null}
            {m.mailboxLabel ? <MailboxChip label={m.mailboxLabel} showDelivery /> : null}
            {/* The tags it carries — the row's capsules, the web reader's tag chips. */}
            {m.tags
              ? m.tags.map((tag) => (
                <TagChip key={tag.id} name={tag.name} ink={t.c.tag[tag.hue].ink} bg={t.c.tag[tag.hue].bg} />
              ))
              : null}
          </View>

          {/* Where its body starts — its first lines are the read rule's top, with the sender row. */}
          {m.protected ? <View style={{ height: 0 }} onLayout={(e) => seen.openedBody(e.nativeEvent.layout.y)} /> : null}
          {m.protected ? <ProtectedBlock label={m.protected.label} policy={m.protected.policy} /> : null}

          {!m.protected ? (
            <>
              {emptied ? (
                <EmptiedLetter
                  key={m.id}
                  messageId={m.id}
                  removed={mailboxStatusOf(w.mailboxes.all, m.mailboxId) === "disabled"}
                  onLoaded={(text) => setLiveText({ id: m.id, text })}
                  onSettings={() => router.push("/storage")}
                />
              ) : null}
              {bodyNote ? (
                <Txt variant="caption" tone="ink3" style={{ marginBottom: 10 }}>
                  {bodyNote}
                </Txt>
              ) : null}
              {invitation ? (
                <Txt variant="caption" tone="ink3" style={{ marginBottom: 10 }} testID="reader-invitation-note">
                  {invitation.line}
                  {invitation.href !== null ? (
                    <>
                      {" "}
                      <Txt
                        variant="caption"
                        tone="accent"
                        accessibilityRole="link"
                        onPress={() => {
                          const href = invitation.href;
                          if (href !== null) void openConfirmedLink(href, { openURL: (u) => Linking.openURL(u), say: toast.say });
                        }}
                      >
                        {Copy.invitationOwaOpenSetting}
                      </Txt>
                    </>
                  ) : null}
                </Txt>
              ) : null}
              {/* The invitation's event, once, above the mail (`EventCards`). */}
              <EventCards events={m.events} />
              <MailFoundEvents found={found} />
              <View style={{ height: 0 }} onLayout={(e) => seen.openedBody(e.nativeEvent.layout.y)} />
              {/* The html part renders in the frame (the web's rules, `MailBodyFrame`); the
                  text part is the fallback AND the reader's own "Show as text" choice. */}
              {m.html != null && m.html !== "" && textFor !== m.id ? (
                <>
                  {openedHistory === "leading" ? historyRow : null}
                  <MailBodyFrame m={m} onShowAsText={() => setTextFor(m.id)} highlight={eventWords}
                    onFinal={(final) => setFrameFinalFor((was) => (final ? m.id : was === m.id ? null : was))}
                    historyOpen={historyFor === m.id}
                    onHistory={(at) => setFrameHistory(at === null ? null : { id: m.id, at })} />
                  {/* Where the message's own words end: under the frame, above a trailing row. */}
                  <View style={{ height: 0 }} onLayout={(e) => seen.openedEnd(e.nativeEvent.layout.y)} />
                  {openedHistory === "trailing" ? historyRow : null}
                </>
              ) : (
                <>
                  {m.html != null && m.html !== "" ? (
                    <View style={{ flexDirection: "row", justifyContent: "flex-end", marginBottom: 10 }}>
                      <Txt variant="caption" tone="accent" onPress={() => setTextFor(null)} accessibilityRole="button">
                        {Copy.mailShowOriginal}
                      </Txt>
                    </View>
                  ) : null}
                  {/* THE READER'S SIZE, NOT THE PANE'S. On a phone the web has no reading column
                      (`AppShell.tsx`: below 900 it is hidden) — opening a message opens the READER
                      sheet at 16.5/1.78 (`reader.css:16`). This screen is that reader, so it reads
                      at `readerBody`. `msgBody` is the desktop pane's role and stays with it. */}
                  <HistoryFold foldKey={m.id} html={m.html} subject={m.subject} end={<View style={{ height: 0 }} onLayout={(e) => seen.openedEnd(e.nativeEvent.layout.y)} />}>
                    <BodyPages variant="readerBody" style={{ maxWidth: t.layout.proseMax }} text={loaded ?? m.body} highlight={eventWords} />
                  </HistoryFold>
                </>
              )}
            </>
          ) : null}
          {/* The section's foot, for the tint; a protected message's body ends here too (the body's
              own end marker reports it otherwise). */}
          <View
            style={{ height: 0 }}
            onLayout={(e) => { if (m.protected) seen.openedEnd(e.nativeEvent.layout.y); setOpenedEndY(e.nativeEvent.layout.y); }}
          />

          <AttachmentTiles m={m} />
          </View>

          {below.length > 0 ? (
            <View
              style={{ marginTop: 34, gap: 12 }}
              onLayout={(e) => { seen.offset("below", e.nativeEvent.layout.y); anchor.layout(); }}
            >
              {below.map((h) => memberPanel(h, "below"))}
            </View>
          ) : null}

        </View>
      </Scroller>
      </View>
      {inline ? (
        <View style={{
          maxHeight: replyDockMax, flexShrink: 1, paddingTop: mailSize.inset, backgroundColor: t.c.canvas,
        }}>
          <SurfaceBoundary surface="composer" frame="inline" onClose={closeReply}>
            <ComposeSheet
              m={inline.message} mode={inline.open.compose} onClose={closeReply} inline
              {...(inline.open.compose === "forward" ? { forwardConfirmed: inline.open.confirmed }
                : { draft: inline.open.draft, replyAside: inline.open.aside, offerDraftReply: inline.open.offerDraftReply })}
              keyboardHeight={replyKeyboardHeight} doneOnSend={runReply !== undefined} run={runReply}
              messageActions={{ message: m, record, onDeleted: onClose }}
            />
          </SurfaceBoundary>
        </View>
      ) : null}
      </View>
      </KeyboardAvoidingView>
      {/* A message's ⋯: Mark unread, for a read message that is not the account's own. It stays
          unread for the rest of this visit. */}
      <Sheet open={menuFor !== null} onClose={() => setMenuFor(null)} label={Copy.readerMessageActions} phoneMenu={phoneSheet}>
        {phoneSheet && menuFor === m.id && m.recipients ? (
          <SheetRow icon="person" label={Copy.readerRecipientDetails} onPress={() => {
            setMenuFor(null);
            setDetailsFor(detailsFor === m.id ? null : m.id);
          }} />
        ) : null}
        {menuFor !== m.id || (inOhbox && markUnreadOffered({ read: !m.unread, own: m.ownMail === true })) ? <SheetRow
          icon="x"
          label={Copy.actionMarkUnread}
          onPress={() => {
            const mid = menuFor;
            setMenuFor(null);
            if (mid === null) return;
            record.keepUnread(mid);
            w.actions.markSeen(mid, true);
          }}
        /> : null}
        {phoneSheet && menuFor === m.id && m.html ? (
          <SheetRow icon="reads" label={textFor === m.id ? Copy.mailShowOriginal : Copy.mailShowAsText} onPress={() => {
            setMenuFor(null);
            setTextFor(textFor === m.id ? null : m.id);
          }} />
        ) : null}
      </Sheet>
      {/* The verbs place themselves by posture (`MessageActions`): the compact glass bar at
          the thumb, the desktop ActionBar pinned at this pane's foot, or the right-edge rail.
          A confirmed delete leaves this reader at once: the tombstone already dropped the row,
          and "no longer here" over the reader's own act would read as a failure. */}
      {inline ? null : <MessageActions
        m={m}
        replyTo={replyId === id ? m : w.message(replyId) ?? m}
        onDeleted={onClose}
        onBack={onClose}
        inPane={inPane}
        record={record}
        onInlineReply={phoneSheet ? (message, open) => {
          handOver();
          setReply({ reader: id, world: w.worldKey, message, open });
        } : undefined}
      />}
    </Screen>
  );
}

/**
 * The attachment strip — the engine's own items, every name already through the
 * nameless-part fallback (`invite.ics`, never an empty label), real files first and the
 * body's own pictures after them wearing the "embedded" tag (the world sorts). A tile press
 * OPENS the bytes: one engine fetch under the server's ceiling, then the app's own preview for a
 * picture or a PDF (Share in its bar), and the platform share sheet for every other file. Each refusal renders a
 * sentence on the tile it belongs to; a silent failure here is a person pressing a dead tile.
 * The phone's one strip: the reader, each conversation member and the Screener's held mail.
 */
export function AttachmentTiles({ m }: { m: { id: string; attachments?: WorldAttachment[] } }) {
  const t = useTheme();
  const w = useWorld();
  const [busy, setBusy] = useState<string | null>(null);
  // The REFUSAL, not its sentence: a deck read held in state freezes in the language it was
  // read in; the kind is stored and the sentence resolves where it renders.
  const [note, setNote] = useState<
    | { id: string; kind: "too_large" } | { id: string; kind: "share" }
    | { id: string; kind: "failed"; fault: AttachmentFault } | null
  >(null);
  /* A picture or a PDF opens in the app's own preview; Share stands in its bar. */
  const [shown, setShown] = useState<PreviewFile | null>(null);
  // Only ever the world's list — a raw `m.attachment.filename` here would be the empty-label
  // bug this component exists to close (the world resolves every name through the fallback).
  const tiles = m.attachments ?? [];
  if (tiles.length === 0) return null;

  const open = async (id: string): Promise<void> => {
    if (busy !== null) return;
    setBusy(id);
    setNote(null);
    const got = await w.actions.openAttachmentBytes(m.id, id);
    setBusy(null);
    if (got.state === "ready" && got.preview !== null) {
      setShown({ base64: got.base64, mime: got.mime, filename: got.filename, preview: got.preview });
      return;
    }
    if (got.state === "ready") {
      const shared = await shareAttachmentBytes(got.base64, got.mime, got.filename);
      if (!shared) setNote({ id, kind: "share" });
      return;
    }
    if (got.state === "failed") setNote({ id, kind: "failed", fault: got });
    else if (got.state === "too_large") setNote({ id, kind: "too_large" });
    // No held list to read the file from: ours, and a second tap asks for it again.
    else setNote({ id, kind: "failed", fault: { code: "bytes_unavailable", retryable: true, status: null } });
  };

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 20 }}>
      {/* A TILE NEVER OUTGROWS ITS LINE: a 60-character name ran the tile past the screen's edge,
          cut mid-word with its size and its end gone. The name gives way, from the middle so the
          extension stays; the clip, the size and the tag never do. */}
      {tiles.map((a) => (
        <View key={a.id} style={{ maxWidth: "100%", flexShrink: 1 }}>
          <Tap
            accessibilityRole="button"
            accessibilityLabel={a.inline ? Copy.attachmentEmbeddedLabel(a.filename) : a.filename}
            disabled={busy !== null}
            onPress={() => void open(a.id)}
            style={[
              {
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                borderRadius: t.mail ? t.radius.row : t.radius.pill,
                backgroundColor: t.c.panel,
                paddingHorizontal: t.mail ? 8 : 15,
                paddingVertical: t.mail ? 7 : 9,
                maxWidth: "100%",
              },
              t.mail ? null : t.lift("l0"),
            ]}
          >
            {busy === a.id ? (
              <ActivityIndicator size="small" color={t.c.ink2} />
            ) : t.mail ? (
              <View style={{ width: 40, height: 38, borderRadius: 8, borderWidth: 1, borderColor: t.c.hair, alignItems: "center", justifyContent: "center", backgroundColor: t.c.panel }}>
                <Txt variant="caption" tone="ink2">{a.filename.includes(".") ? a.filename.split(".").at(-1)?.slice(0, 4).toUpperCase() : null}</Txt>
              </View>
            ) : (
              <Icon name="clip" size={13} color={t.c.ink2} />
            )}
            {t.mail ? (
              <View style={{ flexShrink: 1 }}>
                <Txt variant="button" numberOfLines={1} ellipsizeMode="middle">{a.filename}</Txt>
                {a.size ? <Txt variant="caption" tone="ink2">{a.size}</Txt> : null}
              </View>
            ) : (
              <Txt variant="button" numberOfLines={1} ellipsizeMode="middle" style={{ flexShrink: 1 }}>{a.filename}</Txt>
            )}
            {!t.mail && a.size ? (
              <Txt variant="caption" tone="ink3" style={{ flexShrink: 0 }}>
                {a.size}
              </Txt>
            ) : null}
            {a.inline ? (
              <Txt variant="caption" tone="ink3" style={{ flexShrink: 0 }}>
                {Copy.attachmentEmbedded}
              </Txt>
            ) : null}
            {t.mail ? <Icon name="attachmentDownload" size={15} color={t.c.ink2} /> : null}
          </Tap>
          {note?.id === a.id ? (
            <Txt variant="caption" tone="ink3" accessibilityRole="alert" style={{ marginTop: 4 }}>
              {note.kind === "too_large"
                ? Copy.attachmentTooLarge
                : note.kind === "share"
                  ? Copy.attachmentShareRefused
                  : attachmentFaultNote(note.fault)}
            </Txt>
          ) : null}
        </View>
      ))}
      {shown !== null ? <AttachmentPreview file={shown} onClose={() => setShown(null)} /> : null}
    </View>
  );
}

/**
 * The protected block: a tinted pool of light, no frame. Redaction dots stand
 * where a code would be, and the policy sentence is the product promise
 * verbatim — not a tooltip, not a settings row.
 */
function ProtectedBlock({ label, policy }: { label: string; policy: string }) {
  const t = useTheme();
  return (
    <View
      style={{
        borderRadius: t.radius.panel,
        backgroundColor: t.c.accentSoft,
        padding: 22,
        marginBottom: 8,
        maxWidth: 460,
      }}
    >
      <Icon name="shield" size={17} color={t.c.accentInk} />
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, marginVertical: 12 }}>
        <Txt variant="protectedCode">{Copy.protectedRedacted}</Txt>
        <Txt variant="caption" tone="ink3">
          {label}
        </Txt>
      </View>
      <Txt variant="note" tone="ink2">
        <Txt variant="settingsLabel">{Copy.protectedLead}</Txt>
        {policy.replace(/^Protected/, "")}
      </Txt>
    </View>
  );
}

const EASE = Easing.bezier(0.22, 0.61, 0.36, 1);
/** An animated rail jump is done by then (Android's smooth scroll runs about 250ms). */
const RAIL_JUMP_SETTLE_MS = 450;
/** The longest the column waits, undrawn, for the open anchor to place the opened message. */
const ANCHOR_PLACE_BOUND_MS = 400;

/**
 * THE UNREAD TINT under a message: the wash and a 3dp accent edge while unread; once read (its top
 * was on screen for the dwell) it settles over the fade; back to unread it returns quicker. Reduced
 * motion: instant.
 */
function ReadTint({ unread, style, edge = true }: { unread: boolean; style: object; edge?: boolean }) {
  const t = useTheme();
  const v = useRef(new Animated.Value(unread ? 1 : 0)).current;
  const was = useRef(unread);
  useEffect(() => {
    if (was.current === unread) return;
    was.current = unread;
    if (t.reduceMotion) { v.setValue(unread ? 1 : 0); return; }
    Animated.timing(v, {
      toValue: unread ? 1 : 0,
      duration: unread ? THREAD_UNREAD_BACK_MS : THREAD_READ_FADE_MS,
      easing: EASE,
      useNativeDriver: true,
    }).start();
  }, [unread, t.reduceMotion, v]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        style,
        { opacity: v, backgroundColor: t.c.unreadWash, borderLeftWidth: edge ? 3 : 0, borderLeftColor: t.c.accent },
      ]}
    />
  );
}

/**
 * THE RAIL — one square per message beside the reader, 22dp, in time order (oldest first, as the
 * reader draws the conversation here and the row's squares run): solid accent unread, dimmed read,
 * hollow the account's own; the current message ringed (neutral, never the accent): the engine's
 * walk, first at the top and last at the very end. A tap brings that message's top to the walk's
 * reading line and holds its ring until the person drags. It fits the reader's height less what of
 * the bottom chrome stands over it: past that a window over the conversation follows the ring
 * (`useSquaresWindow`), the squares at an edge that hides more tapered and "+N" there counting them,
 * so the ringed square is always whole in view and nothing scrolls.
 */
function ReaderRail({ items, here, over, onJump, marks, horizontal }: {
  items: readonly RailItem[];
  here: string | null;
  /** What of the bottom chrome stands over the rail's foot. */
  over: number;
  onJump: (id: string) => void;
  /** The held square: the reader's, so its own drag drops the sheet too. */
  marks: MarkHold;
  horizontal: boolean;
}) {
  const t = useTheme();
  const n = items.length;
  const [extent, setExtent] = useState<number | null>(null);
  const edge = horizontal ? mailSize.inset : RAIL_TOP;
  const win = useWindowDimensions();
  const pitch = horizontal ? 20 : RAIL_PITCH;
  const headerWidth = Math.min(win.width * 0.48, n * pitch + 2 * edge + 2);
  const room = extent === null ? null : Math.max(0, extent - (horizontal ? 2 * edge : over));
  const at = items.findIndex((it) => it.id === here);
  const run = useSquaresWindow(n, at, room === null ? null : room - (horizontal ? 0 : edge), pitch, RAIL_MORE);
  const older = run?.from ?? 0;
  const newer = run === null ? 0 : n - run.to;
  const slots = items.map((_, i) => slotOf(pitch, run?.scale[i] ?? 1));
  const ringAt = ringRest(slots, at, edge + (older > 0 ? RAIL_MORE : 0));
  /* A held square's sheet stands right of the rail under its square (over it near the foot), never on a square. */
  const { held, hold, release, drop } = marks;
  const heldAt = held === null ? -1 : items.findIndex((it) => it.id === held);
  const [sheetH, setSheetH] = useState(0);
  const more = (k: number, side: "old" | "new") => (
    <View testID={`more-${side}`} pointerEvents="none" style={{ height: horizontal ? 30 : RAIL_MORE, width: horizontal ? RAIL_MORE : undefined, flexDirection: "row" }}>
      {/* as wide as the count from the rail's start: a short one centred on the rail, "+109" runs on beside it */}
      <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, minWidth: 22, flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
        <Txt variant="caption" tone="ink3" tabular numberOfLines={1}>{Copy.rowMarksMore(k)}</Txt>
      </View>
    </View>
  );
  const squares = items.map((it, i) => (
    <Tap
      key={it.id}
      accessibilityRole="button"
      accessibilityLabel={it.kind === "mine"
        ? Copy.readerMarkMine(i + 1, n)
        : Copy.readerMarkFrom(i + 1, n, it.sender, it.kind === "unread")}
      accessibilityState={{ selected: it.id === here }}
      testID={`rail-${it.id}`}
      onPressIn={() => { if (held !== null && held !== it.id) drop(); }}
      onPress={() => { drop(); onJump(it.id); }}
      onLongPress={() => hold(it.id)}
      delayLongPress={MARK_HOLD_MS}
      onPressOut={release}
      hitSlop={RAIL_HIT_SLOP}
      style={{ height: horizontal ? 30 : slots[i], width: horizontal ? slots[i] : 22, alignItems: "center", justifyContent: "center" }}
    >
      <View
        style={{
          // never taller than its slot: a hidden square's box would take presses beside it
          width: horizontal ? Math.min(MARK_RING, slots[i]!) : MARK_RING,
          height: horizontal ? MARK_RING : Math.min(MARK_RING, slots[i]!),
          alignItems: "center", justifyContent: "center",
        }}
      >
        <MarkSquare kind={it.kind} scale={run?.scale[i] ?? 1} />
      </View>
    </Tap>
  ));
  const under = RAIL_TOP + (older > 0 ? RAIL_MORE : 0) + slots.slice(0, heldAt + 1).reduce((a, b) => a + b, 0) + 4;
  const sheetTop = room !== null && sheetH > 0 && under + sheetH > room ? Math.max(0, under - slots[heldAt]! - 8 - sheetH) : under;
  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel={Copy.readerMarksAria}
      style={horizontal ? {
        width: headerWidth, flexShrink: 1, zIndex: 2, borderRadius: t.radius.pill,
        backgroundColor: t.c.panel, borderWidth: 1, borderColor: t.c.hair,
      } : { width: 22, alignSelf: "stretch", zIndex: heldAt >= 0 ? 2 : 1 }}
      onLayout={(e) => setExtent(horizontal ? e.nativeEvent.layout.width - 2 : e.nativeEvent.layout.height)}
    >
      {/* no clip: the window fits the room, and a long count runs on over the reader's margin */}
      <View style={horizontal
        ? { paddingHorizontal: edge, flexDirection: "row", alignItems: "center", minHeight: 30 }
        : { paddingTop: edge, ...(room !== null ? { maxHeight: room } : {}) }}>
        {older > 0 ? more(older, "old") : null}
        {squares}
        {newer > 0 ? more(newer, "new") : null}
        {ringAt === null ? null : <MarkRing testID="ring-rail" along={horizontal ? "left" : "top"} at={ringAt} cross={((horizontal ? 30 : 22) - MARK_RING) / 2} />}
      </View>
      {heldAt >= 0 ? (
        <MarkSheet
          item={items[heldAt]!}
          onLayout={(e) => setSheetH(e.nativeEvent.layout.height)}
          style={horizontal
            ? { position: "absolute", right: 0, top: 38, width: Math.min(320, win.width - 24) }
            : { position: "absolute", left: 28, top: sheetTop, width: Math.min(320, win.width - 60) }}
        />
      ) : null}
    </View>
  );
}

/** A message's ⋯, beside its stamp. */
function MoreDots({ expanded, onPress }: { expanded: boolean; onPress: () => void }) {
  return (
    <Tap accessibilityRole="button" accessibilityLabel={Copy.readerMessageActions} accessibilityState={{ expanded }}
      onPress={onPress} style={{ paddingHorizontal: 4 }}>
      <Txt variant="caption" tone="ink3">⋯</Txt>
    </Tap>
  );
}

function placeName(place: "ohbox" | "reads" | "receipts"): string {
  return place === "ohbox" ? Copy.ohbox : place === "reads" ? Copy.reads : Copy.receipts;
}
