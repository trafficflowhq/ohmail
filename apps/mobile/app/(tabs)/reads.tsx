/**
 * Reads — the skim stream.
 *
 * Newsletters are not rows to open, they are issues to skim, so the stream *is*
 * the view: every issue is a card carrying its own text, clamped to about a
 * screenful with the one functional fade, and tapping opens the rest in place.
 *
 * SCROLLING PAST MARKS SEEN. The waterline is a marker, not a sort key: when a
 * card passes the read line its dot fades **in place**, the "new" count ticks
 * down by one, and nothing moves. A list that re-sorted under the thumb would
 * be the opposite of a skim stream. On a live account the sweep rides the
 * engine's `feed_mark_seen` (this stream's folder only), and LEAVING the screen
 * commits the waterline above the newest issue the reader passed — "new since
 * last visit" holds still for the whole visit and moves exactly once.
 *
 * Every issue the world answers renders. There is no "and 9 more".
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useFocusEffect } from "expo-router";
import { Copy } from "../../src/copy";
import { useTheme } from "../../src/theme";
import { world } from "../../src/state/model";
import { useStore } from "../../src/state/store";
import { useWorld, type WorldMail } from "../../src/state/world";
import { Badge, Chip, Panel, Rule, Screen, Scroller, Tail, TapRow, Txt, Waterline } from "../../src/ui/base";
import { TopBar } from "../../src/ui/chrome";
import { FadeOut } from "../../src/ui/FadeOut";

/** The read line: a card counts as skimmed once its foot clears this fraction. */
const READ_LINE = 0.62;

export default function ReadsScreen() {
  const w = useWorld();
  const { items, waterlineAboveId, waterLabel, waterMeta, meta } = w.reads;
  const actions = w.actions;

  const bounds = useRef<Record<string, { y: number; h: number }>>({});
  const onCardLayout = useCallback(
    (id: string) => (e: LayoutChangeEvent) => {
      const { y, height } = e.nativeEvent.layout;
      bounds.current[id] = { y, h: height };
    },
    [],
  );

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement } = e.nativeEvent;
      const line = contentOffset.y + layoutMeasurement.height * READ_LINE;
      const passed = Object.entries(bounds.current)
        .filter(([, b]) => b.y + b.h <= line)
        .map(([id]) => id);
      if (passed.length) actions.markSeenThrough("reads", passed);
    },
    [actions],
  );

  // Leaving the stream (tab switch, back) is the waterline commit — live only, by the
  // world's own arm; the demo world has no line to move.
  useFocusEffect(
    useCallback(() => () => actions.leaveFeed("reads"), [actions]),
  );

  return (
    <Screen>
      <TopBar />
      <Scroller onScroll={onScroll} scrollEventThrottle={64}>
        <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
            <Txt variant="h1">{Copy.reads}</Txt>
            <Txt variant="meta" tone="ink3" tabular>
              {meta}
            </Txt>
          </View>
          <Txt variant="caption" tone="ink3" style={{ marginTop: 4 }}>
            {Copy.streamSeenHint}
          </Txt>
        </View>

        {items.map((m, i) => (
          <View key={m.id} onLayout={onCardLayout(m.id)}>
            {/*
             * The routing chip belongs to the *first* issue and to no other, so
             * it rides inside that card rather than on the canvas between two.
             * Demo-only: the chip is the fixtures' AI classification story.
             */}
            {/* The line stands ABOVE the newest already-seen issue — the anchor was seen,
                so it sits below the line, with everything that arrived since above it. */}
            {waterlineAboveId === m.id ? <Waterline label={waterLabel} meta={waterMeta} /> : null}
            <StreamCard
              m={m}
              // Expanding an issue is an explicit ask for its full text: on a live account
              // the synced row carries only the snippet until hydration, and a card that
              // said "Read in full" while showing the preview would be presenting a
              // truncation as the mail.
              onExpand={() => actions.hydrateMessage(m.id)}
              live={w.live}
              footer={i === 0 && !w.live ? <RoutingChips /> : null}
            />
          </View>
        ))}

        <Tail>{Copy.readsTail(items.length)}</Tail>
      </Scroller>
    </Screen>
  );
}

/**
 * The AI's routing call on the first issue, and the two ways to answer it.
 * Rendered as a card footer: it is a statement *about this issue*, so it lives
 * on the issue's own surface. Demo world only — the fixtures' story.
 */
function RoutingChips() {
  const { s, setReadsChip } = useStore();
  if (s.readsChip === "corrected") {
    return <Chip icon="route">{world.readsChip.correctedLabel}</Chip>;
  }
  if (s.readsChip === "approved") {
    return <Chip icon="check">{world.readsChip.approvedLabel}</Chip>;
  }
  return (
    <>
      <Chip icon="spark" variant="pending">
        {world.readsChip.label}
      </Chip>
      <Chip onPress={() => setReadsChip("approved")}>Approve</Chip>
      <Chip onPress={() => setReadsChip("corrected")}>Belongs in Ohbox</Chip>
    </>
  );
}

/** One issue. Clamped until tapped; the fade says there is more, not how much. */
function StreamCard({
  m,
  live,
  onExpand,
  footer,
}: {
  m: WorldMail;
  live: boolean;
  onExpand: () => void;
  footer?: ReactNode;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const clamped = !open;
  const [before, after] = m.body.split("[[img]]");
  // What the open card is actually showing, said out loud — never a preview presented as
  // the whole issue. Only the live world has hydration states; the demo carries full text.
  const bodyNote =
    live && open && (m.bodyState === "snippet" || m.bodyState === "loading")
      ? Copy.liveBodyLoading
      : live && open && m.bodyState === "failed"
        ? Copy.liveBodyFailed
        : null;

  return (
    <Panel level="l1" radius={t.radius.card} style={{ marginBottom: 12 }}>
      <TapRow
        onPress={() =>
          setOpen((v) => {
            if (!v) onExpand();
            return !v;
          })
        }
        accessibilityRole="button"
        accessibilityLabel={`${m.subject}. ${open ? "Collapse" : "Read in full"}.`}
        style={{ borderRadius: t.radius.card }}
      >
        <View style={{ padding: 18, paddingBottom: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {m.unread ? (
              <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: t.c.accent }} />
            ) : null}
            <Txt variant="rowSender" tone={m.unread ? "ink" : "ink2"} numberOfLines={1} style={{ flexShrink: 1 }}>
              {m.from.name}
            </Txt>
            <View style={{ flex: 1 }} />
            <Txt variant="caption" tone="ink3" tabular>
              {m.time}
            </Txt>
          </View>

          <Txt variant="cardTitle" tone={m.unread ? "ink" : "ink2"} style={{ marginTop: 8 }}>
            {m.subject}
          </Txt>

          <View style={{ marginTop: 10 }}>
            {bodyNote ? (
              <Txt variant="caption" tone="ink3" style={{ marginBottom: 8 }}>
                {bodyNote}
              </Txt>
            ) : null}
            <Txt variant="streamBody" numberOfLines={clamped ? 6 : undefined}>
              {before}
            </Txt>
            {clamped ? <FadeOut color={t.c.panel} /> : null}
          </View>

          {open && m.art ? (
            <View
              style={{
                marginTop: 14,
                borderRadius: t.radius.rowDense,
                backgroundColor: t.c.tint,
                paddingVertical: 26,
                alignItems: "center",
                gap: 6,
              }}
              accessibilityLabel={m.art.ariaLabel}
            >
              <Txt variant="caption" tone="ink3">
                {m.art.caption}
              </Txt>
            </View>
          ) : null}

          {open && after ? (
            <Txt variant="streamBody" style={{ marginTop: 12 }}>
              {after}
            </Txt>
          ) : null}

          <View style={{ flexDirection: "row", gap: 6, marginTop: 14 }}>
            <Badge icon={open ? "chev" : "open"}>{open ? "Collapse" : "Read in full"}</Badge>
          </View>
        </View>
      </TapRow>

      {/*
       * Outside the TapRow on purpose: the footer holds its own buttons, and
       * nesting them in the card's press target would make "Approve" also
       * expand the issue.
       */}
      {footer ? (
        <View>
          <Rule inset={18} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 18, paddingTop: 14 }}>
            {footer}
          </View>
        </View>
      ) : null}
    </Panel>
  );
}
