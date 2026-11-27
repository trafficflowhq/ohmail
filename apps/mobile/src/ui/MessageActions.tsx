/**
 * The open message's verbs — the webapp action bar, in the phone's idiom. The verbs are the
 * same verbs: same names (`src/copy.ts` mirrors the webapp catalogue;
 * `test/action-parity.test.ts` derives the list from the webapp's source), same engine
 * mutations behind them (`src/state/live.ts`, mirrored from `AppShell.onMessageAction`) —
 * arranged for a thumb: the bar pins to the bottom; everything else stands in the More sheet.
 * The webapp's absence rules hold: Reply all only where `replyAllRecipients` admitted an
 * envelope, Forward always (a `no_forward` message asks once), the read slot holds one of its
 * three faces. The composer offers drafting through its paired server when the account allows it.
 */
import type { StayedWhy, RuleEntity as WorldRule } from "@ohmail/wire";
import { SCREENER_ACKNOWLEDGEMENTS } from "@ohmail/app-logic/consent/screener-acknowledgements";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ThreadRead } from "./reader-seen";
import {
  AppState, Image, Keyboard, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, TextInput, useWindowDimensions, View,
  type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ViewStyle,
} from "react-native";
import { FadeOut } from "./FadeOut";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy } from "../copy";
import { useLocale } from "../i18n/LocaleProvider";
import { useTheme } from "../theme";
import { useBottomChromeSlot } from "./bottom-chrome";
import { destLabel, DESTINATIONS, domainOf, type Destination, type Scope } from "../state/model";
import {
  calendarDayLabel,
  dayAt,
  dayAtHour,
  dayNine,
  effectiveSignature,
  effectiveSignatureHtml,
  forwardOffered,
  forwardSubject,
  moveTargetsFor,
  moveTargetLabel,
  pickFloor,
  keptRecipients,
  typedRecipients,
  type WorldDraftEdit,
  parseRecipients,
  readerZone,
  replySubject,
  resurfaceClock,
  resurfaceHorizons,
  resurfaceTimeLabel,
  RESURFACE_HOURS,
  sizeLabel,
  draftLimitLabel,
  draftOverCeiling,
  scheduleLabel,
  SEND_LATER_MIN_LEAD_MS,
  SIG_FOLLOWING,
  horizonDays,
  horizonHours,
  inSendLaterHorizon,
  sendLaterHorizon,
  todayEvening,
  sendLaterMornings,
  SMALL_HOURS_END,
  type ForwardAsk,
  type ResurfaceHorizon,
  type SignatureState,
  type WorldMail,
  type WorldTag,
  folderName,
  type ConflictGroup,
  type PressForecast,
  connectionSaid,
  type FailedSendCopy,
  type DraftKeep,
  ruleMatchKey,
  isSharedProviderDomain,
} from "../state/live";
import { useWorld, useWorldToast } from "../state/world";
import { BAR, PILL, compactFit } from "./action-bar-layout";
import { Button, Rule, Tap, Txt } from "./base";
import { GlassActionBar, GlassPill, nextRoom, type BarVerbSpec } from "./glass";
import { mailColors, mailSize } from "../theme/mail";
import type { RailAction } from "./glass/GlassRail";
import { useAppWindow, usePosture } from "./posture";
import { readerBarClearance, scaffoldPlan, screenHingeClearance, screenSideInsets } from "./scaffold/plan";
import { publishReaderRail } from "./reader-rail";
import {
  readerPaneWidth,
  readerVerbMode,
  readerVerbPlacement,
  railReaderGroups,
  type ReaderVerbFacts,
  type ReaderVerbId,
  type ReaderVerbMode,
} from "./reader-verbs";
import { Icon, NavigationIcon, type IconName } from "./Icon";
import { scheduledNotHereSentence, sendLaterOffered } from "./standalone-form";
import { noneOrganizedWhy } from "./not-organizing";
import { useNetworkNow } from "../net/network-door";
import { queuedCaptionKey } from "../engine/send-waits";
import {
  admitPicked,
  attachPreview,
  attachThumb,
  forwardCaps,
  shrinkPicked,
  phoneAttachCap,
  phoneSendNeedsContent,
  toComposeAttachments,
  type AttachPickOutcome,
  type PhoneComposeAttachment,
} from "../compose/attach";
/* The expo pickers — a `*-native.ts` twin the suite never imports; every rule is in attach.ts. */
import { PhoneDrafter } from "./PhoneDrafter";
import { hasEnvelopeEdits, wordsOf, type ReplyEdits } from "../compose/letter-store";
import { editRuns, markupOf, runsOf, toggleMark, type Mark, type Run } from "../compose/formatting";
import { COMPOSE_EMOJI } from "@ohmail/app-logic/write/emoji";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { nativeAttachPicker, nativeImageShrink } from "../compose/attach-native";
import { shareAttachmentBytes } from "../mail/open-attachment-native";
import { AttachmentPreview, type PreviewFile } from "./AttachmentPreview";
import { letterSession, openLetterKeeper, type LetterKeeper } from "../compose/letter-keeper";
import { KEPT_FILES_MAX_BYTES } from "../compose/letter-store";
import { forwardFilesPlan } from "../compose/forward-files";
import { sayRefusal, type Refusal } from "../refusal";
import { usePrefs } from "../state/store";
import { refusalSentence, type DraftDiscardRefusal } from "./draft-card";
import { cancelAct, cancelSendOffered, cancelSendPress, keptSay, waitingRowOf } from "./send-cancel";
import { autosaveKeep, baseAfter, baseFor, keepAct, unmountKeep, waitedFor, worthKeeping, type DraftBase } from "./compose-keep";
import { composeFromOf } from "./compose-sender";
import { editWhileIdle } from "./compose-edit";
import { copiesOffered, copiesShown, copiesToKeep, copiesToSend, type TypedCopies } from "./compose-copies";
import { ComposeCopies } from "./ComposeCopies";
import { ComposeSignature } from "./ComposeSignature";
import { composeLabelWidth, composeLine, RecipientInput, stepBack, type BackStep } from "./RecipientInput";
import type { MailtoPrefill } from "./mailto";
import { diagStrip } from "./help-contact";
import { Segmented } from "./Segmented";
import { Sheet, SheetBackdrop, SheetRow, useModalKey, useSheetPanelBounds, useSheetRoom } from "./Sheet";
import { useSheetAnchor } from "./sheet-anchor";
import { useFocusKeeper } from "./keep-focus";
import { showKeyboardWhenFocused } from "./keyboard-native";
import { composeBodyHeight, composeBodyMin, letterRunsOn, notesMeasured, notesPinned, pinnedNotesMax } from "./compose-fit";
import { SurfaceBoundary } from "./ErrorBoundary";
import { heldSheetFooter, sendPressAct } from "./send-press";
import { sendAgainSentence, type DraftSendAgainRefusal } from "./draft-card";
import { holdReader, holdWhileOpen } from "./reader-held";
import { ATTACH_ROW_GAP, attachHintFits, attachHintStyle } from "./attach-hint";
import { changedElsewhere, failedSendLine } from "./send-failed";
import { stayedRows } from "./sender-stayed-lines";
import { keyboardLift, useKeyboardHeight } from "./keyboard-lift";
import { conversationUnreadIds } from "./read-slot";
import { useReaderCover } from "./reader-cover";
import { replyOpen, type InlineComposeOpen } from "./compose-route";
import { noteReplySend } from "./sent-reveal";

/**
 * One pick's verdicts, held as KINDS — the sentence is derived where it is shown, so a refusal
 * on screen follows a later language switch (`refusal.test.ts`). `filenames` is data.
 */
type AttachNote =
  | { kind: "overCap" }
  | { kind: "duplicates"; filenames: string }
  | { kind: "unreadable" }
  | { kind: "unavailable" };

/** Which surface is up. One at a time — a union, so two sheets cannot stack. */
type Open =
  | null
  | "more"
  | "resurface"
  | "pick"
  | "time"
  | "move"
  | "tag"
  | "screening"
  | "delete"
  | "forward-ask"
  | InlineComposeOpen;

/** The ask's reason, read at render time so it follows the app's language. */
export function forwardAskSentence(ask: ForwardAsk): string {
  switch (ask) {
    case "otp": return Copy.forwardAskOtp;
    case "verification": return Copy.forwardAskVerification;
    case "password_reset": return Copy.forwardAskPasswordReset;
    case "security_alert": return Copy.forwardAskSecurityAlert;
    case "sensitive": return Copy.forwardAskSensitive;
  }
}

/** The reader's verb surface, by posture and by the width the reader stands in (`readerPaneWidth`). */
export function useReaderVerbMode(inPane: boolean): ReaderVerbMode {
  const posture = usePosture();
  const plan = scaffoldPlan(posture, Platform.OS === "ios" ? "ios" : "android");
  const win = useAppWindow();
  const insets = useSafeAreaInsets();
  return readerVerbMode(plan, readerPaneWidth(posture, plan, { w: win.width, h: win.height }, insets, inPane));
}

type InlineMessageMore = {
  render: (rows: ReactNode) => ReactNode;
  close: () => void;
  afterClose: (press: () => void) => void;
  hasWriterFocus: () => boolean;
  restoreWriterFocus: () => void;
};

export function MessageActions({
  m,
  replyTo = m,
  onDeleted,
  onBack,
  inPane = false,
  record,
  onInlineReply,
  inlineMore,
}: {
  m: WorldMail;
  replyTo?: WorldMail;
  onInlineReply?: (message: WorldMail, reply: InlineComposeOpen) => void;
  inlineMore?: InlineMessageMore;
  /** The reader's visit: a Mark unread here keeps the message unread for it, a Mark read lets go. */
  record?: ThreadRead;
  /** Drawn in the list-detail pair's reading pane, which already starts past the rail. */
  inPane?: boolean;
  /**
   * Leaves the reader when a confirmed delete COMMITS — the window's close, not the press. The
   * delete opens an 8 s undo window and the tombstone drops only at its end, so the reader stays
   * over the pill for the window (like every other verb; navigating away at the press killed the
   * pill's surface — the device defect the 0.20 review found) and this fires when the delete actually lands.
   */
  onDeleted?: () => void;
  /** Closes the reader — the rail's Back on the unfolded-landscape Duo presses this. */
  onBack?: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const w = useWorld();
  /* The resurface chooser's day rows are named by `Intl`, so this bar needs the language as a
     value and not only as a subscription. */
  const locale = useLocale();
  const [open, setPanel] = useState<Open>(null);
  const [dismissing, setDismissing] = useState<Open>(null);

  // A message swap must not leave a sheet open over a different message's verbs — the same
  // reset the webapp's pane applies to its panels.
  useEffect(() => {
    setPanel(null);
    setDismissing(null);
  }, [m.id, w.worldKey]);
  /* A sheet or composer open here holds the fold/unfold move until it closes (`reader-held.ts`). */
  const holdToken = useRef(Symbol("reader")).current;
  const holding = open !== null;
  useEffect(() => {
    holdReader(holdToken, holding);
    return () => holdReader(holdToken, false);
  }, [holdToken, holding]);

  const a = w.actions;
  const close = () => {
    if (open === null) inlineMore?.close();
    else if (inlineMore?.hasWriterFocus()) {
      if (Platform.OS === "ios") setDismissing(open);
      else requestAnimationFrame(inlineMore.restoreWriterFocus);
    }
    setPanel(null);
  };
  const restoreOnDismiss = () => {
    setDismissing(null);
    inlineMore?.restoreWriterFocus();
  };

  /* The reader may leave (the delete committed) OR be gone already (the person backed out during
     the window). The window still commits the delete either way; only the NAVIGATION is guarded,
     so a commit after the reader is gone does not over-pop a screen it no longer owns. */
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const shown = useRef({ letter: m, world: w.worldKey, draftReplies: w.draftReplies });
  shown.current = { letter: m, world: w.worldKey, draftReplies: w.draftReplies };
  const setOpen = (next: Exclude<Open, null>) => {
    if (!inlineMore || open !== null) { setPanel(next); return; }
    const { letter, world } = shown.current;
    inlineMore.afterClose(() => {
      if (mounted.current && shown.current.letter.id === letter.id && shown.current.world === world) setPanel(next);
    });
  };

  const trash = () => {
    close();
    a.deleteMessage(m.id, { onCommitted: () => { if (mounted.current) onDeleted?.(); } });
  };
  const requestTrash = () => {
    const acknowledged = w.screenerConfirmation?.acknowledged ?? 0;
    if ((acknowledged & SCREENER_ACKNOWLEDGEMENTS.moveToTrash) !== 0) trash();
    else setOpen("delete");
  };

  /** Every Reply and Reply all press: a kept reply is resumed, or said to be in Drafts (`replyOpen`). */
  const availableReply = useRef(replyTo);
  availableReply.current = replyTo;
  const replyTarget = useRef(replyTo);
  const openReply = (all: boolean, offerDraftReply?: true) => {
    if (offerDraftReply && (shown.current.world !== w.worldKey || shown.current.letter.id !== m.id
      || shown.current.draftReplies !== true)) return;
    const replyTo = availableReply.current;
    replyTarget.current = replyTo;
    const next = replyOpen(a.keptReply(replyTo.id), all ? "replyAll" : "reply");
    if (offerDraftReply) next.offerDraftReply = true;
    if (onInlineReply) {
      close();
      onInlineReply(replyTo, next);
    } else {
      setOpen(next);
    }
  };
  const showForward = (confirmed?: boolean) => {
    const next = { compose: "forward" as const, confirmed };
    if (onInlineReply) {
      close();
      const letter = shown.current.letter;
      onInlineReply(w.message(letter.id) ?? letter, next);
    } else {
      setOpen(next);
    }
  };

  /**
   * Forward is always offered (`forwardOffered`). A row the mirror does not hold has its body read
   * through the reader's door first (`forwardFetch`), and a `no_forward` message asks once. A read
   * that settles after the reader moved to another message opens nothing.
   */
  const openForward = () => {
    const id = m.id;
    const ask = m.forwardAsk;
    const go = () => {
      if (onInlineReply && !ask) showForward();
      else setOpen(ask ? "forward-ask" : { compose: "forward" });
    };
    const reading = a.forwardFetch(id);
    if (reading === null) { go(); return; }
    void reading.then(() => {
      if (mounted.current && shown.current.letter.id === id && shown.current.world === w.worldKey) go();
    });
  };

  /**
   * WHICH PRESENTATION THIS POSTURE TAKES (`reader-verbs.ts`, the census-walked model): the
   * phone's compact bar (also on a reading pane under 560 dp), the desktop ActionBar pinned at
   * the reading pane's foot (owner rule 4 — iPad and Android two-pane, a wide pane), or the
   * right-edge rail on the unfolded-landscape Duo. Junk has no row verb on the ActionBar —
   * the desktop's own design; it stays behind Move — and only the rail carries it directly.
   */
  const posture = usePosture();
  const plan = scaffoldPlan(posture, Platform.OS === "ios" ? "ios" : "android");
  const mode = useReaderVerbMode(inPane);
  const paperMenu = t.mail === true && (mode === "compact" || inlineMore !== undefined);
  const canDraftReply = paperMenu && w.draftReplies === true;
  const barRail = readerBarClearance(plan, inPane);
  const barSide = screenSideInsets(insets, inPane);
  const barHinge = screenHingeClearance(posture, plan, !inPane, inPane, useAppWindow().width);
  /* This bar stands at the foot, so it reports how far up it reaches and the toast clears it
     (`bottom-chrome.ts`); on the rail postures nothing stands here and the slot says so. */
  const standing = useBottomChromeSlot("reader-bar");
  useEffect(() => {
    if (mode === "rail") standing(null);
  }, [mode, standing]);
  const facts: ReaderVerbFacts = {
    canReplyAll: replyTo.canReplyAll === true,
    forwardOffered: forwardOffered(m),
    junkOffered: moveTargetsFor(m).includes("spam"),
    // No Screening press on the account's own mail: it would be a rule about our own address.
    screeningOffered: m.ownMail !== true,
  };
  const placement = readerVerbPlacement(mode, facts);
  const toggleFiling = (kind: "replyLater" | "setAside") =>
    a.pileToggle(m.id, kind);
  const filingHold = m.pendingReplyCopy ? { disabled: true, accessibilityHint: Copy.replyCopyWaiting } : undefined;
  const filingStatus = filingHold ? (
    <View style={{ alignItems: "center" }} accessibilityLiveRegion="polite">
      <Txt variant="note">{Copy.replySending}</Txt>
      <Txt variant="note" tone="ink2">{Copy.replyCopyWaiting}</Txt>
    </View>
  ) : null;

  /* ── THE COMPACT BAR IS ONE ROW, AND IT MEASURES BEFORE IT SHOWS ────────────────────────────
     A hidden copy of Reply and every capsule reports its width; the wrapper reports the room.
     `compactFit` admits the verbs that fit in row order and the tail goes behind ⋯ — a second
     row of capsules stood over the message on the iPhone 18 Pro, and a scroller before it cut
     the fourth verb mid-glyph. Until both readings are in, the floor stands (Reply and ⋯) and
     every verb is in the sheet: a bar with nothing measured must not guess. */
  const [compactRoom, setCompactRoom] = useState<number | null>(null);
  const [compactWidths, setCompactWidths] = useState<Record<string, number> | null>(null);
  const measuredWidths = useRef<Record<string, number>>({});
  const compactRow = mode !== "compact" ? [] : ([
    { id: "later" as const, label: Copy.actionLater, icon: (t.mail ? "hourglass" : "clock") as IconName,
      on: m.pile === "reply_later", onPress: () => toggleFiling("replyLater"), ...filingHold },
    { id: "aside" as const, label: Copy.actionSetAside, icon: "pause" as IconName,
      on: m.pile === "set_aside", onPress: () => toggleFiling("setAside"), ...filingHold },
    /* Resurface asks "when?" — except on a message already scheduled, where the press is the
       webapp's horizon-less toggle: it clears the booking rather than re-dating it. */
    { id: "resurface" as const, label: Copy.actionResurface, icon: "up" as IconName,
      on: m.pile === "bubbled_up",
      onPress: () => (m.pile === "bubbled_up" ? a.resurfaceToggle(m.id) : setOpen("resurface")) },
  ]).filter((v) => placement.standing.includes(v.id));
  /* FORWARD BESIDE REPLY (the compact bar's lead): measured as its word and as its icon; it folds
     into ⋯ only where that lets a horizon stand (`compactFit`). */
  const forwardStands = mode === "compact" && placement.standing.includes("forward");
  const recordWidth = (id: string) => (e: LayoutChangeEvent) => {
    measuredWidths.current[id] = e.nativeEvent.layout.width;
    if (Object.keys(measuredWidths.current).length >= compactRow.length + 1 + (forwardStands ? 2 : 0)) {
      setCompactWidths({ ...measuredWidths.current });
    }
  };
  const barFit = compactFit({
    verbs: [...(forwardStands ? ["forward"] : []), ...compactRow.map((v) => v.id)],
    widths: compactWidths,
    room: compactRoom,
    ...(forwardStands ? { lead: "forward" } : {}),
  });
  /* A folded verb is in the sheet, so the row and ⋯ together always carry the whole set. */
  const moreHas = (id: ReaderVerbId) =>
    inlineMore
      ? id !== "replyAll" && id !== "forward" && (id !== "screening" || facts.screeningOffered)
      : placement.behindMore.includes(id) || barFit.overflow.includes(id);

  /**
   * The one three-faced read slot — the webapp's read switch, never empty and never two. Mark as
   * read takes the CONVERSATION on screen (`conversationUnreadIds`) in one deliberate write with
   * one Undo; Mark unread stays this message alone.
   */
  const unreadIds = conversationUnreadIds(m);
  /* The person's own read lets the visit's keeps go; their Mark unread keeps it for the visit. */
  const markRead = (): void => {
    for (const id of unreadIds) record?.release(id);
    a.markSeen(unreadIds[0]!, false, unreadIds, m.id);
  };
  const markUnread = (): void => {
    record?.keepUnread(m.id);
    a.markSeen(m.id, true);
  };
  const readFace =
    m.pile === "resurfaced"
      ? { icon: "check" as IconName, label: Copy.actionDone, press: () => a.resurfaceDone(m.id) }
      : unreadIds.length > 0
        ? { icon: "check" as IconName, label: Copy.actionMarkRead, press: () => markRead(), a11y: Copy.actionMarkReadCount(unreadIds.length) }
        : { icon: "x" as IconName, label: Copy.actionMarkUnread, press: () => markUnread() };

  /* THE RAIL CLAIM (unfolded-landscape Duo): the reader's verbs ride the ONE right-edge rail —
     back · reply · reply all · forward, Done · Park · Junk, ⋯ (prototype v5, Mail's order) —
     published to the store the rail's renderer reads, released on unmount so the destinations
     return the moment no message is open. Handlers close over THIS render; the deps re-publish
     whenever a label, face or admission changes (the locale re-reads the deck's getters). */
  const pile = m.pile;
  const unread = m.unread;
  /* The face key: the rail re-publishes when a sibling flips, never holding a stale press. */
  const unreadKey = unreadIds.join(",");
  useEffect(() => {
    if (mode !== "rail" || inlineMore) return;
    const core = (id: ReaderVerbId): RailAction => {
      switch (id) {
        case "reply":
          return { id, icon: "reply", label: Copy.actionReply, accent: true, fixed: true, onPress: () => openReply(false) };
        case "replyAll":
          return { id, icon: "replyall", label: Copy.actionReplyAll, onPress: () => openReply(true) };
        case "forward":
          return { id, icon: "fwd", label: Copy.actionForward, onPress: openForward };
        case "read":
          return { id, icon: readFace.icon, label: readFace.label, onPress: readFace.press };
        case "aside":
          return { id, icon: "pause", label: Copy.actionSetAside, on: pile === "set_aside", onPress: () => toggleFiling("setAside"), ...filingHold };
        default:
          // later/resurface/tag/screening/move/delete live behind ⋯ on the rail (`RAIL_MORE`).
          return { id, icon: "more", label: Copy.actionMore, onPress: () => setOpen("more") };
      }
    };
    const entry = (id: ReturnType<typeof railReaderGroups>[number][number]): RailAction =>
      id === "back"
        ? { id, icon: "back", label: Copy.back, fixed: true, onPress: onBack }
        : id === "junk"
          ? { id, icon: "junk", label: moveTargetLabel("spam"), onPress: () => void a.move(m, "spam") }
          : id === "more"
            ? { id, glyph: "⋯", label: Copy.actionMore, fixed: true, onPress: () => setOpen("more") }
            : core(id);
    publishReaderRail(railReaderGroups(facts).map((g) => g.map(entry)));
    return () => publishReaderRail(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, m.id, pile, unread, unreadKey, facts.canReplyAll, facts.forwardOffered, m.forwardAsk, facts.junkOffered, locale, onBack, inlineMore !== undefined, m.pendingReplyCopy]);

  /**
   * THE HOUR THE CHOOSER IS ASKING ABOUT (mail 0110) — the account's stored time, or the
   * product's 09:00 when there is none, as a `'HH:MM'` that is always real. A local override
   * stands only while the sheet is up: a time picked and then abandoned is not an answer, so it
   * is dropped on close and only a pressed horizon writes the account's default.
   */
  const storedClock = resurfaceClock(w.resurfaceTime);
  const storedHhmm = resurfaceTimeLabel(storedClock.hour, storedClock.minute);
  const [pickedTime, setPickedTime] = useState<string | null>(null);
  const resurfaceTime = pickedTime ?? storedHhmm;
  /**
   * A DATED ANSWER — dispatch it, then remember the hour it was given at, in that order: the
   * message was the ask and the default is a courtesy, so a refused write leaves a correctly
   * scheduled message behind. Nothing is written when the hour is the one already stored, and
   * "Now" never reaches here — it is a state, not a date, and no time can apply to it.
   */
  const pickResurface = (when: ResurfaceHorizon): void => {
    const chosen = resurfaceTime;
    close();
    setPickedTime(null);
    void a.resurfaceAt(m.id, when.at.toISOString());
    if (chosen !== storedHhmm) void w.remember(chosen).catch(() => undefined);
  };
  /**
   * THE TWO DATED HORIZONS, composed where the rows can read them: each carries the wall clock it
   * will actually book, so a row states 03:30 on the night the clocks skip the chosen 02:30 —
   * and {@link SkipNote} says why, before the press. The repeated-hour night books the time that
   * was asked for (the earlier of the two), so it earns no sentence.
   */
  /* Per reader day and chosen hour, not per render: the reader re-renders on every body and bar change. */
  const today = new Date();
  // The small hours are their own key: "Tomorrow" is the coming morning until 05:00.
  const horizonDay = (today.getFullYear() * 10_000 + today.getMonth() * 100 + today.getDate()) * 2
    + (today.getHours() < SMALL_HOURS_END ? 1 : 0);
  // On a Sunday after the small hours Next week is Tomorrow's Monday, so it is not offered.
  const { tomorrow, nextWeek } = useMemo(
    () => resurfaceHorizons(new Date(), resurfaceTime),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resurfaceTime, horizonDay],
  );

  /**
   * The ActionBar's verb capsules (mode "bar") — the webapp's `BAR_VERB_ORDER` arrives through
   * `placement.standing`; the segments (defer, file) abut exactly as the desktop's do. The
   * handlers are the SAME handlers the compact bar and the sheets press — one verb, one act.
   */
  const barSpec = (id: ReaderVerbId): BarVerbSpec => {
    switch (id) {
      case "replyAll": return { id, label: Copy.actionReplyAll, onPress: () => openReply(true) };
      case "forward": return { id, label: Copy.actionForward, iconFace: "fwd", onPress: openForward };
      case "later": return { id, icon: t.mail ? "hourglass" : "clock", label: Copy.actionLater, seg: "defer", onPress: () => toggleFiling("replyLater"), ...filingHold };
      case "aside": return { id, icon: "pause", label: Copy.actionSetAside, seg: "defer", onPress: () => toggleFiling("setAside"), ...filingHold };
      case "resurface": return { id, icon: "up", label: Copy.actionResurface, seg: "defer", onPress: () => (m.pile === "bubbled_up" ? a.resurfaceToggle(m.id) : setOpen("resurface")) };
      case "tag": return { id, icon: "tag", label: Copy.actionTag, onPress: () => setOpen("tag") };
      case "screening": return { id, icon: "door", label: Copy.actionScreening, seg: "file", onPress: () => setOpen("screening") };
      case "move": return { id, icon: "ohbox", label: Copy.actionMove, seg: "file", onPress: () => setOpen("move") };
      case "delete": return { id, icon: "trash", label: Copy.actionDelete, onPress: requestTrash };
      // reply and read ride their own slots on the bar; they never reach this map.
      default: return { id, label: Copy.actionReply, onPress: () => openReply(false) };
    }
  };
  const barVerbs: BarVerbSpec[] =
    mode === "bar" ? placement.standing.filter((v) => v !== "reply" && v !== "read").map(barSpec) : [];
  const barExtraMore: BarVerbSpec[] = mode === "bar" ? placement.behindMore.map(barSpec) : [];
  const parkRow = moreHas("aside") ? (
    <SheetRow
      icon="pause"
      navigationIcon={paperMenu ? "parked" : undefined}
      label={Copy.actionSetAside}
      on={m.pile === "set_aside"}
      {...filingHold}
      onPress={() => { close(); toggleFiling("setAside"); }}
    />
  ) : null;

  const messageRows = (
    <>
      {moreHas("later") ? (
        <SheetRow
          icon="clock"
          navigationIcon={paperMenu ? "later" : undefined}
          label={Copy.actionLater}
          on={m.pile === "reply_later"}
          {...filingHold}
          onPress={() => { close(); toggleFiling("replyLater"); }}
        />
      ) : null}
      {paperMenu ? parkRow : null}
      {moreHas("resurface") ? (
        <SheetRow
          icon="up"
          navigationIcon={paperMenu ? "resurface" : undefined}
          label={Copy.actionResurface}
          on={m.pile === "bubbled_up"}
          onPress={() => {
            if (m.pile === "bubbled_up") {
              close();
              a.resurfaceToggle(m.id);
            } else setOpen("resurface");
          }}
        />
      ) : null}
      {paperMenu ? null : parkRow}
      {moreHas("tag") ? <SheetRow icon="tag" label={Copy.actionTag} onPress={() => setOpen("tag")} /> : null}
      {moreHas("screening") ? (
        <SheetRow icon="door" navigationIcon={paperMenu ? "screener" : undefined}
          label={Copy.actionScreening} onPress={() => setOpen("screening")} />
      ) : null}
      {moreHas("move") ? (
        <SheetRow icon="ohbox" navigationIcon={paperMenu ? "move" : undefined}
          label={Copy.actionMove} onPress={() => setOpen("move")} />
      ) : null}
      {moreHas("read") && !paperMenu ? <Rule inset={14} /> : null}
      {/* One slot, three faces — the webapp's read switch, never empty and never two. */}
      {moreHas("read") ? (
        m.pile === "resurfaced" ? (
          <SheetRow icon="check" label={Copy.actionDone} onPress={() => { close(); a.resurfaceDone(m.id); }} />
        ) : unreadIds.length > 0 ? (
          <SheetRow icon="check" label={Copy.actionMarkRead} onPress={() => { close(); markRead(); }} />
        ) : (
          <SheetRow icon="x" navigationIcon={paperMenu ? "unread" : undefined}
            label={Copy.actionMarkUnread} onPress={() => { close(); markUnread(); }} />
        )
      ) : null}
    </>
  );
  const deleteRow = <SheetRow icon="trash" navigationIcon={paperMenu ? "trash" : undefined}
    label={Copy.actionDelete} onPress={requestTrash} />;
  const moreRule = paperMenu
    ? <Rule inset={mailSize.menuRowInset} style={{ height: 1, marginVertical: mailSize.rowInset }} />
    : <Rule inset={14} />;

  return (
    <>
      {inlineMore ? inlineMore.render(<>{filingStatus}{messageRows}{moreRule}{deleteRow}</>) : mode === "bar" ? (
        /* The desktop reader's ActionBar in the glass grammar, pinned at the READING PANE's
           foot (owner rule 4) and floating over the scroll — the Scroller's tab clearance
           already keeps the last lines readable above it. */
        <View
          pointerEvents="box-none"
          onLayout={(e) => standing(Math.max(insets.bottom, 12) + e.nativeEvent.layout.height)}
          style={{
            position: "absolute",
            /* A full-window reader beside the rail starts past the rail's column, from the same
               clearance `Screen` reads; the pane of a pair already does. */
            left: barRail.left,
            right: barRail.right,
            bottom: Math.max(insets.bottom, 12),
            alignItems: "center",
            zIndex: t.zLayer.tabBar,
          }}
        >
          {filingStatus}
          <GlassActionBar
            reply={{ label: Copy.actionReply, onPress: () => openReply(false) }}
            verbs={barVerbs}
            readSwitch={{ label: readFace.label, icon: readFace.icon, onPress: readFace.press, a11yLabel: "a11y" in readFace ? readFace.a11y : undefined }}
            floor={["forward"]}
            extraMore={barExtraMore}
          />
        </View>
      ) : mode === "rail" ? filingStatus : (
      /* The compact bar, in the glass material (owner: one look on every device) — the same
         verbs and More it always carried, on ONE row; only the slab became the translucent pill. */
      <View
        pointerEvents="box-none"
        // This view ends at the window's foot, so its own height is how far the bar reaches —
        // and its WIDTH is the room the verbs are admitted against (`nextRoom`: a zero reading
        // is a layout in flight, not a room, so a transient 0 cannot fold a standing bar).
        onLayout={(e) => {
          /* READ THE POOLED EVENT HERE, NOT IN THE UPDATER. React Native nulls `nativeEvent`
             when the handler returns, and a state updater runs after it — the same read that
             aborted the app from `GlassActionBar`. */
          const { height, width } = e.nativeEvent.layout;
          standing(height);
          setCompactRoom((r) => nextRoom(r, width));
        }}
        style={{
          position: "absolute",
          left: Math.max(barSide.left + barRail.left, barHinge.left),
          right: Math.max(barSide.right + barRail.right, barHinge.right),
          bottom: 0,
          paddingHorizontal: BAR.outerPadH,
          paddingBottom: Math.max(insets.bottom, t.mail ? 16 : 8),
          zIndex: t.zLayer.tabBar,
        }}
      >
      {/* The hidden copy every width is read from — the same capsules, absolute and invisible,
          out of the touch path and out of the accessibility tree. */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ position: "absolute", opacity: 0, flexDirection: "row", left: 0, top: 0 }}
      >
        <View onLayout={recordWidth("__reply")}>
          <Button label={Copy.actionReply} icon="reply" variant="solid" onPress={() => undefined} />
        </View>
        {forwardStands ? (
          <>
            <View onLayout={recordWidth("forward")}>
              <Button label={Copy.actionForward} icon="fwd" variant={t.mail ? "quiet" : "plain"} onPress={() => undefined} />
            </View>
            <View onLayout={recordWidth("forward.icon")}>
              <ForwardIcon onPress={() => undefined} />
            </View>
          </>
        ) : null}
        {compactRow.map((v) => (
          <View key={v.id} onLayout={recordWidth(v.id)}>
            <BarToggle label={v.label} icon={v.icon} on={false} onPress={() => undefined} />
          </View>
        ))}
      </View>
      {filingStatus}
      <GlassPill
        horizontal
        level="l3"
        radius={t.mail ? t.radius.pill : t.radius.panel}
        contentStyle={{
          alignSelf: "stretch",
          alignItems: "center",
          gap: BAR.gap,
          paddingHorizontal: BAR.padH,
          // Six points of each vertical pad live INSIDE the verb block (below), not here: RN
          // clips `hitSlop` at parent bounds, so a block measuring exactly the capsules' 38pt
          // would cut their touch targets under the 48dp `Tap` reaches. Same visual bar,
          // uncut hit rectangles.
          paddingVertical: 2,
        }}
      >
        {/* ONE ROW, MEASURED. More is pinned OUTSIDE it and never folds, so it can neither
            overlap a capsule nor land alone on a line; what does not fit is a row in its sheet
            (`barFit.overflow` feeds `moreHas`), so every verb is one press away at every width
            and in every language. The three horizons are toggles, with the pile that holds the
            message shown pressed. */}
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: BAR.gap,
            paddingVertical: PILL.padV,
          }}
        >
          <Button
            label={Copy.actionReply}
            icon="reply"
            variant="solid"
            style={{ maxWidth: "100%" }}
            onPress={() => openReply(false)}
          />
          {/* Forward, beside Reply, through the SAME door as the sheet's row (`openForward` → the
              composer over `m`, Reply's own target). Its word while it fits, else its icon. */}
          {forwardStands && barFit.standing.includes("forward") ? (
            barFit.leadIcon
              ? <ForwardIcon onPress={openForward} />
              : <Button label={Copy.actionForward} icon="fwd" variant={t.mail ? "quiet" : "plain"} onPress={openForward} />
          ) : null}
          {compactRow
            .filter((v) => barFit.standing.includes(v.id))
            .map((v) => (
              <BarToggle key={v.id} {...v} />
            ))}
        </View>
        <Tap
          onPress={() => setOpen("more")}
          accessibilityRole="button"
          accessibilityLabel={Copy.actionMore}
          accessibilityState={{ expanded: open === "more" }}
          style={{ padding: (BAR.moreBox - 16) / 2 }}
        >
          {paperMenu ? <NavigationIcon name="more" size={16} color={t.c.ink} /> : <Icon name="more" size={16} color={t.c.ink2} />}
        </Tap>
      </GlassPill>
      </View>
      )}

      {/* ── More: everything not standing on this posture's surface, one verb per row —
             `placement.behindMore` names the rows, so the sheet and the surface can never
             carry the same verb twice, and no mode loses one ───────────────────────────── */}
      {inlineMore ? null : <Sheet open={open === "more"} onClose={close} label={Copy.actionMore} phoneMenu={paperMenu}>
        {moreHas("replyAll") ? (
          <SheetRow icon={paperMenu ? "replyall" : "pen"} label={Copy.actionReplyAll} onPress={() => openReply(true)} />
        ) : null}
        {moreHas("forward") ? (
          <SheetRow icon={paperMenu ? "fwd" : "open"} label={Copy.actionForward} onPress={openForward} />
        ) : null}
        {messageRows}
        {canDraftReply ? (
          <>
            {moreRule}
            <SheetRow icon="spark" label={Copy.draftAiReply} onPress={() => openReply(false, true)} />
          </>
        ) : null}
        {/* Delete asks once per account, then opens the same Undo window directly. */}
        {moreHas("delete") ? (
          <>
            {paperMenu ? null : moreRule}
            {deleteRow}
          </>
        ) : null}
      </Sheet>}

      {/* ── Forward's ask: a `no_forward` message says why it was flagged, once, before the composer ── */}
      {m.forwardAsk ? (
        <Sheet open={open === "forward-ask"} onClose={close} label={Copy.forwardAskQuestion}>
          <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
            {Copy.forwardAskQuestion}
          </Txt>
          <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
            {forwardAskSentence(m.forwardAsk)}
          </Txt>
          <SheetRow icon="open" label={Copy.actionForward} onPress={() => showForward(true)} />
        </Sheet>
      ) : null}

      {/* ── The account’s first Move to Trash ── */}
      <Sheet open={open === "delete"} onClose={close} label={Copy.deleteAsk}
        onDismiss={dismissing === "delete" ? restoreOnDismiss : undefined}>
        <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          {Copy.deleteAsk}
        </Txt>
        <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
          {Copy.deleteNote}
        </Txt>
        <SheetRow
          icon="trash"
          label={Copy.actionDelete}
          onPress={() => {
            w.screenerConfirmation?.remember("moveToTrash");
            trash();
          }}
        />
      </Sheet>

      {/* ── Resurface: the horizon chooser — Now / Tomorrow / Next week / Pick a date ────── */}
      <Sheet
        open={open === "resurface" || open === "pick" || open === "time"}
        onClose={() => { close(); setPickedTime(null); }}
        onDismiss={dismissing === "resurface" || dismissing === "pick" || dismissing === "time" ? restoreOnDismiss : undefined}
        label={open === "time" ? Copy.resurfaceTime : Copy.resurfaceWhen}
        phoneMenu={paperMenu}
        title={open === "time" ? Copy.resurfaceTime : Copy.actionResurface}
      >
        {paperMenu ? null : <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          {open === "time" ? Copy.resurfaceTime : Copy.resurfaceWhen}
        </Txt>}
        {open === "resurface" ? (
          <>
            {/* THE TIME, FIRST AND BEFORE ANY CHOICE — the webapp strip's time control in the
                phone's idiom. It states the hour the three dated answers land at rather than
                leaving it implied, and it opens a second-level list because this app installs
                no datetime-picker native module. It stands ABOVE "Now" because it is not an
                answer to "when?" — it qualifies the three that are. */}
            <SheetRow
              icon="chev"
              label={Copy.resurfaceTime}
              detail={resurfaceTime}
              onPress={() => setOpen("time")}
            />
            <Rule inset={14} />
            <SheetRow label={Copy.resurfaceNow} onPress={() => { close(); setPickedTime(null); a.resurfaceNow(m.id); }} />
            <SheetRow
              label={Copy.resurfaceTomorrow}
              detail={tomorrow.time}
              onPress={() => pickResurface(tomorrow)}
            />
            <SkipNote horizon={tomorrow} label={Copy.resurfaceTomorrow} asked={resurfaceTime} />
            {nextWeek ? (
              <>
                <SheetRow
                  label={Copy.resurfaceNextWeek}
                  detail={nextWeek.time}
                  onPress={() => pickResurface(nextWeek)}
                />
                <SkipNote horizon={nextWeek} label={Copy.resurfaceNextWeek} asked={resurfaceTime} />
              </>
            ) : null}
            <SheetRow icon="chev" label={Copy.resurfacePick} onPress={() => setOpen("pick")} />
          </>
        ) : open === "time" ? (
          // EVERY HALF HOUR FROM 06:00 TO 22:00 — the phone's idiom for the webapp's time input,
          // the 90-day list's shape one axis over. The current value is checked; a stored value
          // outside this range still SHOWS and still applies (the rows are bounded, the account's
          // hour is not), so a time set on a computer is never silently rounded here.
          <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {RESURFACE_HOURS.map((hhmm) => (
              <SheetRow
                key={hhmm}
                label={hhmm}
                on={hhmm === resurfaceTime}
                onPress={() => { setPickedTime(hhmm); setOpen("resurface"); }}
              />
            ))}
          </ScrollView>
        ) : open === "pick" ? (
          // The picked day, as rows — the native idiom for the webapp's date input, floored at
          // the first day the chosen time is still ahead (today, while it is). Built only while this list
          // is open: it stood in the closed branch, so every reader render built ninety rows.
          <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {/* Ninety days of rows — the webapp's date input takes any future day; a list is
                the phone's idiom, and a quarter ahead covers the horizons people actually
                book. A fortnight did not, and was an exclusion nothing on screen admitted. */}
            {Array.from({ length: 90 }, (_, i) => {
              const day = dayAt(new Date(), i + pickFloor(new Date(), resurfaceTime), resurfaceTime);
              return (
                <Fragment key={day.at.toISOString()}>
                  <SheetRow
                    label={dayLabel(day.at, locale)}
                    detail={day.time}
                    onPress={() => pickResurface(day)}
                  />
                  <SkipNote horizon={day} label={dayLabel(day.at, locale)} asked={resurfaceTime} />
                </Fragment>
              );
            })}
          </ScrollView>
        ) : null}
      </Sheet>

      {/* ── Move: this message, relocated — every place except where it is ───────────────── */}
      <Sheet open={open === "move"} onClose={close} label={Copy.actionMove} phoneMenu={paperMenu} title={Copy.actionMove}
        onDismiss={dismissing === "move" ? restoreOnDismiss : undefined}>
        {paperMenu ? null : <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          {Copy.moveLabel}
        </Txt>}
        {/* The place the row is SHOWN in is what a person means by "where it is" — a newsletter
            ruled to Reads is offered the Ohbox, which the filed folder hid. `move` gets the row
            so the retarget names the same place the list did. */}
        {moveTargetsFor(m).map((target) => (
          <SheetRow
            key={target}
            label={paperMenu ? moveTargetLabel(target) : `→ ${moveTargetLabel(target)}`}
            onPress={() => { close(); a.move(m, target); }}
          />
        ))}
      </Sheet>

      {open === "tag" || dismissing === "tag" ? <TagSheet m={m} tags={w.tags} open={open === "tag"}
        onClose={close} onDismiss={dismissing === "tag" ? restoreOnDismiss : undefined} /> : null}
      {open === "screening" || dismissing === "screening" ? <ScreeningSheet m={m} open={open === "screening"}
        onClose={close} onDismiss={dismissing === "screening" ? restoreOnDismiss : undefined} /> : null}
      {/* The composer under its own boundary, in the sheet's shape: a throw while composing
          leaves the reader behind it readable and offers Retry, never the process. */}
      {open !== null && typeof open === "object" ? (
        <SurfaceBoundary surface="composer" frame="sheet" onClose={close}>
          <ComposeSheet
            m={open.compose === "forward" ? m : replyTarget.current} mode={open.compose} forwardConfirmed={"confirmed" in open && open.confirmed === true}
            {...("draft" in open && open.draft ? { draft: open.draft } : {})} replyAside={"aside" in open && open.aside === true}
            offerDraftReply={"offerDraftReply" in open ? open.offerDraftReply : undefined}
            onClose={close}
          />
        </SurfaceBoundary>
      ) : null}
    </>
  );
}

/* ── the tag sheet — the webapp picker: filter, toggle, create what does not exist ─────────── */

type ReaderPickerProps = { m: WorldMail; open: boolean; onClose: () => void; onDismiss?: () => void };

function TagSheet({ m, tags, open, onClose, onDismiss }: ReaderPickerProps & { tags: WorldTag[] }) {
  const t = useTheme();
  const w = useWorld();
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const list = tags.filter((tag) => tag.name.toLowerCase().includes(typed.toLowerCase()));
  // Against the WHOLE set, case-folded — the unique index is on `lower(name)`, so offering to
  // create "Invoices" while "invoices" exists would promise a tag the server answers 409 for.
  const canCreate = typed.length > 0 && !tags.some((tag) => tag.name.toLowerCase() === typed.toLowerCase());
  return (
    <Sheet open={open} onClose={onClose} onDismiss={onDismiss} label={Copy.actionTag} avoidKeyboard>
      <TextInput
        maxFontSizeMultiplier={t.textCap}
        disableFullscreenUI
        keyboardAppearance={t.scheme}
        value={query}
        onChangeText={setQuery}
        placeholder={Copy.tagPlaceholder}
        placeholderTextColor={t.c.ink3}
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          t.type.body,
          {
            color: t.c.ink,
            backgroundColor: t.c.tint2,
            borderRadius: t.radius.pill,
            paddingHorizontal: 14,
            paddingVertical: 9,
            marginHorizontal: 14,
            marginBottom: 8,
          },
        ]}
      />
      <ScrollView style={{ maxHeight: 300 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {list.map((tag) => {
          const on = m.labels.includes(tag.id);
          return (
            <SheetRow
              key={tag.id}
              label={tag.name}
              on={on}
              onPress={() => { onClose(); w.actions.tagToggle(m.id, tag, !on); }}
            />
          );
        })}
        {list.length === 0 && !canCreate ? (
          <Txt variant="note" tone="ink3" style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
            {Copy.tagNone}
          </Txt>
        ) : null}
        {canCreate ? (
          <SheetRow icon="plus" label={Copy.tagCreate(typed)} onPress={() => { onClose(); w.actions.tagCreate(m.id, typed); }} />
        ) : null}
      </ScrollView>
      {/* The honest sentence, at the point of creation — the webapp picker's own footnote. */}
      <Txt variant="caption" tone="ink3" style={{ paddingHorizontal: 14, paddingTop: 8 }}>
        {Copy.tagNotOnServer}
      </Txt>
    </Sheet>
  );
}

/* ── the screening sheet — where THIS SENDER's mail goes, and at what scope ────────────────── */

function ScreeningSheet({ m, open, onClose, onDismiss }: ReaderPickerProps) {
  const w = useWorld();
  const t = useTheme();
  const [scope, setScope] = useState<Scope>("sender");
  /**
   * Whether the rule also reaches the mail already filed — the webapp's second switch, same
   * default. It used to be sent as a hard `true` with nothing on screen saying so, which is a
   * promise the person could neither read nor decline.
   */
  const [applyRetro, setApplyRetro] = useState(true);
  /** The resolve step over the rules that disagree, in place of the destinations; `null` is the list. */
  const [step, setStep] = useState<PhoneStep | null>(null);
  const domain = domainOf(m.from.address);
  const hasDomain = m.from.address.includes("@") && domain !== "";
  // A shared provider's domain is never a scope: a decision about everyone there admits nobody.
  const sharedDomain = hasDomain && isSharedProviderDomain(domain);
  const target = scope === "domain" ? `@${domain}` : m.from.address;
  /* Nothing organizes any mailbox: the note says so rather than what a rule would file. */
  const nobody = w.mailboxes.known && noneOrganizedWhy(w.mailboxes.rows) !== null;
  const inPlay = w.actions.screeningRules(m.id, scope);
  const unsubscribeFor = (choice: Scope) => ({
    claim: w.actions.screeningUnsubClaim(m.id, choice),
    ids: w.actions.screeningUnsubscribeIds(m.id, choice),
  });
  const unsub = unsubscribeFor(scope);
  const chosenScope = step ? phoneTiles(step.cls, step.forecast)[step.choice]!.scope ?? scope : scope;
  const chosenUnsub = step?.unsubscribe[chosenScope];
  /* WHY SOME OF THEIR MAIL STAYED once the rule's past-mail pass finished — asked of the server
     once per row set, one line per place and reason, as the web sheet asks it. */
  const ask = w.actions.screeningStayed(m.id, scope);
  const askKey = ask ? ask.elsewhere.map((e) => e.id).join(",") : "";
  const [why, setWhy] = useState<{ key: string; map: ReadonlyMap<string, StayedWhy> } | null>(null);
  useEffect(() => {
    if (askKey === "") return;
    let live = true;
    void w.actions.stayedWhy(askKey.split(",")).then((map) => { if (live) setWhy({ key: askKey, map }); });
    return () => { live = false; };
  }, [askKey, w.actions]);
  // A mailbox by its own label beside a folder two mailboxes share a name for; never its address.
  const labelOf = (id: string) => w.mailboxes.all.find((r) => r.id === id)?.displayName?.trim() || null;
  const stayed = stayedRows(ask, why && why.key === askKey ? why.map : null, labelOf);
  const press = (dest: Destination) => {
    const demoting = dest === "screened" || dest === "spam";
    const ids = demoting && unsub.claim !== "none" ? unsub.ids : undefined;
    const f = w.actions.screeningForecast(m.id, dest, scope, applyRetro);
    const cls = f ? phoneStepClass(f, scope) : null;
    // On a shared provider the domain above the address is answered by the address: no "everyone" tile.
    if (f && cls === "domain" && sharedDomain) {
      onClose();
      w.actions.screenSender(m.id, dest, scope, applyRetro, {
        resolution: "keep", shown: f.groups.map((g) => g.rule), forecast: f,
      }, ids);
      return;
    }
    if (f && cls) {
      setStep({
        dest, forecast: f, cls, choice: cls === "domain" && !f.exception ? 1 : 0,
        unsubscribe: demoting ? { [scope]: unsub, ...(cls === "domain" ? { domain: unsubscribeFor("domain") } : {}) } : {},
      });
      return;
    }
    onClose();
    w.actions.screenSender(m.id, dest, scope, applyRetro, undefined, ids);
  };
  return (
    /* The system back gesture in the step goes back to the list; on the list it closes the sheet. */
    <Sheet open={open} onClose={() => (step ? setStep(null) : onClose())} onDismiss={onDismiss} label={Copy.actionScreening}>
      {step ? (
        <PhoneResolveStep
          step={step}
          domain={domain}
          warning={chosenUnsub && chosenUnsub.claim !== "none" && chosenUnsub.ids.length > 0
            ? Copy.decideUnsub(chosenUnsub.claim, chosenScope === "domain" ? `@${domain}` : m.from.address, chosenScope === "domain")
            : undefined}
          onChoice={(choice) => setStep({ ...step, choice })}
          onCommit={() => {
            const tile = phoneTiles(step.cls, step.forecast)[step.choice]!;
            onClose();
            w.actions.screenSender(m.id, step.dest, tile.scope ?? scope, applyRetro, {
              resolution: tile.resolution, shown: step.forecast.groups.map((g) => g.rule), forecast: step.forecast,
            }, chosenUnsub?.claim === "none" ? undefined : chosenUnsub?.ids);
          }}
          onCancel={() => setStep(null)}
        />
      ) : (
        <>
      <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
        {Copy.screeningFor(m.from.name)}
      </Txt>
      {sharedDomain ? (
        <Txt variant="caption" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
          {Copy.screeningScopeShared(domain)}
        </Txt>
      ) : hasDomain ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
          <Segmented
            fill={false}
            segments={[
              { value: "sender", label: Copy.scopeSender },
              { value: "domain", label: Copy.scopeDomain },
            ]}
            value={scope}
            onChange={setScope}
          />
        </View>
      ) : null}
      {inPlay?.worthShowing ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
          <Txt variant="caption" tone="ink3">{Copy.screeningRulesHead}</Txt>
          {inPlay.lines.slice(0, 3).map((line) => (
            <PhoneRuleLine key={line.rules[0]!.id} rule={line.rules[0]!} count={line.count} domain={domain} />
          ))}
          {inPlay.inside ? (
            <Txt variant="caption" tone="ink2">{Copy.screeningRuleInsideCount(inPlay.inside.senders, inPlay.inside.count)}</Txt>
          ) : null}
        </View>
      ) : null}
      {stayed.length > 0 ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 8, gap: 4 }}>
          {stayed.map((row) => (
            <View key={row.key} style={{ gap: 2 }}>
              <Txt variant="caption" tone="ink2">{row.text}</Txt>
              {row.move ? (
                <Button
                  label={row.move.label}
                  variant="quiet"
                  onPress={() => { const mv = row.move!; onClose(); w.actions.moveStayed(mv.ids, mv.dest); }}
                />
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      {/* THE PAST-MAIL OPTION, ABOVE THE DESTINATIONS, because it changes what pressing one of
          them does and a control read afterwards is not a choice. A switch by ROLE and STATE, so
          it is pressable and readable rather than a decorated row. */}
      <Tap
        accessibilityRole="switch"
        accessibilityState={{ checked: applyRetro }}
        accessibilityLabel={Copy.screeningRetroToggle}
        onPress={() => setApplyRetro((on) => !on)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 16,
          paddingVertical: 13,
          backgroundColor: pressed ? t.c.tint : "transparent",
        })}
      >
        <Txt variant="button" style={{ flexShrink: 1 }}>{Copy.screeningRetroToggle}</Txt>
        <View style={{ flex: 1 }} />
        {applyRetro ? <Icon name="check" size={14} color={t.c.accentInk} /> : null}
      </Tap>
      {DESTINATIONS.map((dest: Destination) => (
        <SheetRow
          key={dest}
          label={`→ ${destLabel(dest)}`}
          onPress={() => press(dest)}
        />
      ))}
      <Txt variant="caption" tone="ink3" style={{ paddingHorizontal: 14, paddingTop: 8 }}>
        {nobody ? Copy.screeningNoteNobody : applyRetro ? Copy.screeningNoteRetro(target) : Copy.screeningNote(target)}
      </Txt>
      {/* What Screen out and Spam send for a sender still waiting, before either is pressed. */}
      {unsub.claim !== "none" && unsub.ids.length ? (
        <Txt variant="caption" tone="ink2" style={{ paddingHorizontal: 14, paddingTop: 6 }} testID="screening-unsub">
          {Copy.decideUnsub(unsub.claim, target, scope === "domain")}
        </Txt>
      ) : null}
        </>
      )}
    </Sheet>
  );
}

/** The phone's step: which question, over which forecast, and the tile chosen. */
interface PhoneStep {
  dest: Destination;
  forecast: PressForecast;
  cls: "term" | "domain" | "inside";
  choice: 0 | 1;
  unsubscribe: Partial<Record<Scope, { claim: ReturnType<ReturnType<typeof useWorld>["actions"]["screeningUnsubClaim"]>; ids: readonly string[] }>>;
}

const isTermGroup = (g: ConflictGroup) => g.cause === "term-subject" || g.cause === "term-body";

/** The web sheet's `stepClass`, read the same way. */
function phoneStepClass(f: PressForecast, scope: Scope): PhoneStep["cls"] | null {
  if (scope === "sender" && f.groups.some(isTermGroup)) return "term";
  if (scope === "sender" && (f.exception !== null || f.groups.some((g) => g.cause === "domain-outranks"))) return "domain";
  if (scope === "domain" && f.groups.some((g) => g.cause === "own-rule-inside")) return "inside";
  return null;
}

/** Each tile's answer and words, the web sheet's `tilesOf` and its titles. */
function phoneTiles(cls: PhoneStep["cls"], f: PressForecast): Array<{
  resolution: "remove" | "keep"; scope?: Scope; title: (place: string, domain: string) => string; note: string | null; count: number;
}> {
  const terms = f.groups.filter(isTermGroup);
  const inside = f.groups.filter((g) => g.cause === "own-rule-inside");
  const listed = cls === "term" ? terms : inside;
  const kept = listed.reduce((n, g) => n + (g.rows?.length ?? 0), 0);
  const counted = listed.every((g) => g.rows !== null);
  const outranking = f.exception?.rule ?? f.groups.find((g) => g.cause === "domain-outranks")?.rule ?? null;
  const keep = {
    resolution: "keep" as const, title: () => Copy.screeningResolveKeepTitle, count: f.keep.landing.length,
    note: counted ? Copy.screeningResolveKeepNote(kept, listed.length || 1) : Copy.screeningResolveKeepNoteUncounted,
  };
  const wide = (place: string, domain: string) => Copy.screeningRuleLine(Copy.screeningRuleEveryone(domain), place);
  if (cls === "term") {
    return [{
      resolution: "remove", title: (place) => Copy.screeningRuleLine(Copy.screeningRuleAll, place),
      note: Copy.screeningResolveAllNote(terms.length), count: f.remove.landing.length,
    }, keep];
  }
  if (cls === "inside") {
    return [
      { resolution: "keep", title: () => Copy.screeningResolveInsideKeepTitle, note: null, count: f.keep.landing.length },
      { resolution: "remove", title: wide, note: Copy.screeningResolveInsideAllNote(inside.length), count: f.remove.landing.length },
    ];
  }
  const everyone = { resolution: "keep" as const, scope: "domain" as const, title: wide, note: null, count: f.keep.places.size };
  return f.exception
    ? [{
        resolution: "keep", title: (place) => Copy.screeningRuleLine(Copy.screeningRuleOnlyThis, place),
        note: Copy.screeningResolveExceptNote(outranking?.match ?? "", folderName(outranking?.destination ?? "")),
        count: f.keep.landing.length,
      }, everyone]
    : [everyone, keep];
}

/** One rule line: what it claims → where it files, and the rows it places (or "not counted here"). */
function PhoneRuleLine({ rule, count, domain, inside = false }: {
  rule: WorldRule; count: number | null; domain: string;
  /** At domain scope an address rule is somebody's own, named by its address. */
  inside?: boolean;
}) {
  const subjectTerm = (rule.subjectContains ?? "").trim();
  const bodyTerm = (rule.bodyContains ?? "").trim();
  const condition = rule.kind === "domain" ? Copy.screeningRuleEveryone(rule.match || domain)
    : inside ? rule.match
    : subjectTerm ? Copy.screeningRuleSubject(subjectTerm)
      : bodyTerm ? Copy.screeningRuleBody(bodyTerm) : Copy.screeningRuleAll;
  return (
    <View style={{ flexDirection: "row", gap: 10, paddingTop: 2 }}>
      <Txt variant="caption" tone="ink2" style={{ flex: 1 }}>
        {Copy.screeningRuleLine(condition, folderName(rule.destination))}
      </Txt>
      <Txt variant="caption" tone="ink3">{count === null ? Copy.screeningRuleUncounted : String(count)}</Txt>
    </View>
  );
}

/** THE STEP, in the same sheet: the rules that disagree, two radio rows, the press and Cancel. */
function PhoneResolveStep({ step, domain, warning, onChoice, onCommit, onCancel }: {
  step: PhoneStep; domain: string; warning?: string; onChoice: (c: 0 | 1) => void; onCommit: () => void; onCancel: () => void;
}) {
  const t = useTheme();
  const f = step.forecast;
  const place = destLabel(step.dest);
  const terms = f.groups.filter(isTermGroup);
  const inside = f.groups.filter((g) => g.cause === "own-rule-inside");
  const outranking = f.exception?.rule ?? f.groups.find((g) => g.cause === "domain-outranks")?.rule ?? null;
  const title = step.cls === "term"
    ? Copy.screeningResolveTitle(place, terms.length)
    : step.cls === "inside"
      ? Copy.screeningResolveInsideTitle(place, new Set(inside.map((g) => ruleMatchKey(g.rule.match))).size)
      : Copy.screeningResolveDomainTitle(place, outranking?.match ?? domain, folderName(outranking?.destination ?? ""));
  const lines = step.cls === "domain" ? (outranking ? [{ rule: outranking, count: null as number | null }] : [])
    : (step.cls === "term" ? terms : inside).slice(0, 3).map((g) => ({ rule: g.rule, count: g.rows?.length ?? null }));
  return (
    <View style={{ paddingHorizontal: 14, gap: 8 }}>
      <Txt variant="button">{title}</Txt>
      {lines.map((l) => <PhoneRuleLine key={l.rule.id} rule={l.rule} count={l.count} domain={domain} inside={step.cls === "inside"} />)}
      <View accessibilityRole="radiogroup" accessibilityLabel={Copy.screeningResolveChoiceAria} style={{ gap: 6, paddingTop: 4 }}>
        {phoneTiles(step.cls, f).map((tile, i) => (
          <Tap
            key={i}
            accessibilityRole="radio"
            accessibilityState={{ checked: step.choice === i }}
            accessibilityLabel={tile.title(place, domain)}
            onPress={() => onChoice(i as 0 | 1)}
            style={({ pressed }) => ({
              flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 2,
              backgroundColor: pressed ? t.c.tint : "transparent",
            })}
          >
            <View style={{ flex: 1 }}>
              <Txt variant="button">{tile.title(place, domain)}</Txt>
              <Txt variant="caption" tone="ink3">
                {tile.note ? Copy.screeningNoteWithCount(tile.note, tile.count) : Copy.screeningCount(tile.count)}
              </Txt>
            </View>
            {step.choice === i ? <Icon name="check" size={14} color={t.c.accentInk} /> : null}
          </Tap>
        ))}
      </View>
      {warning ? <Txt variant="caption" tone="ink2">{warning}</Txt> : null}
      <Button label={Copy.screeningResolveGo(place)} variant="solid" onPress={onCommit} />
      <Button label={Copy.screeningResolveCancel} variant="quiet" onPress={onCancel} />
    </View>
  );
}

/* ── the composer — reply, reply all, forward; plain text, sent through the engine. The
   sending mailbox's stored signature stands below the writing area as a distinct block —
   removable, editable, serialized exactly as shown (SIG-MOB; `signature.ts` is the shared
   model, `SignatureBlock.tsx` the webapp reference). ─────────────────────────────────────── */

/** How long after the last keystroke a composer bound to a draft writes it — the web's autosave. */
export const DRAFT_AUTOSAVE_MS = 2000;

export function ComposeSheet({
  m,
  mode,
  forwardConfirmed = false,
  draft,
  prefill,
  diag,
  replyAside = false,
  offerDraftReply,
  inline = false,
  keyboardHeight: dockKeyboardHeight,
  messageActions,
  backLabel = Copy.back,
  doneOnSend = false,
  run,
  onClose,
}: {
  /** The message being answered — `null` for a mail with no parent (the `new` mode). */
  m: WorldMail | null;
  mode: "reply" | "replyAll" | "forward" | "new";
  /** The forward ask was answered (`forward-ask`); the send carries the confirmation. */
  forwardConfirmed?: boolean;
  /** A draft opened from Drafts: the composer is bound to its row from the first keystroke. */
  draft?: { id: string; body: string } & WorldDraftEdit;
  /** A new mail's starting text — a `mailto:` pressed in a message (`app/compose.tsx`). */
  prefill?: MailtoPrefill;
  /** The diagnostics block a mail to support carries in its body (`help-contact.ts`), offered for removal. */
  diag?: string;
  /** A reply to this message is kept that this sheet cannot resume (`replyOpen`): said in its notes. */
  replyAside?: boolean;
  /** The reader opened the drafter's offer for this reply. */
  offerDraftReply?: true;
  /** The same editor and dispatch, laid within the conversation. */
  inline?: boolean;
  /** The keyboard shared with the reader when the editor is docked under its history. */
  keyboardHeight?: number;
  /** The root letter owns the conversation actions even when answering another member. */
  messageActions?: { message: WorldMail; record: ThreadRead; onDeleted?: () => void };
  backLabel?: string;
  doneOnSend?: boolean;
  run?: { skip: () => void; exit: () => void };
  onClose: () => void;
}) {
  const t = useTheme();
  const phonePill = t.mail === true;
  const fresh = mode === "new";
  const forward = mode === "forward";
  const addressed = fresh || forward;
  const ownKeyboardHeight = useKeyboardHeight(!inline);
  const keyboardHeight = dockKeyboardHeight ?? ownKeyboardHeight;
  const insets = useSafeAreaInsets();
  const { heightClass, panes } = usePosture();
  const windowHeight = useWindowDimensions().height;
  const modalKey = useModalKey();
  const menuHost = useRef<View | null>(null);
  const afterMore = useRef<(() => void) | null>(null);
  const writerFocus = useRef<(() => void) | null>(null);
  const { anchorRef: moreRef, anchorTo, anchor: moreAnchor } = useSheetAnchor();
  /* The composer stands over the reader: nothing under it is read while it is shown (`reader-cover.ts`). */
  useReaderCover(true);
  /* An unfold redraws the dialog; the field that held the caret gets it back (`keep-focus.ts`). */
  const focusKeeper = useFocusKeeper(Date.now, showKeyboardWhenFocused);
  const toField = useRef<TextInput | null>(null);
  const subjectField = useRef<TextInput | null>(null);
  /* Android otherwise shows the end of a long prefilled subject before it is edited. */
  const [subjectHasFocused, setSubjectHasFocused] = useState(false);
  const subjectFocus = focusKeeper.bind(subjectField);
  const bodyField = useRef<TextInput | null>(null);
  const [bodyHeight, setBodyHeight] = useState(0);
  const [letterHeight, setLetterHeight] = useState(0);
  const letterScroll = useRef<null | ScrollView>(null);
  const letterInner = useRef<View | null>(null);
  const [notesHeight, setNotesHeight] = useState<number | null>(null);
  const [attachRow, setAttachRow] = useState({ row: 0, files: 0, photos: 0, hint: 0 });
  const measureAttach = (k: "row" | "files" | "photos" | "hint", width: number) => {
    const w = Math.round(width);
    setAttachRow((m) => (m[k] === w ? m : { ...m, [k]: w }));
  };
  const pinNotes = notesPinned(notesHeight, pinnedNotesMax(windowHeight));
  useEffect(() => {
    if (!pinNotes) letterScroll.current?.scrollToEnd({ animated: false });
  }, [pinNotes, notesHeight]);
  /* Whether the letter goes on below its scroller's edge: a fade over the edge says so. */
  const letterBox = useRef({ content: 0, view: 0, y: 0 });
  const [runsOn, setRunsOn] = useState(false);
  const measureLetter = (k: "content" | "view" | "y", v: number) => {
    letterBox.current[k] = v;
    const next = letterRunsOn(letterBox.current.content, letterBox.current.view, letterBox.current.y);
    setRunsOn((was) => (was === next ? was : next));
  };
  const revealField = () => {
    const scroll = letterScroll.current;
    const content = letterInner.current;
    const field = TextInput.State?.currentlyFocusedInput();
    if (!scroll || !content || !field) return;
    field.measureLayout(content, (_x, top, _width, height) => {
      if (letterScroll.current !== scroll || field !== TextInput.State.currentlyFocusedInput()) return;
      const { view, y } = letterBox.current;
      if (view > 0 && (top < y || top + height > y + view)) {
        const next = top < y ? top : Math.min(top, top + height - view);
        scroll.scrollTo({ y: Math.max(0, next), animated: false });
      }
    }, () => undefined);
  };
  const letterContent = (_w: number, h: number) => {
    measureLetter("content", h);
    if (keyboardHeight > 0) revealField();
  };
  const letterView = (e: LayoutChangeEvent) => {
    const height = e.nativeEvent.layout.height;
    measureLetter("view", height);
    setLetterHeight(Math.round(height));
    if (keyboardHeight > 0) revealField();
  };
  const letterMoved = (e: NativeSyntheticEvent<NativeScrollEvent>) => measureLetter("y", e.nativeEvent.contentOffset.y);
  const w = useWorld();
  /* Read when a recipient field is typed in, not on every render of the sheet. */
  const addressBook = () => w.addressBook;
  const suggestionsBack = useRef<BackStep["current"]>(null);
  const toast = useWorldToast();
  /* THE COMPOSER HOLDS THE READER'S MOVE, whatever opened it (the reader's sheet, the rail's pen, a
     mailto in a body): a fold or unfold while it is open replaced or covered the New mail route and
     unmounted it without a close. The move fires once the composer is gone (`reader-held.ts`). */
  const holdToken = useRef(Symbol("composer")).current;
  useEffect(() => holdWhileOpen(holdToken), [holdToken]);
  /* EVERY ROAD OUT IS A CLOSE: `leave` marks it. An unmount that did not come through one keeps what
     a close would have kept (`unmountKeep`), so nothing typed goes with a screen that went. */
  const closed = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const leave = () => {
    closed.current = true;
    onClose();
  };
  const atUnmount = useRef<() => void>(() => undefined);
  useEffect(() => () => { if (!closed.current) atUnmount.current(); }, []);
  /** The composer never straddles a hinge and stays bounded on wide windows (`Sheet.tsx`). */
  const panelBounds = useSheetPanelBounds();
  const composerKeyboardLift = keyboardLift(Platform.OS, keyboardHeight, insets.bottom);
  const room = useSheetRoom(composerKeyboardLift);
  /** The send-later day rows, named by `Intl` in the app's language. */
  const locale = useLocale();
  const [discardAsked, setDiscardAsked] = useState(false);
  const [discardPending, setDiscardPending] = useState(false);
  const [discardRefused, setDiscardRefused] = useState<DraftDiscardRefusal | null>(null);
  const discarding = useRef(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [tools, setTools] = useState<"attachment" | "emoji" | "format" | "more" | null>(null);
  const [formatOpen, setFormatOpen] = useState(false);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const [{ body, runs }, setWords] = useState<{ body: string; runs: Run[] | null }>(() => {
    const seed = draft?.body ?? prefill?.body ?? "";
    return { body: seed, runs: draft?.html ? runsOf(seed, draft.html) : null };
  });
  const setBody = (next: string | ((body: string) => string)) => setWords((before) => {
    const body = typeof next === "string" ? next : next(before.body);
    return { body, runs: before.runs === null ? null : editRuns(before.runs, body) };
  });
  const setDrafterBody = (next: string, nextRuns?: Run[] | null) => {
    if (nextRuns === undefined) setBody(next);
    else setWords({ body: next, runs: nextRuns });
  };
  const html = runs === null ? undefined : markupOf(runs) ?? null;
  const rich = html === undefined ? {} : { html };
  const formatting = (mark: Mark) => {
    if (phase !== "idle") return;
    const range = selection.current;
    if (range === null || range.start === range.end) return;
    setWords((before) => ({ ...before, runs: toggleMark(before.runs ?? [{ text: before.body, marks: [] }], range.start, range.end, mark) }));
  };
  const replyDefaults = !addressed && m
    ? w.actions.keepEnvelope(mode, m.id) ?? { to: [m.from], cc: [], subject: replySubject(m.subject) }
    : null;
  const draftReply = m !== null && draft?.replyTo === m.id;
  const replyTo = replyDefaults ? typedRecipients(replyDefaults.to) : "";
  const replyCc = replyDefaults ? typedRecipients(replyDefaults.cc) : "";
  const foldedCc = replyDefaults?.cc.map(({ name, address }) => name?.trim() || displayAddress(address)).join(", ") ?? "";
  const replyTitle = replyDefaults?.subject ?? "";
  const [to, setTo] = useState(replyDefaults && !draftReply ? replyTo : draft?.to ?? prefill?.to ?? "");
  const [subject, setSubject] = useState(replyDefaults && !draftReply ? replyTitle
    : draft?.subject ?? prefill?.subject ?? (forward && m ? forwardSubject(m.subject) : replyTitle));
  /* A forward opens its full recipient rows. New mail reveals copies where set or on request. */
  const [copies, setCopies] = useState<TypedCopies>(replyDefaults && !draftReply ? { cc: replyCc, bcc: "" }
    : { cc: draft?.cc ?? prefill?.cc ?? "", bcc: draft?.bcc ?? prefill?.bcc ?? "" });
  const [replyPeopleOpen, setReplyPeopleOpen] = useState(draftReply);
  const replyPeopleAsked = useRef(false);
  useEffect(() => {
    if (replyPeopleOpen && replyPeopleAsked.current) {
      replyPeopleAsked.current = false;
      toField.current?.focus();
    }
  }, [replyPeopleOpen]);
  const replyRecipientsEdited = draftReply || (replyPeopleOpen && (to !== replyTo || copies.cc !== replyCc || copies.bcc !== ""));
  const replySubjectEdited = draftReply || (replyDefaults !== null && subject !== replyTitle);
  const storedRecipients = replyDefaults && !replyRecipientsEdited ? { to: "", cc: "", bcc: "" } : { to, ...copies };
  const storedSubject = replyDefaults && !replySubjectEdited ? "" : subject;
  const keptReplyEdits: ReplyEdits = {
    ...(replyPeopleOpen ? { replyEnvelope: { to: keptRecipients(to), ...copiesToKeep(copies) } } : {}),
    ...(replySubjectEdited ? { replySubject: subject } : {}),
  };
  const [copiesOn, setCopiesOn] = useState(() => forward || (fresh && copiesShown(draft ?? prefill)));
  const ccField = useRef<TextInput | null>(null);
  /* Focused once the fields have mounted, not in the press: the input does not exist yet then. */
  const [copiesAsked, setCopiesAsked] = useState(false);
  useEffect(() => {
    if (copiesAsked && copiesOn) ccField.current?.focus();
  }, [copiesAsked, copiesOn]);
  /**
   * The composer's send phase. `queued` is TERMINAL for this composer: the text stands on
   * the engine's retry queue under its Idempotency-Key (the reconnect flush retries it, the
   * same key every time), so Send stays locked — a second press would be a second key, which
   * is the double-delivery the send contract forbids. The sentence under the editor says
   * what is true; closing discards only this screen's copy of text the queue already holds.
   */
  const [phase, setPhase] = useState<"idle" | "sending" | "queued" | "unverified">("idle");
  /** The queued send's Idempotency-Key — what the settle effect follows through the ledger. */
  const [queuedKey, setQueuedKey] = useState<string | null>(null);
  /** The queued send is the server's (`SendResult.accepted`): it says it is still sending. */
  const [accepted, setAccepted] = useState(false);
  /** The server offered it again (`SendResult.rearmed`): its window runs, so nothing promises the network. */
  const [rearmed, setRearmed] = useState(false);
  /** The phone's network, so a send waiting for it says so in place (`send-waits.ts`). */
  const network = useNetworkNow();
  /**
   * TRUE once a Cancel was answered "too late": the request had left and this device cannot
   * un-send it. The sentence stands in place and the next press dismisses — see `closeComposer`.
   */
  const [alreadySent, setAlreadySent] = useState(false);
  /** The Cancel could not reach the server about a send that may have left; it is asked again. */
  const [cancelUnreachable, setCancelUnreachable] = useState(false);
  /** TRUE after Send was pressed over an unconfirmed send — the press says why nothing went. */
  const [againNote, setAgainNote] = useState(false);
  /** The row the server holds an unconfirmed send in: Send again is pressed on it. */
  const [heldId, setHeldId] = useState<string | null>(null);
  /** A Send again press is running: locked until it answers. */
  const [againBusy, setAgainBusy] = useState(false);
  /** Why a Send again did not send, said in place. */
  const [againSaid, setAgainSaid] = useState<DraftSendAgainRefusal | null>(null);
  /**
   * THE SIGNATURE BLOCK'S STATE (`signature.ts`, shared with the webapp composer): `following`
   * until the user speaks, then their edit or their strike stands for THIS message. The sheet
   * is mounted per compose and unmounts on close, so the state's lifetime IS the message's —
   * the one-removal-one-message rule by construction.
   */
  const [sig, setSig] = useState<SignatureState>(SIG_FOLLOWING);
  const phoneLetter = phonePill && fresh && panes === 1 && heightClass !== "compact";
  const paperEditor = phonePill || inline;
  const insertEmoji = (emoji: string) => {
    if (phase !== "idle") return;
    const range = selection.current;
    setBody((text) => range ? text.slice(0, range.start) + emoji + text.slice(range.end) : text + emoji);
    setTools(null);
    if (phonePill) bodyField.current?.focus();
  };
  /* What the writing area asks for — a reply's own words, a forward's optional note, or, with
     no parent to answer, a message of its own. */
  const bodyPlaceholder = fresh
    ? (phoneLetter ? Copy.composePaperPlaceholder : Copy.composeBodyPlaceholder)
    : forward
      ? Copy.forwardNotePlaceholder
      : Copy.replyPlaceholder;
  /**
   * THE ATTACHMENTS — bytes in memory, nothing filed (`ComposeAttachment`'s contract); they ride
   * the same `mail_send` the webapp composer sends. The admit pipeline, the cap and the
   * needs-content rule live in `../compose/attach`; the pickers behind their native twin. Notes
   * are the LAST pick's verdicts (refused-over-cap, duplicates, unreadable, picker refused) —
   * each said in place, the webapp's `role="status"` rows in this sheet's idiom.
   */
  /* A DRAFT OPENED FROM DRAFTS brings the files kept with it on this phone (`compose/letter-store.ts`). */
  const [attachments, setAttachments] = useState<PhoneComposeAttachment[]>(() => (draft === undefined ? []
    : (letterSession()?.door.filesOf(draft.id) ?? []).map((f) => ({
      filename: f.filename, contentType: f.contentType, contentBase64: f.contentBase64, sizeBytes: f.sizeBytes, fileId: f.fileId,
    }))));
  /* KINDS, never sentences: a deck read stored in state freezes in the language it was read in
     (refusal.test.ts's rule) — the sentence is derived at render time. Filenames are data. */
  const [attachNotes, setAttachNotes] = useState<AttachNote[]>([]);
  /** TRUE after a press on a Send that lacks only content — cleared the moment content arrives. */
  const [needNote, setNeedNote] = useState(false);
  /**
   * Why the last close stayed. A second close retries a failed save; only Discard drops words.
   */
  const [keepNote, setKeepNote] = useState<"failed" | "files" | "tooLong" | null>(null);
  /** The files the last close named as past what this phone keeps with drafts. */
  const [filesOver, setFilesOver] = useState<string[]>([]);
  /** A keep on its way — one row per close, however often the backdrop is tapped meanwhile. */
  const keeping = useRef(false);
  /** A Cancel send still being asked: a press meanwhile is not a second question. */
  const withdrawing = useRef(false);
  /**
   * THE ROW THIS LETTER IS — set once a refused send names the draft it left. Every later press
   * sends that row and the keep on close updates it, so one letter is one draft however often
   * Send is pressed with the network gone. `null` until a refusal names one.
   */
  const [draftId, setDraftId] = useState<string | null>(draft?.id ?? null);
  /** The version of that row the words on screen are based on: a row moved elsewhere is never written over. */
  const base = useRef<DraftBase>({ row: draft?.id ?? null, rev: draft?.revision ?? null });
  /** The row was changed elsewhere and these words went to a new draft: said here, toasts render under the sheet. */
  const [forked, setForked] = useState(false);
  const rebase = (r: { draftId: string | null; revision?: string; key?: string | null }): void => { base.current = baseAfter(base.current, r); };
  /** What the bound row last held from this sheet — the seed until the first save. */
  const saved = useRef<string | null>(draft ? wordsOf({
    ...draft, ...storedRecipients, subject: storedSubject, replyRecipientsEdited, replySubjectEdited,
  }) : null);
  /** The last press was refused, and which sentence it earned — said in the sheet, see `send-failed.ts`. */
  const [failNote, setFailNote] = useState<FailedSendCopy | null>(null);
  /* A reply or forward starts from the original's mailbox. A reopened draft keeps its From. */
  const [picked, setPicked] = useState<string | null>(draft?.mailboxId ?? null);
  const [fromOpen, setFromOpen] = useState(false);
  const senderFacts = {
    bound: draft?.mailboxId ?? (fresh ? null : m?.mailboxId ?? w.mailboxes.sendingId),
    fallback: w.mailboxes.sendingId, known: w.mailboxes.known, rows: w.mailboxes.all,
  };
  const { keepFrom: mailboxId, sendFrom, ...sender } = composeFromOf({ ...senderFacts, picked });
  const fromEdited = draft === undefined && picked !== null
    && picked !== composeFromOf({ ...senderFacts, picked: null }).sendFrom;
  const replyFrom = !addressed && m?.mailboxId && sendFrom !== m.mailboxId ? sendFrom ?? undefined : undefined;
  /* The sending address, only where the phone has read the mailbox list — `null` is "not
     asked yet", which states nothing rather than a guessed address. */
  const activeFrom = w.mailboxes.rows.find((r) => r.id === sendFrom);
  const fromAddress = activeFrom ? displayAddress(activeFrom.address) : null;
  /* The ONE shared bound (`composeAttachCap`) of the sending mailbox's announced `SIZE` and the
     door's surface — the pair the send will enforce (`compose/attach.ts#phoneSendSurface`). */
  const sendSurface = w.actions.sendSurface();
  const attachCap = phoneAttachCap(w.mailboxes.rows, sendFrom ?? "", sendSurface);
  const letterWords = {
    mode, messageId: m?.id ?? null, mailboxId, fromEdited, ...storedRecipients, subject: storedSubject, body, ...rich,
    replyRecipientsEdited: replyRecipientsEdited || undefined, replySubjectEdited: replySubjectEdited || undefined,
  };
  /* THE LETTER ON THE PHONE'S DISK as it is written (`compose/letter-keeper.ts`): half a second after
     the last change, at once when the app leaves the foreground, and marked before a keep or a send. */
  const [keeper] = useState<LetterKeeper | null>(() => {
    const letters = letterSession();
    if (letters === null) return null;
    const held = draft !== undefined ? letters.door.letterOf(draft.id) : undefined;
    return openLetterKeeper({
      door: letters.door, id: held?.id ?? letters.uuid(), newFileId: letters.uuid,
      words: { ...letterWords, envelope: replyDefaults ?? w.actions.keepEnvelope(mode, m?.id ?? null) },
      draftId: draft?.id ?? null, savedAs: saved.current, revision: draft?.revision ?? null,
    });
  });
  const forwardEnvelope = forward ? { forwardSubject: subject } : {};
  /* THE ORIGINAL'S FILES, LISTED (`compose/forward-files.ts`): held while the sheet stands, removable
     where the server sends only the parts the forward names, and weighed apart from the phone's own. */
  /* The ids kept once one was removed (`Letter.forwardKept`), so a reopened or restored forward keeps its choice;
     else the row's, so a draft trimmed on another device opens listing only the kept files. */
  const [forwardKept, setForwardKept] = useState<readonly string[] | null>(
    () => keeper?.current().forwardKept ?? draft?.forwardParts ?? null,
  );
  /** The kept files every save of a forward writes onto its row; never a clearing null. */
  const keptOnRow = forward && forwardKept !== null ? { forwardParts: forwardKept } : {};
  const [forwardNote, setForwardNote] = useState<Refusal | null>(null);
  useEffect(() => {
    if (!forward || m === null) return undefined;
    w.actions.holdFiles([m.id]);
    return () => w.actions.releaseFiles([m.id]);
    // The original is the sheet's for its life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const forwardPlan = forward && m !== null ? forwardFilesPlan({
    list: w.actions.forwardFiles(m.id), supported: w.actions.forwardPartsSupported(), kept: forwardKept,
    addedBytes: attachments.reduce((n, a) => n + a.sizeBytes, 0), caps: forwardCaps(w.mailboxes.rows, sendFrom ?? "", sendSurface),
  }) : null;
  const removePart = (id: string) => {
    if (phase !== "idle" || forwardPlan === null) return;
    const next = (forwardKept ?? forwardPlan.rows.map((r) => r.id)).filter((k) => k !== id);
    setForwardKept(next);
    setForwardNote(null);
    keeper?.forwardKept(next);
  };
  useEffect(() => {
    keeper?.edit({ ...letterWords, envelope: replyDefaults ?? keeper.current().envelope });
    // The words are the change; the keeper reads the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, subject, body, copies.cc, copies.bcc, mailboxId, fromEdited, replyRecipientsEdited, replySubjectEdited, replyTo, replyCc, replyTitle, html]);
  const { pictureQuality } = usePrefs();
  /* AN ATTACHED FILE OPENS from its bytes in hand: a picture or a PDF in the reader's own preview, over
     this sheet; anything else in another app, as the reader's tiles do. */
  const [previewed, setPreviewed] = useState<PreviewFile | null>(null);
  const [openRefused, setOpenRefused] = useState<PhoneComposeAttachment | null>(null);
  const openAttached = async (file: PhoneComposeAttachment) => {
    setOpenRefused(null);
    const shown = attachPreview(file);
    if (shown !== null) {
      setPreviewed(shown);
      return;
    }
    if (!(await shareAttachmentBytes(file.contentBase64, file.contentType, file.filename))) setOpenRefused(file);
  };
  const pick = async (which: "files" | "photos") => {
    if (phase !== "idle") return;
    const picker = nativeAttachPicker();
    /* A file past the room left is never read into memory (`readWithin`). */
    const room = attachCap - attachments.reduce((n, a) => n + a.sizeBytes, 0);
    const outcome: AttachPickOutcome =
      which === "files" ? await picker.pickFiles(room) : await picker.pickPhotos(zone);
    if (outcome.kind === "cancelled") return;
    if (outcome.kind === "unavailable") {
      // The platform refused the picker itself — said by name, never a press that does nothing.
      setAttachNotes([{ kind: "unavailable" }]);
      return;
    }
    /* SHRUNK BEFORE THE CAP, as the web does — a photo that only fits once shrunk must attach.
       The level is read at the pick, so a change in Settings applies to the next one. */
    const picked = await shrinkPicked(outcome.files, pictureQuality, nativeImageShrink);
    const admit = admitPicked(attachments, picked, attachCap);
    /* Each admitted file's bytes reach the phone's disk once, now (`compose/letter-store.ts`). */
    if (keeper !== null) {
      for (let i = attachments.length; i < admit.next.length; i++) {
        const f = admit.next[i]!;
        admit.next[i] = { ...f, fileId: keeper.addFile(f) };
      }
    }
    const notes: AttachNote[] = [];
    if (admit.overCap + (outcome.overCap ?? 0) > 0) notes.push({ kind: "overCap" });
    if (admit.duplicates.length > 0) notes.push({ kind: "duplicates", filenames: admit.duplicates.join(", ") });
    if (outcome.unreadable + admit.unreadable > 0) notes.push({ kind: "unreadable" });
    setAttachments(admit.next);
    setAttachNotes(notes);
  };
  /**
   * Send later: presets, days and hours. `openedAt` freezes "now" when
   * the picker opens so the presets do not drift mid-decision — and because that freeze lets a
   * preset go stale, the press re-checks the lead against the real clock
   * ({@link Copy.sendLaterPast}). A draft row stores no forward reference (§14), so a forward
   * cannot wear an appointment: the affordance is disabled with its reason.
   */
  const [later, setLater] = useState<LaterStep | null>(null);
  const laterInline = later !== null && !phonePill;
  /* WHETHER THE AFFORDANCE IS THERE AT ALL — one predicate, two reasons (`sendLaterOffered`): a
     forward cannot wear an appointment, and the standalone door keeps none. Withheld rather than
     refused after the pick, and the sentence below says which it is. */
  const filesKept = w.actions.scheduleFilesKept();
  const laterOffered = sendLaterOffered({
    standalone: w.standalone, forward, hasAttachments: attachments.length > 0, filesKept: filesKept?.kept === true,
  });
  /* A picker open when a file arrives that this door cannot keep closes: its times would go without it. */
  useEffect(() => { if (!laterOffered) setLater(null); }, [laterOffered]);
  /* SEND + DONE's own offer — the engine's rule about the SOURCE, asked through the world layer
     so the paired door and the standalone door get the same answer from the same reader. */
  /* A parent-less mail has no source to finish, and `m` is null in that mode — the offer asks
     the engine only where there IS a source: the composer for a mail with no parent arrived
     after this rule was written, and the rule is "a reply or forward of an Ohbox message". */
  const andDoneOffered = m !== null && w.actions.sendAndDoneOffered(m.id);
  const [openedAt, setOpenedAt] = useState<Date>(() => new Date());
  /** The one refusal this picker can raise, said in place — the webapp's `role="status"` note. */
  const [pastNote, setPastNote] = useState(false);
  const zone = readerZone();
  /* An edit is a new question: the note about the last close no longer describes what is here. */
  useEffect(() => { setKeepNote(null); }, [body, subject, to, attachments.length]);
  /* A DRAFT OPENED HERE IS WRITTEN AS IT IS EDITED: two seconds after the last keystroke its row
     holds what is on screen, quietly, so leaving the app mid-sentence loses nothing. Only a bound
     sheet saves this way; a fresh one keeps on close. */
  const onScreen = wordsOf(letterWords);
  /* PAST THE DRAFT LIMIT no save can land (the server's 413): said while typing, never autosaved. */
  const tooLong = draftOverCeiling(body, html);
  /* By presence, not identity: the route builds the seed per render, and a new object must not reset the timer. */
  const bound = draft !== undefined;
  /** The snapshot a quiet save is carrying — one in flight per snapshot. */
  const savingFor = useRef<string | null>(null);
  const savesOutstanding = useRef(new Set<Promise<void>>());
  const latestDraft = useRef(draftId);
  latestDraft.current = draftId;
  /** The quiet save of a draft opened here, when one is owed; also run as the app leaves the foreground. */
  const quietSave = useRef<() => void>(() => undefined);
  quietSave.current = () => {
    if (keeping.current || discarding.current || !bound || draftId === null || phase !== "idle" || saved.current === onScreen || tooLong) return;
    if (savingFor.current === onScreen) return;
    const snapshot = onScreen;
    savingFor.current = snapshot;
    let row = draftId;
    /* Saved only once kept: a refused keep is the close's to keep again and to say (`autosaveKeep`).
       A forward draft is saved as a forward of its original, never as a new mail. */
    const saving = autosaveKeep(saved, onScreen, () => w.actions.draftKeep({
      mode: m !== null ? mode : "new", messageId: m?.id ?? null,
      mailboxId, to: addressed ? keptRecipients(to) : [], ...(addressed ? copiesToKeep(copies) : {}),
      subject, body, ...rich, files: 0, draftId, quiet: true, ...keptOnRow, ...forwardEnvelope, ...keptReplyEdits,
      revision: baseFor(base.current, draftId), waited: waitedFor(base.current, draftId), forked: () => setForked(true),
      rebind: setDraftId, row: (r) => { if (r.draftId !== null) { row = r.draftId; latestDraft.current = row; } rebase(r); },
    })).then(() => { if (saved.current === snapshot) keeper?.saved(row, snapshot, baseFor(base.current, row)); }).catch(() => undefined).finally(() => {
      if (savingFor.current === snapshot) savingFor.current = null;
      savesOutstanding.current.delete(saving);
    });
    savesOutstanding.current.add(saving);
  };
  useEffect(() => {
    if (discarding.current || !bound || draftId === null || phase !== "idle" || saved.current === onScreen || tooLong) return;
    const timer = setTimeout(() => {
      quietSave.current();
    }, DRAFT_AUTOSAVE_MS);
    return () => clearTimeout(timer);
    // `onScreen` is the fields' change; `quietSave` reads the rest when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bound, draftId, phase, onScreen, tooLong]);
  /* A PICK ON A DRAFT OPENED HERE moves its row: the row no longer holds what is on screen, so it is
     saved now and the close keeps it if that save did not land. */
  const savedFrom = useRef<string | null>(draft?.mailboxId ?? null);
  useEffect(() => {
    if (!bound || mailboxId === savedFrom.current) return;
    savedFrom.current = mailboxId;
    saved.current = null;
    savingFor.current = null;
    quietSave.current();
    // The pick is the change; `quietSave` reads the rest when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailboxId]);
  /* LEAVING THE FOREGROUND writes the letter now, and a draft opened here saves now: the next thing
     may be a force-stop. */
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") return;
      keeper?.flush();
      quietSave.current();
    });
    return () => sub.remove();
  }, [keeper]);
  /* THE ROW WAS SENT OR DELETED ON ANOTHER DEVICE — the mirror's word, read while this sheet is idle
     on it (its own send leaves the sheet). Held from that moment, because the keep that follows
     binds a NEW row; `at` is what the row held, so text typed after it is told apart from the letter. */
  const left = draftId !== null && phase === "idle" ? w.actions.draftLeft(draftId) : null;
  const [gone, setGone] = useState<{ why: "sent" | "deleted"; at: string } | null>(null);
  useEffect(() => {
    if (left !== null && gone === null) setGone({ why: left, at: saved.current ?? onScreen });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);
  const goneAt = gone?.at ?? null;
  const goneNote: FailedSendCopy | null = gone === null ? null
    : gone.why === "sent" ? "replySentElsewhere" : "replyDeletedElsewhere";
  const typedSinceGone = goneAt !== null && onScreen !== goneAt;

  /**
   * THE LOCKED COMPOSER SETTLES ITSELF. A queued send is retried by the world layer's
   * reconnect flush; when the ledger answers for THIS key, the composer follows: confirmed
   * closes it with the sent toast it was owed, a terminal rollback re-arms it (the queued
   * copy is gone, so a fresh Send cannot double-deliver). `w` re-derives on every flush
   * settle (`outcomeSeq`), which is what fires this without a mirror change.
   */
  useEffect(() => {
    if (phase !== "queued" || queuedKey === null) return;
    const settled = w.sendOutcome(queuedKey);
    const said = w.sendSettlement(queuedKey);
    // Confirmed: the flush already announced the send (kind-aware toast); this just closes.
    if (settled === "confirmed") {
      keeper?.drop();
      leave();
    }
    else if (settled === "rolled_back") {
      keeper?.sendAnswered({ outcome: "failed", ...(said.draftId !== null ? { draftId: said.draftId } : {}) });
      // The queued copy is gone with the rollback — a fresh Send cannot double-deliver.
      setQueuedKey(null);
      setAccepted(false);
      setRearmed(false);
      setPhase("idle");
      // …and the send did NOT go after all, so the too-late sentence may not stand over a
      // re-armed Send. Cleared with the phase that raised it.
      setAlreadySent(false);
      setCancelUnreachable(false);
      // The refusal left a row: the next press sends THAT row, never a second copy of one letter.
      if (said.draftId !== null) setDraftId(said.draftId);
      // The re-armed Send says why it is back, in the words the refusal earned.
      setFailNote(said.failure ?? "replyFailed");
      /* CHANGED ELSEWHERE: the row holds the other version; the words on screen are kept as a new draft. */
      if (changedElsewhere(said.failure)) {
        setDraftId(null);
        void w.actions.draftKeep({
          mode, messageId: m?.id ?? null, mailboxId, to: addressed ? keptRecipients(to) : [],
          ...(addressed ? copiesToKeep(copies) : {}), subject, body, ...rich, files: 0, draftId: null, quiet: true, ...keptOnRow, ...forwardEnvelope, ...keptReplyEdits,
          row: (r) => { if (r.draftId !== null) { setDraftId(r.draftId); rebase(r); } },
        }).then((kept) => { if (kept === "kept") setFailNote("replyChangedElsewhere"); });
      }
    }
    else if (settled === "unverified") {
      keeper?.sendAnswered({ outcome: "unverified", ...(said.draftId !== null ? { draftId: said.draftId } : {}) });
      if (said.draftId !== null) setHeldId(said.draftId);
      setPhase("unverified");
    }
    // Still queued: the server holds the send (sending, not waiting), or offered it again.
    else {
      if (said.accepted) setAccepted(true);
      if (said.rearmed) setRearmed(true);
    }
    // `unverified` stays locked: the server could not say whether the message left, so the
    // only honest controls are the check-Sent sentence (in place and toasted) and Cancel.
  }, [phase, queuedKey, w, onClose]);
  // EVERY typed entry must parse, or nothing sends. A filter that dropped the malformed
  // entry silently narrowed the audience — "alice@x, bob.x" sent to Alice alone with nobody
  // told — so an invalid entry LOCKS Send rather than shrinking the list. Entries split on
  // commas/semicolons (never bare spaces: `Alice <alice@x.org>` is ONE entry), and a
  // display-named entry is validated on the address its angle brackets carry.
  const typedAddressed = addressed || replyPeopleOpen;
  const recipients = typedAddressed ? parseRecipients(to) : [];
  /* NOTHING TO SEND — the webapp's `sendNeedsContent`, mirrored: empty body AND no attachments,
     except a forward (its content is the forwarded message). A signature never lights Send up
     on its own — the rule reads the body and the files, never the block. */
  const needsContent = phoneSendNeedsContent({ forward, body, attachmentCount: attachments.length });
  const sendCopies = typedAddressed ? copiesToSend(copies) : null;
  const canSend =
    phase === "idle" && !needsContent && (!typedAddressed || (recipients !== null && recipients.length > 0 && sendCopies !== null));
  /* CONTENT IS THE ONE THING MISSING — the webapp's told refusal: Send stays pressable, dressed
     unlit, and the press earns the sentence instead of doing nothing. Every stronger lock
     (sending, queued, unverified) keeps the dead press. */
  const contentOnlyMissing = phase === "idle" && needsContent;
  const pressAct = sendPressAct({ canSend, contentOnlyMissing, phase });
  const held = heldSheetFooter({ phase, heldId, busy: againBusy });
  /* SEND AGAIN, on the held row: the message goes only once it went, and the sheet closes then. */
  const sendAgain = async (row: string) => {
    if (againBusy) return;
    setAgainBusy(true);
    setAgainSaid(null);
    const outcome = await w.actions.draftSendAgain(row);
    setAgainBusy(false);
    if (outcome === "sent" || outcome === "alreadySent" || outcome === "superseded") {
      keeper?.drop();
      leave();
      return;
    }
    setAgainSaid(outcome);
  };
  const press = (act: typeof pressAct, andDone = false) => {
    if (discarding.current) return;
    if (act === "send") void send(null, andDone);
    else if (act === "needContent") setNeedNote(true);
    else if (act === "again") setAgainNote(true);
  };

  /**
   * WHAT THE BLOCK SHOWS — and exactly what the send appends (`effectiveSignature`, one
   * derivation, two consumers). The sending mailbox: the one the message arrived in for a reply
   * or forward (what `Engine.enrich` puts on the wire), the resolved From for a new mail.
   * `w.signatures === null` (not yet server-confirmed) renders no block and appends nothing: a
   * signature is never drawn or serialized from a guess.
   */
  const sigText =
    w.signatures === null || sendFrom === null ? null : effectiveSignature(sig, w.signatures, sendFrom);
  const sigHtml = sigText === null ? null : effectiveSignatureHtml(sig, w.signing?.html ?? {}, sendFrom);

  /**
   * The three presets, computed off the frozen `openedAt`. The evening one is OFFERED ONLY
   * while it is meaningfully ahead — past ~17:57 "this evening at 18:00" is a promise measured
   * in seconds, and the honest menu simply omits it (the webapp's `eveningUsable`).
   */
  /* WITH FILES, a server keeps them only so far ahead (`scheduleFilesDays`): no later day or hour is offered. */
  const laterDays = attachments.length > 0 && filesKept?.kept === true ? filesKept.days : null;
  const laterEnd = sendLaterHorizon(openedAt, laterDays);
  const withinLater = (at: Date): boolean => inSendLaterHorizon(at, laterEnd);
  const eveningAt = todayEvening(openedAt).instant;
  const eveningUsable = eveningAt.getTime() - openedAt.getTime() > SEND_LATER_MIN_LEAD_MS && withinLater(eveningAt);
  const mornings = sendLaterMornings(openedAt, zone);
  const openLater = () => {
    if (!phonePill) Keyboard.dismiss();
    setOpenedAt(new Date());
    setPastNote(false);
    setLater({ step: "presets" });
  };
  /**
   * A PICKED INSTANT, RE-JUDGED AGAINST THE REAL CLOCK. The rows cannot name a past instant
   * when they are drawn, but they were drawn at `openedAt`; a sheet left open across the
   * preset's own time would otherwise dispatch an appointment the server refuses. Refused
   * here, in words, with nothing on the wire — the server's refusal against ITS clock remains
   * the authority.
   */
  const pickLater = (at: Date) => {
    /**
     * One press is one delivery — the picker's half of that invariant. Send and the picker
     * stand side by side, so a reader can open the chooser, press Send, then tap a preset
     * while the first request is still out. `canSend` locks the Send button on `phase`, but
     * the picker's rows are their own dispatch site: without this the second press mints a
     * fresh Idempotency-Key, and the reply is delivered AND a second copy scheduled. The
     * picker also closes on dispatch (see `send`) — the two together mean neither a stale
     * open panel nor a fast thumb can produce a second key.
     */
    if (phase !== "idle") {
      setLater(null);
      return;
    }
    if (at.getTime() - Date.now() < SEND_LATER_MIN_LEAD_MS) {
      // Back to the preset menu, recomputed against now — so the row that went stale is gone
      // and the sentence says why, rather than the press appearing to do nothing.
      setOpenedAt(new Date());
      setPastNote(true);
      setLater({ step: "presets" });
      return;
    }
    setPastNote(false);
    setLater(null);
    void send(at.toISOString());
  };

  const keepRequest = (files: number, dropped: number): DraftKeep => {
    const target = latestDraft.current;
    keeper?.markKeep(target);
    return {
      mode, messageId: m?.id ?? null, mailboxId, to: addressed ? keptRecipients(to) : [],
      ...(addressed ? copiesToKeep(copies) : {}), subject, body, ...rich, files, dropped, draftId: target,
      quiet: target !== null, ...keptOnRow, ...forwardEnvelope, ...keptReplyEdits,
      revision: baseFor(base.current, target), waited: waitedFor(base.current, target),
      row: (r) => {
        rebase(r);
        keeper?.keepAnswered(r, onScreen);
        if (r.draftId !== null && r.draftId !== latestDraft.current) {
          latestDraft.current = r.draftId;
          if (mounted.current) setDraftId(r.draftId);
        }
      },
    };
  };

  /**
   * EVERY ROAD OUT OF THIS SHEET — the button, the scrim, the back gesture. Over a queued send
   * the close KEEPS it: the send stands under its one key and goes when the network is back, and
   * the sheet's caption is said as it goes. Only {@link cancelSend} withdraws.
   */
  const latestClose = useRef<{ words: string; retry: () => void } | null>(null);
  const closeComposer = () => {
    if (discarding.current || keeping.current) return;
    if (discardAsked) { setDiscardAsked(false); return; }
    // An open suggestion list is the inner state Back steps out of first.
    if (stepBack(suggestionsBack)) return;
    if (savesOutstanding.current.size > 0) {
      keeping.current = true;
      void Promise.all(savesOutstanding.current).then(() => {
        keeping.current = false;
        latestClose.current?.retry();
      });
      return;
    }
    const way = cancelAct({ road: "close", phase, key: queuedKey, alreadySent, cancelOwed: cancelUnreachable });
    if (way === "keepSend") {
      w.actions.leaveSend(queuedKey!);
      toast.say(keptSay(queuedCaptionKey(network, accepted, rearmed)));
      // The letter keeps its send's key: the flush or the next launch settles it.
      keeper?.release();
      leave();
      return;
    }
    if (way === "close") {
      /* The second close after the files were named keeps the letter without them. */
      const dropped = keepNote === "files" ? filesOver.length : 0;
      if (dropped > 0) {
        keeper?.dropOverLimit();
        const kept = new Set(keeper?.current().files.map((f) => f.fileId));
        setAttachments((list) => list.filter((a) => a.fileId === undefined || kept.has(a.fileId)));
      }
      const files = keeper?.current().files.length ?? 0;
      /* A bound draft keeps exactly what is on screen, emptied included; unchanged, it just closes,
         its files staying with it on this phone. After a Cancel the server could not answer the words
         are kept too, except standalone, whose engine already wrote them into a row. */
      const target = latestDraft.current;
      const worth = target !== null ? saved.current !== onScreen
        : worthKeeping({ fresh, subject, body, files }) || hasEnvelopeEdits(letterWords, keptRecipients);
      const cancelOwed = cancelUnreachable && !alreadySent && !w.standalone;
      const over = dropped > 0 ? [] : keeper?.overKeepLimit() ?? [];
      const act = keepAct({
        phase, worth, filesOver: over.length, armed: keepNote === "files" && dropped === 0, tooLong, cancelOwed,
      });
      if (act === "close") {
        // Nothing worth a row, or discarded: the letter goes; a bound draft's or a send's stays.
        if (phase === "idle" && target === null && !cancelOwed) keeper?.drop();
        else keeper?.release();
        if (mounted.current) leave();
        return;
      }
      if (act === "tooLong") {
        setKeepNote("tooLong");
        return;
      }
      if (act === "ask") {
        setFilesOver(over.map((f) => f.filename));
        setKeepNote("files");
        return;
      }
      keeping.current = true;
      void (async () => {
        const kept = await autosaveKeep(saved, onScreen, () => w.actions.draftKeep({
          ...keepRequest(files, dropped),
        }).catch(() => "refused" as const));
        keeping.current = false;
        if (kept === "kept") {
          const latest = latestClose.current;
          if (latest && latest.words !== onScreen) {
            if (latestDraft.current !== null) {
              latest.retry();
              return;
            }
            // A queued create will bind the device letter on reconnect and save its later edits.
            if (keeper?.current().keep?.key == null) {
              setKeepNote("failed");
              return;
            }
          }
          keeper?.release();
          if (mounted.current) leave();
        } else {
          keeper?.keepAnswered(null);
          setKeepNote(kept === "tooLong" ? "tooLong" : "failed");
        }
      })();
    }
  };

  latestClose.current = { words: onScreen, retry: closeComposer };

  /**
   * CANCEL SEND, the one way to withdraw a queued send. A withdrawal the engine refuses because the
   * request has already left says so and STAYS, and the press after that dismisses (`cancelAct`'s
   * `alreadySent` arm).
   */
  const cancelSend = () => {
    if (cancelAct({ road: "cancelSend", phase, key: queuedKey, alreadySent }) !== "withdraw") {
      closeComposer();
      return;
    }
    void (async () => {
      const key = queuedKey!;
      // Read before the withdrawal ends the waiting send: the row its press wrote.
      const row = waitingRowOf(w.drafts, key);
      const end = await cancelSendPress({
        asking: withdrawing, withdraw: () => w.actions.withdrawSend(key), verdict: () => w.sendOutcome(key),
        standalone: w.standalone && row !== null, bound: draftId !== null,
      });
      if (end === null) return;
      if (end.said === "close") {
        if (end.say !== null) toast.say(end.say);
        /* Withdrawn: the files stay with the row that holds the words, if one does. */
        if (end.say !== null) keeper?.cancelled(draftId ?? row);
        else keeper?.release();
        leave();
      }
      else if (end.said === "already_sent") setAlreadySent(true);
      else setCancelUnreachable(true);
    })();
  };

  atUnmount.current = () => {
    if (discarding.current) return;
    const keep = () => {
      // Nobody is left to ask about files past the phone's limit: the keep goes without them.
      keeper?.dropOverLimit();
      const files = keeper?.current().files.length ?? 0;
      const target = latestDraft.current;
      const worth = target !== null ? saved.current !== onScreen
        : worthKeeping({ fresh, subject, body, files }) || hasEnvelopeEdits(letterWords, keptRecipients);
      if (unmountKeep({ phase, worth, keeping: keeping.current, tooLong }) === "keep") {
        void w.actions.draftKeep({ ...keepRequest(files, 0), quiet: true }).then((kept) => {
          if (kept !== "kept") keeper?.keepAnswered(null);
        });
      }
      keeper?.release();
    };
    if (!keeping.current && savesOutstanding.current.size > 0) {
      keeper?.flush();
      void Promise.all(savesOutstanding.current).then(keep);
    } else keep();
  };

  /* OVER A LETTER SENT ELSEWHERE A PRESS IS ANSWERED IN WORDS; only the offer sends, and it sends
     the text as a new letter — the row a keep bound since, or none, never the sent one. */
  const send = async (sendAt: string | null = null, andDone = false, asNew = false) => {
    if (keeping.current || discarding.current || !canSend) return;
    if (forwardPlan?.refusal) { setForwardNote(forwardPlan.refusal); return; }
    if (goneNote !== null && !asNew) { setFailNote(goneNote); return; }
    // The picker closes the moment ANY send is dispatched — a panel left standing over a
    // message that is already on its way offers rows for an act that may no longer happen.
    setLater(null);
    setPhase("sending");
    setFailNote(null);
    const files = toComposeAttachments(attachments);
    const markupArgs: [html?: string | null, signatureHtml?: string] =
      sigHtml !== null ? [html, sigHtml] : html === undefined ? [] : [html];
    const replyArgs: [html?: string | null, signatureHtml?: string, fromMailboxId?: string, edits?: ReplyEdits] =
      replyPeopleOpen || replySubjectEdited ? [html, sigHtml ?? undefined, replyFrom, {
        ...(replyPeopleOpen && recipients !== null && sendCopies !== null
          ? { replyEnvelope: { to: recipients, ...sendCopies } } : {}),
        ...(replySubjectEdited ? { replySubject: subject } : {}),
      }] : replyFrom === undefined ? markupArgs : [html, sigHtml ?? undefined, replyFrom];
    const toRow = async (draftId: string | null) => fresh
      ? await w.actions.sendNew(sendFrom, recipients ?? [], subject, body, sigText, sendAt, files, draftId, sendCopies ?? undefined, baseFor(base.current, draftId), waitedFor(base.current, draftId), ...markupArgs)
      : forward
        ? await w.actions.sendForward(m!.id, recipients ?? [], body, sigText, files, andDone, forwardConfirmed, draftId,
          { mailboxId: sendFrom, subject, ...sendCopies, ...(forwardPlan?.wire !== undefined ? { forwardParts: forwardPlan.wire } : {}) },
          baseFor(base.current, draftId), waitedFor(base.current, draftId), ...markupArgs)
        : await w.actions.sendReply(m!.id, body, mode === "replyAll", sigText, sendAt, files, andDone, draftId,
          baseFor(base.current, draftId), waitedFor(base.current, draftId), ...replyArgs);
    const target = asNew && draftId !== null && w.actions.draftLeft(draftId) !== null ? null : draftId;
    const press = () => toRow(target);
    /* The reader under this sheet shows the sent copy once it is drawn (`sent-reveal.ts`). */
    const answered = !fresh && m ? m.id : null;
    if (answered !== null) noteReplySend(answered, "pressed");
    /* MARKED BEFORE THE DISPATCH: a hard stop from here on leaves the next launch a sent letter, which
       it never sends again (`compose/letter-restore.ts`). */
    const envelopeMark = {
      draftId: target,
      mailboxId: sendFrom ?? undefined,
      ...(forward ? { forwardParts: forwardPlan?.wire ?? null } : {}),
    };
    const result = keeper ? await keeper.sendVia(press, sigText, sigHtml, envelopeMark) : await press();
    // `superseded`: a newer press of this reply carries it and says its sentence.
    if (result.outcome === "sent" || result.outcome === "superseded") {
      if (answered !== null && result.outcome === "sent") noteReplySend(answered, "sent");
      leave();
      return;
    }
    if (result.outcome === "queued") {
      setQueuedKey(result.key ?? null);
      setAccepted(result.accepted === true);
      setRearmed(result.rearmed === true);
      setPhase("queued");
      return;
    }
    // `unverified` LOCKS the composer exactly like queued, for the opposite reason: the
    // server could not say whether the message left, so a fresh-key re-send is the
    // duplicate-delivery door. Only a plain failure re-arms Send.
    setPhase(result.outcome === "unverified" ? "unverified" : "idle");
    if (result.outcome === "unverified" && result.draftId) setHeldId(result.draftId);
    // A refused send binds the row it left and says why, here: nothing outside this sheet shows.
    if (result.outcome === "failed" && result.draftId) setDraftId(result.draftId);
    if (result.outcome === "failed" && result.draftId) rebase({ draftId: result.draftId, ...(result.revision ? { revision: result.revision } : {}) });
    // Changed elsewhere with no new row to name: the row holds the other version, and is not this letter's.
    else if (result.outcome === "failed" && changedElsewhere(result.failure)) setDraftId(null);
    if (result.outcome === "failed" && result.failure) setFailNote(result.failure);
  };

  /* THE SENTENCES ABOVE THE BUTTONS, each answering a press or saying why a control is absent: the
     toast and the top bar render under this Modal, so a sentence said only there was a press with no
     answer. Pinned up to `pinnedNotesMax`; past it they scroll at the letter's end, scrolled to. */
  const noteItems = [
    discardRefused ? <Txt key="discard" variant="note" accessibilityRole="alert">{refusalSentence(discardRefused)}</Txt> : null,
    replyAside ? (
      <Txt key="replyAside" variant="caption" tone="ink3">
        {Copy.composeReplyAside}
      </Txt>
    ) : null,
    gone !== null ? (
      <Txt key="leftElsewhere" variant="caption" tone="ink2" accessibilityRole="alert">
        {gone.why === "sent" ? Copy.composeSentElsewhere : Copy.composeDeletedElsewhere}
      </Txt>
    ) : null,
    goneNote !== null && typedSinceGone && failNote === goneNote ? (
      <Button key="sendAsNew" label={Copy.composeSendAsNew} variant="quiet" disabled={!canSend} onPress={() => { void send(null, false, true); }} />
    ) : null,
    phase === "queued" || phase === "unverified" ? (
      <Txt key="queued" variant="caption" tone="ink3">
        {phase === "queued" ? Copy[queuedCaptionKey(network, accepted, rearmed)] : Copy.replyUnverified}
      </Txt>
    ) : null,
    held.sendAgain !== null ? (
      <Txt key="sendAgain" variant="caption" tone="ink3">
        {Copy.replyUnverifiedSendAgain}
      </Txt>
    ) : null,
    phase === "unverified" && againSaid !== null && againSaid !== "unverified" ? (
      <Txt key="againSaid" variant="caption" tone="ink2" accessibilityRole="alert">
        {sendAgainSentence(againSaid)}
      </Txt>
    ) : null,
    phase === "unverified" && againNote ? (
      <Txt key="again" variant="caption" tone="ink2" accessibilityRole="alert">
        {Copy.replyUnverifiedAgain}
      </Txt>
    ) : null,
    /* A refused Cancel, said in place — a Cancel that rendered nothing is a button not working. */
    alreadySent ? (
      <Txt key="alreadySent" variant="caption" tone="ink2" accessibilityRole="alert">
        {Copy.replyAlreadySent}
      </Txt>
    ) : null,
    cancelUnreachable && !alreadySent ? (
      <Txt key="cancelUnreachable" variant="caption" tone="ink2" accessibilityRole="alert">
        {Copy.replyCancelUnreachable}
      </Txt>
    ) : null,
    /* The told refusal: a Send lacking only content earned a sentence, gone once content arrives. */
    needNote && needsContent ? (
      <Txt key="needContent" variant="caption" tone="ink2" accessibilityRole="alert">
        {Copy.composeNeedContent}
      </Txt>
    ) : null,
    forwardNote !== null && forwardPlan?.refusal ? (
      <Txt key="forwardFiles" variant="caption" tone="ink2" accessibilityRole="alert">
        {sayRefusal(forwardPlan.refusal)}
      </Txt>
    ) : null,
    failNote !== null && phase === "idle" ? (
      <Txt key="failed" variant="caption" tone="ink2" accessibilityRole="alert">
        {failedSendLine(failNote, w.boot.connection, draftId !== null)}
      </Txt>
    ) : phase === "idle" && connectionSaid(w.boot.connection) !== null ? (
      <Txt key="connection" variant="caption" tone="ink3">
        {connectionSaid(w.boot.connection)}
      </Txt>
    ) : null,
    /* Why the close stayed — nothing typed is thrown away without the person being told. A draft
       opened from Drafts says the row still holds its earlier words. */
    keepNote !== null ? (
      <Txt key="keep" variant="caption" tone="ink2" accessibilityRole="alert">
        {keepNote === "failed" ? Copy.composeKeepFailed
          : keepNote === "files" ? Copy.composeKeepFiles(filesOver.join(", "), sizeLabel(KEPT_FILES_MAX_BYTES))
            : bound && draftId !== null ? Copy.composeKeepTooLongBound(draftLimitLabel())
              : Copy.composeKeepTooLong(draftLimitLabel())}
      </Txt>
    ) : tooLong ? (
      /* Past the limit, while typing — the web's `compose.bodyTooLong`. */
      <Txt key="tooLong" variant="caption" tone="ink2" accessibilityRole="alert">
        {Copy.composeTooLong(draftLimitLabel())}
      </Txt>
    ) : null,
  ].filter((n) => n !== null);
  if (forked) {
    noteItems.unshift(
      <Txt key="forked" variant="caption" tone="ink2" accessibilityRole="alert">
        {Copy.composeKeptChangedElsewhere}
      </Txt>,
    );
  }
  const mailTool = (label: string, onPress: () => void, icon: IconName, expanded?: boolean) => {
    const disabled = phase !== "idle";
    if (!phonePill) {
      return <Button label={label} icon={icon === "clip" ? icon : undefined} variant="quiet" disabled={disabled} onPress={onPress} />;
    }
    const style = {
      width: 38, height: mailSize.action, alignItems: "center", justifyContent: "center",
      borderRadius: t.radius.pill, backgroundColor: icon === "clip" || expanded === true ? t.c.tint2 : "transparent",
    } as const;
    const glyph = <Icon name={icon} size={16} color={t.c.ink2} />;
    return expanded === undefined ? (
      <Tap accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={style}>
        {glyph}
      </Tap>
    ) : (
      <Tap accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: expanded === true }}
        disabled={disabled} onPress={onPress} style={style}>
        {glyph}
      </Tap>
    );
  };
  const notesBlock = noteItems.length === 0 ? null : (
    <View style={{ gap: 10 }} onLayout={(e) => setNotesHeight(Math.round(e.nativeEvent.layout.height))}>
      {noteItems}
    </View>
  );
  /* Every sentence cleared: forget their height, or the next one draws a frame at the letter's end. */
  if (notesMeasured(notesHeight, noteItems.length) !== notesHeight) setNotesHeight(null);

  const discardDraft = async () => {
    if (phase !== "idle" || discarding.current || keeping.current) return;
    discarding.current = true;
    Keyboard.dismiss();
    setDiscardPending(true);
    try {
      await Promise.all(savesOutstanding.current);
      const id = latestDraft.current;
      if (id !== null) {
        const verdict = await w.actions.draftDiscard(id);
        if (verdict !== "discarded" && verdict !== "queued") {
          if (verdict === "stillSending" || verdict === "alreadySent" || verdict === "cancelUnknown") setDiscardRefused(verdict);
          return;
        }
      }
      keeper?.drop();
      leave();
    } finally {
      discarding.current = false;
      setDiscardPending(false);
      setDiscardAsked(false);
    }
  };
  const canPickFrom = fromAddress !== null && sender.choices.length > 1;
  const fromFace = fromAddress === null ? null : canPickFrom ? (
    <Tap accessibilityRole="button" accessibilityLabel={Copy.composeFromChange(fromAddress)}
      accessibilityState={{ expanded: fromOpen, disabled: phase !== "idle" }}
      onPress={() => { if (phase === "idle") setFromOpen(!fromOpen); }}
      style={{
        flexDirection: "row", alignItems: "center", alignSelf: "flex-start", maxWidth: "100%", gap: 4,
        borderRadius: t.radius.pill, paddingVertical: 4,
        ...(paperEditor ? { backgroundColor: t.c.tint2, paddingHorizontal: 7 } : {}),
      }}>
      <Txt variant={paperEditor ? "button" : "caption"} tone={paperEditor ? "ink" : "ink2"} numberOfLines={1}
        style={{ flexShrink: 1 }}>{paperEditor ? fromAddress : Copy.composeFrom(fromAddress)}</Txt>
      <View style={{ transform: [{ rotate: fromOpen ? "-90deg" : "90deg" }] }}>
        <Icon name="chev" size={11} color={t.c.ink3} />
      </View>
    </Tap>
  ) : (
    <Txt variant={paperEditor ? "button" : "caption"} tone={paperEditor ? "ink" : "ink3"} numberOfLines={1}
      style={paperEditor ? { paddingVertical: 4 } : undefined}>
      {paperEditor ? fromAddress : Copy.composeFrom(fromAddress)}
    </Txt>
  );
  const senderRows = canPickFrom && fromOpen && phase === "idle" ? (
    <View accessibilityRole="radiogroup" accessibilityLabel={Copy.composeFromList} style={{ gap: phonePill ? 0 : 2 }}>
      {sender.choices.map((c) => {
        const checked = c.id === sendFrom;
        const address = displayAddress(c.address);
        const name = w.mailboxes.all.find((mailbox) => mailbox.id === c.id)?.displayName?.trim();
        return (
          <Tap key={c.id} accessibilityRole="radio" accessibilityState={{ checked: checked === true }} accessibilityLabel={address}
            onPress={() => { if (!checked) setPicked(c.id); setFromOpen(false); }}
            style={({ pressed }) => ({
              flexDirection: "row", alignItems: "center", gap: 4, minHeight: phonePill ? mailSize.menuRowHeight : mailSize.action,
              paddingHorizontal: phonePill ? mailSize.menuRowInset : 2, borderRadius: t.radius.row,
              backgroundColor: pressed ? t.c.tint : "transparent",
            })}>
            <Txt variant={phonePill ? "button" : "body"} numberOfLines={1} style={{ flexShrink: 1 }}>{address}</Txt>
            {checked ? (
              phonePill
                ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.c.ink }} />
                : <Icon name="check" size={14} color={t.c.accentInk} />
            ) : null}
            {name ? <Txt variant="caption" tone="ink2" numberOfLines={1} style={{ flexShrink: 1 }}>{name}</Txt> : null}
          </Tap>
        );
      })}
    </View>
  ) : null;
  const askDiscard = () => { setDiscardRefused(null); setDiscardAsked(true); };
  const discardButton = (
    <Button label={Copy.draftsDiscard} icon="trash" variant="quiet"
      style={paperEditor ? { paddingHorizontal: 6, gap: 4 } : undefined}
      onPress={askDiscard} />
  );
  const closeButton = cancelSendOffered({ phase, key: queuedKey, alreadySent }) ? (
    <Button label={Copy.cancelSend} variant="quiet" onPress={cancelSend} style={{ marginRight: "auto" }} />
  ) : held.close === "close" ? (
    /* Over a held send the close leaves the message in Drafts: Close, not Cancel. */
    <Button label={Copy.replyUnverifiedClose} variant="quiet" onPress={closeComposer} style={{ marginRight: "auto" }} />
  ) : paperEditor && phase === "idle" ? (
    discardButton
  ) : (
    <Button label={Copy.replyCancel} icon={inline ? "x" : undefined} variant="quiet" onPress={closeComposer} style={{ marginRight: "auto" }} />
  );
  const laterButton = laterOffered ? (
    <Button
      label={Copy.sendLater}
      variant={paperEditor ? "quiet" : "plain"}
      icon={paperEditor ? "clock" : undefined}
      style={paperEditor ? { paddingHorizontal: 6, gap: 4 } : undefined}
      disabled={!canSend}
      onPress={openLater}
    />
  ) : null;
  const doneButton = andDoneOffered && !doneOnSend ? (
    <Button
      label={Copy.sendAndDone}
      icon={paperEditor ? "check" : undefined}
      variant={paperEditor ? "quiet" : "plain"}
      style={paperEditor ? { paddingHorizontal: 6, gap: 4 } : undefined}
      disabled={pressAct === "none"}
      onPress={() => press(pressAct, true)}
    />
  ) : null;
  const sendButton = held.sendAgain !== null ? (
    <Button
      label={Copy.draftsSendAgain}
      variant="solid"
      disabled={held.sendAgain.locked}
      onPress={() => { void sendAgain(held.sendAgain!.draftId); }}
    />
  ) : (
    <Button
      label={phase === "sending" ? Copy.replySending : run ? Copy.replyRunSendNext : doneOnSend ? Copy.sendAndDone : Copy.replySend}
      accessibilityLabel={run && phase !== "sending" ? Copy.sendAndDone : undefined}
      icon={paperEditor ? "send" : undefined}
      style={paperEditor ? { paddingHorizontal: 8, gap: 4 } : undefined}
      appearance={phonePill && phase === "idle" && pressAct !== "send" ? {
        color: mailColors(t)["on-off"], surface: { backgroundColor: mailColors(t).off }, text: t.type.button,
      } : undefined}
      variant="solid"
      disabled={pressAct === "none"}
      onPress={() => press(pressAct, doneOnSend)}
    />
  );
  const bottom = mailSize.inset + (keyboardHeight > 0 ? 0 : insets.bottom);
  const keyboardSpace = Platform.OS === "android" ? composerKeyboardLift : keyboardHeight;
  const compactVerbs = !fresh || (keyboardHeight > 0 && windowHeight - keyboardSpace - insets.top - mailSize.back < 200);
  const visibleBodyHeight = letterHeight === 0 ? bodyHeight : Math.min(bodyHeight, Math.max(0, letterHeight - 12));
  const openTools = phase === "idle" && later === null ? tools : null;
  const formatPreview = html && (formatOpen || openTools === "format") ? <Txt variant="body" style={{ width: "100%" }}>{runs?.map((run, index) => (
    <Txt key={index} variant={run.marks.includes("strong") ? "rowSubject" : "body"} style={{
      fontStyle: run.marks.includes("em") ? "italic" : undefined,
      textDecorationLine: run.marks.includes("u") ? "underline" : undefined,
    }}>{run.text}</Txt>
  ))}</Txt> : null;
  const formatControls = phonePill && formatOpen && phase === "idle" ? (
    <View accessibilityLabel={Copy.composeFormat} style={{
      flexDirection: "row", alignItems: "center", backgroundColor: t.c.tint2, borderRadius: t.radius.row,
    }}>
      {([
        ["B", Copy.composeBold, "strong", { fontWeight: "700" }],
        ["I", Copy.composeItalic, "em", { fontStyle: "italic" }],
        ["U", Copy.composeUnderline, "u", { textDecorationLine: "underline" }],
      ] as const).map(([glyph, label, mark, style]) => (
        <Tap key={mark} accessibilityRole="button" accessibilityLabel={label} onPress={() => formatting(mark)}
          style={{ width: mailSize.action, height: mailSize.action, alignItems: "center", justifyContent: "center" }}>
          <Txt variant="button" style={style}>{glyph}</Txt>
        </Tap>
      ))}
      <Txt variant="caption" tone="ink2" style={{ flexShrink: 1 }}>{Copy.composeFormatSelect}</Txt>
    </View>
  ) : null;
  const headerLine = [composeLine, { minHeight: mailSize.action }];
  const headerLabel = { width: composeLabelWidth };

  const laterPreset = (word: (time?: string) => string, at: Date) => {
    const time = scheduleLabel(at.toISOString(), openedAt, zone, locale);
    return <SheetRow label={phonePill ? word() : word(time)} detail={phonePill ? time : undefined} onPress={() => pickLater(at)} />;
  };
  const laterChoices = later === null ? null : (
    <>
      {later.step === "presets" ? (
        <>
          {eveningUsable ? laterPreset(Copy.sendLaterTonight, eveningAt) : null}
          {withinLater(mornings.tomorrow) ? laterPreset(Copy.sendLaterTomorrow, mornings.tomorrow) : null}
          {mornings.monday && withinLater(mornings.monday) ? laterPreset(Copy.sendLaterMonday, mornings.monday) : null}
          <SheetRow
            icon={phonePill ? undefined : "chev"}
            label={Copy.sendLaterPick}
            onPress={() => { setPastNote(false); setLater({ step: "days" }); }}
          />
        </>
      ) : later.step === "days" ? (
        /* THE DAYS. A quarter ahead — the resurface chooser's own span and its own
           reason (a fortnight was an exclusion nothing on screen admitted). TODAY is
           offered only while some hour on it is still far enough ahead to be worth
           naming, which is the same lead rule the evening preset lives under. */
        <ScrollView style={{ maxHeight: 208 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {horizonDays(openedAt, laterEnd).map((offset) => (
            <SheetRow
              key={offset}
              icon="chev"
              label={dayLabel(dayNine(openedAt, offset), locale)}
              onPress={() => setLater({ step: "hours", offset })}
            />
          ))}
        </ScrollView>
      ) : (
        /* THE HOURS on the chosen day, filtered by the lead so no row on screen can
           name a moment already gone. The set is the product's own clock vocabulary
           widened for sending: the 09:00 the horizons fix, the 18:00 the evening
           preset fixes, and the four ordinary hours between and around them. */
        <ScrollView style={{ maxHeight: 208 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {horizonHours(openedAt, later.offset, laterEnd).map((hour) => {
            const at = dayAtHour(openedAt, later.offset, hour).instant;
            return (
              <SheetRow
                key={hour}
                label={scheduleLabel(at.toISOString(), openedAt, zone, locale)}
                onPress={() => pickLater(at)}
              />
            );
          })}
        </ScrollView>
      )}
      {/* A PAST PICK IS REFUSED HERE, in words, before anything goes on the wire —
          and the zone is stated plainly, because "18:00" is only half a fact. */}
      {pastNote ? (
        <Txt
          variant="caption"
          tone="ink2"
          accessibilityRole="alert"
          style={{ paddingHorizontal: 14, paddingTop: 6 }}
        >
          {Copy.sendLaterPast}
        </Txt>
      ) : null}
      {!phonePill ? (<Txt variant="caption" tone="ink3" style={{ paddingHorizontal: 14, paddingTop: 6, paddingBottom: 2 }}>
        {Copy.sendLaterZone(zone)}
      </Txt>) : null}
      {laterDays !== null ? (
        <Txt variant="caption" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 2 }}>
          {Copy.sendLaterFilesDays(laterDays)}
        </Txt>
      ) : null}
      {/* BACK unwinds ONE step — the escape cascade's rule (close the innermost thing
          that is open), which on the last step closes the picker itself. */}
      {later.step !== "presets" || !phonePill ? <SheetRow
        icon="x"
        label={Copy.sendLaterClose}
        onPress={() =>
          setLater(
            later.step === "presets" ? null
              : later.step === "days" ? { step: "presets" }
                : { step: "days" },
          )
        }
      /> : null}
    </>
  );
  const menuKind = !phonePill ? null
    : senderRows ? "from"
      : later !== null ? "later"
        : openTools === "more" || openTools === "attachment" || openTools === "emoji" ? openTools : null;
  const closeMenu = () => {
    if (menuKind === "from") setFromOpen(false);
    else if (menuKind === "later") setLater(null);
    else setTools(null);
  };
  const requestClose = menuKind === null ? closeComposer : closeMenu;
  const menuTitle = menuKind === "from" ? Copy.composeFromLabel
    : menuKind === "emoji" ? Copy.composeEmoji
      : menuKind === "attachment" ? Copy.composeFileTools
        : menuKind === "later" ? Copy.sendLater : undefined;
  const showInlineMore = () => {
    writerFocus.current = messageActions && keyboardHeight > 0 ? focusKeeper.capture() : null;
    setTools("more");
  };
  const restoreWriterFocus = () => {
    const restore = writerFocus.current;
    writerFocus.current = null;
    if (mounted.current) restore?.();
  };
  const runAfterMore = (press: () => void) => {
    if (afterMore.current !== null) return;
    // UIKit must finish dismissing this menu before another native sheet can present.
    if (Platform.OS === "ios") afterMore.current = press;
    closeMenu();
    if (Platform.OS !== "ios") press();
  };
  const finishMore = () => {
    const press = afterMore.current;
    afterMore.current = null;
    press?.();
  };
  const closeMore = () => {
    if (writerFocus.current === null) closeMenu();
    else runAfterMore(restoreWriterFocus);
  };
  const drawMenu = (rows?: ReactNode) => menuKind === null && afterMore.current === null ? null : (
    <Sheet open={menuKind !== null} phoneMenu={menuKind === "later" ? "card" : true} inlineAnchor={!inline}
      onDismiss={rows && Platform.OS === "ios" ? finishMore : undefined}
      label={menuTitle ?? Copy.tabMore} title={menuTitle}
      aside={menuKind === "later" ? zone : undefined}
      anchor={menuKind === "more" && !inline ? moreAnchor : undefined} anchorAlign="end"
      anchorSide={menuKind === "more" && !inline ? "above" : undefined}
      onClose={menuKind === "more" && inline ? closeMore : closeMenu}>
      {menuKind === "from" ? senderRows : null}
      {menuKind === "later" ? laterChoices : null}
      {menuKind === "more" ? (
        <>
          {laterOffered ? <SheetRow label={Copy.sendLater} icon="clock" disabled={!canSend}
            onPress={() => { closeMenu(); openLater(); }} /> : null}
          <SheetRow label={Copy.draftsDiscard} icon="trash" onPress={() => { closeMenu(); askDiscard(); }} />
          {rows}
        </>
      ) : null}
      {menuKind === "attachment" ? (
        <>
          <SheetRow label={Copy.attachFile} icon="clip" onPress={() => { closeMenu(); void pick("files"); }} />
          <SheetRow label={Copy.attachPhoto} onPress={() => { closeMenu(); void pick("photos"); }} />
          <Txt variant="caption" tone="ink3" style={{ padding: mailSize.inset }}>{Copy.attachCap(sizeLabel(attachCap))}</Txt>
        </>
      ) : null}
      {menuKind === "emoji" ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", paddingBottom: mailSize.rowInset }}>
          {COMPOSE_EMOJI.map(([emoji]) => (
            <Tap key={emoji} accessibilityRole="button" accessibilityLabel={emoji} onPress={() => insertEmoji(emoji)}
              style={{ width: "12.5%", minHeight: mailSize.touchAction, alignItems: "center", justifyContent: "center" }}>
              <Txt variant="settingsLabel">{emoji}</Txt>
            </Tap>
          ))}
        </View>
      ) : null}
    </Sheet>
  );

  const composerMenu = inline && phonePill && run === undefined && messageActions ? (
    <MessageActions m={messageActions.message} record={messageActions.record} onDeleted={messageActions.onDeleted}
      inlineMore={{ render: drawMenu, close: closeMore, afterClose: runAfterMore,
        hasWriterFocus: () => writerFocus.current !== null, restoreWriterFocus }} />
  ) : drawMenu();

  return (
    <ComposerFrame inline={inline} modalKey={modalKey} room={room} animate={!t.reduceMotion}
      overlayHost={menuHost} overlay={composerMenu} onRequestClose={requestClose} onShow={focusKeeper.onShow}>
        {!phoneLetter && !inline ? <SheetBackdrop label={Copy.replyCancel} onPress={closeComposer} /> : null}
        <View
          accessibilityElementsHidden={menuKind !== null}
          importantForAccessibility={menuKind !== null ? "no-hide-descendants" : "auto"}
          style={[
            {
              backgroundColor: t.c.float,
              borderTopLeftRadius: t.radius.panel,
              borderTopRightRadius: t.radius.panel,
              paddingHorizontal: 16,
              paddingTop: 16,
              paddingBottom: 12 + insets.bottom,
              gap: 10,
              flexShrink: 1,
            },
            inline && t.mail ? {
              backgroundColor: "transparent",
              paddingHorizontal: mailSize.inset, paddingTop: 0, paddingBottom: bottom,
            } : inline ? {
              borderRadius: t.radius.card, borderWidth: 2, borderColor: t.c.ink,
              paddingHorizontal: 18, paddingBottom: 16,
            } : panelBounds,
            phoneLetter ? {
              flex: 1, backgroundColor: t.c.canvas, borderRadius: 0, paddingHorizontal: mailSize.inset,
              paddingTop: mailSize.inset, paddingBottom: bottom,
            } : inline ? null : t.liftUp("l3"),
            paperEditor && !phoneLetter && !inline ? { paddingBottom: bottom } : null,
          ]}
        >
          {phoneLetter ? (
            <Tap
              onPress={closeComposer}
              accessibilityRole="button"
              accessibilityLabel={backLabel}
              style={{
                alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4,
                minHeight: mailSize.back, paddingHorizontal: 12, backgroundColor: t.c.panel,
                borderRadius: t.radius.pill, borderWidth: 1, borderColor: t.c.hair,
              }}
            >
              <View style={{ transform: [{ rotate: "180deg" }] }}><Icon name="chev" size={16} color={t.c.ink} /></View>
              <Txt variant="button">{backLabel}</Txt>
            </Tap>
          ) : null}
          <PhoneDrafter body={body} bodyRuns={runs} subject={subject} mailboxId={sendFrom} messageId={m?.id ?? null}
            allowed={paperEditor && !forward && !laterInline && w.draftReplies === true}
            offerDraftReply={offerDraftReply}
            blocked={phase !== "idle" || discardPending || later !== null} onChange={setDrafterBody}>
            {(draftSwitch, draftTool, draftNotice, draftSelected, fullDraftTool) => <>
          {/* The short-window form yields to the dock while its active input stays editable. */}
          <ScrollView
            ref={letterScroll}
            innerViewRef={letterInner as RefObject<View>}
            style={{ flexGrow: 0, flexShrink: 1 }}
            contentContainerStyle={paperEditor ? {
              gap: 4, padding: mailSize.edge, backgroundColor: t.c.panel,
              borderRadius: t.radius.card, borderWidth: 2, borderColor: t.c.ink,
            } : { gap: 10 }}
            bounces={false}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            onContentSizeChange={letterContent}
            onLayout={letterView}
            onScroll={letterMoved}
            scrollEventThrottle={32}
          >
          {/* The head states the audience — the same statement the webapp editor opens with,
              and for reply-all the same envelope the send will carry, every name on it. */}
          {!paperEditor ? <Txt variant="settingsLabel">
            {fresh
              ? Copy.composeNewHead
              : forward
                ? Copy.forwardHead
                : mode === "replyAll" && m?.replyAllHead
                  ? Copy.replyToAll(m.replyAllHead.to)
                  : Copy.replyTo(m?.from.name ?? "")}
          </Txt> : null}
          {/* WHICH ADDRESS IT LEAVES FROM — stated only where nothing else says it. A reply
              carries the conversation's own mailbox and the head already names the audience;
              a parent-less mail states its sender rather than letting a person guess. */}
          {paperEditor && (fresh || fromFace !== null) ? (
            <View style={headerLine}>
              <Txt variant="button" tone="ink2" style={headerLabel}>{Copy.composeFromLabel}</Txt>
              <View style={{ flex: 1, minWidth: 0 }}>{fromFace}</View>
              <Txt variant="caption" tone="ink3">{draftSelected ? Copy.composeAiDraftLabel : Copy.composeDraftLabel}</Txt>
            </View>
          ) : addressed ? fromFace : null}
          {replyDefaults && !replyPeopleOpen ? (
            <View style={headerLine}>
              <Txt variant="button" tone="ink2" style={headerLabel}>{Copy.replyRecipientLabel}</Txt>
              <Txt variant="body" style={{ flex: 1 }} numberOfLines={2}>
                {replyDefaults.to.map(({ name, address }) => name?.trim() || displayAddress(address)).join(", ")}
              </Txt>
              <Tap accessibilityRole="button" accessibilityLabel={Copy.replyChangeRecipients}
                disabled={phase !== "idle" || discardPending}
                style={{ width: mailSize.action, height: mailSize.action, alignItems: "center", justifyContent: "center" }}
                onPress={() => {
                  replyPeopleAsked.current = true;
                  setTo(replyTo);
                  setCopies({ cc: replyCc, bcc: "" });
                  setReplyPeopleOpen(true);
                }}>
                <Icon name="person" size={16} color={t.c.ink2} />
              </Tap>
            </View>
          ) : null}
          {!phonePill ? senderRows : null}
          {sender.substituted && fromAddress !== null ? (
            <Txt variant="caption" tone="ink3" accessibilityLiveRegion="polite">
              {sender.was !== null ? Copy.composeFromSubstituted(sender.was) : Copy.composeFromSubstitutedUnknown}
            </Txt>
          ) : null}
          {!replyPeopleOpen && foldedCc !== "" ? (
            paperEditor ? (
              <View style={headerLine}>
                <Txt variant="button" tone="ink2" style={headerLabel}>{Copy.composeCc}</Txt>
                <Txt variant="body" style={{ flex: 1 }} numberOfLines={2}>{foldedCc}</Txt>
              </View>
            ) : <Txt variant="caption" tone="ink3">{Copy.replyCcLine(foldedCc)}</Txt>
          ) : null}
          {addressed || replyPeopleOpen ? (
            <RecipientInput
              label={Copy.forwardTo}
              plain={paperEditor}
              trailing={paperEditor && copiesOffered({ mode, shown: copiesOn, phase }) ? (
                <Button label={Copy.composeAddCopies} variant="quiet"
                  style={{ paddingHorizontal: 0 }}
                  onPress={() => { setCopiesOn(true); setCopiesAsked(true); }} />
              ) : null}
              ref={toField}
              {...focusKeeper.bind(toField)}
              value={to}
              onChangeText={editWhileIdle(phase, setTo)}
              editable={phase === "idle" && !discardPending}
              book={addressBook}
              back={suggestionsBack}
              autoFocus={fresh || forward}
              placeholder={paperEditor ? "" : fresh ? Copy.composeToPlaceholder : Copy.forwardToPlaceholder}
            />
          ) : null}
          {!paperEditor && copiesOffered({ mode, shown: copiesOn, phase }) ? (
            <Button
              label={Copy.composeAddCopies}
              variant="quiet"
              style={{ alignSelf: "flex-start" }}
              onPress={() => { setCopiesOn(true); setCopiesAsked(true); }}
            />
          ) : null}
          {copiesOn || replyPeopleOpen ? <ComposeCopies value={copies} editable={phase === "idle" && !discardPending}
            onChange={editWhileIdle(phase, setCopies)} book={addressBook} back={suggestionsBack} ccField={ccField} plain={paperEditor} /> : null}
          {!forward ? (
            <View style={paperEditor ? headerLine : composeLine}>
              <Txt variant={paperEditor ? "button" : "caption"} tone={paperEditor ? "ink2" : "ink3"}
                style={paperEditor ? headerLabel : undefined}>{Copy.composeSubject}</Txt>
              <TextInput
                ref={subjectField}
                {...subjectFocus}
                onFocus={() => {
                  subjectFocus.onFocus();
                  if (Platform.OS === "android") setSubjectHasFocused(true);
                }}
                selection={Platform.OS === "android" && !subjectHasFocused && subject !== "" ? { start: 0, end: 0 } : undefined}
                maxFontSizeMultiplier={t.textCap}
                disableFullscreenUI
                keyboardAppearance={t.scheme}
                keyboardType="default"
                underlineColorAndroid={paperEditor ? "transparent" : undefined}
                value={subject}
                onChangeText={editWhileIdle(phase, setSubject)}
                editable={phase === "idle" && !discardPending}
                placeholder={paperEditor ? "" : Copy.composeSubjectPlaceholder}
                placeholderTextColor={t.c.ink3}
                accessibilityLabel={Copy.composeSubject}
                style={[
                  t.type.body,
                  {
                    flex: 1,
                    minWidth: 0,
                    color: t.c.ink,
                    backgroundColor: paperEditor ? "transparent" : t.c.tint2,
                    borderRadius: t.radius.pill,
                    paddingHorizontal: paperEditor ? 0 : 14,
                    paddingVertical: 8,
                  },
                ]}
              />
            </View>
          ) : paperEditor && m ? (
            <View style={headerLine}>
              <Txt variant="button" tone="ink2" style={headerLabel}>{Copy.composeSubject}</Txt>
              <Txt variant="body" style={{ flex: 1 }} numberOfLines={2}>
                {subject}
              </Txt>
            </View>
          ) : null}
          {/* Frozen the moment Send is pressed: the dispatch captured the fields at the
              press, and an editable field over a sending/queued/unverified state would
              display words the wire will not carry. */}
          <View style={paperEditor ? { borderWidth: 1, borderColor: t.c.hair, borderRadius: t.radius.row, padding: 5, gap: 4 } : { gap: 10 }}>
          {inline ? draftSwitch : null}
          {formatControls}
          <TextInput
            ref={bodyField}
            {...focusKeeper.bind(bodyField)}
            maxFontSizeMultiplier={t.textCap}
            disableFullscreenUI
            keyboardAppearance={t.scheme}
            underlineColorAndroid={paperEditor ? "transparent" : undefined}
            value={body}
            onSelectionChange={(event) => { selection.current = event.nativeEvent.selection; }}
            onChangeText={editWhileIdle(phase, setBody)}
            editable={phase === "idle" && !discardPending}
            placeholder={inline && !forward && t.mail ? Copy.composeReplyPaperHint : bodyPlaceholder}
            placeholderTextColor={t.c.ink3}
            multiline
            scrollEnabled={paperEditor ? true : undefined}
            onContentSizeChange={paperEditor ? (event) => setBodyHeight(event.nativeEvent.contentSize.height) : undefined}
            autoFocus={!addressed && !offerDraftReply}
            accessibilityLabel={bodyPlaceholder}
            style={[
              t.type.body,
              {
                color: t.c.ink,
                backgroundColor: t.mail ? t.c.panel : t.c.tint2,
                borderColor: t.mail ? t.c.hair : undefined,
                borderWidth: t.mail && !paperEditor ? 1 : undefined,
                borderRadius: t.mail ? t.radius.row : t.radius.card,
                paddingHorizontal: 14,
                paddingVertical: 10,
                /* THE PANEL MUST NOT GROW PAST THE VIEWPORT AND BURY SEND — the exact defect
                   the signature block's own ceiling exists for, one control over. While the
                   Send-later picker is open the writing area yields to it: the first line
                   still stands (nothing is disowned, and the text is untouched), and the
                   full editor comes back with a single Back. */
                minHeight: composeBodyMin(laterInline, heightClass),
                textAlignVertical: "top",
              },
              paperEditor ? {
                minHeight: 0,
                height: composeBodyHeight(visibleBodyHeight, laterInline, heightClass),
              } : null,
              paperEditor && Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null,
            ]}
          />
          {formatOpen ? formatPreview : null}
          {/* A mail to support: what its diagnostics block holds, and Remove / Add back in one press. */}
          {diag !== undefined && !laterInline ? (() => {
            const strip = diagStrip(body, diag);
            return (
              <View
                accessibilityLabel={Copy.helpDiag}
                style={{ backgroundColor: t.c.tint2, borderRadius: t.radius.card, paddingHorizontal: 14, paddingVertical: 8, gap: 4 }}
              >
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Txt variant="caption" tone="ink3">
                    {strip.k === "present" ? Copy.helpDiag : Copy.helpRemoved}
                  </Txt>
                  <View style={{ flex: 1 }} />
                  <Button
                    label={strip.k === "present" ? Copy.helpRemove : Copy.helpAddBack}
                    variant="quiet"
                    disabled={phase !== "idle"}
                    onPress={() => { if (phase === "idle") setBody(strip.next); }}
                  />
                </View>
                {strip.k === "present" ? <Txt variant="note" tone="ink3">{Copy.helpDiagWhat}</Txt> : null}
              </View>
            );
          })() : null}
          {inline && m?.body && !m.protected && !laterInline ? (
            <>
              <Tap accessibilityRole="button" accessibilityLabel={quoteOpen ? Copy.bodyHistoryHide : Copy.bodyHistoryShow}
                accessibilityState={{ expanded: quoteOpen }} onPress={() => setQuoteOpen(!quoteOpen)}
                style={{ alignSelf: "flex-start", paddingHorizontal: 10, minHeight: 36, justifyContent: "center" }}>
                <Txt variant="button" tone="ink2">…</Txt>
              </Tap>
              {quoteOpen ? <Txt variant="note" tone="ink2" numberOfLines={6}>{m.body.slice(0, 1200)}</Txt> : null}
            </>
          ) : null}
          {sigText !== null && !laterInline ? (
            <ComposeSignature
              text={sigText}
              html={sigHtml}
              disabled={phase !== "idle" || discardPending}
              editor={
                <TextInput
                  maxFontSizeMultiplier={t.textCap}
                  disableFullscreenUI
                  keyboardAppearance={t.scheme}
                  value={sigText}
                  onChangeText={editWhileIdle(phase, (text: string) => setSig({ kind: "edited", text }))}
                  editable={phase === "idle" && !discardPending}
                  autoFocus
                  multiline
                  accessibilityLabel={Copy.sigAria}
                  style={[t.type.body, { color: t.c.ink2, paddingVertical: 0, maxHeight: 144 }]}
                />
              }
              onRemove={() => { if (phase === "idle") setSig({ kind: "removed" }); }}
            />
          ) : null}
          {fullDraftTool}
          {!inline ? draftSwitch : null}
          </View>
          {/* ── THE ATTACHMENTS — each row a file with its remove; the two pickers and the cap
              sentence below, stated from the same value the admit rule refuses against. Yields
              to the Send-later picker exactly as the signature block does, and freezes with the
              fields once a send is dispatched. ── */}
          {!laterInline ? (
            <>
              {paperEditor && forwardPlan !== null ? (
                <Txt variant="caption" tone="ink3">{sayRefusal(forwardPlan.line)}</Txt>
              ) : null}
              {/* THE ORIGINAL'S FILES go with a forward: listed, each removable where the server
                  sends only the parts named (`compose/forward-files.ts`). */}
              {forwardPlan !== null && forwardPlan.rows.length > 0 ? (
                <View style={{ gap: 6 }}>
                  <Txt variant="caption" tone="ink3">
                    {Copy.forwardFilesHead}
                  </Txt>
                  {forwardPlan.rows.filter((part) => forwardPlan.kept.includes(part.id) || !part.removable).map((part) => (
                    <View
                      key={part.id}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        backgroundColor: t.c.tint2,
                        borderRadius: t.radius.card,
                        paddingHorizontal: 14,
                        paddingVertical: 8,
                      }}
                    >
                      <Icon name="clip" size={13} color={t.c.ink3} />
                      <Txt variant="caption" tone="ink2" numberOfLines={1} style={{ flex: 1 }}>
                        {part.filename}
                      </Txt>
                      <Txt variant="caption" tone="ink3">
                        {sizeLabel(part.sizeBytes)}
                      </Txt>
                      {part.removable ? (
                        <Tap
                          onPress={() => removePart(part.id)}
                          accessibilityRole="button"
                          accessibilityState={{ disabled: phase !== "idle" }}
                          accessibilityLabel={Copy.attachRemove(part.filename)}
                          style={{ padding: 8, marginRight: -8 }}
                        >
                          <Icon name="x" size={13} color={t.c.ink3} />
                        </Tap>
                      ) : null}
                    </View>
                  ))}
                </View>
              ) : null}
              {attachments.map((file) => (
                <Fragment key={`${file.filename}:${file.sizeBytes}`}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                      backgroundColor: t.c.tint2,
                      borderRadius: t.radius.card,
                      paddingHorizontal: 14,
                      paddingVertical: 8,
                    }}
                  >
                    {/* The thumbnail and the name open the file: the app's own preview, or another app. */}
                    <Tap
                      onPress={() => void openAttached(file)}
                      accessibilityRole="button"
                      accessibilityLabel={file.filename}
                      style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }}
                    >
                      <AttachThumbView file={file} />
                      <Txt variant="caption" tone="ink2" numberOfLines={1} ellipsizeMode="middle" style={{ flex: 1 }}>
                        {file.filename}
                      </Txt>
                      <Txt variant="caption" tone="ink3">
                        {sizeLabel(file.sizeBytes)}
                      </Txt>
                    </Tap>
                    <Tap
                      onPress={() => {
                        if (phase !== "idle") return;
                        setAttachments((list) => list.filter((a) => a !== file));
                        if (file.fileId !== undefined) keeper?.removeFile(file.fileId);
                      }}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: phase !== "idle" }}
                      accessibilityLabel={Copy.attachRemove(file.filename)}
                      style={{ padding: 8, marginRight: -8 }}
                    >
                      <Icon name="x" size={13} color={t.c.ink3} />
                    </Tap>
                  </View>
                  {openRefused === file ? (
                    <Txt variant="caption" tone="ink3" accessibilityRole="alert" style={{ marginTop: 4, paddingHorizontal: 14 }}>
                      {Copy.attachmentShareRefused}
                    </Txt>
                  ) : null}
                </Fragment>
              ))}
              {previewed !== null ? <AttachmentPreview file={previewed} onClose={() => setPreviewed(null)} /> : null}
              {!paperEditor ? <View
                style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: ATTACH_ROW_GAP, rowGap: 4 }}
                onLayout={(e) => measureAttach("row", e.nativeEvent.layout.width)}
              >
                <View onLayout={(e) => measureAttach("files", e.nativeEvent.layout.width)}>
                  <Button
                    label={Copy.attachFile}
                    icon="clip"
                    variant="quiet"
                    disabled={phase !== "idle"}
                    onPress={() => void pick("files")}
                  />
                </View>
                <View onLayout={(e) => measureAttach("photos", e.nativeEvent.layout.width)}>
                  <Button
                    label={Copy.attachPhoto}
                    variant="quiet"
                    disabled={phase !== "idle"}
                    onPress={() => void pick("photos")}
                  />
                </View>
                {forwardPlan === null ? (
                  <Txt
                    variant="caption"
                    tone="ink3"
                    style={attachHintStyle(attachHintFits(attachRow.row, [attachRow.files, attachRow.photos], attachRow.hint))}
                    onLayout={(e) => measureAttach("hint", e.nativeEvent.layout.width)}
                  >
                    {Copy.attachCap(sizeLabel(attachCap))}
                  </Txt>
                ) : (
                  /* A forward never says "total": its own files are weighed apart from these. */
                  <Txt
                    variant="caption"
                    tone="ink3"
                    style={attachHintStyle(attachHintFits(attachRow.row, [attachRow.files, attachRow.photos], attachRow.hint))}
                    onLayout={(e) => measureAttach("hint", e.nativeEvent.layout.width)}
                  >
                    {sayRefusal(forwardPlan.line)}
                  </Txt>
                )}
              </View> : null}
              {attachNotes.map((note) => (
                <Txt key={note.kind} variant="caption" tone="ink2" accessibilityRole="alert">
                  {note.kind === "overCap"
                    ? Copy.attachRefused(sizeLabel(attachCap))
                    : note.kind === "duplicates"
                      ? Copy.attachDuplicate(note.filenames)
                      : note.kind === "unreadable"
                        ? Copy.attachUnreadable
                        : Copy.attachUnavailable}
                </Txt>
              ))}
            </>
          ) : null}
          {laterInline ? (
            <View accessibilityViewIsModal accessibilityLabel={Copy.sendLater}
              style={{ backgroundColor: t.c.tint2, borderRadius: t.radius.card, paddingVertical: 6 }}>
              <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 4 }}>{Copy.sendLaterWhat}</Txt>
              {laterChoices}
            </View>
          ) : null}
          {/* WHY THERE IS NO SEND LATER — a phone organizing its own mailbox, or attachments (a draft
              row stores no files); a forward's absence has its own note. It explains a control, not a
              press, so it ends the letter rather than taking the short window's pinned room. */}
          {w.standalone && !forward ? (
            <Txt variant="hint" tone="ink3" style={{ paddingBottom: 2 }}>
              {scheduledNotHereSentence(w.mailboxes.organizer)}
            </Txt>
          ) : null}
          {!w.standalone && !forward && attachments.length > 0 && filesKept?.kept !== true ? (
            <Txt variant="hint" tone="ink3" style={{ paddingBottom: 2 }}>
              {filesKept === null ? Copy.sendLaterUnavailable : Copy.sendLaterFilesNotHere}
            </Txt>
          ) : null}
          {pinNotes ? null : notesBlock}
          </ScrollView>
          {/* The scroller's bottom edge, drawn: a cut letter reads as an edge, not a sliced field. */}
          <View style={{ height: StyleSheet.hairlineWidth * 2, marginTop: -10, backgroundColor: t.c.hairSoft, opacity: phoneLetter ? 0 : 1 }}>
            {/* More letter below the edge: the clamp fade over it, so the line under it reads as cut. */}
            {runsOn ? (
              <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: StyleSheet.hairlineWidth * 2, height: 0 }}>
                <FadeOut color={t.c.float} height={18} />
              </View>
            ) : null}
          </View>
          {pinNotes ? notesBlock : null}
          {(!phonePill && openTools !== null) || draftNotice ? (
            <ScrollView
              style={{ flexGrow: 0, flexShrink: 1, maxHeight: 112 }}
              contentContainerStyle={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}
              nestedScrollEnabled keyboardShouldPersistTaps="handled"
            >
              {!phonePill && openTools === "attachment" ? <>
                <Button label={Copy.attachFile} icon="clip" onPress={() => { setTools(null); void pick("files"); }} />
                <Button label={Copy.attachPhoto} onPress={() => { setTools(null); void pick("photos"); }} />
                <Txt variant="caption" tone="ink3">{Copy.attachCap(sizeLabel(attachCap))}</Txt>
              </> : !phonePill && openTools === "format" ? <>
                <Button label={Copy.composeBold} onPress={() => formatting("strong")} />
                <Button label={Copy.composeItalic} onPress={() => formatting("em")} />
                <Button label={Copy.composeUnderline} onPress={() => formatting("u")} />
                <Txt variant="caption" tone="ink2">{Copy.composeFormatSelect}</Txt>
                {formatPreview}
              </> : !phonePill && openTools === "emoji" ? COMPOSE_EMOJI.map(([emoji]) => (
                <Button key={emoji} label={emoji} onPress={() => insertEmoji(emoji)} />
              )) : null}
              {!phonePill && openTools !== null ? <Button label={Copy.moveCancel} variant="quiet" onPress={() => setTools(null)} /> : null}
              {draftNotice}
            </ScrollView>
          ) : null}
          {phonePill && phase === "idle" && !discardAsked ? (
            <GlassPill level="l3"
              style={{ alignSelf: "center", maxWidth: "100%", marginTop: phoneLetter ? "auto" : undefined }}
              contentStyle={{ paddingHorizontal: 8, gap: 0, alignItems: "stretch" }}>
              <View style={{ flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: t.c.hairSoft, justifyContent: "space-between" }}>
                {mailTool(Copy.composeFileTools, () => setTools("attachment"), "clip", menuKind === "attachment")}
                {mailTool(Copy.composeFormat, () => setFormatOpen(!formatOpen), "format", formatOpen)}
                {mailTool(Copy.composeEmoji, () => setTools("emoji"), "smile", menuKind === "emoji")}
                {draftTool}
                {!phoneLetter && !run ? mailTool(Copy.replyCancel, closeComposer, "x") : null}
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
                {sendButton}
                {run ? <>
                  <Button label={Copy.replyRunSkip} icon="chev" variant="quiet" onPress={run.skip} />
                  <Button label={Copy.replyRunExit} icon="x" variant="quiet" onPress={run.exit} />
                </> : !compactVerbs ? <>{laterButton}{discardButton}</> : <>
                  {doneButton}
                  <View ref={moreRef} collapsable={false}>
                    <Tap accessibilityRole="button" accessibilityLabel={Copy.tabMore}
                      accessibilityState={{ expanded: menuKind === "more" }}
                      onPress={() => inline ? showInlineMore() : anchorTo(() => setTools("more"), undefined, menuHost)}
                      style={{ width: 38, minHeight: 38, alignItems: "center", justifyContent: "center" }}>
                      <Txt variant="button">⋯</Txt>
                    </Tap>
                  </View>
                </>}
              </View>
            </GlassPill>
          ) : <View style={paperEditor ? {
            width: "100%", maxWidth: 560, alignSelf: "center", marginTop: phoneLetter ? "auto" : undefined,
            borderRadius: t.radius.pill, paddingVertical: 6, paddingHorizontal: 12, gap: 4,
            backgroundColor: t.c.panel, ...t.lift("l2"),
          } : undefined}>
          {!phonePill && paperEditor && later === null && !discardAsked ? (
            <View style={{
              flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6,
              paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: t.c.hairSoft,
            }}>
              {mailTool(Copy.composeFileTools, () => setTools(tools === "attachment" ? null : "attachment"), "clip")}
              {mailTool(Copy.composeFormat, () => setTools(tools === "format" ? null : "format"), "format")}
              {mailTool(Copy.composeEmoji, () => setTools(tools === "emoji" ? null : "emoji"), "smile")}
              {draftTool ? <View style={{ flexShrink: 1, marginLeft: "auto" }}>{draftTool}</View> : null}
              {!phoneLetter && phase === "idle" && !run ? mailTool(Copy.replyCancel, closeComposer, "x") : null}
            </View>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: paperEditor ? "space-between" : "flex-end", columnGap: 4, rowGap: 4 }}>
            {discardAsked ? <>
              <Txt variant="caption" tone="ink2" style={{ alignSelf: "center" }}>{Copy.draftsDiscardWhat}</Txt>
              <Button label={Copy.draftsDiscardCancel} variant="quiet" disabled={discardPending} onPress={() => setDiscardAsked(false)} />
              <Button label={Copy.draftsDiscardConfirm} variant="solid" disabled={discardPending} onPress={() => { void discardDraft(); }} />
            </> : run ? <>{sendButton}
              <Button label={Copy.replyRunSkip} icon="chev" variant="quiet" onPress={run.skip} />
              <Button label={Copy.replyRunExit} icon="x" variant="quiet" onPress={run.exit} />
            </> : paperEditor ? <>{sendButton}{laterButton}{closeButton}{doneButton}
            </> : <>{closeButton}{laterButton}{doneButton}{sendButton}</>}
            {!discardAsked && !paperEditor && phase === "idle" && (keepNote === "failed" || keepNote === "tooLong")
              ? discardButton : null}
          </View>
          </View>}
          </>}
          </PhoneDrafter>
        </View>
    </ComposerFrame>
  );
}

function ComposerFrame({ inline, modalKey, room, animate, onRequestClose, onShow, overlayHost, overlay, children }: {
  inline: boolean;
  modalKey: string;
  room: ViewStyle;
  animate: boolean;
  onRequestClose: () => void;
  onShow: () => void;
  overlayHost: RefObject<View | null>;
  overlay: ReactNode;
  children: ReactNode;
}) {
  if (inline) return <>{children}{overlay}</>;
  return (
    <Modal key={modalKey} transparent statusBarTranslucent navigationBarTranslucent
      animationType={animate ? "slide" : "none"} visible onRequestClose={onRequestClose} onShow={onShow}>
      <View ref={overlayHost} collapsable={false} style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={room}>
          {children}
        </KeyboardAvoidingView>
        {overlay}
      </View>
    </Modal>
  );
}



/** An attached file's thumbnail (`attachThumb`): a picture the phone cannot draw wears its type mark. */
function AttachThumbView({ file }: { file: PhoneComposeAttachment }) {
  const t = useTheme();
  const [drawable, setDrawable] = useState(true);
  // Once per file: a kept picture's data: URI is its whole bytes, and the sheet re-renders per keystroke.
  const thumb = useMemo(() => {
    const made = attachThumb(file, drawable);
    return made.kind === "picture" ? { ...made, source: { uri: made.uri } } : made;
  }, [file, drawable]);
  const box = {
    width: 36, height: 36, borderRadius: t.radius.item, backgroundColor: t.c.panel,
    alignItems: "center", justifyContent: "center", overflow: "hidden",
  } as const;
  if (thumb.kind === "picture") {
    // "resize": Android decodes a data: URI at full size otherwise (only file:/content: auto-resize).
    return <Image source={thumb.source} resizeMethod="resize" resizeMode="cover" onError={() => setDrawable(false)} style={box} />;
  }
  return (
    <View style={box}>
      {thumb.label === null ? <Icon name="clip" size={13} color={t.c.ink3} /> : (
        <Txt variant="tagchip" tone="ink2" numberOfLines={1} adjustsFontSizeToFit>
          {thumb.label}
        </Txt>
      )}
    </View>
  );
}

/* ── primitives ────────────────────────────────────────────────────────────────────────────── */

/** A bar capsule with a pressed face — the webapp button's `aria-pressed`, in RN vocabulary. */
function BarToggle({
  label,
  icon,
  on,
  onPress,
  disabled,
  accessibilityHint,
}: {
  label: string;
  icon: IconName;
  on: boolean;
  onPress: () => void;
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  const t = useTheme();
  const activeFill = t.mail ? t.c.tint2 : t.c.accentSoft;
  const restFill = t.mail ? "transparent" : t.c.panel;
  const accented = on && !t.mail;
  return (
    <Tap
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: on, disabled: disabled === true }}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: PILL.iconGap,
          minHeight: PILL.minH,
          // A capsule never outgrows its line: at a big font scale the LABEL wraps inside the
          // pill instead — a second line of the verb's own words, never an ellipsis and never
          // a shorter word. `Icon` keeps its size; only the text gives.
          maxWidth: "100%",
          paddingHorizontal: PILL.padH,
          paddingVertical: 8,
          borderRadius: t.radius.pill,
          backgroundColor: on ? activeFill : restFill,
          opacity: disabled ? 0.5 : pressed ? 0.86 : 1,
        },
        t.mail ? null : t.lift("l0"),
      ]}
    >
      <Icon name={icon} size={PILL.icon} color={accented ? t.c.accentInk : t.c.ink} />
      <Txt variant="button" tone={accented ? "accent" : "ink"} style={{ flexShrink: 1 }}>
        {label}
      </Txt>
    </Tap>
  );
}

/**
 * THE NIGHT THE CHOSEN HOUR IS MISSING, SAID OUT LOUD — one sentence under the row it is about,
 * naming the time that will be booked instead. Nothing at all on the other two verdicts: an exact
 * booking needs no sentence, and the repeated hour books what was asked for.
 */
function SkipNote(
  { horizon, label, asked }: { horizon: ResurfaceHorizon; label: string; asked: string },
) {
  if (horizon.verdict !== "shifted_forward") return null;
  return (
    <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
      {Copy.resurfaceSkipNote(label, horizon.time, asked)}
    </Txt>
  );
}

/* ── SEND LATER's picker state (mail 0077) — its VOCABULARY lives in `state/live.ts` ─────── */

/** Which step of the Send-later picker is showing. See `ComposeSheet`'s state block. */
type LaterStep =
  | { step: "presets" }
  | { step: "days" }
  /** The chosen day, held as the OFFSET the rows were derived from — `dayAtHour`'s own input,
   *  so the day the reader tapped and the instant the press dispatches cannot drift apart. */
  | { step: "hours"; offset: number };

/**
 * "Mon 1 Sep" — or "Mo., 1. Sept." — for the picked-day rows. The arithmetic moved to
 * `state/live.ts#calendarDayLabel` when the away responder's end date became the second surface
 * that names calendar days: one spelling, so two chooser lists cannot abbreviate a weekday
 * differently in the same language.
 */
const dayLabel = calendarDayLabel;

/** Forward's narrow face on the compact bar: the 44pt square with its icon, the word as its label. */
function ForwardIcon({ onPress }: { onPress: () => void }) {
  const t = useTheme();
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={Copy.actionForward}
      style={({ pressed }) => [
        {
          width: 44, minHeight: 38, alignItems: "center", justifyContent: "center",
          borderRadius: t.radius.pill, backgroundColor: t.c.panel, opacity: pressed ? 0.86 : 1,
        },
        t.lift("l0"),
      ]}
    >
      <Icon name="fwd" size={13} color={t.c.ink} />
    </Tap>
  );
}
