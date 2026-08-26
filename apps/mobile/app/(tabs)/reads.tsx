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
import { useCallback, useRef, useState } from "react";
import { View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useFocusEffect } from "expo-router";
import { Copy } from "../../src/copy";
import { usePullToSync } from "../../src/state/pull";
import { listSurface, metaWhen } from "../../src/state/surface";
import { useTheme } from "../../src/theme";
import { useWorld, type WorldMail } from "../../src/state/world";
import { Badge, Empty, Panel, Screen, Scroller, Tail, TapRow, Txt, Waterline } from "../../src/ui/base";
import { TopBar } from "../../src/ui/chrome";
import { FadeOut } from "../../src/ui/FadeOut";
import { SkeletonList } from "../../src/ui/Skeleton";

/** The read line: a card counts as skimmed once its foot clears this fraction. */
const READ_LINE = 0.62;

export default function ReadsScreen() {
  const w = useWorld();
  const pull = usePullToSync();
  const { items, waterlineAboveId, waterLabel, meta } = w.reads;
  const actions = w.actions;
  // Unknown ≠ empty — the stream shows card silhouettes until this mirror has settled once.
  const surface = listSurface({ settled: w.boot.settled, count: items.length });

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

  // Leaving the stream (tab switch, back) is the waterline commit.
  useFocusEffect(
    useCallback(() => () => actions.leaveFeed("reads"), [actions]),
  );

  return (
    <Screen>
      <TopBar />
      <Scroller onScroll={onScroll} scrollEventThrottle={64} refresh={pull}>
        <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
            <Txt variant="h1">{Copy.reads}</Txt>
            <Txt variant="meta" tone="ink3" tabular>
              {metaWhen(surface, meta) ?? " "}
            </Txt>
          </View>
          <Txt variant="caption" tone="ink3" style={{ marginTop: 4 }}>
            {Copy.streamSeenHint}
          </Txt>
        </View>

        {surface === "skeleton" ? (
          <SkeletonList kind="card" stalled={w.boot.syncFailure} />
        ) : surface === "empty" ? (
          <Empty glyph="📰" title={Copy.readsEmptyTitle} hint={Copy.readsEmptyHint} />
        ) : (
          <>
            {items.map((m) => (
              <View key={m.id} onLayout={onCardLayout(m.id)}>
                {/* The line stands ABOVE the newest already-seen issue — the anchor was seen,
                    so it sits below the line, with everything that arrived since above it. */}
                {waterlineAboveId === m.id ? <Waterline label={waterLabel} meta="" /> : null}
                <StreamCard
                  m={m}
                  // Expanding an issue is an explicit ask for its full text: the synced row
                  // carries only the snippet until hydration, and a card that said "Read in
                  // full" while showing the preview would be presenting a truncation as the
                  // mail.
                  onExpand={() => actions.hydrateMessage(m.id)}
                />
              </View>
            ))}

            <Tail>{Copy.readsTail(items.length)}</Tail>
          </>
        )}
      </Scroller>
    </Screen>
  );
}

/** One issue. Clamped until tapped; the fade says there is more, not how much. */
function StreamCard({ m, onExpand }: { m: WorldMail; onExpand: () => void }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const clamped = !open;
  // What the open card is actually showing, said out loud — never a preview presented as
  // the whole issue.
  const bodyNote =
    open && (m.bodyState === "snippet" || m.bodyState === "loading")
      ? Copy.liveBodyLoading
      : open && m.bodyState === "withheld"
        ? Copy.liveBodyWithheld
        : open && m.bodyState === "failed"
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
              {m.body}
            </Txt>
            {clamped ? <FadeOut color={t.c.panel} /> : null}
          </View>

          <View style={{ flexDirection: "row", gap: 6, marginTop: 14 }}>
            <Badge icon={open ? "chev" : "open"}>{open ? "Collapse" : "Read in full"}</Badge>
          </View>
        </View>
      </TapRow>
    </Panel>
  );
}
