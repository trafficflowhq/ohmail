/**
 * Reads — the skim stream. Issues are cards carrying their own text, clamped
 * to about a screenful, and tapping opens the rest in place.
 * Scrolling past marks seen. The waterline is a marker, not a sort key: when
 * a card passes the read line its dot fades in place, the "new" count ticks
 * down, and nothing moves. On a live account the sweep rides the engine's
 * `feed_mark_seen` (this stream's folder only), and leaving the screen commits
 * the waterline above the newest issue the reader passed — it moves exactly
 * once per visit. Every issue the world answers renders; no "and 9 more".
 */
import { useCallback, useRef, useState } from "react";
import { AppState, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useFocusEffect } from "expo-router";
import { Copy } from "../../src/copy";
import { usePullToSync } from "../../src/state/pull";
import { listSurface, metaWhen } from "../../src/state/surface";
import { useTheme } from "../../src/theme";
import { useWorld, type WorldMail } from "../../src/state/world";
import { Badge, Empty, Panel, Screen, Tail, TapRow, Txt, Waterline } from "../../src/ui/base";
import { TopBar } from "../../src/ui/chrome";
import { ListDetail, useListDetail } from "../../src/ui/list-detail";
import { MailList, type RowFrame } from "../../src/ui/MailList";
import { MessageReader } from "../../src/ui/MessageReader";
import { FadeOut } from "../../src/ui/FadeOut";
import { MarkAllRead } from "../../src/ui/MarkAllRead";
import { SkeletonList } from "../../src/ui/Skeleton";
import { useLocale } from "../../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../../src/ui/ErrorBoundary";

/** The read line: a card counts as skimmed once its foot clears this fraction. */
const READ_LINE = 0.62;

export default function ReadsScreen() {
  return (
    <SurfaceBoundary surface="reads">
      <ReadsBody />
    </SurfaceBoundary>
  );
}

function ReadsBody() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  const w = useWorld();
  const pull = usePullToSync();
  /* Two panes: an issue OPENS BESIDE the stream instead of unclamping in place — list-detail
     with the selection in the route's `open` param; the compact stream is untouched. */
  const { open, openRow, close, twoPane } = useListDetail((id) => `/message/${id}`);
  const { items, waterlineAboveId, waterLabel, meta, unreadIds, newCount } = w.reads;
  const actions = w.actions;
  // Unknown ≠ empty — the stream shows card silhouettes until this mirror has settled once.
  const surface = listSurface({ settled: w.boot.settled, count: items.length });

  /* A card's frame in scroll-content coordinates, as its cell lays out (`MailList#onRowFrame`). */
  const bounds = useRef<Record<string, { y: number; h: number }>>({});
  const onRowFrame = useCallback((m: WorldMail, frame: RowFrame) => {
    bounds.current[m.id] = { y: frame.y, h: frame.height };
  }, []);

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

  // Leaving the stream (tab switch, back) is the waterline commit — and so is the APP going
  // to the background while this stream is focused: on a phone that is how a visit usually
  // ends, and a process killed from the switcher gets no unmount. The verb itself rides the
  // engine's durable outbox, so even a kill right after the flush delivers it on the next
  // boot. Backgrounding then RETURNING starts a fresh visit pool — a second commit at the
  // real leave carries only what accrued after, and a commit that says nothing new is skipped.
  useFocusEffect(
    useCallback(() => {
      const sub = AppState.addEventListener("change", (s) => {
        if (s === "background") void actions.leaveFeed("reads");
      });
      return () => {
        sub.remove();
        void actions.leaveFeed("reads");
      };
    }, [actions]),
  );

  const list = (
    <Screen>
      <TopBar />
      <MailList
        groups={[{ key: "issues", rows: items }]}
        rowKey={(m) => m.id}
        renderRow={(m) => (
          <>
            {/* The line stands ABOVE the newest already-seen issue — the anchor was seen,
                so it sits below the line, with everything that arrived since above it. */}
            {waterlineAboveId === m.id ? <Waterline label={waterLabel} meta="" /> : null}
            <StreamCard
              m={m}
              // Expanding an issue is an explicit ask for its full text: the synced row
              // carries only the snippet until hydration, and a card that said "Read in
              // full" while showing the preview would be presenting a truncation as the
              // mail. Beside a reading pane the ask is the pane's own open instead.
              onExpand={() => actions.hydrateMessage(m.id)}
              onOpenBeside={twoPane ? () => openRow(m.id) : undefined}
            />
          </>
        )}
        // Each issue is its own card: no panel under the stream.
        surface={false}
        onRowFrame={onRowFrame}
        onScroll={onScroll}
        scrollEventThrottle={64}
        refresh={pull}
        head={
          <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Txt variant="h1">{Copy.reads}</Txt>
              <Txt variant="meta" tone="ink3" tabular>
                {metaWhen(surface, meta) ?? " "}
              </Txt>
              <View style={{ flex: 1 }} />
              {/* The web's ReadsView press, both halves: flip the stream's unread AND commit the
                  waterline above the newest issue — a fresh-only stream ("2 new", nothing
                  unread) still gets its clearing control. */}
              <MarkAllRead
                unreadCount={unreadIds.length}
                freshCount={newCount}
                onPress={() =>
                  actions.markAllSeen(
                    unreadIds,
                    items[0] ? { place: "reads", upToId: items[0].id } : undefined,
                  )
                }
              />
            </View>
            <Txt variant="caption" tone="ink3" style={{ marginTop: 4 }}>
              {Copy.streamSeenHint}
            </Txt>
          </View>
        }
        empty={
          surface === "skeleton" ? (
            <SkeletonList kind="card" stalled={w.boot.syncFailure} />
          ) : surface === "empty" ? (
            <Empty title={Copy.readsEmptyTitle} hint={Copy.readsEmptyHint} />
          ) : null
        }
        tail={surface === "content" ? <Tail>{Copy.readsTail(items.length)}</Tail> : null}
      />
    </Screen>
  );

  return (
    <ListDetail
      open={open}
      onClose={close}
      toRoute={(id) => `/message/${id}`}
      list={list}
      renderDetail={(id, ctx) => <MessageReader id={id} inPane={ctx.inPane} onClose={ctx.onClose} />}
    />
  );
}

/** One issue. Clamped until tapped; the fade says there is more, not how much. */
function StreamCard({
  m,
  onExpand,
  onOpenBeside,
}: {
  m: WorldMail;
  onExpand: () => void;
  /** Two panes: the tap opens the issue in the reading pane instead of unclamping the card. */
  onOpenBeside?: () => void;
}) {
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
        onPress={() => {
          if (onOpenBeside !== undefined) {
            onOpenBeside();
            return;
          }
          setOpen((v) => {
            if (!v) onExpand();
            return !v;
          });
        }}
        accessibilityRole="button"
        accessibilityLabel={Copy.readsCardAria(m.subject, open)}
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

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 14 }}>
            <Badge icon={open ? "chev" : "open"}>{open ? Copy.readsCollapse : Copy.readsReadInFull}</Badge>
            {/* Which of your addresses this arrived at — set only above one mailbox, so a
                single-mailbox account's cards are exactly the cards they were. */}
            {m.mailboxLabel ? <Badge tone="place">{Copy.deliveredTo(m.mailboxLabel)}</Badge> : null}
          </View>
        </View>
      </TapRow>
    </Panel>
  );
}
