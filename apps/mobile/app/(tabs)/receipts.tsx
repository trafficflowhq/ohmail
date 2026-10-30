/**
 * Receipts — orders, invoices and tickets, grouped by day. The one list where
 * a number is the point: amounts get their own right-aligned tabular column.
 * A row turns read once it rests on screen, by the same rule as Reads; leaving
 * commits this stream's own waterline (`feedPartition` keeps the two views'
 * lines independent). The sweep measures in scroll-content coordinates:
 * `MailList` reports each row's cell frame there, so the {@link GroupedSweepLedger}'s
 * chain above the row is zero and it answers each row where it really stands.
 * The rows are a window, never the whole stream.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { AppState, View } from "react-native";
import { useSeenRun } from "../../src/ui/stream-seen";
import { useFocusEffect } from "expo-router";
import { Copy } from "../../src/copy";
import { usePullToSync } from "../../src/state/pull";
import { listSurface, metaWhen } from "../../src/state/surface";
import { GroupedSweepLedger } from "../../src/state/sweep";
import { useWorld, type WorldMail } from "../../src/state/world";
import { ListDetail, useListDetail } from "../../src/ui/list-detail";
import { MessageReader } from "../../src/ui/MessageReader";
import { Empty, Screen, Tail, Txt, Waterline, useListInsets } from "../../src/ui/base";
import { TopBar } from "../../src/ui/chrome";
import { MailList, type ListGroup, type RowFrame } from "../../src/ui/MailList";
import { MailRow } from "../../src/ui/MailRow";
import { MarkAllRead, VIEW_HEAD_ROW } from "../../src/ui/MarkAllRead";
import { SkeletonList } from "../../src/ui/Skeleton";
import { useLocale } from "../../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../../src/ui/ErrorBoundary";

/**
 * A group's ledger identity is its FIRST ROW's id, never the display label: day labels
 * repeat across years ("10 Aug" names two different days once the list spans one), and two
 * groups sharing a key would overwrite each other's offsets — rows evaluated at the wrong
 * position. A first-row id belongs to exactly one group.
 */
const groupKeyOf = (g: { label: string; items: { id: string }[] }): string =>
  g.items[0]?.id ?? g.label;

export default function ReceiptsScreen() {
  return (
    <SurfaceBoundary surface="receipts">
      <ReceiptsBody />
    </SurfaceBoundary>
  );
}

function ReceiptsBody() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  const w = useWorld();
  const pull = usePullToSync();
  /* Two panes: a row SELECTS and the reader opens beside the list; one pane: it pushes, as
     ever. The selection is the route's `open` param — `src/ui/list-detail.tsx` is the rule. */
  const { open, openRow, close } = useListDetail((id) => `/message/${id}`);
  const { groups, waterlineAboveId, waterLabel, total, meta, unreadIds, newCount } = w.receipts;
  const actions = w.actions;
  // Unknown ≠ empty — see `state/surface.ts`.
  const surface = listSurface({ settled: w.boot.settled, count: total });

  const ledger = useRef(new GroupedSweepLedger()).current;
  /* Which day a row belongs to, for the ledger — the cell reports a frame, not a group. */
  const groupOfRow = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) for (const item of g.items) m.set(item.id, groupKeyOf(g));
    return m;
  }, [groups]);

  // PRUNE the ledger against the rendered generation: a projection change (a consent or
  // rule re-home) removes rows from `groups` without any onLayout firing for them, and a
  // stale measurement would sweep mail that is no longer on screen. The cells measure in
  // scroll-content coordinates, so every level above the row is zero.
  useEffect(() => {
    ledger.retain(
      groups.flatMap((g) => g.items.map((m) => m.id)),
      groups.map(groupKeyOf),
    );
    ledger.setPanel(0);
    for (const g of groups) {
      ledger.setGroup(groupKeyOf(g), 0);
      ledger.setItems(groupKeyOf(g), 0);
    }
  }, [groups, ledger]);

  const onRowFrame = useCallback(
    (m: WorldMail, frame: RowFrame) => {
      const key = groupOfRow.get(m.id);
      if (key !== undefined) ledger.setRow(m.id, key, frame.y, frame.height);
    },
    [groupOfRow, ledger],
  );

  const onRowGone = useCallback((m: WorldMail) => ledger.drop(m.id), [ledger]);
  const foot = useListInsets().paddingBottom;
  const rows = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const { run, gestures } = useSeenRun(
    () => ledger.frames(),
    (ids) => actions.markSeenThrough("receipts", ids),
    () => foot,
    rows,
  );

  // The leave commit for this stream's own waterline — including the APP backgrounding while
  // this stream is focused, for the reasons written out on the Reads twin: a phone visit
  // usually ends at the home button, a switcher kill gets no unmount, and the flushed verb
  // rides the durable outbox so even that kill delivers on the next boot.
  useFocusEffect(
    useCallback(() => {
      run.restart();
      const sub = AppState.addEventListener("change", (s) => {
        if (s === "background") {
          run.restart();
          void actions.leaveFeed("receipts");
        }
        if (s === "active") run.restart();
      });
      return () => {
        sub.remove();
        run.restart();
        void actions.leaveFeed("receipts");
      };
    }, [actions, run]),
  );

  const dayGroups: ListGroup<WorldMail>[] = groups.map((g) => ({
    key: groupKeyOf(g),
    title: g.label,
    rows: g.items,
  }));

  const list = (
    <Screen>
      <TopBar />
      <MailList
        groups={dayGroups}
        rowKey={(m) => m.id}
        renderRow={(m) => (
          <>
            {/* The line stands ABOVE the newest receipt already seen at the last
                visit — this stream's own anchor, independent of Reads'. */}
            {waterlineAboveId === m.id ? <Waterline label={waterLabel} meta="" /> : null}
            <MailRow m={m} onPress={() => openRow(m.id)} swipe />
          </>
        )}
        rowInset={6}
        onRowFrame={onRowFrame}
        onRowGone={onRowGone}
        {...gestures}
        scrollEventThrottle={64}
        refresh={pull}
        head={
          <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 14 }}>
            <View style={VIEW_HEAD_ROW}>
              <Txt variant="h1">{Copy.receipts}</Txt>
              {/* Reads' press: flip the stream's unread and commit its line above the newest receipt. */}
              <MarkAllRead
                unreadCount={unreadIds.length}
                freshCount={newCount}
                onPress={() =>
                  actions.markAllSeen(unreadIds, rows[0] ? { place: "receipts", upToId: rows[0].id } : undefined)
                }
              />
            </View>
            <Txt variant="meta" tone="ink3" tabular style={{ marginTop: 4 }}>
              {metaWhen(surface, meta) ?? " "}
            </Txt>
          </View>
        }
        empty={
          surface === "skeleton" ? (
            <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
              <SkeletonList stalled={w.boot.syncFailure} />
            </View>
          ) : surface === "empty" ? (
            <Empty title={Copy.receiptsEmptyTitle} hint={Copy.receiptsEmptyHint} />
          ) : null
        }
        foot={total > 0 ? <Tail>{Copy.receiptsTail(total)}</Tail> : null}
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
