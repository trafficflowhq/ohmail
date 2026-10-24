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
import { useIsFocused } from "expo-router";
import { JUNK_REFILL_BOUND_MS, type WorldAttachment, type WorldEarlier } from "../state/live";
import { invitationNote, junkLeaving, withheldNote } from "./body-note";
import { attachmentFaultNote, type AttachmentFault } from "./attachment-fault-note";
import {
  ActivityIndicator, Animated, AppState, Easing, Linking, Platform, ScrollView, StyleSheet, useWindowDimensions, View,
  type NativeScrollEvent, type NativeSyntheticEvent,
} from "react-native";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { useBodyStamp, useFilesStamp, useWorld, useWorldToast } from "../state/world";
import { openConfirmedLink } from "../mail/frame-nav";
import { endMark } from "../engine/ui-marks";
import { shareAttachmentBytes } from "../mail/open-attachment-native";
import { Chip, Panel, Screen, Scroller, Tap, TagChip, Txt } from "./base";
import { DetailBar, PaneTop } from "./chrome";
import { Icon } from "./Icon";
import { BodyPages } from "./BodyPages";
import { HistoryFold, HistoryRow } from "./HistoryFold";
import { EventCards } from "./EventCard";
import { MailBodyFrame } from "./MailBodyFrame";
import { FadeOut } from "./FadeOut";
import { MessageActions } from "./MessageActions";
import { usePosture } from "./posture";
import { readerVerbMode } from "./reader-verbs";
import { scaffoldPlan } from "./scaffold/plan";
import { hasPaneScroll, panePlaceOf, paneScrollOf, recordPanePlace, recordPaneScroll } from "./pane-memory";
import { createOpenAnchor, placeAt, placeY, type OpenAnchor } from "./open-anchor";
import {
  THREAD_READ_FADE_MS, THREAD_TOP_LINES, THREAD_UNREAD_BACK_MS, createPhoneThreadRead,
} from "./reader-seen";
import { standsInOhboxMail } from "./pane-routes";
import { onReaderCover, readerSees, setReaderWindowFocused } from "./reader-cover";
import { Sheet, SheetRow } from "./Sheet";
import { useBottomChromeExtent } from "./bottom-chrome";
import {
  RAIL_HIT_SLOP, RAIL_TOP, arrivalsToAsk, markUnreadOffered, openedBodyFinal, railFit, railItemsOf, railOffsetFor, readerChromeOverlap,
  readerGroups, type RailItem,
} from "./reader-marks";
import { hideVisit, showVisit, visitRecordFor } from "./visit-records";
import { threadHeading } from "./thread-heading";
import { MARK_RING, MarkSquare, ringRadius } from "./MarkSquare";
import {
  bindThreadJump, clearThreadPlace, publishThreadPlace, takeThreadPending, threadPending, threadPlace,
} from "../state/thread-place";

const platformName = Platform.OS === "ios" ? ("ios" as const) : ("android" as const);

/** The window width below which the reader's from-line puts the address under the name. */
export const FROM_LINE_SPLIT_DP = 360;

export function MessageReader({
  id,
  inPane = false,
  onClose,
}: {
  id: string;
  /** Mounted beside its list — no back bar of its own; the pane or the rail carries Back. */
  inPane?: boolean;
  /** Leaves the reader: `router.back()` on the route, clearing the selection in a pane. */
  onClose?: () => void;
}) {
  const t = useTheme();
  const w = useWorld();
  /* Below 360 dp the address takes its own line under the name (`FROM_LINE_SPLIT_DP`). */
  const narrowFrom = useWindowDimensions().width < FROM_LINE_SPLIT_DP;
  // The reader draws the body, so it subscribes to it: a body landing redraws this pane alone.
  useBodyStamp();
  const m = w.message(id);
  // …and to its files and events: a list or a calendar part landing redraws the tiles and cards.
  useFilesStamp(m ? [m.id, ...m.earlier.map((h) => h.id)] : [id]);
  /* The rail carries Back where it carries the verbs (the closed Duo, the unfolded landscape):
     a detail bar above it would stand Back twice. */
  const verbMode = readerVerbMode(scaffoldPlan(usePosture(), platformName));
  const railBack = verbMode === "rail";
  const bare = inPane || railBack;
  /** "Show as text" — this reading's own choice, per message; a new open renders rich again. */
  const [textFor, setTextFor] = useState<string | null>(null);
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
  /** The message whose frame has its document's height (`MailBodyFrame`'s `onFinal`). */
  const [frameFinalFor, setFrameFinalFor] = useState<string | null>(null);
  /** The opened html message's quoted history: where its frame found one, and whether it is open. */
  const [frameHistory, setFrameHistory] = useState<{ id: string; at: "trailing" | "leading" } | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const framed = m != null && m.html != null && m.html !== "" && textFor !== m.id;
  const facts = useRef<{ inOhbox: boolean; unread: (mid: string) => boolean; ready: (mid: string) => boolean }>({
    inOhbox, unread: () => false, ready: () => false,
  });
  facts.current = {
    inOhbox,
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
  const shown = useRef(screenShown);
  shown.current = screenShown;
  /** The anchor on its way to a place: the view shows no place the person chose, so it reads nothing. */
  const anchorRef = useRef<OpenAnchor | null>(null);
  /* THE CONVERSATION'S SQUARES (the Ohbox only), and A STRIP PRESS THIS OPEN CARRIES: the list row's
     square pressed with no reader mounted opened the row and left that member pending
     (`thread-place.ts`); this reader lands on it. Read once per opened id, taken in an effect. */
  const railItems = m && inOhbox ? railItemsOf(m) : [];
  const landing = useRef<{ for: string; id: string | null } | null>(null);
  if (m && landing.current?.for !== id) {
    const p = threadPending();
    landing.current = { for: id, id: p !== null && railItems.some((it) => it.id === p) ? p : null };
  }
  const landingId = landing.current?.for === id ? landing.current.id : null;
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
      active: () => shown.current && readerSees(AppState.currentState) && anchorRef.current?.aiming !== true,
      onHere: setHere,
      start: paneScrollOf(`msg:${id}`),
    }),
    [id, record],
  );
  useEffect(() => () => seen.dispose(), [seen]);
  /* THE LANDING PIN: a fresh open rings the message it opens at (or the strip's pressed member) until
     the person's first scroll (a drag, or any scroll the app did not ask for) — the anchor's own scrolls are the app's, and the walk would ring a
     neighbour of a short opened message. A remount that resumes a remembered place walks from there. */
  const freshOpen = useMemo(() => !hasPaneScroll(`msg:${id}`), [id]);
  useEffect(() => {
    if (landingId !== null) { takeThreadPending(landingId); seen.pin(landingId); } else if (freshOpen) seen.pin(id);
  }, [seen, id, landingId, freshOpen]);
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
  /* Only what stands OVER the scroll view shortens the read zone: the compact bar stands below it. */
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
      const p = placeAt(seen.layout(id), y, box.current);
      /* Only the person's own scroll keeps the content's end; a landing keeps its message. */
      const q = p === null || !p.end || !a.holding || place.current?.end === true ? p : { id: p.id, dy: p.dy, h: p.h };
      if (q !== null) { place.current = q; recordPanePlace(scrollKey, q); }
    } else if (a !== null && place.current === null) {
      /* The open stands clamped at the end, short of its message's top: a remount (one pane to two) aims at that top again. */
      const mid = landingOf() ?? id;
      const top = seen.topOf(mid);
      const at = openTarget();
      const h = seen.layout(id).find((x) => x.id === mid)?.height ?? 0;
      if (top !== null && at !== null) recordPanePlace(scrollKey, { id: mid, dy: at - top, h });
    }
    seen.onScroll(y, jumpEnd.current !== null || anchorRef.current?.moving === true);
  };
  const box = useRef({ content: 0, view: 0 });
  /** An animated jump's last frames may never reach `onScroll`: once it is done, the reader stands where it ends. */
  const jumpEnd = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (jumpEnd.current) clearTimeout(jumpEnd.current); }, []);
  /** How many members stand above the opened message: with none, it opens at the top as before. */
  const aboveCount = useRef(0);
  /* Until the anchor has placed the opened message the column is not drawn: its first frame stands at
     the oldest member, and would flash it. A bound in case no layout ever places it. */
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setPlaced(true), ANCHOR_PLACE_BOUND_MS);
    return () => clearTimeout(t);
  }, []);
  /* THE OPEN ANCHOR (the Ohbox's time order puts the older members above the opened message): until
     the person's first drag or square, every layout that moves the opened section, the content or the
     view puts it back at the top, and keeps aiming until the view stands there (`open-anchor.ts`: a
     scroll asked on a fresh start is clamped before the members' bodies mount). Every scroll report
     goes through it: the reader stands where the view reached, never where it asked. A remembered
     offset — a fold's remount — is the person's own place and wins. */
  const standRef = useRef(stand);
  standRef.current = stand;
  const anchorFacts = useRef(() => (facts.current.inOhbox && aboveCount.current > 0 ? seen.topOf(id) : null));
  anchorFacts.current = () => (facts.current.inOhbox && aboveCount.current > 0 ? seen.topOf(id) : null);
  /** The strip's pressed member this open lands on, if any. */
  const landingOf = (): string | null => {
    const l = landing.current;
    return l !== null && l.for === id ? l.id : null;
  };
  /** Where the open aims: the pressed member, the kept place, or the opened message's top less its air. */
  const openTarget = (): number | null => {
    const l = landingOf();
    if (l !== null) return seen.scrollFor(l);
    if (place.current !== null) return placeY(seen.layout(id), place.current, box.current);
    const top = anchorFacts.current();
    return top === null ? null : top - 8;
  };
  const anchor = useMemo(
    () => createOpenAnchor({
      holding: !hasPaneScroll(scrollKey) || place.current !== null,
      start: startAt.y,
      target: () => openTarget(),
      extent: () => box.current,
      scrollTo: (y) => { seen.asked(y); scrollRef.current?.scrollTo({ y, animated: false }); },
      stand: (y) => standRef.current(y),
      onPlaced: () => setPlaced(true),
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
    if (was > 0 && width > 0 && Math.abs(width - was) >= 1) anchor.rearm();
  };
  const handOver = (): void => {
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
  /* WHERE THE PERSON STOPPED, for the list row's strip: this conversation's squares and the ring, kept
     after the reader goes. Another open replaces them; one without squares leaves no row ringed. While
     this reader shows squares, a strip press jumps it. */
  const railKey = railItems.map((it) => `${it.id}:${it.kind}:${it.sender}`).join("\n");
  const hasRail = railItems.length > 0;
  useEffect(() => {
    if (!m) return;
    if (hasRail) publishThreadPlace(railItems, here);
    else if (!threadPlace()?.items.some((it) => it.id === id)) clearThreadPlace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railKey, here, id, m === undefined || m === null]);
  useEffect(() => (hasRail ? bindThreadJump((mid) => jumpRef.current(mid)) : undefined), [hasRail]);

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
  // answer the server gave, so "reopen to try again" would be false. See `Copy.liveBodyWithheld`.
  // Per MARKER, and a verdict's husk outside the spam pile is text on its way — `withheldNote`.
  const bodyNote =
    !m.protected && (m.bodyState === "snippet" || m.bodyState === "loading")
      ? Copy.liveBodyLoading
      : !m.protected && m.bodyState === "withheld"
        ? withheldNote(m, refillExpired)
        : !m.protected && m.bodyState === "failed"
          ? Copy.liveBodyFailed
          : null;

  // A meeting invitation whose event cannot be shown — an OWA stub, or the header fact.
  const invitation = invitationNote(m);

  /** Continuity: the offset survives the remounts a posture change forces (`pane-memory`). */
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => anchor.reached(e.nativeEvent.contentOffset.y);
  /** The Ohbox draws the conversation in time order around the opened message; elsewhere it leads. */
  const { above, below } = readerGroups(m, inOhbox);
  aboveCount.current = above.length;
  /** Waiting for the open anchor: older members above, nothing remembered, not placed yet. */
  const unplaced = inOhbox && above.length > 0 && anchor.holding && !placed;
  /** The opened html message's history row, when its frame found a history. */
  const openedHistory = frameHistory !== null && frameHistory.id === m.id ? frameHistory.at : null;
  const historyRow = (
    <HistoryRow open={historyFor === m.id} onToggle={() => setHistoryFor(historyFor === m.id ? null : m.id)} />
  );
  /** A member's panel, above or below the opened message: its header, its body, its own files. */
  const memberPanel = (h: WorldEarlier, group: "above" | "below") => (
    <Panel key={h.id} radius={t.radius.card} style={{ padding: 18 }}
      onLayout={(e) => { seen.panel(h.id, group, e.nativeEvent.layout.y, e.nativeEvent.layout.height); anchor.layout(); }}>
      {inOhbox ? (
        <ReadTint unread={!h.seen} style={{ top: 0, left: 0, right: 0, bottom: 0, borderRadius: t.radius.card }} />
      ) : null}
      <View
        style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}
        onLayout={(e) => seen.panelHeader(h.id, e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
      >
        {/* An unread member wears the list row's unread dot — where no tint says it. */}
        {h.seen || inOhbox ? null : (
          <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: t.c.accent, alignSelf: "center" }} />
        )}
        <Txt variant="rowSubject" style={{ flexShrink: 1 }}>
          {h.face ?? h.subject}
        </Txt>
        <View style={{ flex: 1 }} />
        {inOhbox && markUnreadOffered({ read: h.seen, own: h.mine === true })
          ? <MoreDots onPress={() => setMenuFor(h.id)} /> : null}
        <Txt variant="caption" tone="ink3" tabular>
          {h.time}
        </Txt>
      </View>
      <EventCards events={h.events} style={{ marginTop: 10, marginBottom: 0 }} />
      {/* Where its body starts and ends: its first lines, with the header, are the read rule's top. */}
      <View style={{ height: 0, marginTop: 10 }} onLayout={(e) => seen.panelBody(h.id, e.nativeEvent.layout.y)} />
      {/* Its quoted history folds; its end is where its own words end, above the row. */}
      <HistoryFold foldKey={h.id} html={h.html} end={<View style={{ height: 0 }} onLayout={(e) => seen.panelEnd(h.id, e.nativeEvent.layout.y)} />}>
        <BodyPages variant="streamBody" tone="ink2" text={h.body} />
      </HistoryFold>
      {/* Each member's own files: the reader's open asked for its list. */}
      <AttachmentTiles m={h} />
    </Panel>
  );

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
          title={m.historyPlace ? Copy.history : m.gateHeld ? Copy.screener : m.folderLeaf ?? placeName(m.place)}
        />
      )}
      {/* The reader's top edge: text scrolled under the bar ends in canvas, not in sliced glyphs.
          A zero-height row drawn above the scroller, so it takes no room and no touch. */}
      <View pointerEvents="none" style={{ height: 0, zIndex: 1 }}>
        <FadeOut color={t.c.canvas} height={10} edge="top" />
      </View>
      {/* `.msg{padding:20px 20px 40px}` in the ≤900px block — the message needs
          air above the from-line, or the back bar reads as part of the mail. */}
      <View style={{ flex: 1, flexDirection: "row" }}>
      {/* THE RAIL OF SQUARES, in time order — the order the reader draws the conversation in here,
          and the list row's. Only in the Ohbox, and only for a conversation. */}
      {railItems.length > 0 ? (
        <ReaderRail items={railItems} here={here} over={chromeOver} onJump={jump} />
      ) : null}
      <Scroller
        key={scrollKey}
        scrollRef={scrollRef}
        contentStyle={{ paddingHorizontal: 0 }}
        contentOffset={startAt}
        onScroll={onScroll}
        onScrollBeginDrag={() => { handOver(); seen.pin(null); }}
        onScrollEndDrag={onScroll}
        onMomentumScrollEnd={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={(cw, h) => { box.current.content = h; seen.content(h); widthSeen("content", cw); anchor.layout(); }}
        onLayout={(e) => {
          box.current.view = e.nativeEvent.layout.height;
          seen.viewport(e.nativeEvent.layout.height);
          widthSeen("view", e.nativeEvent.layout.width);
          anchor.layout();
        }}
      >
        <View
          style={{ paddingHorizontal: 20, paddingTop: 18, opacity: unplaced ? 0 : 1 }}
          onLayout={(e) => { seen.offset("padded", e.nativeEvent.layout.y); anchor.layout(); }}
        >
          {/* In the Ohbox, the members older than the opened message, above it (oldest first). */}
          {above.length > 0 ? (
            <View style={{ marginBottom: 34, gap: 12 }} onLayout={(e) => { seen.offset("above", e.nativeEvent.layout.y); anchor.layout(); }}>
              {above.map((h) => memberPanel(h, "above"))}
            </View>
          ) : null}
          <View onLayout={(e) => { seen.offset("opened", e.nativeEvent.layout.y); anchor.layout(); }}>
          {/* The opened message's unread tint, under its section (the Ohbox only). */}
          {inOhbox ? (
            <ReadTint unread={m.unread === true} style={{ top: -18, left: -20, right: -20, height: openedEndY + 32 }} />
          ) : null}
          {/* THE NAME IS THE FACT, THE ADDRESS THE DETAIL: the address yields first, and below 360 dp
              it takes its own line under the name, so a name is the last thing to truncate. */}
          <View
            style={{ flexDirection: "row", alignItems: "baseline", gap: 9 }}
            onLayout={(e) => seen.openedFrom(e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
          >
            <Txt variant="button" style={{ flexShrink: 0, maxWidth: "60%" }} numberOfLines={1}>
              {m.from.name}
            </Txt>
            {narrowFrom ? null : (
              <Txt variant="caption" tone="ink3" numberOfLines={1} style={{ flexShrink: 1, minWidth: 0 }}>
                {m.from.address}
              </Txt>
            )}
            <View style={{ flex: 1 }} />
            {inOhbox && markUnreadOffered({ read: !m.unread, own: m.ownMail === true })
              ? <MoreDots onPress={() => setMenuFor(m.id)} /> : null}
            <Txt variant="caption" tone="ink3" tabular style={{ flexShrink: 0 }}>
              {m.time}
            </Txt>
          </View>
          {narrowFrom ? (
            <Txt variant="caption" tone="ink3" numberOfLines={1}>
              {m.from.address}
            </Txt>
          ) : null}
          {/* THE IDENTITY FACT, under the address it is about — always drawn, never folded away, behind
              the shield the sender detail and the web draw. */}
          {m.senderCheck ? (
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

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, alignItems: "center", marginBottom: 20 }}>
            {m.rationale ? (
              <Chip icon="route" style={{ maxWidth: "100%" }}>
                {m.rationale}
              </Chip>
            ) : null}
            {m.trackerNote ? <Chip icon="shield">{m.trackerNote}</Chip> : null}
            {m.amount ? <Chip>{m.amount}</Chip> : null}
            {/* The delivery mailbox, in the reader's own chip grammar. A DELIVERY claim off
                `mailboxId`, never a To/Cc read — this screen shows no recipients at all. */}
            {m.mailboxLabel ? (
              <Chip icon="route" style={{ maxWidth: "100%" }}>
                {Copy.deliveredTo(m.mailboxLabel)}
              </Chip>
            ) : null}
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
              <View style={{ height: 0 }} onLayout={(e) => seen.openedBody(e.nativeEvent.layout.y)} />
              {/* The html part renders in the frame (the web's rules, `MailBodyFrame`); the
                  text part is the fallback AND the reader's own "Show as text" choice. */}
              {m.html != null && m.html !== "" && textFor !== m.id ? (
                <>
                  {openedHistory === "leading" ? historyRow : null}
                  <MailBodyFrame m={m} onShowAsText={() => setTextFor(m.id)}
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
                  <HistoryFold foldKey={m.id} html={m.html} end={<View style={{ height: 0 }} onLayout={(e) => seen.openedEnd(e.nativeEvent.layout.y)} />}>
                    <BodyPages variant="readerBody" style={{ maxWidth: t.layout.proseMax }} text={m.body} />
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
              onLayout={(e) => seen.offset("below", e.nativeEvent.layout.y)}
            >
              {/* The heading over the members listed after the opened message — where it leads; in the
                  Ohbox's time order the conversation reads on without one, as the web's column. */}
              {inOhbox ? null : (
                <Txt variant="caption" tone="ink3">
                  {threadHeading(Copy, m.earlier)}
                </Txt>
              )}
              {below.map((h) => memberPanel(h, "below"))}
            </View>
          ) : null}

        </View>
      </Scroller>
      </View>
      {/* A message's ⋯: Mark unread, for a read message that is not the account's own. It stays
          unread for the rest of this visit. */}
      <Sheet open={menuFor !== null} onClose={() => setMenuFor(null)} label={Copy.readerMessageActions}>
        <SheetRow
          icon="x"
          label={Copy.actionMarkUnread}
          onPress={() => {
            const mid = menuFor;
            setMenuFor(null);
            if (mid === null) return;
            record.keepUnread(mid);
            w.actions.markSeen(mid, true);
          }}
        />
      </Sheet>
      {/* The verbs place themselves by posture (`MessageActions`): the compact glass bar at
          the thumb, the desktop ActionBar pinned at this pane's foot, or the right-edge rail.
          A confirmed delete leaves this reader at once: the tombstone already dropped the row,
          and "no longer here" over the reader's own act would read as a failure. */}
      <MessageActions m={m} onDeleted={onClose} onBack={onClose} inPane={inPane} record={record} />
    </Screen>
  );
}

/**
 * The attachment strip — the engine's own items, every name already through the
 * nameless-part fallback (`invite.ics`, never an empty label), real files first and the
 * body's own pictures after them wearing the "embedded" tag (the world sorts). A tile press
 * OPENS the bytes: one engine fetch under the server's ceiling, then the platform share
 * sheet — viewer, save and send are the platform's own routes. Each refusal renders a
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
                borderRadius: t.radius.pill,
                backgroundColor: t.c.panel,
                paddingHorizontal: 15,
                paddingVertical: 9,
                maxWidth: "100%",
              },
              t.lift("l0"),
            ]}
          >
            {busy === a.id ? (
              <ActivityIndicator size="small" color={t.c.ink2} />
            ) : (
              <Icon name="clip" size={13} color={t.c.ink2} />
            )}
            <Txt variant="button" numberOfLines={1} ellipsizeMode="middle" style={{ flexShrink: 1 }}>
              {a.filename}
            </Txt>
            {a.size ? (
              <Txt variant="caption" tone="ink3" style={{ flexShrink: 0 }}>
                {a.size}
              </Txt>
            ) : null}
            {a.inline ? (
              <Txt variant="caption" tone="ink3" style={{ flexShrink: 0 }}>
                {Copy.attachmentEmbedded}
              </Txt>
            ) : null}
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
function ReadTint({ unread, style }: { unread: boolean; style: object }) {
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
        { opacity: v, backgroundColor: t.c.unreadWash, borderLeftWidth: 3, borderLeftColor: t.c.accent },
      ]}
    />
  );
}

/**
 * THE RAIL — one square per message beside the reader, 22dp, in time order (oldest first, as the
 * reader draws the conversation here and the row's squares run): solid accent unread, dimmed read,
 * hollow the account's own; the current message ringed (neutral, never the accent): the engine's
 * walk, first at the top and last at the very end. A tap brings that message's top to the walk's
 * reading line and holds its ring until the person drags. Marks, never a count. It fits the reader's height less what of the
 * bottom chrome stands over it — closer squares first, and past that it scrolls, keeping the ringed
 * square in view — so the newest squares are never under the bar or off the screen (`railFit`).
 */
function ReaderRail({ items, here, over, onJump }: {
  items: RailItem[];
  here: string | null;
  /** What of the bottom chrome stands over the rail's foot. */
  over: number;
  onJump: (id: string) => void;
}) {
  const t = useTheme();
  const n = items.length;
  const [height, setHeight] = useState<number | null>(null);
  const room = height === null ? null : Math.max(0, height - over);
  const { pitch, scrolls } = railFit(n, room);
  const list = useRef<ScrollView>(null);
  const at = items.findIndex((it) => it.id === here);
  useEffect(() => {
    if (!scrolls || room === null || at < 0) return;
    list.current?.scrollTo({ y: railOffsetFor(at, n, pitch, room), animated: false });
  }, [scrolls, room, at, n, pitch]);
  const ring = Math.min(MARK_RING, pitch);
  const squares = items.map((it, i) => (
    <Tap
      key={it.id}
      accessibilityRole="button"
      accessibilityLabel={it.kind === "mine"
        ? Copy.readerMarkMine(i + 1, n)
        : Copy.readerMarkFrom(i + 1, n, it.sender, it.kind === "unread")}
      accessibilityState={{ selected: it.id === here }}
      testID={`rail-${it.id}`}
      onPress={() => onJump(it.id)}
      hitSlop={RAIL_HIT_SLOP}
      style={{ height: pitch, width: 22, alignItems: "center", justifyContent: "center" }}
    >
      <View
        style={{
          width: ring, height: ring, alignItems: "center", justifyContent: "center",
          borderWidth: it.id === here ? 1.5 : 0, borderColor: t.c.ink3, borderRadius: ringRadius(t.radius.focus),
        }}
      >
        <MarkSquare kind={it.kind} />
      </View>
    </Tap>
  ));
  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel={Copy.readerMarksAria}
      style={{ width: 22, alignSelf: "stretch" }}
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
    >
      {scrolls && room !== null ? (
        <ScrollView
          ref={list}
          style={{ height: room, flexGrow: 0 }}
          contentContainerStyle={{ paddingTop: RAIL_TOP }}
          showsVerticalScrollIndicator={false}
        >
          {squares}
        </ScrollView>
      ) : (
        <View style={{ paddingTop: RAIL_TOP }}>{squares}</View>
      )}
    </View>
  );
}

/** A message's ⋯, beside its stamp. */
function MoreDots({ onPress }: { onPress: () => void }) {
  return (
    <Tap accessibilityRole="button" accessibilityLabel={Copy.readerMessageActions} onPress={onPress} style={{ paddingHorizontal: 4 }}>
      <Txt variant="caption" tone="ink3">⋯</Txt>
    </Tap>
  );
}

function placeName(place: "ohbox" | "reads" | "receipts"): string {
  return place === "ohbox" ? Copy.ohbox : place === "reads" ? Copy.reads : Copy.receipts;
}
