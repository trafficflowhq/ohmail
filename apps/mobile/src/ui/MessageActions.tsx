/**
 * The open message's verbs — the webapp action bar, in the phone's idiom. The verbs are the
 * same verbs: same names (`src/copy.ts` mirrors the webapp catalogue;
 * `test/action-parity.test.ts` derives the list from the webapp's source), same engine
 * mutations behind them (`src/state/live.ts`, mirrored from `AppShell.onMessageAction`) —
 * arranged for a thumb: the bar pins to the bottom; everything else stands in the More sheet.
 * The webapp's absence rules hold: Reply all only where `replyAllRecipients` admitted an
 * envelope, Forward always (a `no_forward` message asks once), the read slot holds one of its
 * three faces. The AI drafter is not here — no engine verb, so an absent control, never a dead one.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View,
  type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy } from "../copy";
import { useLocale } from "../i18n/LocaleProvider";
import { useTheme } from "../theme";
import { useBottomChromeSlot } from "./bottom-chrome";
import { destLabel, DESTINATIONS, domainOf, type Destination, type Scope } from "../state/model";
import {
  calendarDayLabel,
  DAY_OFFSETS,
  dayAt,
  dayAtHour,
  dayNine,
  effectiveSignature,
  forwardOffered,
  moveTargetsFor,
  moveTargetLabel,
  nextWeekAt,
  nextWeekNine,
  keptRecipients,
  type WorldDraftEdit,
  parseRecipients,
  readerZone,
  resurfaceClock,
  resurfaceTimeLabel,
  RESURFACE_HOURS,
  sizeLabel,
  scheduleLabel,
  SEND_LATER_MIN_LEAD_MS,
  SIG_FOLLOWING,
  usableHours,
  todayEvening,
  tomorrowAt,
  tomorrowNine,
  type ForwardAsk,
  type ResurfaceHorizon,
  type SignatureState,
  type WorldMail,
  type WorldTag,
  folderName,
  type ConflictGroup,
  type PressForecast,
  type WorldRule,
  connectionSaid,
  type FailedSendCopy,
  ruleMatchKey,
} from "../state/live";
import { useWorld } from "../state/world";
import { BAR, PILL, compactFit } from "./action-bar-layout";
import { Button, Rule, Tap, Txt } from "./base";
import { GlassActionBar, GlassPill, nextRoom, type BarVerbSpec } from "./glass";
import type { RailAction } from "./glass/GlassRail";
import { usePosture } from "./posture";
import { readerBarClearance, scaffoldPlan } from "./scaffold/plan";
import { publishReaderRail } from "./reader-rail";
import {
  readerVerbMode,
  readerVerbPlacement,
  railReaderGroups,
  type ReaderVerbFacts,
  type ReaderVerbId,
} from "./reader-verbs";
import { Icon, type IconName } from "./Icon";
import { scheduledNotHereSentence, sendLaterOffered } from "./standalone-form";
import { useNetworkNow } from "../net/network-door";
import { queuedCaptionKey } from "../engine/send-waits";
import {
  admitPicked,
  shrinkPicked,
  phoneAttachCap,
  phoneSendNeedsContent,
  toComposeAttachments,
  type AttachPickOutcome,
  type PhoneComposeAttachment,
} from "../compose/attach";
/* The expo pickers — a `*-native.ts` twin the suite never imports; every rule is in attach.ts. */
import { nativeAttachPicker, nativeImageShrink } from "../compose/attach-native";
import { usePrefs } from "../state/store";
import { afterWithdraw, cancelAct } from "./send-cancel";
import { keepAct, worthKeeping } from "./compose-keep";
import { editWhileIdle } from "./compose-edit";
import { Segmented } from "./Segmented";
import { Sheet, SheetRow, useSheetPanelBounds } from "./Sheet";
import { composeBodyMin, notesPinned, pinnedNotesMax } from "./compose-fit";
import { SurfaceBoundary } from "./ErrorBoundary";
import { sendPressAct } from "./send-press";
import { holdReader } from "./reader-held";
import { ATTACH_ROW_GAP, attachHintFits, attachHintStyle } from "./attach-hint";
import { failedSendLine } from "./send-failed";
import type { StayedWhy } from "../state/sender-stayed";
import { stayedRows } from "./sender-stayed-lines";
import { useKeyboardLift } from "./keyboard-lift";

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
  | { compose: "reply" | "replyAll" | "forward"; confirmed?: boolean };

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

export function MessageActions({
  m,
  onDeleted,
  onBack,
  inPane = false,
}: {
  m: WorldMail;
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
  const [open, setOpen] = useState<Open>(null);

  // A message swap must not leave a sheet open over a different message's verbs — the same
  // reset the webapp's pane applies to its panels.
  useEffect(() => setOpen(null), [m.id]);
  /* A sheet or composer open here holds the fold/unfold move until it closes (`reader-held.ts`). */
  const holdToken = useRef(Symbol("reader")).current;
  const holding = open !== null;
  useEffect(() => {
    holdReader(holdToken, holding);
    return () => holdReader(holdToken, false);
  }, [holdToken, holding]);

  const a = w.actions;
  const close = () => setOpen(null);

  /* The reader may leave (the delete committed) OR be gone already (the person backed out during
     the window). The window still commits the delete either way; only the NAVIGATION is guarded,
     so a commit after the reader is gone does not over-pop a screen it no longer owns. */
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const shownId = useRef(m.id);
  shownId.current = m.id;

  /**
   * Forward is always offered (`forwardOffered`). A row the mirror does not hold has its body read
   * through the reader's door first (`forwardFetch`), and a `no_forward` message asks once. A read
   * that settles after the reader moved to another message opens nothing.
   */
  const openForward = () => {
    const id = m.id;
    const ask = m.forwardAsk;
    const go = () => setOpen(ask ? "forward-ask" : { compose: "forward" });
    const reading = a.forwardFetch(id);
    if (reading === null) { go(); return; }
    void reading.then(() => { if (mounted.current && shownId.current === id) go(); });
  };

  /**
   * WHICH PRESENTATION THIS POSTURE TAKES (`reader-verbs.ts`, the census-walked model): the
   * phone's compact bar, the desktop ActionBar pinned at the reading pane's foot (owner rule
   * 4 — iPad both orientations, the unfolded-portrait Duo, Android two-pane), or the
   * right-edge rail on the unfolded-landscape Duo. Junk has no row verb on the ActionBar —
   * the desktop's own design; it stays behind Move — and only the rail carries it directly.
   */
  const posture = usePosture();
  const plan = scaffoldPlan(posture, Platform.OS === "ios" ? "ios" : "android");
  const mode = readerVerbMode(plan);
  const barRail = readerBarClearance(plan, inPane);
  /* This bar stands at the foot, so it reports how far up it reaches and the toast clears it
     (`bottom-chrome.ts`); on the rail postures nothing stands here and the slot says so. */
  const standing = useBottomChromeSlot("reader-bar");
  useEffect(() => {
    if (mode === "rail") standing(null);
  }, [mode, standing]);
  const facts: ReaderVerbFacts = {
    canReplyAll: m.canReplyAll === true,
    forwardOffered: forwardOffered(m),
    foldersEnabled: w.folders.enabled,
    junkOffered: moveTargetsFor(m).includes("spam"),
  };
  const placement = readerVerbPlacement(mode, facts);

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
    { id: "later" as const, label: Copy.actionLater, icon: "clock" as IconName,
      on: m.pile === "reply_later", onPress: () => a.pileToggle(m.id, "replyLater") },
    { id: "aside" as const, label: Copy.actionSetAside, icon: "pause" as IconName,
      on: m.pile === "set_aside", onPress: () => a.pileToggle(m.id, "setAside") },
    /* Resurface asks "when?" — except on a message already scheduled, where the press is the
       webapp's horizon-less toggle: it clears the booking rather than re-dating it. */
    { id: "resurface" as const, label: Copy.actionResurface, icon: "up" as IconName,
      on: m.pile === "bubbled_up",
      onPress: () => (m.pile === "bubbled_up" ? a.resurfaceToggle(m.id) : setOpen("resurface")) },
  ]).filter((v) => placement.standing.includes(v.id));
  /* FORWARD STANDS BESIDE REPLY (the compact bar's lead): measured as its word and as its icon. */
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
    placement.behindMore.includes(id) || barFit.overflow.includes(id);

  /** The one three-faced read slot — the webapp's read switch, never empty and never two. */
  const readFace =
    m.pile === "resurfaced"
      ? { icon: "check" as IconName, label: Copy.actionDone, press: () => a.resurfaceDone(m.id) }
      : m.unread
        ? { icon: "check" as IconName, label: Copy.actionMarkRead, press: () => a.markSeen(m.id, false) }
        : { icon: "x" as IconName, label: Copy.actionMarkUnread, press: () => a.markSeen(m.id, true) };

  /* THE RAIL CLAIM (unfolded-landscape Duo): the reader's verbs ride the ONE right-edge rail —
     back · reply · reply all · forward, Done · Park · Junk, ⋯ (prototype v5, Mail's order) —
     published to the store the rail's renderer reads, released on unmount so the destinations
     return the moment no message is open. Handlers close over THIS render; the deps re-publish
     whenever a label, face or admission changes (the locale re-reads the deck's getters). */
  const pile = m.pile;
  const unread = m.unread;
  useEffect(() => {
    if (mode !== "rail") return;
    const core = (id: ReaderVerbId): RailAction => {
      switch (id) {
        case "reply":
          return { id, icon: "reply", label: Copy.actionReply, accent: true, fixed: true, onPress: () => setOpen({ compose: "reply" }) };
        case "replyAll":
          return { id, icon: "replyall", label: Copy.actionReplyAll, onPress: () => setOpen({ compose: "replyAll" }) };
        case "forward":
          return { id, icon: "fwd", label: Copy.actionForward, onPress: openForward };
        case "read":
          return { id, icon: readFace.icon, label: readFace.label, onPress: readFace.press };
        case "aside":
          return { id, icon: "pause", label: Copy.actionSetAside, on: pile === "set_aside", onPress: () => a.pileToggle(m.id, "setAside") };
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
  }, [mode, m.id, pile, unread, facts.canReplyAll, facts.forwardOffered, m.forwardAsk, facts.foldersEnabled, facts.junkOffered, locale, onBack]);

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
  const horizonDay = today.getFullYear() * 10_000 + today.getMonth() * 100 + today.getDate();
  const { tomorrow, nextWeek } = useMemo(
    () => ({ tomorrow: tomorrowAt(new Date(), resurfaceTime), nextWeek: nextWeekAt(new Date(), resurfaceTime) }),
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
      case "replyAll": return { id, label: Copy.actionReplyAll, onPress: () => setOpen({ compose: "replyAll" }) };
      case "forward": return { id, label: Copy.actionForward, iconFace: "fwd", onPress: openForward };
      case "later": return { id, icon: "clock", label: Copy.actionLater, seg: "defer", onPress: () => a.pileToggle(m.id, "replyLater") };
      case "aside": return { id, icon: "pause", label: Copy.actionSetAside, seg: "defer", onPress: () => a.pileToggle(m.id, "setAside") };
      case "resurface": return { id, icon: "up", label: Copy.actionResurface, seg: "defer", onPress: () => (m.pile === "bubbled_up" ? a.resurfaceToggle(m.id) : setOpen("resurface")) };
      case "tag": return { id, icon: "tag", label: Copy.actionTag, onPress: () => setOpen("tag") };
      case "screening": return { id, icon: "door", label: Copy.actionScreening, seg: "file", onPress: () => setOpen("screening") };
      case "move": return { id, icon: "ohbox", label: Copy.actionMove, seg: "file", onPress: () => setOpen("move") };
      case "delete": return { id, icon: "trash", label: Copy.actionDelete, onPress: () => setOpen("delete") };
      // reply and read ride their own slots on the bar; they never reach this map.
      default: return { id, label: Copy.actionReply, onPress: () => setOpen({ compose: "reply" }) };
    }
  };
  const barVerbs: BarVerbSpec[] =
    mode === "bar" ? placement.standing.filter((v) => v !== "reply" && v !== "read").map(barSpec) : [];
  const barExtraMore: BarVerbSpec[] = mode === "bar" ? placement.behindMore.map(barSpec) : [];

  return (
    <>
      {mode === "bar" ? (
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
          <GlassActionBar
            reply={{ label: Copy.actionReply, onPress: () => setOpen({ compose: "reply" }) }}
            verbs={barVerbs}
            readSwitch={{ label: readFace.label, icon: readFace.icon, onPress: readFace.press }}
            floor={["forward"]}
            extraMore={barExtraMore}
          />
        </View>
      ) : mode === "rail" ? null : (
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
        style={{ paddingHorizontal: BAR.outerPadH, paddingBottom: Math.max(insets.bottom, 8) }}
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
          <Button label={Copy.actionReply} icon="pen" variant="solid" onPress={() => undefined} />
        </View>
        {forwardStands ? (
          <>
            <View onLayout={recordWidth("forward")}>
              <Button label={Copy.actionForward} icon="fwd" variant="plain" onPress={() => undefined} />
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
      <GlassPill
        horizontal
        level="l3"
        radius={t.radius.panel}
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
            icon="pen"
            variant="solid"
            style={{ maxWidth: "100%" }}
            onPress={() => setOpen({ compose: "reply" })}
          />
          {/* Forward, beside Reply, through the SAME door as the sheet's row (`openForward` → the
              composer over `m`, Reply's own target). Its word while it fits, else its icon. */}
          {forwardStands && barFit.standing.includes("forward") ? (
            barFit.leadIcon
              ? <ForwardIcon onPress={openForward} />
              : <Button label={Copy.actionForward} icon="fwd" variant="plain" onPress={openForward} />
          ) : null}
          {compactRow
            .filter((v) => barFit.standing.includes(v.id))
            .map((v) => (
              <BarToggle key={v.id} label={v.label} icon={v.icon} on={v.on} onPress={v.onPress} />
            ))}
        </View>
        <Tap
          onPress={() => setOpen("more")}
          accessibilityRole="button"
          accessibilityLabel={Copy.actionMore}
          style={{ padding: (BAR.moreBox - 16) / 2 }}
        >
          <Icon name="more" size={16} color={t.c.ink2} />
        </Tap>
      </GlassPill>
      </View>
      )}

      {/* ── More: everything not standing on this posture's surface, one verb per row —
             `placement.behindMore` names the rows, so the sheet and the surface can never
             carry the same verb twice, and no mode loses one ───────────────────────────── */}
      <Sheet open={open === "more"} onClose={close} label={Copy.actionMore}>
        {moreHas("replyAll") ? (
          <SheetRow icon="pen" label={Copy.actionReplyAll} onPress={() => setOpen({ compose: "replyAll" })} />
        ) : null}
        {moreHas("forward") ? (
          <SheetRow icon="open" label={Copy.actionForward} onPress={openForward} />
        ) : null}
        {/* The two horizons the rail does not stand (its column carries Done · Park · Junk;
            Later and Resurface live here, one press away — never gone). */}
        {moreHas("later") ? (
          <SheetRow
            icon="clock"
            label={Copy.actionLater}
            on={m.pile === "reply_later"}
            onPress={() => { close(); a.pileToggle(m.id, "replyLater"); }}
          />
        ) : null}
        {moreHas("resurface") ? (
          <SheetRow
            icon="up"
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
        {/* Park has a row here for the same reason: the compact bar folds it when the width
            cannot carry it, and a folded verb is never gone. */}
        {moreHas("aside") ? (
          <SheetRow
            icon="pause"
            label={Copy.actionSetAside}
            on={m.pile === "set_aside"}
            onPress={() => { close(); a.pileToggle(m.id, "setAside"); }}
          />
        ) : null}
        {moreHas("tag") ? <SheetRow icon="tag" label={Copy.actionTag} onPress={() => setOpen("tag")} /> : null}
        {moreHas("screening") ? (
          <SheetRow icon="door" label={Copy.actionScreening} onPress={() => setOpen("screening")} />
        ) : null}
        {moreHas("move") ? <SheetRow icon="ohbox" label={Copy.actionMove} onPress={() => setOpen("move")} /> : null}
        {moreHas("read") ? <Rule inset={14} /> : null}
        {/* One slot, three faces — the webapp's read switch, never empty and never two. */}
        {!moreHas("read") ? null : m.pile === "resurfaced" ? (
          <SheetRow icon="check" label={Copy.actionDone} onPress={() => { close(); a.resurfaceDone(m.id); }} />
        ) : m.unread ? (
          <SheetRow icon="check" label={Copy.actionMarkRead} onPress={() => { close(); a.markSeen(m.id, false); }} />
        ) : (
          <SheetRow icon="x" label={Copy.actionMarkUnread} onPress={() => { close(); a.markSeen(m.id, true); }} />
        )}
        {/* Delete stands LAST and opens its own confirm — a destructive verb never fires off a
            scrolled thumb, and the desktop keeps the ask on its button press too. Move-to-Trash
            on the server, never an expunge (mail 0065); there is no un-delete on the wire, so
            the confirmed press opens a WINDOW (`world.tsx`'s delete arm over
            `state/held-delete.ts`) — the pill's Undo cancels a delete not yet sent.
            GATED ON THE FOUNDATION FLAG with the confirm sheet below:
            the reader Delete verb ships behind "Use folders" (FOLDERS-SPEC.md §16.3/§16.7 —
            flag-off is the pre-feature reader, "no Delete verb", byte for byte), so with the
            flag off neither the row nor a stale confirm can dispatch. */}
        {moreHas("delete") ? (
          <>
            <Rule inset={14} />
            <SheetRow icon="trash" label={Copy.actionDelete} onPress={() => setOpen("delete")} />
          </>
        ) : null}
      </Sheet>

      {/* ── Forward's ask: a `no_forward` message says why it was flagged, once, before the composer ── */}
      {m.forwardAsk ? (
        <Sheet open={open === "forward-ask"} onClose={close} label={Copy.forwardAskQuestion}>
          <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
            {Copy.forwardAskQuestion}
          </Txt>
          <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
            {forwardAskSentence(m.forwardAsk)}
          </Txt>
          <SheetRow icon="open" label={Copy.actionForward} onPress={() => setOpen({ compose: "forward", confirmed: true })} />
        </Sheet>
      ) : null}

      {/* ── Delete: the one destructive verb, behind its own stated confirm ─────────────── */}
      {w.folders.enabled ? (
        <Sheet open={open === "delete"} onClose={close} label={Copy.deleteAsk}>
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
              // Close the confirm sheet and open the window — but DO NOT navigate now: the reader
              // stays over the pill for the whole window (the review's device fix), leaving only when the
              // delete commits (`onCommitted`, guarded so a person who backed out is not over-popped).
              close();
              a.deleteMessage(m.id, { onCommitted: () => { if (mounted.current) onDeleted?.(); } });
            }}
          />
        </Sheet>
      ) : null}

      {/* ── Resurface: the horizon chooser — Now / Tomorrow / Next week / Pick a date ────── */}
      <Sheet
        open={open === "resurface" || open === "pick" || open === "time"}
        onClose={() => { close(); setPickedTime(null); }}
        label={open === "time" ? Copy.resurfaceTime : Copy.resurfaceWhen}
      >
        <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          {open === "time" ? Copy.resurfaceTime : Copy.resurfaceWhen}
        </Txt>
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
            <SheetRow
              label={Copy.resurfaceNextWeek}
              detail={nextWeek.time}
              onPress={() => pickResurface(nextWeek)}
            />
            <SkipNote horizon={nextWeek} label={Copy.resurfaceNextWeek} asked={resurfaceTime} />
            <SheetRow icon="chev" label={Copy.resurfacePick} onPress={() => setOpen("pick")} />
          </>
        ) : open === "time" ? (
          // EVERY HALF HOUR FROM 06:00 TO 22:00 — the phone's idiom for the webapp's time input,
          // the 90-day list's shape one axis over. The current value is checked; a stored value
          // outside this range still SHOWS and still applies (the rows are bounded, the account's
          // hour is not), so a time set on a computer is never silently rounded here.
          <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled>
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
          // tomorrow so the chooser cannot name a horizon in the past. Built only while this list
          // is open: it stood in the closed branch, so every reader render built ninety rows.
          <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled>
            {/* Ninety days of rows — the webapp's date input takes any future day; a list is
                the phone's idiom, and a quarter ahead covers the horizons people actually
                book. A fortnight did not, and was an exclusion nothing on screen admitted. */}
            {Array.from({ length: 90 }, (_, i) => {
              const day = dayAt(new Date(), i + 1, resurfaceTime);
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
      <Sheet open={open === "move"} onClose={close} label={Copy.actionMove}>
        <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          {Copy.moveLabel}
        </Txt>
        {/* The place the row is SHOWN in is what a person means by "where it is" — a newsletter
            ruled to Reads is offered the Ohbox, which the filed folder hid. `move` gets the row
            so the retarget names the same place the list did. */}
        {moveTargetsFor(m).map((target) => (
          <SheetRow
            key={target}
            label={`→ ${moveTargetLabel(target)}`}
            onPress={() => { close(); a.move(m, target); }}
          />
        ))}
      </Sheet>

      {open === "tag" ? <TagSheet m={m} tags={w.tags} onClose={close} /> : null}
      {open === "screening" ? <ScreeningSheet m={m} onClose={close} /> : null}
      {/* The composer under its own boundary, in the sheet's shape: a throw while composing
          leaves the reader behind it readable and offers Retry, never the process. */}
      {open !== null && typeof open === "object" ? (
        <SurfaceBoundary surface="composer" frame="sheet" onClose={close}>
          <ComposeSheet m={m} mode={open.compose} forwardConfirmed={open.confirmed === true} onClose={close} />
        </SurfaceBoundary>
      ) : null}
    </>
  );
}

/* ── the tag sheet — the webapp picker: filter, toggle, create what does not exist ─────────── */

function TagSheet({ m, tags, onClose }: { m: WorldMail; tags: WorldTag[]; onClose: () => void }) {
  const t = useTheme();
  const w = useWorld();
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const list = tags.filter((tag) => tag.name.toLowerCase().includes(typed.toLowerCase()));
  // Against the WHOLE set, case-folded — the unique index is on `lower(name)`, so offering to
  // create "Invoices" while "invoices" exists would promise a tag the server answers 409 for.
  const canCreate = typed.length > 0 && !tags.some((tag) => tag.name.toLowerCase() === typed.toLowerCase());
  return (
    <Sheet open onClose={onClose} label={Copy.actionTag}>
      <TextInput
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
      <ScrollView style={{ maxHeight: 300 }} nestedScrollEnabled>
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

function ScreeningSheet({ m, onClose }: { m: WorldMail; onClose: () => void }) {
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
  const target = scope === "domain" ? `@${domain}` : m.from.address;
  const inPlay = w.actions.screeningRules(m.id, scope);
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
  const labelOf = (id: string) => w.mailboxes.rows.find((r) => r.id === id)?.displayName?.trim() || null;
  const stayed = stayedRows(ask, why && why.key === askKey ? why.map : null, labelOf);
  const press = (dest: Destination) => {
    const f = w.actions.screeningForecast(m.id, dest, scope, applyRetro);
    const cls = f ? phoneStepClass(f, scope) : null;
    if (f && cls) { setStep({ dest, forecast: f, cls, choice: cls === "domain" && !f.exception ? 1 : 0 }); return; }
    onClose();
    w.actions.screenSender(m.id, dest, scope, applyRetro);
  };
  return (
    /* The system back gesture in the step goes back to the list; on the list it closes the sheet. */
    <Sheet open onClose={() => (step ? setStep(null) : onClose())} label={Copy.actionScreening}>
      {step ? (
        <PhoneResolveStep
          step={step}
          domain={domain}
          onChoice={(choice) => setStep({ ...step, choice })}
          onCommit={() => {
            const tile = phoneTiles(step.cls, step.forecast)[step.choice]!;
            onClose();
            w.actions.screenSender(m.id, step.dest, tile.scope ?? scope, applyRetro, {
              resolution: tile.resolution, shown: step.forecast.groups.map((g) => g.rule), forecast: step.forecast,
            });
          }}
          onCancel={() => setStep(null)}
        />
      ) : (
        <>
      <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
        {Copy.screeningFor(m.from.name)}
      </Txt>
      {hasDomain ? (
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
        {applyRetro ? Copy.screeningNoteRetro(target) : Copy.screeningNote(target)}
      </Txt>
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
function PhoneResolveStep({ step, domain, onChoice, onCommit, onCancel }: {
  step: PhoneStep; domain: string; onChoice: (c: 0 | 1) => void; onCommit: () => void; onCancel: () => void;
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
  prefill?: { to: string; subject: string; body: string };
  onClose: () => void;
}) {
  const t = useTheme();
  const keyboardLift = useKeyboardLift();
  const insets = useSafeAreaInsets();
  const heightClass = usePosture().heightClass;
  const windowHeight = useWindowDimensions().height;
  const letterScroll = useRef<null | ScrollView>(null);
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
  const w = useWorld();
  /** The composer never straddles a hinge and stays bounded on wide windows (`Sheet.tsx`). */
  const panelBounds = useSheetPanelBounds();
  /** The send-later day rows, named by `Intl` in the app's language. */
  const locale = useLocale();
  const [body, setBody] = useState(draft?.body ?? prefill?.body ?? "");
  const [to, setTo] = useState(draft?.to ?? prefill?.to ?? "");
  /** A parent-less mail's own subject. Reply and forward derive theirs; this one is typed. */
  const [subject, setSubject] = useState(draft?.subject ?? prefill?.subject ?? "");
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
  /** The phone's network, so a send waiting for it says so in place (`send-waits.ts`). */
  const network = useNetworkNow();
  /**
   * TRUE once a Cancel was answered "too late": the request had left and this device cannot
   * un-send it. The sentence stands in place and the next press dismisses — see `closeComposer`.
   */
  const [alreadySent, setAlreadySent] = useState(false);
  /** TRUE after Send was pressed over an unconfirmed send — the press says why nothing went. */
  const [againNote, setAgainNote] = useState(false);
  /**
   * THE SIGNATURE BLOCK'S STATE (`signature.ts`, shared with the webapp composer): `following`
   * until the user speaks, then their edit or their strike stands for THIS message. The sheet
   * is mounted per compose and unmounts on close, so the state's lifetime IS the message's —
   * the one-removal-one-message rule by construction.
   */
  const [sig, setSig] = useState<SignatureState>(SIG_FOLLOWING);
  const forward = mode === "forward";
  /**
   * A MAIL WITH NO PARENT. It shares every rule below with the reply family — one
   * signature derivation, one empty-content refusal, one key, the same Send later clock — and
   * differs in exactly three facts: it asks for its recipients, it asks for its subject, and
   * it names the mailbox it leaves from rather than inheriting one.
   */
  const fresh = mode === "new";
  /* What the writing area asks for — a reply's own words, a forward's optional note, or, with
     no parent to answer, a message of its own. */
  const bodyPlaceholder = fresh
    ? Copy.composeBodyPlaceholder
    : forward
      ? Copy.forwardNotePlaceholder
      : Copy.replyPlaceholder;
  /** Addressed, so the To field is offered and its entries are the envelope. */
  const addressed = forward || fresh;
  /**
   * THE ATTACHMENTS — bytes in memory, nothing filed (`ComposeAttachment`'s contract); they ride
   * the same `mail_send` the webapp composer sends. The admit pipeline, the cap and the
   * needs-content rule live in `../compose/attach`; the pickers behind their native twin. Notes
   * are the LAST pick's verdicts (refused-over-cap, duplicates, unreadable, picker refused) —
   * each said in place, the webapp's `role="status"` rows in this sheet's idiom.
   */
  const [attachments, setAttachments] = useState<PhoneComposeAttachment[]>([]);
  /* KINDS, never sentences: a deck read stored in state freezes in the language it was read in
     (refusal.test.ts's rule) — the sentence is derived at render time. Filenames are data. */
  const [attachNotes, setAttachNotes] = useState<AttachNote[]>([]);
  /** TRUE after a press on a Send that lacks only content — cleared the moment content arrives. */
  const [needNote, setNeedNote] = useState(false);
  /**
   * WHY THE LAST CLOSE DID NOT CLOSE — the keep failed, or the files cannot be kept. Said in place;
   * the next close discards (`compose-keep.ts`). Any edit takes it back, so new text is kept again.
   */
  const [keepNote, setKeepNote] = useState<"failed" | "files" | null>(null);
  /** A keep on its way — one row per close, however often the backdrop is tapped meanwhile. */
  const keeping = useRef(false);
  /**
   * THE ROW THIS LETTER IS — set once a refused send names the draft it left. Every later press
   * sends that row and the keep on close updates it, so one letter is one draft however often
   * Send is pressed with the network gone. `null` until a refusal names one.
   */
  const [draftId, setDraftId] = useState<string | null>(draft?.id ?? null);
  /** What the bound row last held from this sheet — the seed until the first save. */
  const saved = useRef<string | null>(draft ? JSON.stringify([draft.to, draft.subject, draft.body]) : null);
  /** The last press was refused, and which sentence it earned — said in the sheet, see `send-failed.ts`. */
  const [failNote, setFailNote] = useState<FailedSendCopy | null>(null);
  /* The ONE shared bound (`composeAttachCap`) of the sending mailbox's announced `SIZE` —
     the same pair the send will enforce. The phone declares no surface: its send rides one
     JSON request, so the strict constant is the other arm. */
  /* WHICH MAILBOX THIS LEAVES FROM — the parent's for a reply or forward (what `Engine.enrich`
     would derive anyway, made explicit), the engine's `sendingMailboxId` for a parent-less
     mail. `null` only where this phone has mirrored nothing, and the send refuses by name. */
  const mailboxId = draft?.mailboxId ?? m?.mailboxId ?? w.mailboxes.sendingId;
  /* The sending address, only where the phone has read the mailbox list — `null` is "not
     asked yet", which states nothing rather than a guessed address. */
  const fromAddress = w.mailboxes.rows.find((r) => r.id === mailboxId)?.address ?? null;
  const attachCap = phoneAttachCap(w.mailboxes.rows, mailboxId ?? "");
  const { pictureQuality } = usePrefs();
  const pick = async (which: "files" | "photos") => {
    if (phase !== "idle") return;
    const picker = nativeAttachPicker();
    const outcome: AttachPickOutcome =
      which === "files" ? await picker.pickFiles() : await picker.pickPhotos();
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
    const notes: AttachNote[] = [];
    if (admit.overCap > 0) notes.push({ kind: "overCap" });
    if (admit.duplicates.length > 0) notes.push({ kind: "duplicates", filenames: admit.duplicates.join(", ") });
    if (outcome.unreadable + admit.unreadable > 0) notes.push({ kind: "unreadable" });
    setAttachments(admit.next);
    setAttachNotes(notes);
  };
  /**
   * Send later (mail 0077) — the picker, inline in this panel: a panel above the button row,
   * never a second Modal over this one (the webapp `ComposeView`'s decision; on RN it also
   * avoids a Modal in a Modal). Three steps because "a date and time" is two facts and a phone
   * has no datetime input worth the name: presets, days, hours. `openedAt` freezes "now" when
   * the picker opens so the presets do not drift mid-decision — and because that freeze lets a
   * preset go stale, the press re-checks the lead against the real clock
   * ({@link Copy.sendLaterPast}). A draft row stores no forward reference (§14), so a forward
   * cannot wear an appointment: the affordance is disabled with its reason.
   */
  const [later, setLater] = useState<LaterStep | null>(null);
  /* WHETHER THE AFFORDANCE IS THERE AT ALL — one predicate, two reasons (`sendLaterOffered`): a
     forward cannot wear an appointment, and the standalone door keeps none. Withheld rather than
     refused after the pick, and the sentence below says which it is. */
  const laterOffered = sendLaterOffered({ standalone: w.standalone, forward, hasAttachments: attachments.length > 0 });
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
  const onScreen = JSON.stringify([to, subject, body]);
  /* By presence, not identity: the route builds the seed per render, and a new object must not reset the timer. */
  const bound = draft !== undefined;
  useEffect(() => {
    if (!bound || draftId === null || phase !== "idle" || saved.current === onScreen) return;
    const timer = setTimeout(() => {
      saved.current = onScreen;
      /* A forward draft is saved as a forward of its original, never as a new mail. */
      void w.actions.draftKeep({
        mode: forward ? "forward" : "new", messageId: forward ? m!.id : null,
        mailboxId, to: keptRecipients(to), subject, body, files: 0, draftId, quiet: true,
      });
    }, DRAFT_AUTOSAVE_MS);
    return () => clearTimeout(timer);
    // `w`, `mailboxId` and the three fields are read at the timer; `onScreen` is their change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bound, draftId, phase, onScreen]);

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
    if (settled === "confirmed") onClose();
    else if (settled === "rolled_back") {
      // The queued copy is gone with the rollback — a fresh Send cannot double-deliver.
      setQueuedKey(null);
      setAccepted(false);
      setPhase("idle");
      // …and the send did NOT go after all, so the too-late sentence may not stand over a
      // re-armed Send. Cleared with the phase that raised it.
      setAlreadySent(false);
      // The refusal left a row: the next press sends THAT row, never a second copy of one letter.
      if (said.draftId !== null) setDraftId(said.draftId);
      // The re-armed Send says why it is back, in the words the refusal earned.
      setFailNote(said.failure ?? "replyFailed");
    }
    else if (settled === "unverified") setPhase("unverified");
    // Still queued, and the server has said it holds the send: it is sending, not waiting.
    else if (said.accepted) setAccepted(true);
    // `unverified` stays locked: the server could not say whether the message left, so the
    // only honest controls are the check-Sent sentence (in place and toasted) and Cancel.
  }, [phase, queuedKey, w, onClose]);
  // EVERY typed entry must parse, or nothing sends. A filter that dropped the malformed
  // entry silently narrowed the audience — "alice@x, bob.x" sent to Alice alone with nobody
  // told — so an invalid entry LOCKS Send rather than shrinking the list. Entries split on
  // commas/semicolons (never bare spaces: `Alice <alice@x.org>` is ONE entry), and a
  // display-named entry is validated on the address its angle brackets carry.
  const recipients = addressed ? parseRecipients(to) : [];
  /* NOTHING TO SEND — the webapp's `sendNeedsContent`, mirrored: empty body AND no attachments,
     except a forward (its content is the forwarded message). A signature never lights Send up
     on its own — the rule reads the body and the files, never the block. */
  const needsContent = phoneSendNeedsContent({ forward, body, attachmentCount: attachments.length });
  const canSend =
    phase === "idle" && !needsContent && (addressed ? recipients !== null && recipients.length > 0 : true);
  /* CONTENT IS THE ONE THING MISSING — the webapp's told refusal: Send stays pressable, dressed
     unlit, and the press earns the sentence instead of doing nothing. Every stronger lock
     (sending, queued, unverified) keeps the dead press. */
  const contentOnlyMissing = phase === "idle" && needsContent;
  const pressAct = sendPressAct({ canSend, contentOnlyMissing, phase });
  const press = (act: typeof pressAct, andDone = false) => {
    if (act === "send") void send(null, andDone);
    else if (act === "needContent") setNeedNote(true);
    else if (act === "again") setAgainNote(true);
  };

  /**
   * WHAT THE BLOCK SHOWS — and exactly what the send appends (`effectiveSignature`, one
   * derivation, two consumers). The sending mailbox is the row's own `mailboxId`: the mailbox
   * the message arrived in, which is what `Engine.enrich` puts on a reply's wire and what the
   * forward arm passes explicitly — this sheet has no From selector, so the resolution is the
   * mutation's, made visible. `w.signatures === null` (not yet server-confirmed) renders no
   * block and appends nothing: a signature is never drawn or serialized from a guess.
   */
  const sigText =
    w.signatures === null || mailboxId === null ? null : effectiveSignature(sig, w.signatures, mailboxId);

  /**
   * The three presets, computed off the frozen `openedAt`. The evening one is OFFERED ONLY
   * while it is meaningfully ahead — past ~17:57 "this evening at 18:00" is a promise measured
   * in seconds, and the honest menu simply omits it (the webapp's `eveningUsable`).
   */
  const eveningAt = todayEvening(openedAt).instant;
  const eveningUsable = eveningAt.getTime() - openedAt.getTime() > SEND_LATER_MIN_LEAD_MS;
  const openLater = () => {
    // The keyboard would cover the picker it is being asked to read.
    Keyboard.dismiss();
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

  /**
   * EVERY ROAD OUT OF THIS SHEET — the button, the scrim, the back gesture. Over a queued send
   * the close IS the cancellation: the intent is withdrawn before the sheet goes, so the
   * reconnect flush has nothing left to deliver and a second composer cannot mint a second copy.
   * A withdrawal the engine refuses because the request has already left says so and STAYS, and
   * the press after that dismisses (`cancelAct`'s `alreadySent` arm).
   */
  const closeComposer = () => {
    if (cancelAct({ phase, key: queuedKey, alreadySent }) === "close") {
      /* A bound draft keeps exactly what is on screen, emptied included; unchanged, it just closes. */
      const worth = bound && draftId !== null ? saved.current !== onScreen : worthKeeping({ fresh, subject, body });
      const act = keepAct({ phase, worth, files: attachments.length, armed: keepNote !== null });
      if (act === "close") {
        onClose();
        return;
      }
      if (act === "ask") {
        setKeepNote("files");
        return;
      }
      if (keeping.current) return;
      keeping.current = true;
      void (async () => {
        /* A draft opened from Drafts is kept where it was, unannounced: its keep's Undo would
           discard a row that existed before this sheet. */
        const kept = await w.actions.draftKeep({
          mode, messageId: m?.id ?? null, mailboxId, to: addressed ? keptRecipients(to) : [],
          subject, body, files: attachments.length, draftId, ...(draft !== undefined ? { quiet: true } : {}),
        });
        keeping.current = false;
        if (kept === "kept") onClose();
        else setKeepNote("failed");
      })();
      return;
    }
    void (async () => {
      const key = queuedKey!;
      // The verdict is read AFTER the withdrawal answers, not before it: a flush can settle
      // under the await, and the fresher reading is the one this press is owed.
      const said = afterWithdraw(await w.actions.withdrawSend(key), w.sendOutcome(key));
      if (said === "close") onClose();
      else if (said === "already_sent") setAlreadySent(true);
    })();
  };

  const send = async (sendAt: string | null = null, andDone = false) => {
    // The picker closes the moment ANY send is dispatched — a panel left standing over a
    // message that is already on its way offers rows for an act that may no longer happen.
    setLater(null);
    setPhase("sending");
    setFailNote(null);
    const files = toComposeAttachments(attachments);
    const result = fresh
      ? await w.actions.sendNew(mailboxId, recipients ?? [], subject, body, sigText, sendAt, files, draftId)
      : forward
        ? await w.actions.sendForward(m!.id, recipients ?? [], body, sigText, files, andDone, forwardConfirmed, draftId)
        : await w.actions.sendReply(m!.id, body, mode === "replyAll", sigText, sendAt, files, andDone, draftId);
    // `superseded`: a newer press of this reply carries it and says its sentence.
    if (result.outcome === "sent" || result.outcome === "superseded") {
      onClose();
      return;
    }
    if (result.outcome === "queued") {
      setQueuedKey(result.key ?? null);
      setAccepted(result.accepted === true);
      setPhase("queued");
      return;
    }
    // `unverified` LOCKS the composer exactly like queued, for the opposite reason: the
    // server could not say whether the message left, so a fresh-key re-send is the
    // duplicate-delivery door. Only a plain failure re-arms Send.
    setPhase(result.outcome === "unverified" ? "unverified" : "idle");
    // A refused send binds the row it left and says why, here: nothing outside this sheet shows.
    if (result.outcome === "failed" && result.draftId) setDraftId(result.draftId);
    if (result.outcome === "failed" && result.failure) setFailNote(result.failure);
  };

  /* THE SENTENCES ABOVE THE BUTTONS, each answering a press or saying why a control is absent: the
     toast and the top bar render under this Modal, so a sentence said only there was a press with no
     answer. Pinned up to `pinnedNotesMax`; past it they scroll at the letter's end, scrolled to. */
  const noteItems = [
    phase === "queued" || phase === "unverified" ? (
      <Txt key="queued" variant="caption" tone="ink3">
        {phase === "queued" ? Copy[queuedCaptionKey(network, accepted)] : Copy.replyUnverified}
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
    /* The told refusal: a Send lacking only content earned a sentence, gone once content arrives. */
    needNote && needsContent ? (
      <Txt key="needContent" variant="caption" tone="ink2" accessibilityRole="alert">
        {Copy.composeNeedContent}
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
    /* Why the close stayed — nothing typed is thrown away without the person being told. */
    keepNote !== null ? (
      <Txt key="keep" variant="caption" tone="ink2" accessibilityRole="alert">
        {keepNote === "failed" ? Copy.composeKeepFailed : Copy.composeKeepFiles}
      </Txt>
    ) : null,
  ].filter((n) => n !== null);
  const notesBlock = noteItems.length === 0 ? null : (
    <View style={{ gap: 10 }} onLayout={(e) => setNotesHeight(Math.round(e.nativeEvent.layout.height))}>
      {noteItems}
    </View>
  );

  return (
    <Modal transparent animationType={t.reduceMotion ? "none" : "slide"} visible onRequestClose={closeComposer}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, justifyContent: "flex-end", paddingBottom: keyboardLift }}
      >
        <Pressable style={{ flex: 1 }} accessibilityLabel={Copy.replyCancel} onPress={closeComposer} />
        <View
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
            panelBounds,
            t.liftUp("l3"),
          ]}
        >
          {/* THE LETTER SCROLLS; THE BUTTONS DO NOT. On a cover screen held sideways (403 dp) the
              fields outgrew the window and Send and Cancel stood below it. The sentences answering
              a press stand pinned over the buttons up to a bound and scroll with the letter past it
              (`compose-fit.ts`); the Send / Cancel row alone is always pinned. */}
          <ScrollView
            ref={letterScroll}
            style={{ flexGrow: 0, flexShrink: 1 }}
            contentContainerStyle={{ gap: 10 }}
            bounces={false}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
          >
          {/* The head states the audience — the same statement the webapp editor opens with,
              and for reply-all the same envelope the send will carry, every name on it. */}
          <Txt variant="settingsLabel">
            {fresh
              ? Copy.composeNewHead
              : forward
                ? Copy.forwardHead
                : mode === "replyAll" && m?.replyAllHead
                  ? Copy.replyToAll(m.replyAllHead.to)
                  : Copy.replyTo(m?.from.name ?? "")}
          </Txt>
          {/* WHICH ADDRESS IT LEAVES FROM — stated only where nothing else says it. A reply
              carries the conversation's own mailbox and the head already names the audience;
              a parent-less mail states its sender rather than letting a person guess. */}
          {fresh && fromAddress !== null ? (
            <Txt variant="caption" tone="ink3">
              {Copy.composeFrom(fromAddress)}
            </Txt>
          ) : null}
          {mode === "replyAll" && m?.replyAllHead && m.replyAllHead.cc !== "" ? (
            <Txt variant="caption" tone="ink3">
              {Copy.replyCcLine(m.replyAllHead.cc)}
            </Txt>
          ) : null}
          {addressed ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Txt variant="caption" tone="ink3">
                {Copy.forwardTo}
              </Txt>
              <TextInput
                value={to}
                onChangeText={editWhileIdle(phase, setTo)}
                editable={phase === "idle"}
                /* THE FIELD A NEW MAIL OPENS ON — a composer whose first keystroke lands in
                   the body is a composer that asks for the message before the audience. */
                autoFocus={fresh}
                placeholder={fresh ? Copy.composeToPlaceholder : Copy.forwardToPlaceholder}
                placeholderTextColor={t.c.ink3}
                accessibilityLabel={Copy.forwardTo}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                style={[
                  t.type.body,
                  {
                    flex: 1,
                    color: t.c.ink,
                    backgroundColor: t.c.tint2,
                    borderRadius: t.radius.pill,
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                  },
                ]}
              />
            </View>
          ) : null}
          {fresh ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Txt variant="caption" tone="ink3">
                {Copy.composeSubject}
              </Txt>
              <TextInput
                value={subject}
                onChangeText={editWhileIdle(phase, setSubject)}
                editable={phase === "idle"}
                placeholder={Copy.composeSubjectPlaceholder}
                placeholderTextColor={t.c.ink3}
                accessibilityLabel={Copy.composeSubject}
                style={[
                  t.type.body,
                  {
                    flex: 1,
                    color: t.c.ink,
                    backgroundColor: t.c.tint2,
                    borderRadius: t.radius.pill,
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                  },
                ]}
              />
            </View>
          ) : null}
          {/* Frozen the moment Send is pressed: the dispatch captured the fields at the
              press, and an editable field over a sending/queued/unverified state would
              display words the wire will not carry. */}
          <TextInput
            value={body}
            onChangeText={editWhileIdle(phase, setBody)}
            editable={phase === "idle"}
            placeholder={bodyPlaceholder}
            placeholderTextColor={t.c.ink3}
            multiline
            /* THE FIRST KEYSTROKE GOES WHERE THE MESSAGE IS MISSING A FACT. A reply and a
               forward already know their audience, so the body takes the caret; a mail with no
               parent does not, and the device showed the caret in the body under "Write your
               reply…" with the To field empty above it. */
            autoFocus={!fresh}
            accessibilityLabel={bodyPlaceholder}
            style={[
              t.type.body,
              {
                color: t.c.ink,
                backgroundColor: t.c.tint2,
                borderRadius: t.radius.card,
                paddingHorizontal: 14,
                paddingVertical: 10,
                /* THE PANEL MUST NOT GROW PAST THE VIEWPORT AND BURY SEND — the exact defect
                   the signature block's own ceiling exists for, one control over. While the
                   Send-later picker is open the writing area yields to it: the first line
                   still stands (nothing is disowned, and the text is untouched), and the
                   full editor comes back with a single Back. */
                minHeight: composeBodyMin(later !== null, heightClass),
                textAlignVertical: "top",
              },
            ]}
          />
          {/* THE SIGNATURE BLOCK — a DISTINCT, REMOVABLE element below the writing area
              (`SignatureBlock.tsx` is the webapp reference; `signature.ts` owns the model).
              Nothing renders when there is nothing to show — struck, edited to blank, the
              sender stores nothing, or the map is not yet server-confirmed: absence is the
              resting state, never a collapsed control. × strikes it for THIS message only;
              typing edits it (the user's text stands whatever the resolution later says). */}
          {sigText !== null && later === null ? (
            <View
              accessibilityLabel={Copy.sigLabel}
              style={{
                backgroundColor: t.c.tint2,
                borderRadius: t.radius.card,
                paddingHorizontal: 14,
                paddingTop: 6,
                paddingBottom: 10,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Txt variant="caption" tone="ink3">
                  {Copy.sigLabel}
                </Txt>
                <View style={{ flex: 1 }} />
                <Tap
                  onPress={phase === "idle" ? () => setSig({ kind: "removed" }) : undefined}
                  accessibilityRole="button"
                  accessibilityLabel={Copy.sigRemove}
                  style={{ padding: 8, marginRight: -8 }}
                >
                  <Icon name="x" size={13} color={t.c.ink3} />
                </Tap>
              </View>
              {/* BOUNDED: a stored signature may run thousands of characters, and an
                  unbounded content-measured input would grow the panel past the viewport and
                  bury Send under the keyboard (codex round 1). Capped, it scrolls inside the
                  block — the webapp's own 8-row ceiling, in points. */}
              <TextInput
                value={sigText}
                onChangeText={editWhileIdle(phase, (text: string) => setSig({ kind: "edited", text }))}
                editable={phase === "idle"}
                multiline
                accessibilityLabel={Copy.sigAria}
                style={[t.type.body, { color: t.c.ink2, paddingVertical: 0, maxHeight: 144 }]}
              />
            </View>
          ) : null}
          {/* ── THE ATTACHMENTS — each row a file with its remove; the two pickers and the cap
              sentence below, stated from the same value the admit rule refuses against. Yields
              to the Send-later picker exactly as the signature block does, and freezes with the
              fields once a send is dispatched. ── */}
          {later === null ? (
            <>
              {attachments.map((file) => (
                <View
                  key={`${file.filename}:${file.sizeBytes}`}
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
                    {file.filename}
                  </Txt>
                  <Txt variant="caption" tone="ink3">
                    {sizeLabel(file.sizeBytes)}
                  </Txt>
                  <Tap
                    onPress={() => {
                      if (phase !== "idle") return;
                      setAttachments((list) => list.filter((a) => a !== file));
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: phase !== "idle" }}
                    accessibilityLabel={Copy.attachRemove(file.filename)}
                    style={{ padding: 8, marginRight: -8 }}
                  >
                    <Icon name="x" size={13} color={t.c.ink3} />
                  </Tap>
                </View>
              ))}
              <View
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
                <Txt
                  variant="caption"
                  tone="ink3"
                  style={attachHintStyle(attachHintFits(attachRow.row, [attachRow.files, attachRow.photos], attachRow.hint))}
                  onLayout={(e) => measureAttach("hint", e.nativeEvent.layout.width)}
                >
                  {Copy.attachCap(sizeLabel(attachCap))}
                </Txt>
              </View>
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
          {/* ── SEND LATER: the picker, above the button row (see the state block above) ──── */}
          {later !== null ? (
            <View
              accessibilityViewIsModal
              accessibilityLabel={Copy.sendLater}
              style={{ backgroundColor: t.c.tint2, borderRadius: t.radius.card, paddingVertical: 6 }}
            >
              <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 4 }}>
                {Copy.sendLaterWhat}
              </Txt>
              {later.step === "presets" ? (
                <>
                  {eveningUsable ? (
                    <SheetRow
                      label={Copy.sendLaterTonight(scheduleLabel(eveningAt.toISOString(), openedAt, zone))}
                      onPress={() => pickLater(eveningAt)}
                    />
                  ) : null}
                  <SheetRow
                    label={Copy.sendLaterTomorrow(
                      scheduleLabel(tomorrowNine(openedAt).toISOString(), openedAt, zone),
                    )}
                    onPress={() => pickLater(tomorrowNine(openedAt))}
                  />
                  <SheetRow
                    label={Copy.sendLaterMonday(
                      scheduleLabel(nextWeekNine(openedAt).toISOString(), openedAt, zone),
                    )}
                    onPress={() => pickLater(nextWeekNine(openedAt))}
                  />
                  <SheetRow
                    icon="chev"
                    label={Copy.sendLaterPick}
                    onPress={() => { setPastNote(false); setLater({ step: "days" }); }}
                  />
                </>
              ) : later.step === "days" ? (
                /* THE DAYS. A quarter ahead — the resurface chooser's own span and its own
                   reason (a fortnight was an exclusion nothing on screen admitted). TODAY is
                   offered only while some hour on it is still far enough ahead to be worth
                   naming, which is the same lead rule the evening preset lives under. */
                <ScrollView style={{ maxHeight: 208 }} nestedScrollEnabled>
                  {DAY_OFFSETS.filter(
                    (offset) => offset > 0 || usableHours(openedAt, 0).length > 0,
                  ).map((offset) => (
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
                <ScrollView style={{ maxHeight: 208 }} nestedScrollEnabled>
                  {usableHours(openedAt, later.offset).map((hour) => {
                    const at = dayAtHour(openedAt, later.offset, hour).instant;
                    return (
                      <SheetRow
                        key={hour}
                        label={scheduleLabel(at.toISOString(), openedAt, zone)}
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
              <Txt variant="caption" tone="ink3" style={{ paddingHorizontal: 14, paddingTop: 6, paddingBottom: 2 }}>
                {Copy.sendLaterZone(zone)}
              </Txt>
              {/* BACK unwinds ONE step — the escape cascade's rule (close the innermost thing
                  that is open), which on the last step closes the picker itself. */}
              <SheetRow
                icon="x"
                label={Copy.sendLaterClose}
                onPress={() =>
                  setLater(
                    later.step === "presets" ? null
                      : later.step === "days" ? { step: "presets" }
                        : { step: "days" },
                  )
                }
              />
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
          {!w.standalone && !forward && attachments.length > 0 ? (
            <Txt variant="hint" tone="ink3" style={{ paddingBottom: 2 }}>
              {Copy.sendLaterUnavailable}
            </Txt>
          ) : null}
          {pinNotes ? null : notesBlock}
          </ScrollView>
          {/* The scroller's bottom edge, drawn: a cut letter reads as an edge, not a sliced field. */}
          <View style={{ height: StyleSheet.hairlineWidth * 2, marginTop: -10, backgroundColor: t.c.hairSoft }} />
          {pinNotes ? notesBlock : null}
          {/* The footer WRAPS on a narrow sheet: Cancel keeps the left edge on its own line and the
              send verbs stay right-aligned under it — nothing starts off-screen (the attach row's grammar). */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", columnGap: 8, rowGap: 8 }}>
            <Button label={Copy.replyCancel} variant="quiet" onPress={closeComposer} style={{ marginRight: "auto" }} />
            {/* SEND LATER stands beside Send because it is the same act on a different clock,
                under the SAME lock: a message that may not be sent now may not be scheduled
                either, and one predicate owns both buttons. A forward is never offered it —
                a draft row cannot hold the forward reference (§14) — and the sentence saying
                so is the button's accessibility hint rather than a control that fails after
                the pick. */}
            {laterOffered ? (
              <Button
                label={Copy.sendLater}
                variant="plain"
                disabled={!canSend}
                onPress={openLater}
              />
            ) : null}
            {/* SEND + DONE — the same send, and the message being answered filed with it. Beside
                Send under the SAME lock, like Send later: a message that may not be sent may not
                be sent and filed either, and one predicate owns all three buttons. Offered only
                where the ENGINE says the second action would finish something
                (`sendAndDoneOffered`) — the webapp composer reads the same rule, and neither
                surface judges it for itself. It carries the same disabled/handler pair as Send:
                an undefined handler takes the button role off the control. */}
            {andDoneOffered ? (
              <Button
                label={Copy.sendAndDone}
                variant="plain"
                disabled={pressAct === "none"}
                onPress={() => press(pressAct, true)}
              />
            ) : null}
            {/* Send keeps its FACE and dims when it cannot be taken — `Button`'s own rule.
                Swapping the variant made the unavailable state look like a different,
                perfectly pressable verb, and dropping the handler took the button role off
                it entirely (measured in the accessibility tree on the Duo). */}
            <Button
              label={phase === "sending" ? Copy.replySending : Copy.replySend}
              variant="solid"
              disabled={pressAct === "none"}
              onPress={() => press(pressAct)}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}



/* ── primitives ────────────────────────────────────────────────────────────────────────────── */

/** A bar capsule with a pressed face — the webapp button's `aria-pressed`, in RN vocabulary. */
function BarToggle({
  label,
  icon,
  on,
  onPress,
}: {
  label: string;
  icon: IconName;
  on: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
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
          backgroundColor: on ? t.c.accentSoft : t.c.panel,
          opacity: pressed ? 0.86 : 1,
        },
        t.lift("l0"),
      ]}
    >
      <Icon name={icon} size={PILL.icon} color={on ? t.c.accentInk : t.c.ink} />
      <Txt variant="button" tone={on ? "accent" : "ink"} style={{ flexShrink: 1 }}>
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
