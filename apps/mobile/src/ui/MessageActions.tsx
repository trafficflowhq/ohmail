/**
 * The open message's verbs — the webapp action bar, in the phone's idiom. The verbs are the
 * same verbs: same names (`src/copy.ts` mirrors the webapp catalogue;
 * `test/action-parity.test.ts` derives the list from the webapp's source), same engine
 * mutations behind them (`src/state/live.ts`, mirrored from `AppShell.onMessageAction`) —
 * arranged for a thumb: the bar pins to the bottom; everything else stands in the More sheet.
 * The webapp's absence rules hold: Reply all only where `replyAllRecipients` admitted an
 * envelope, Forward never on `no_forward`, the read slot holds one of its three faces. The AI
 * drafter is not here — no engine verb, so an absent control, never a dead one.
 */
import { Fragment, useEffect, useState } from "react";
import {
  Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, TextInput, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy } from "../copy";
import { useLocale } from "../i18n/LocaleProvider";
import { useTheme } from "../theme";
import { destLabel, DESTINATIONS, domainOf, type Destination, type Scope } from "../state/model";
import {
  DAY_OFFSETS,
  dayAt,
  dayAtHour,
  dayNine,
  effectiveSignature,
  moveTargetsFor,
  moveTargetLabel,
  nextWeekAt,
  nextWeekNine,
  parseRecipients,
  readerZone,
  resurfaceClock,
  resurfaceTimeLabel,
  RESURFACE_HOURS,
  scheduleLabel,
  SEND_LATER_MIN_LEAD_MS,
  SIG_FOLLOWING,
  usableHours,
  todayEvening,
  tomorrowAt,
  tomorrowNine,
  type ResurfaceHorizon,
  type SignatureState,
  type WorldMail,
  type WorldTag,
} from "../state/live";
import { useWorld } from "../state/world";
import { BAR, PILL } from "./action-bar-layout";
import { Button, Rule, Tap, Txt } from "./base";
import { GlassActionBar, GlassPill, type BarVerbSpec } from "./glass";
import type { RailAction } from "./glass/GlassRail";
import { usePosture } from "./posture";
import { scaffoldPlan } from "./scaffold/plan";
import { publishReaderRail } from "./reader-rail";
import {
  readerVerbMode,
  readerVerbPlacement,
  railReaderGroups,
  type ReaderVerbFacts,
  type ReaderVerbId,
} from "./reader-verbs";
import { Icon, type IconName } from "./Icon";
import { sendLaterOffered } from "./standalone-form";
import { afterWithdraw, cancelAct } from "./send-cancel";
import { Segmented } from "./Segmented";
import { CancelRow, Sheet, SheetRow, useSheetPanelBounds } from "./Sheet";

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
  | { compose: "reply" | "replyAll" | "forward" };

export function MessageActions({
  m,
  onDeleted,
  onBack,
}: {
  m: WorldMail;
  /**
   * Called the moment a CONFIRMED delete is dispatched — the optimistic tombstone has already
   * dropped the row from every view, so the screen behind this bar is about to say "no longer
   * here" over a message the reader just acted on. The caller navigates away instead; a
   * rollback re-lists the row where it was, under the failure toast.
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

  const a = w.actions;
  const close = () => setOpen(null);

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
  const facts: ReaderVerbFacts = {
    canReplyAll: m.canReplyAll === true,
    noForward: m.noForward === true,
    foldersEnabled: w.folders.enabled,
    junkOffered: moveTargetsFor(m).includes("spam"),
  };
  const placement = readerVerbPlacement(mode, facts);
  const moreHas = (id: ReaderVerbId) => placement.behindMore.includes(id);

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
          return { id, icon: "fwd", label: Copy.actionForward, onPress: () => setOpen({ compose: "forward" }) };
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
  }, [mode, m.id, pile, unread, facts.canReplyAll, facts.noForward, facts.foldersEnabled, facts.junkOffered, locale, onBack]);

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
  const tomorrow = tomorrowAt(new Date(), resurfaceTime);
  const nextWeek = nextWeekAt(new Date(), resurfaceTime);

  /**
   * The ActionBar's verb capsules (mode "bar") — the webapp's `BAR_VERB_ORDER` arrives through
   * `placement.standing`; the segments (defer, file) abut exactly as the desktop's do. The
   * handlers are the SAME handlers the compact bar and the sheets press — one verb, one act.
   */
  const barSpec = (id: ReaderVerbId): BarVerbSpec => {
    switch (id) {
      case "replyAll": return { id, label: Copy.actionReplyAll, onPress: () => setOpen({ compose: "replyAll" }) };
      case "forward": return { id, label: Copy.actionForward, onPress: () => setOpen({ compose: "forward" }) };
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
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: Math.max(insets.bottom, 12),
            alignItems: "center",
            zIndex: t.zLayer.tabBar,
          }}
        >
          <GlassActionBar
            reply={{ label: Copy.actionReply, onPress: () => setOpen({ compose: "reply" }) }}
            verbs={barVerbs}
            readSwitch={{ label: readFace.label, onPress: readFace.press }}
            extraMore={barExtraMore}
          />
        </View>
      ) : mode === "rail" ? null : (
      /* The compact bar, in the glass material (owner: one look on every device) — the same
         verbs, wrap and More it always carried; only the slab became the translucent pill. */
      <View pointerEvents="box-none" style={{ paddingHorizontal: 8, paddingBottom: Math.max(insets.bottom, 8) }}>
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
        {/* THE VERBS WRAP; More is pinned OUTSIDE the wrap. A scroller stood here and a
            horizontal ScrollView clips: at 1080 px / 420 dpi the fourth verb was cut mid-glyph
            — "Resurface" at the pill's right edge, "Wieder auftauchen" as a bare "W". Wrapping
            is what every other pill group on this phone already does. More is a sibling of the
            wrap, not a member, so it can neither overlap a pill nor land alone on a line — the
            shape the first release-binary walk produced and the scroller was answering. */}
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            flexWrap: "wrap",
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
          {/* The three horizons — toggles, with the pile that holds the message shown pressed. */}
          <BarToggle
            label={Copy.actionLater}
            icon="clock"
            on={m.pile === "reply_later"}
            onPress={() => a.pileToggle(m.id, "replyLater")}
          />
          <BarToggle
            label={Copy.actionSetAside}
            icon="pause"
            on={m.pile === "set_aside"}
            onPress={() => a.pileToggle(m.id, "setAside")}
          />
          {/* Resurface asks "when?" — except on a message already scheduled, where the press is
              the webapp's horizon-less toggle: it clears the booking rather than re-dating it. */}
          <BarToggle
            label={Copy.actionResurface}
            icon="up"
            on={m.pile === "bubbled_up"}
            onPress={() => (m.pile === "bubbled_up" ? a.resurfaceToggle(m.id) : setOpen("resurface"))}
          />
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
          <SheetRow icon="open" label={Copy.actionForward} onPress={() => setOpen({ compose: "forward" })} />
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
            onPress={() => { close(); a.deleteMessage(m.id); onDeleted?.(); }}
          />
          <CancelRow onPress={close} />
        </Sheet>
      ) : null}

      {/* ── Resurface: the horizon chooser — Now / Tomorrow / Next week / Pick a date ────── */}
      <Sheet
        open={open === "resurface" || open === "pick" || open === "time"}
        onClose={close}
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
          <ScrollView style={{ maxHeight: 320 }}>
            {RESURFACE_HOURS.map((hhmm) => (
              <SheetRow
                key={hhmm}
                label={hhmm}
                on={hhmm === resurfaceTime}
                onPress={() => { setPickedTime(hhmm); setOpen("resurface"); }}
              />
            ))}
          </ScrollView>
        ) : (
          // The picked day, as rows — the native idiom for the webapp's date input, floored at
          // tomorrow so the chooser cannot name a horizon in the past.
          <ScrollView style={{ maxHeight: 320 }}>
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
        )}
        <CancelRow onPress={() => { close(); setPickedTime(null); }} />
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
        <CancelRow onPress={close} />
      </Sheet>

      {open === "tag" ? <TagSheet m={m} tags={w.tags} onClose={close} /> : null}
      {open === "screening" ? <ScreeningSheet m={m} onClose={close} /> : null}
      {open !== null && typeof open === "object" ? (
        <ComposeSheet m={m} mode={open.compose} onClose={close} />
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
      <ScrollView style={{ maxHeight: 300 }}>
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
  const domain = domainOf(m.from.address);
  const hasDomain = m.from.address.includes("@") && domain !== "";
  const target = scope === "domain" ? `@${domain}` : m.from.address;
  return (
    <Sheet open onClose={onClose} label={Copy.actionScreening}>
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
          onPress={() => { onClose(); w.actions.screenSender(m.id, dest, scope, applyRetro); }}
        />
      ))}
      <Txt variant="caption" tone="ink3" style={{ paddingHorizontal: 14, paddingTop: 8 }}>
        {applyRetro ? Copy.screeningNoteRetro(target) : Copy.screeningNote(target)}
      </Txt>
    </Sheet>
  );
}

/* ── the composer — reply, reply all, forward; plain text, sent through the engine. The
   sending mailbox's stored signature stands below the writing area as a distinct block —
   removable, editable, serialized exactly as shown (SIG-MOB; `signature.ts` is the shared
   model, `SignatureBlock.tsx` the webapp reference). ─────────────────────────────────────── */

function ComposeSheet({
  m,
  mode,
  onClose,
}: {
  m: WorldMail;
  mode: "reply" | "replyAll" | "forward";
  onClose: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const w = useWorld();
  /** The composer never straddles a hinge and stays bounded on wide windows (`Sheet.tsx`). */
  const panelBounds = useSheetPanelBounds();
  /** The send-later day rows, named by `Intl` in the app's language. */
  const locale = useLocale();
  const [body, setBody] = useState("");
  const [to, setTo] = useState("");
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
  /**
   * TRUE once a Cancel was answered "too late": the request had left and this device cannot
   * un-send it. The sentence stands in place and the next press dismisses — see `closeComposer`.
   */
  const [alreadySent, setAlreadySent] = useState(false);
  /**
   * THE SIGNATURE BLOCK'S STATE (`signature.ts`, shared with the webapp composer): `following`
   * until the user speaks, then their edit or their strike stands for THIS message. The sheet
   * is mounted per compose and unmounts on close, so the state's lifetime IS the message's —
   * the one-removal-one-message rule by construction.
   */
  const [sig, setSig] = useState<SignatureState>(SIG_FOLLOWING);
  const forward = mode === "forward";
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
  const laterOffered = sendLaterOffered({ standalone: w.standalone, forward });
  const [openedAt, setOpenedAt] = useState<Date>(() => new Date());
  /** The one refusal this picker can raise, said in place — the webapp's `role="status"` note. */
  const [pastNote, setPastNote] = useState(false);
  const zone = readerZone();

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
    // Confirmed: the flush already announced the send (kind-aware toast); this just closes.
    if (settled === "confirmed") onClose();
    else if (settled === "rolled_back") {
      // The queued copy is gone with the rollback — a fresh Send cannot double-deliver.
      setQueuedKey(null);
      setPhase("idle");
      // …and the send did NOT go after all, so the too-late sentence may not stand over a
      // re-armed Send. Cleared with the phase that raised it.
      setAlreadySent(false);
    }
    else if (settled === "unverified") setPhase("unverified");
    // `unverified` stays locked: the server could not say whether the message left, so the
    // only honest controls are the check-Sent sentence (in place and toasted) and Cancel.
  }, [phase, queuedKey, w, onClose]);
  // EVERY typed entry must parse, or nothing sends. A filter that dropped the malformed
  // entry silently narrowed the audience — "alice@x, bob.x" sent to Alice alone with nobody
  // told — so an invalid entry LOCKS Send rather than shrinking the list. Entries split on
  // commas/semicolons (never bare spaces: `Alice <alice@x.org>` is ONE entry), and a
  // display-named entry is validated on the address its angle brackets carry.
  const recipients = forward ? parseRecipients(to) : [];
  // A signature never lights Send up on its own — `canSend` reads the body alone, deliberately.
  const canSend =
    phase === "idle" && (forward ? recipients !== null && recipients.length > 0 : body.trim() !== "");

  /**
   * WHAT THE BLOCK SHOWS — and exactly what the send appends (`effectiveSignature`, one
   * derivation, two consumers). The sending mailbox is the row's own `mailboxId`: the mailbox
   * the message arrived in, which is what `Engine.enrich` puts on a reply's wire and what the
   * forward arm passes explicitly — this sheet has no From selector, so the resolution is the
   * mutation's, made visible. `w.signatures === null` (not yet server-confirmed) renders no
   * block and appends nothing: a signature is never drawn or serialized from a guess.
   */
  const sigText = w.signatures === null ? null : effectiveSignature(sig, w.signatures, m.mailboxId);

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
      onClose();
      return;
    }
    void (async () => {
      const key = queuedKey!;
      // The verdict is read AFTER the withdrawal answers, not before it: a flush can settle
      // under the await, and the fresher reading is the one this press is owed.
      const said = afterWithdraw(await w.actions.withdrawSend(key), w.sendOutcome(key));
      if (said === "close") onClose();
      else setAlreadySent(true);
    })();
  };

  const send = async (sendAt: string | null = null) => {
    // The picker closes the moment ANY send is dispatched — a panel left standing over a
    // message that is already on its way offers rows for an act that may no longer happen.
    setLater(null);
    setPhase("sending");
    const result = forward
      ? await w.actions.sendForward(m.id, recipients ?? [], body, sigText)
      : await w.actions.sendReply(m.id, body, mode === "replyAll", sigText, sendAt);
    if (result.outcome === "sent") {
      onClose();
      return;
    }
    if (result.outcome === "queued") {
      setQueuedKey(result.key ?? null);
      setPhase("queued");
      return;
    }
    // `unverified` LOCKS the composer exactly like queued, for the opposite reason: the
    // server could not say whether the message left, so a fresh-key re-send is the
    // duplicate-delivery door. Only a plain failure re-arms Send.
    setPhase(result.outcome === "unverified" ? "unverified" : "idle");
  };

  return (
    <Modal transparent animationType={t.reduceMotion ? "none" : "slide"} visible onRequestClose={closeComposer}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, justifyContent: "flex-end" }}
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
            },
            panelBounds,
            t.liftUp("l3"),
          ]}
        >
          {/* The head states the audience — the same statement the webapp editor opens with,
              and for reply-all the same envelope the send will carry, every name on it. */}
          <Txt variant="settingsLabel">
            {forward
              ? Copy.forwardHead
              : mode === "replyAll" && m.replyAllHead
                ? Copy.replyToAll(m.replyAllHead.to)
                : Copy.replyTo(m.from.name)}
          </Txt>
          {mode === "replyAll" && m.replyAllHead && m.replyAllHead.cc !== "" ? (
            <Txt variant="caption" tone="ink3">
              {Copy.replyCcLine(m.replyAllHead.cc)}
            </Txt>
          ) : null}
          {forward ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Txt variant="caption" tone="ink3">
                {Copy.forwardTo}
              </Txt>
              <TextInput
                value={to}
                onChangeText={setTo}
                editable={phase === "idle"}
                placeholder={Copy.forwardToPlaceholder}
                placeholderTextColor={t.c.ink3}
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
          {/* Frozen the moment Send is pressed: the dispatch captured the fields at the
              press, and an editable field over a sending/queued/unverified state would
              display words the wire will not carry. */}
          <TextInput
            value={body}
            onChangeText={setBody}
            editable={phase === "idle"}
            placeholder={forward ? Copy.forwardNotePlaceholder : Copy.replyPlaceholder}
            placeholderTextColor={t.c.ink3}
            multiline
            autoFocus
            accessibilityLabel={forward ? Copy.forwardNotePlaceholder : Copy.replyPlaceholder}
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
                minHeight: later === null ? 120 : 44,
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
                onChangeText={(text) => setSig({ kind: "edited", text })}
                editable={phase === "idle"}
                multiline
                accessibilityLabel={Copy.sigAria}
                style={[t.type.body, { color: t.c.ink2, paddingVertical: 0, maxHeight: 144 }]}
              />
            </View>
          ) : null}
          {phase === "queued" || phase === "unverified" ? (
            <Txt variant="caption" tone="ink3">
              {phase === "queued" ? Copy.replyQueued : Copy.replyUnverified}
            </Txt>
          ) : null}
          {/* THE REFUSED CANCEL, SAID IN PLACE — a Cancel that did nothing and rendered nothing
              is a person watching a button not work. An alert, because it answers a press. */}
          {alreadySent ? (
            <Txt variant="caption" tone="ink2" accessibilityRole="alert">
              {Copy.replyAlreadySent}
            </Txt>
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
                <ScrollView style={{ maxHeight: 208 }}>
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
                <ScrollView style={{ maxHeight: 208 }}>
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
          {/* WHY THERE IS NO SEND LATER on a phone that organizes its own mailbox. Only for that
              reason — a forward's absence has its own note above — and above the buttons, where
              the control it explains would have been. */}
          {w.standalone && !forward ? (
            <Txt variant="hint" tone="ink3" style={{ paddingBottom: 2 }}>
              {Copy.scheduledNotOnThisPhone}
            </Txt>
          ) : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Button label={Copy.replyCancel} variant="quiet" onPress={closeComposer} />
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
                onPress={canSend ? openLater : undefined}
              />
            ) : null}
            <Button
              label={phase === "sending" ? Copy.replySending : Copy.replySend}
              variant={canSend ? "solid" : "plain"}
              onPress={canSend ? () => void send() : undefined}
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
 * "Mon 1 Sep" — or "Mo., 1. Sept." — for the picked-day rows.
 *
 * The locale was the literal `"en"` and is now the app's. `Intl` is what decides how a language
 * shortens a weekday and a month, and that is not ours to invent: German writes "Di." with a stop
 * and "Sept." with one too, which a hand-written table gets wrong in a way nobody reviews. The
 * failure arm is unchanged and still English, because `toDateString()` is the platform's last
 * resort on a runtime with no ICU data at all — an unlocalised date beats no date.
 */
function dayLabel(day: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" }).format(day);
  } catch {
    return day.toDateString();
  }
}
