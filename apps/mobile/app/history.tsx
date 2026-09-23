/**
 * History — every message you own, newest first, back to the first one; the phone's half of the
 * webapp's `HistoryView.tsx`, over the same timeline walker (`state/store-views.ts`). The list is
 * the store's total as fixed-height slots in the one `MailList`, pages fetched as they scroll into
 * view, a year strip on the right edge jumping anywhere, and the mirror's rows painting first
 * until page one replaces them in place. Nothing has moved: every row states its server folder.
 */
import { useMemo, useRef, useState } from "react";
import { View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";

import { Copy } from "../src/copy";
import { usePullToSync } from "../src/state/pull";
import { useStoreHistory } from "../src/state/store-views";
import { useWorld } from "../src/state/world";
import { Empty, Screen, Tail, Tap, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { ListDetail, useListDetail } from "../src/ui/list-detail";
import { MailList } from "../src/ui/MailList";
import { MessageReader } from "../src/ui/MessageReader";
import { Gated } from "../src/ui/Gated";
import { MailRow } from "../src/ui/MailRow";
import { SkeletonList } from "../src/ui/Skeleton";
import { useLocale } from "../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";
import { useTheme } from "../src/theme";

/** One slot's height — fixed, so a scroll offset is a slot and a jump lands without measuring. */
const SLOT_PX = 84;

/** Gated like the tabs — a deep-linked route must not render the empty world. */
export default function HistoryScreen() {
  useLocale();
  return (
    <SurfaceBoundary surface="history">
      <Gated>
        <HistoryBody />
      </Gated>
    </SurfaceBoundary>
  );
}

function HistoryBody() {
  const t = useTheme();
  const w = useWorld();
  const pull = usePullToSync();
  const h = useStoreHistory();
  const { open, openRow, close } = useListDetail((id) => `/message/${id}`);
  const [more, setMore] = useState(false);
  const scrollTo = useRef<((y: number) => void) | null>(null);
  /** Where slot 0 sits in the scroll content, learnt from its own frame. */
  const top = useRef(0);
  /* The slots, as positions only: rows are read per slot from the walker's cache at render. */
  const slots = useMemo(() => Array.from({ length: h.length }, (_, i) => i), [h.length]);
  const groups = useMemo(() => [{ key: "history", rows: slots }], [slots]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement } = e.nativeEvent;
    const first = Math.floor(Math.max(0, contentOffset.y - top.current) / SLOT_PX);
    h.want(Math.max(0, first - 8), first + Math.ceil(layoutMeasurement.height / SLOT_PX) + 9);
  };
  const jump = (start: number) => {
    h.jump(start);
    scrollTo.current?.(top.current + start * SLOT_PX);
  };

  const meta = h.state === "ready" && h.total !== null
    ? Copy.historyMeta(h.total)
    : h.state === "unavailable" && w.boot.settled ? Copy.historyMeta(h.length) : " ";

  const list = (
    <Screen>
      <DetailBar title={Copy.history} />
      <View style={{ flex: 1 }}>
        <MailList
          groups={groups}
          rowKey={(i) => `slot-${i}`}
          renderRow={(i) => {
            const m = h.rowAt(i);
            return (
              <View style={{ height: m === "gone" ? 0 : SLOT_PX, overflow: "hidden" }}>
                {m === "gone" ? null : m === null ? (
                  <View style={{ flex: 1, justifyContent: "center", gap: 8, paddingHorizontal: 12 }}>
                    <View style={{ height: 10, width: "46%", borderRadius: 5, backgroundColor: t.c.tint2 }} />
                    <View style={{ height: 10, width: "72%", borderRadius: 5, backgroundColor: t.c.tint2 }} />
                  </View>
                ) : (
                  <MailRow m={m} onPress={() => {
                    const src = h.sourceAt(i);
                    if (src) w.store.open(src);
                    openRow(m.id);
                  }} swipe />
                )}
              </View>
            );
          }}
          onRowFrame={(i, frame) => { if (i === 0) top.current = frame.y; }}
          onScroll={onScroll}
          scrollEventThrottle={100}
          scrollTo={scrollTo}
          surface={h.length > 0}
          gapAbove={h.length > 0 ? 8 : 0}
          refresh={pull}
          head={
            <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
                <Txt variant="h1" numberOfLines={1} style={{ flexShrink: 1 }}>{Copy.history}</Txt>
                <Txt variant="meta" tone="ink3" tabular>{meta}</Txt>
              </View>
              <Txt variant="note" tone="ink3" style={{ marginTop: 8 }}>{Copy.historyExplainer}</Txt>
              <Tap
                onPress={() => setMore((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ expanded: more }}
                accessibilityLabel={Copy.historyExplainerMoreLabel}
                style={{ paddingVertical: 8 }}
              >
                <Txt variant="settingsLabel" tone="accent">{Copy.historyExplainerMoreLabel}</Txt>
              </Tap>
              {more ? <Txt variant="note" tone="ink3" style={{ paddingBottom: 4 }}>{Copy.historyExplainerMore}</Txt> : null}
              {h.state === "unanswered" ? (
                <Tap onPress={h.retry} accessibilityRole="button" style={{ paddingVertical: 6 }}>
                  <Txt variant="note" tone="ink3">{Copy.historyStoreUnavailable} <Txt variant="note" tone="accent">{Copy.historyStoreRetry}</Txt></Txt>
                </Tap>
              ) : h.state === "loading" && h.length > 0 ? (
                <Txt variant="note" tone="ink3" style={{ paddingVertical: 6 }}>{Copy.historyLoading}</Txt>
              ) : null}
            </View>
          }
          empty={
            h.state === "ready" || (h.state === "unavailable" && w.boot.settled) ? (
              <Empty title={Copy.historyEmptyTitle} hint={Copy.historyEmptyHint} />
            ) : (
              <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
                <SkeletonList stalled={w.boot.syncFailure} />
              </View>
            )
          }
          tail={h.state === "ready" && h.total !== null && h.length > 0 ? <Tail>{Copy.historyTail(h.total)}</Tail> : null}
        />
        {h.state === "ready" && h.years.length > 1 ? (
          <View
            accessibilityRole="menu"
            accessibilityLabel={Copy.historyRailLabel}
            style={{ position: "absolute", right: 2, top: 8, gap: 2, paddingVertical: 4, paddingHorizontal: 2,
              borderRadius: 10, backgroundColor: t.c.panel }}
          >
            {h.years.map((y) => (
              <Tap key={y.year ?? "undated"} onPress={() => jump(y.start)} accessibilityRole="button"
                accessibilityLabel={y.year ?? Copy.historyUndated} style={{ paddingVertical: 3, paddingHorizontal: 6 }}>
                <Txt variant="meta" tone="ink3" tabular>{y.year ?? Copy.historyUndated}</Txt>
              </Tap>
            ))}
          </View>
        ) : null}
      </View>
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
