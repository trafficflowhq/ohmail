/**
 * The persistent chrome: the top strip, the Screener doorbell, and the toast.
 *
 * NO WORDMARK in the chrome: the mark lives on welcome and
 * sign-in, and the space here belongs to the app. The strip still pays the top
 * inset and carries the factual sentences — freshness, outage, first-sync,
 * unsaved changes — which are state, not brand.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Copy } from "../copy";
import { sayArg } from "../refusal";
import { useTheme } from "../theme";
import { useWorld, useWorldToast } from "../state/world";
import { AT_REST, riseForAction, riseForNotice, riseForPress, type Rise, type ToastEntry } from "../state/toast-one";
import { connectionSaid, firstSyncContinuesSaid, staleSaid } from "../state/live";
import { Icon } from "./Icon";
import { usePaneChrome } from "./pane-chrome";
import { usePosture } from "./posture";
import { scaffoldPlan } from "./scaffold/plan";
import { Tap, Txt, useTopPad } from "./base";
import { toastBottom, useBottomChromeExtent } from "./bottom-chrome";
import { doorbellFaces } from "./doorbell-stack";
import { GlassPill } from "./glass";
import { UnsavedChanges } from "./UnsavedChanges";

const platformName = Platform.OS === "ios" ? ("ios" as const) : ("android" as const);

/* ----------------------------------------------------------------- top bar */

export function TopBar({ trailing }: { trailing?: React.ReactNode }) {
  const t = useTheme();
  const top = useTopPad(6);
  // THE FRESHNESS LABEL (INSTANT-ARCH §6.6): while the mirror on screen is stale, every tab
  // says so at the top — "As of Fri 09:00 · catching up" — and says nothing once a
  // drain settles. In the shared chrome rather than any screen, the SyncBar lesson: a view can
  // only speak about itself, and the next tab added must get the sentence for free. The world
  // layer derives it (`boot.staleAsOf`, sentence-ready time or null); this renders words.
  // "Catching up" only while a round is IN FLIGHT (`live.ts#staleSaid`); otherwise the age alone.
  const world = useWorld();
  const boot = world.boot;
  const stale = boot.staleAsOf;
  /* THE CONNECTION OUTRANKS THE FRESHNESS LABEL, and replaces it rather than stacking under it:
     a link that is gone is WHY the mirror is stale, so two lines would say one thing twice and
     the weaker of them would be the one claiming "catching up". The wording and which verdicts
     are silent are `connectionSaid`'s, shared with the Settings panel. */
  const outage = connectionSaid(boot.connection);
  /* AND BELOW BOTH: where a budgeted first sync is continuing (`live.ts#firstSyncContinuesSaid`).
     Ranked under the freshness label rather than over it, which is the browser ladder's own order
     — a stale mirror is the larger fact, and this explains a mirror that is filling in steps
     while nothing is wrong. Off the MAILBOX rows, so it is the stop the server wrote down and not
     an engine's memory of one. */
  const continuing = firstSyncContinuesSaid(world.mailboxes.rows);
  /* THE SIDEBAR TOGGLE, top-left of the LIST PANE on the two-pane postures (prototype v5) —
     provided by the list-detail surface through `pane-chrome`, so every list gets it in the
     same place without threading a prop. One pane provides nothing and nothing renders. */
  const pane = usePaneChrome();
  return (
    <View>
      <View
        style={{
          paddingTop: top,
          paddingBottom: 2,
          paddingHorizontal: 16,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 12,
        }}
      >
        {pane !== null ? (
          <Tap
            onPress={pane.openDrawer}
            accessibilityRole="button"
            accessibilityLabel={Copy.sidebar}
            style={{ padding: 10, marginLeft: -10, marginVertical: -6 }}
          >
            <Icon name="sidebar" size={17} color={t.c.ink2} />
          </Tap>
        ) : null}
        <View style={{ flex: 1 }} />
        {trailing}
      </View>
      {outage !== null ? (
        <Txt
          variant="meta"
          tone="ink3"
          accessibilityRole="alert"
          style={{ paddingHorizontal: 16, paddingBottom: 4 }}
        >
          {outage}
        </Txt>
      ) : stale !== null ? (
        <Txt
          variant="meta"
          tone="ink3"
          accessibilityRole="text"
          style={{ paddingHorizontal: 16, paddingBottom: 4 }}
        >
          {staleSaid(stale, boot.draining)}
        </Txt>
      ) : continuing !== null ? (
        <Txt
          variant="meta"
          tone="ink3"
          accessibilityRole="text"
          style={{ paddingHorizontal: 16, paddingBottom: 4 }}
        >
          {continuing}
        </Txt>
      ) : null}
      {/* BELOW the freshness label and independent of it: a change can be abandoned while the
          mirror is perfectly current, which is the state `stale === null` describes. Rendering it
          inside that branch would hide the notice in the case it is most likely to occur. */}
      <UnsavedChanges />
    </View>
  );
}

/**
 * A back bar for the pushed screens (message, screener detail, settings…).
 * The Servers screen can also be the FIRST screen (the gate lands a paired but
 * disconnected phone there), where there is no history to pop — the back
 * affordance hides rather than offering a press that goes nowhere.
 */
export function DetailBar({ title, right }: { title?: string; right?: React.ReactNode }) {
  const t = useTheme();
  const top = useTopPad(6);
  /* On the rail postures (the closed Duo) the root rail leads with Back on every pushed screen
     (`nav-rail.tsx`); the bar keeps its title and yields the affordance, so Back stands once. */
  const railBack = scaffoldPlan(usePosture(), platformName).nav === "rail";
  const canBack = router.canGoBack() && !railBack;
  return (
    <View>
    {/* THE PUSHED SCREENS NEED IT TOO. A verb can be abandoned from the message, sender, triage,
        scheduled, folder, settings and server screens — all of which render `DetailBar`, not
        `TopBar` — and until this was here the notice appeared nowhere until the reader navigated
        back to a tab root. A recovery surface reachable only from somewhere else is one a person
        finds by accident. */}
    <View
      style={{
        paddingTop: top,
        paddingBottom: 8,
        paddingHorizontal: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
      }}
    >
      {canBack ? (
        <Tap
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={Copy.back}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, padding: 8 }}
        >
          <View style={{ transform: [{ rotate: "180deg" }] }}>
            <Icon name="chev" size={15} color={t.c.ink2} />
          </View>
          <Txt variant="button" tone="ink2">
            {Copy.back}
          </Txt>
        </Tap>
      ) : null}
      {title ? (
        <Txt variant="button" tone="ink3" numberOfLines={1} style={{ flexShrink: 1, marginLeft: 4 }}>
          {title}
        </Txt>
      ) : null}
      <View style={{ flex: 1 }} />
      {right}
    </View>
    <UnsavedChanges />
    </View>
  );
}

/* ---------------------------------------------------------------- doorbell */

/**
 * `.doorbell` — a knock, not a nag. One tinted capsule above the Ohbox rows
 * that says how many strangers are waiting and gets out of the way when none
 * are.
 */
export function Doorbell(
  { initials, count, max }: { initials: string[]; count: number; max?: number },
) {
  const t = useTheme();
  if (count === 0) return null;
  // FOUR FACES AND A COUNT, the web's rule to the letter (`doorbell-stack.ts` holds it and the
  // suite drives it). 351 waiting used to draw 351 letters straight off the right-hand edge.
  const { shown, overflow } = doorbellFaces(initials, max);
  return (
    <Tap
      onPress={() => router.push("/screener")}
      accessibilityRole="button"
      accessibilityLabel={Copy.doorbellAria(count, Copy.doorbellGo)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        marginHorizontal: 10,
        marginBottom: 12,
        paddingLeft: 10,
        paddingRight: 16,
        paddingVertical: 9,
        borderRadius: t.radius.pill,
        backgroundColor: t.c.accentSoft,
      }}
    >
      <View style={{ flexDirection: "row" }}>
        {shown.map((i, n) => (
          <View
            key={`${i}-${n}`}
            style={[
              {
                width: 26,
                height: 26,
                borderRadius: 13,
                backgroundColor: t.c.float,
                alignItems: "center",
                justifyContent: "center",
                marginLeft: n === 0 ? 0 : -7,
              },
              t.lift("l0"),
            ]}
          >
            <Txt variant="tagchip" tone="ink2">
              {i}
            </Txt>
          </View>
        ))}
        {overflow > 0 ? (
          /* The overflow counter is hidden from the screen reader: the capsule's own label
             already names the FULL count, and a second number read out beside it would say the
             same thing twice with a different figure. The web marks its chip `aria-hidden`. */
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
              {
                height: 26,
                minWidth: 26,
                paddingHorizontal: 5,
                borderRadius: 13,
                backgroundColor: t.c.float,
                alignItems: "center",
                justifyContent: "center",
                marginLeft: -7,
              },
              t.lift("l0"),
            ]}
          >
            <Txt variant="tagchip" tone="ink3">
              {Copy.doorbellMore(overflow)}
            </Txt>
          </View>
        ) : null}
      </View>
      <Txt variant="meta" tone="ink2" numberOfLines={1} style={{ flexShrink: 1 }}>
        <Txt variant="settingsLabel" tone="ink">
          {Copy.doorbell(count)}
        </Txt>{" "}
        {Copy.doorbellRest}
      </Txt>
      <View style={{ flex: 1 }} />
      <Txt variant="button" tone="accent">
        {Copy.doorbellGo}
      </Txt>
    </Tap>
  );
}

/* ------------------------------------------------------------------- toast */

/**
 * The toast: two pills over one anchor, the Undo offer above a notice (`state/toast-one.ts`). A
 * notice arriving under a standing offer lifts the offer by the notice's height — a transform, on
 * the arrival only, deferred while the button is held — so the offer stays on screen for its whole
 * window and never moves from under a finger. Reduced motion places it at once (`t.ms`).
 */
export function Toast() {
  const t = useTheme();
  const { slots, dismiss, onScreen } = useWorldToast();
  const lift = useRef(new Animated.Value(0)).current;
  const rise = useRef<Rise>(AT_REST);
  const noticeHeight = useRef<number | null>(null);
  const newest = Math.max(slots.action?.id ?? 0, slots.notice?.id ?? 0);
  const actionId = slots.action?.id ?? null;
  const noticeId = slots.notice?.id ?? null;

  const moveTo = (next: Rise, animate: boolean) => {
    const before = rise.current.lift;
    rise.current = next;
    if (!animate) lift.setValue(-next.lift);
    else if (next.lift !== before) {
      Animated.timing(lift, {
        toValue: -next.lift,
        duration: t.ms("base"),
        easing: Easing.bezier(...t.motion.easing.spring),
        useNativeDriver: true,
      }).start();
    }
  };

  // A new offer is PLACED: above a notice already standing, at the anchor otherwise.
  useLayoutEffect(() => {
    if (noticeId === null) noticeHeight.current = null;
    moveTo(riseForAction(actionId, noticeId === null ? null : noticeHeight.current), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionId]);
  useEffect(() => {
    if (noticeId === null) noticeHeight.current = null;
  }, [noticeId]);

  return (
    <>
      {slots.action ? (
        <ToastPill
          entry={slots.action}
          newest={slots.action.id === newest}
          dismiss={dismiss}
          onScreen={onScreen}
          lift={lift}
          onPressing={(held) => moveTo(riseForPress(rise.current, held), true)}
        />
      ) : null}
      {slots.notice ? (
        <ToastPill
          entry={slots.notice}
          newest={slots.notice.id === newest}
          dismiss={dismiss}
          onScreen={onScreen}
          onHeight={(h) => {
            noticeHeight.current = h;
            moveTo(riseForNotice(rise.current, h), true);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * One pill. Rises once, holds, dismisses itself; under reduced motion a state change is instant,
 * never merely slower. A rejection is one sentence, no verb — the engine already rolled the act
 * back. A verb the wire can reverse carries Undo: the pill holds for the entry's own window and the
 * press hands back to the callback, which enforces its own bound and fires at most once. The
 * material is the glass pill, the one toolbar surface (`glass/GlassPill.tsx`).
 */
function ToastPill({ entry, newest, dismiss, onScreen, lift, onHeight, onPressing }: {
  entry: ToastEntry;
  newest: boolean;
  dismiss: (id?: number) => void;
  onScreen: () => void;
  lift?: Animated.Value;
  onHeight?: (height: number) => void;
  onPressing?: (held: boolean) => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  /* ABOVE WHATEVER STANDS AT THE FOOT. A fixed 74pt cleared the dock and nothing else: on the
     18 Pro the reader's two-row verb bar is taller, and the pill covered Later and Park
     (`bottom-chrome.ts` holds the measurement). The bars report; this reads. */
  const chrome = useBottomChromeExtent();
  const anim = useRef(new Animated.Value(0)).current;
  const y = useMemo(() => {
    const slide = anim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] });
    return lift ? Animated.add(slide, lift) : slide;
  }, [anim, lift]);
  const message = sayArg(entry.say);
  const undo = entry.undo;
  const holdMs = entry.holdMs ?? 3200;
  // The ID, not the text: two ADJACENT identical sentences (two replies confirmed by one flush)
  // must each re-arm the dismiss timer, or the second stands forever.
  const toastId = entry.id;
  /* THE HOLD COUNTS FROM THE SCREEN, NOT FROM THE COMMIT. Everything a JS task commits is
     mounted at its end, and a task that also re-derives the mirror runs for seconds — measured
     on the 18 Pro: "Undone." (3.2 s) expired before it was ever drawn. So the timer and the fade
     start in `onLayout`, the first moment the pill is on screen, once per entry. */
  const hold = useRef<{ id: number | undefined; timer: ReturnType<typeof setTimeout> | null }>({ id: undefined, timer: null });
  const laidOut = (e: LayoutChangeEvent) => {
    onHeight?.(e.nativeEvent.layout.height);
    // The doors waiting on the newest sentence (`LiveDeps.painted`) may dispatch now — it is on screen.
    if (newest) onScreen();
    if (hold.current.id === toastId) return;
    if (hold.current.timer !== null) clearTimeout(hold.current.timer);
    Animated.timing(anim, {
      toValue: 1,
      duration: t.ms("base"),
      easing: Easing.bezier(...t.motion.easing.spring),
      useNativeDriver: true,
    }).start();
    /* BY ID: a displaced sentence's timer must not take the one that replaced it off the
       screen (`state/toast-one.ts#afterDismiss`). */
    hold.current = { id: toastId, timer: setTimeout(() => dismiss(toastId), holdMs) };
  };

  useEffect(() => {
    if (!message) return;
    /* AND IT IS SPOKEN, not merely drawn: iOS has no live region, so the sentence goes through
       the announcement door (Android has `accessibilityLiveRegion` below). The Undo verb rides the
       sentence, because a way back nobody is told about is no way back; a notice QUEUES behind
       whatever is being read, so it never cuts off the offer it stands beneath. */
    if (Platform.OS === "ios") {
      if (undo) AccessibilityInfo.announceForAccessibility(Copy.ariaLabelDetail(message, Copy.undo));
      else AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
    }
    return () => {
      if (hold.current.timer !== null) clearTimeout(hold.current.timer);
      hold.current = { id: undefined, timer: null };
      anim.setValue(0);
    };
    // `message` is rendered; `toastId` is what re-arms the announcement per entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastId, anim, dismiss, t]);

  if (!message) return null;

  return (
    <Animated.View
      // A new entry is a new view, so `onLayout` fires for it even at the same size.
      key={toastId}
      onLayout={laidOut}
      pointerEvents="box-none"
      accessibilityLiveRegion="polite"
      style={{
        position: "absolute",
        left: 12,
        right: 12,
        bottom: toastBottom(insets.bottom, chrome),
        zIndex: t.zLayer.toast,
        opacity: anim,
        transform: [{ translateY: y }],
      }}
    >
      <GlassPill
        horizontal
        level="l2"
        style={{ alignSelf: "center", maxWidth: "100%" }}
        contentStyle={{ alignItems: "center", gap: 12, paddingVertical: 7, paddingHorizontal: 15 }}
      >
        <Txt variant="meta" numberOfLines={2} style={{ flexShrink: 1 }}>
          {message}
        </Txt>
        {undo ? (
          <Tap
            accessibilityRole="button"
            accessibilityLabel={Copy.undo}
            onPressIn={() => onPressing?.(true)}
            onPressOut={() => onPressing?.(false)}
            onPress={() => {
              undo();
              // This handler belongs to the last PAINTED render; a sentence raised since is
              // already in state, and an id-less dismiss would clear that one instead.
              dismiss(toastId);
            }}
            style={{ paddingVertical: 4, paddingLeft: 4 }}
          >
            <Txt variant="button" tone="accent">
              {Copy.undo}
            </Txt>
          </Tap>
        ) : null}
      </GlassPill>
    </Animated.View>
  );
}
