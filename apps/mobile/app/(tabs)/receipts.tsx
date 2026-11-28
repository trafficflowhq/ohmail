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
import { useCallback, useEffect, useMemo, useRef, type ComponentProps, type ReactNode } from "react";
import { AppState, View } from "react-native";
import { useSeenRun } from "../../src/ui/stream-seen";
import { useStreamPreview } from "../../src/ui/stream-preview";
import { useFocusEffect } from "expo-router";
import { Copy } from "../../src/copy";
import { useTheme } from "../../src/theme";
import { usePullToSync } from "../../src/state/pull";
import { listSurface, metaWhen } from "../../src/state/surface";
import { GroupedSweepLedger } from "../../src/state/sweep";
import { useFilesStamp, useWorld, type WorldMail } from "../../src/state/world";
import { ListDetail, useListDetail } from "../../src/ui/list-detail";
import { MailFoundEvents, useMailFoundEvents } from "../../src/ui/MailFoundEvents";
import { EventCards } from "../../src/ui/EventCard";
import { MessageReader } from "../../src/ui/MessageReader";
import { Empty, Screen, Tail, ViewHead, Waterline, useListInsets } from "../../src/ui/base";
import { TopBar } from "../../src/ui/chrome";
import { MailList, type ListGroup, type RowFrame } from "../../src/ui/MailList";
import { MailRow } from "../../src/ui/MailRow";
import { StreamCardHead, StreamListTools, paperStreamCardStyle } from "../../src/ui/StreamMailFacts";
import { StreamCardBody } from "../../src/ui/StreamCardBody";
import { MailCalendarSwitch } from "../../src/ui/MailCalendarSwitch";
import { MailListMenu } from "../../src/ui/MailListMenu";
import { MarkAllRead } from "../../src/ui/MarkAllRead";
import { SkeletonList } from "../../src/ui/Skeleton";
import { useLocale } from "../../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../../src/ui/ErrorBoundary";
import { PileNote } from "../../src/ui/PileNote";

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
  const t = useTheme();
  const pull = usePullToSync();
  /* Two panes: a row SELECTS and the reader opens beside the list; one pane: it pushes, as
     ever. The selection is the route's `open` param — `src/ui/list-detail.tsx` is the rule. */
  const { open, openRow, close } = useListDetail((id) => `/message/${id}`);
  const { groups, waterlineAboveId, waterLabel, total, meta, unreadIds, newCount } = w.receipts;
  const actions = w.actions;
  // Unknown ≠ empty — see `state/surface.ts`.
  const surface = listSurface({ settled: w.boot.settled, count: total });
  const onViewableItemsChanged = useStreamPreview(Boolean(t.mail) && surface === "content");

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
    title: t.mail ? undefined : g.label,
    rows: g.items,
  }));

  const markStream = () => actions.markAllSeen(unreadIds, rows[0] ? { place: "receipts", upToId: rows[0].id } : undefined);

  const list = (
    <Screen>
      <TopBar />
      <MailList
        jumpToTop
        groups={dayGroups}
        rowKey={(m) => m.id}
        renderRow={(m) => {
          const read = () => openRow(m.id);
          return (
            <>
              {waterlineAboveId === m.id ? <Waterline label={waterLabel} meta="" /> : null}
              <View style={t.mail ? paperStreamCardStyle : { marginBottom: 12 }}>
                {t.mail ? (
                  <ReceiptPreview m={m} onRead={read}
                    render={(preview) => <MailRow m={m} onPress={read} swipe receipt
                      receiptHead={preview.receiptHead} receiptBody={preview.receiptBody} receiptDetail={preview.receiptDetail} />} />
                ) : <MailRow m={m} onPress={read} swipe receipt />}
              </View>
            </>
          );
        }}
        surface={false}
        onRowFrame={onRowFrame}
        onRowGone={onRowGone}
        onViewableItemsChanged={onViewableItemsChanged}
        {...gestures}
        scrollEventThrottle={64}
        refresh={pull}
        head={
          <ViewHead
            style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: t.mail ? 10 : 14 }}
            title={Copy.receipts}
            attention={newCount > 0}
            meta={t.mail ? undefined : metaWhen(surface, meta) ?? " "}
            /* Reads' press: flip the stream's unread and commit its line above the newest receipt. */
            leading={t.mail ? <MailCalendarSwitch /> : null}
            right={t.mail ? (
              <StreamListTools settled={surface === "content"} fresh={newCount}>
                <MailListMenu unread={unreadIds.length} fresh={newCount} onMarkAll={markStream} />
              </StreamListTools>
            ) : (
              <MarkAllRead unreadCount={unreadIds.length} freshCount={newCount} onPress={markStream} />
            )}
          >
            {/* Letters here from senders nobody let in, and the press — the web's note. */}
            <PileNote pile="receipts" />
          </ViewHead>
        }
        empty={
          surface === "skeleton" ? (
            <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
              <SkeletonList stalled={w.boot.syncFailure} />
            </View>
          ) : surface === "empty" ? (
            <Empty title={t.mail ? Copy.mailEmptyTitle : Copy.receiptsEmptyTitle} hint={t.mail ? undefined : Copy.receiptsEmptyHint} />
          ) : null
        }
        foot={!t.mail && total > 0 ? <Tail>{Copy.receiptsTail(total)}</Tail> : null}
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

type ReceiptContent = Pick<ComponentProps<typeof MailRow>, "receiptHead" | "receiptBody" | "receiptDetail">;

function ReceiptPreview({ m, onRead, render }: {
  m: WorldMail;
  onRead: () => void;
  render: (content: ReceiptContent) => ReactNode;
}) {
  const world = useWorld();
  useFilesStamp([m.id]);
  const found = useMailFoundEvents(m);
  return render({
    receiptHead: <StreamCardHead m={m} onRead={onRead} receipt />,
    receiptBody: <StreamCardBody m={m} onRead={onRead} showFilePrompt={(found?.rows.length ?? 0) > 0} />,
    receiptDetail: (
      <>
        <EventCards events={world.eventsOf(m.id)} style={{ marginBottom: 0 }} />
        <MailFoundEvents found={found} />
      </>
    ),
  });
}
