/**
 * One mail row — the prototype's `.row`, at thumb scale.
 *
 * Four lines at most, and the fourth only when the mail has something true to
 * say about itself (a blocked tracker, a protected class, a conversation).
 * Blanc's row hierarchy survives the narrower column intact: weight carries
 * unread, colour carries seen, and the dot is the only mark.
 */
import { useMemo, useRef } from "react";
import { Animated, PanResponder, View } from "react-native";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import type { Mail } from "../state/model";
import { useWorld } from "../state/world";
import type { WorldPileState } from "../state/live";
import { Badge, TapRow, Txt } from "./base";
import { Icon } from "./Icon";
import { mailRowSpoken, threadOfRow, trackerShort } from "./row-spoken";
import {
  readFaceOf, swipeClaims, swipeOffset, swipeVerbFor, SWIPE_FIRE_DX, type ReadFace, type SwipeVerb,
} from "./row-swipe";

export function MailRow({
  m,
  onPress,
  /**
   * SWIPE SHORTCUTS — off unless a list asks for them. Trash does not: a
   * deleted row has no Done and no Later, and a gesture that presses a verb the row cannot take
   * is worse than no gesture. Every verb this offers is on the row's own sheet and reachable
   * through the accessibility actions below, so the swipe is a shortcut and never the only door.
   */
  swipe,
}: {
  m: Mail & { pile?: WorldPileState };
  onPress: () => void;
  swipe?: boolean;
}) {
  const t = useTheme();
  const w = useWorld();
  const seen = !m.unread;
  const thread = threadOfRow(m);
  const preview = m.protected ? Copy.protectedPreview : (m.snippet ?? firstLine(m.body));
  /* EVERY BADGE INSIDE THE STRIP DECIDES WHETHER THE STRIP IS DRAWN. `newSince` was missing, and
     a Resurfaced row wears nothing else in a list — so the chip saying somebody wrote since this
     came back rendered for no row on this phone. `test/mail-row-badges-spoken.test.ts` reads
     this condition against the badges below rather than trusting the next person to remember. */
  const badges = !!m.protected || !!m.trackerNote || thread > 1 || !!m.historyPlace || !!m.newSince;

  /* THE READ SLOT'S FACE, from the one rule the reader's bar uses (`row-swipe.ts#readFaceOf`):
     Done on a resurfaced row, otherwise Mark as read / Mark unread. The swipe must press the
     verb the sheet is showing — two spellings of this would let a gesture do the other one. */
  const face = readFaceOf({ pile: m.pile ?? null, unread: !!m.unread });
  const press = (verb: SwipeVerb) => {
    /* The SAME acts the sheet presses, so the toast and its undo pill ride the verb's own arm
       (`state/live.ts`: Later and the read slot both carry the engine's inverse). Nothing about
       undo is re-implemented here — a second undo mechanism is a second contract. */
    if (verb === "later") { void w.actions.pileToggle(m.id, "replyLater"); return; }
    if (face === "done") { void w.actions.resurfaceDone(m.id); return; }
    w.actions.markSeen(m.id, face === "markUnread");
  };

  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const dxNow = useRef(0);
  const settle = () => {
    dxNow.current = 0;
    Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: true, bounciness: 0 }).start();
  };
  const responder = useMemo(
    () =>
      PanResponder.create({
        /* Claimed at the MOVE and never at the start: a row that takes the touch down owns every
           tap, and the list must go on scrolling under a finger that only meant to scroll. */
        onMoveShouldSetPanResponder: (_e, g) => swipe === true && swipeClaims(g.dx, g.dy),
        onPanResponderMove: (_e, g) => {
          dxNow.current = g.dx;
          pan.setValue({ x: swipeOffset(g.dx), y: 0 });
        },
        onPanResponderRelease: () => {
          const verb = swipeVerbFor(dxNow.current);
          settle();
          if (verb !== null) press(verb);
        },
        /* A gesture the system takes away (a modal, a call) fires no verb and leaves no row
           half-open — the same ending as a drag that stopped short, which is the honest one. */
        onPanResponderTerminate: settle,
        onPanResponderTerminationRequest: () => true,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [swipe, m.id, face],
  );

  const row = (
    <TapRow
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={mailRowSpoken(m)}
      /* THE SAME TWO VERBS, FOR A READER WHO CANNOT SWIPE. A gesture is invisible to a screen
         reader, so the shortcut is published as actions on the row itself — VoiceOver's rotor and
         TalkBack's actions menu reach them directly, and the row's sheet still holds the full
         set. Absent where the list offers no swipe, for the same reason the gesture is. */
      {...(swipe === true
        ? {
          accessibilityActions: [
            { name: "readSlot", label: faceLabel(face) },
            { name: "later", label: Copy.actionLater },
          ],
          onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => {
            if (e.nativeEvent.actionName === "later") press("later");
            else if (e.nativeEvent.actionName === "readSlot") press("read");
          },
        }
        : {})}
      style={{ paddingHorizontal: 14, paddingVertical: 12 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {m.unread ? (
          <View
            style={{
              width: 5,
              height: 5,
              borderRadius: 3,
              backgroundColor: t.c.accent,
            }}
          />
        ) : null}
        <Txt
          variant={seen ? "rowSenderSeen" : "rowSender"}
          tone={seen ? "ink2" : "ink"}
          numberOfLines={1}
          style={{ flexShrink: 1 }}
        >
          {m.from.name}
        </Txt>
        <View style={{ flex: 1 }} />
        <Txt variant="caption" tone="ink3" tabular>
          {m.time}
        </Txt>
      </View>

      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10, marginTop: 2 }}>
        <Txt
          variant={seen ? "rowSubjectSeen" : "rowSubject"}
          tone={seen ? "ink2" : "ink"}
          numberOfLines={1}
          style={{ flexShrink: 1 }}
        >
          {m.subject}
        </Txt>
        {m.amount ? (
          <Txt variant="button" tone={seen ? "ink2" : "ink"} tabular style={{ marginLeft: "auto" }}>
            {m.amount}
          </Txt>
        ) : null}
      </View>

      {preview ? (
        <Txt variant="meta" tone="ink3" numberOfLines={1} style={{ marginTop: 1 }}>
          {preview}
        </Txt>
      ) : null}

      {badges ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
          {m.protected ? (
            <Badge icon="shield" tone="accent">
              {Copy.protectedLead}
            </Badge>
          ) : null}
          {thread > 1 ? <Badge>{thread}</Badge> : null}
          {/* NEW SINCE YOU ASKED TO SEE THIS AGAIN — a resurfaced conversation that has been
              written to. Not the unread dot: the dot says "not read", this says the conversation
              moved on while it was waiting, and a row can have either without the other. */}
          {m.newSince ? <Badge tone="new">{Copy.newSinceResurfaced(m.newSince)}</Badge> : null}
          {/* WHERE IT ACTUALLY IS — a History row only. Not a pile label: History is not a
              folder, and the only honest badge is the server's own (the webapp row's `place`). */}
          {m.historyPlace ? <Badge tone="place">{m.historyPlace}</Badge> : null}
          {m.trackerNote ? <Badge icon="shield">{trackerShort(m.trackerNote)}</Badge> : null}
        </View>
      ) : null}
    </TapRow>
  );

  if (swipe !== true) return row;

  return (
    <View>
      {/* WHAT IS UNDER THE ROW — the verb the drag is landing on, on the side it came from, so
          the gesture names itself before it commits. Behind the row and never over it: an
          overlay would take the tap that opens the message. */}
      <View style={StyleSheetAbsolute} pointerEvents="none">
        <SwipeFace side="leading" label={faceLabel(face)} icon={face === "markUnread" ? "x" : "check"} pan={pan} />
        <SwipeFace side="trailing" label={Copy.actionLater} icon="clock" pan={pan} />
      </View>
      <Animated.View
        {...responder.panHandlers}
        style={{ transform: [{ translateX: pan.x }] }}
      >
        {row}
      </Animated.View>
    </View>
  );
}

const StyleSheetAbsolute = {
  position: "absolute" as const,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  justifyContent: "space-between" as const,
  paddingHorizontal: 18,
};

/**
 * The verb under the row, one side each. It fades in with the drag and is fully drawn at the
 * point the verb would fire — the same arithmetic the release reads, so what the reader sees at
 * full strength is what letting go does.
 */
function SwipeFace({
  side,
  label,
  icon,
  pan,
}: {
  side: "leading" | "trailing";
  label: string;
  icon: "check" | "x" | "clock";
  pan: Animated.ValueXY;
}) {
  const t = useTheme();
  const range: [number, number] = side === "leading" ? [0, SWIPE_FIRE_DX] : [-SWIPE_FIRE_DX, 0];
  const outputs: [number, number] = side === "leading" ? [0, 1] : [1, 0];
  const opacity = pan.x.interpolate({ inputRange: range, outputRange: outputs, extrapolate: "clamp" });
  return (
    <Animated.View style={{ flexDirection: "row", alignItems: "center", gap: 6, opacity }}>
      <Icon name={icon} size={13} color={t.c.ink3} />
      <Txt variant="caption" tone="ink3">{label}</Txt>
    </Animated.View>
  );
}

/** The read slot's word, from its face — the sheet's own three labels, not a fourth spelling. */
function faceLabel(face: ReadFace): string {
  return face === "done" ? Copy.actionDone
    : face === "markRead" ? Copy.actionMarkRead
      : Copy.actionMarkUnread;
}

function firstLine(body: string): string {
  return body.split("\n").find((l) => l.trim().length > 0) ?? "";
}
