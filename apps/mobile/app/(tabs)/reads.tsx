/**
 * Reads — the skim stream. Issues show a preview and open the full letter.
 * A card turns read once its first lines rest on screen (the web's rule); a
 * fling past reads nothing. The waterline is a marker, not a sort key: when
 * a card turns read its dot fades in place, the "new" count ticks down, and
 * nothing moves. On a live account the sweep rides the engine's
 * `feed_mark_seen` (this stream's folder only), and leaving the screen commits
 * the waterline above the newest issue the reader read — it moves exactly
 * once per visit. Every issue the world answers renders; no "and 9 more".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, View, useWindowDimensions } from "react-native";
import type { SweepFrame } from "../../src/state/sweep";
import { useSeenRun } from "../../src/ui/stream-seen";
import { useStreamPreview } from "../../src/ui/stream-preview";
import { useFocusEffect, useIsFocused } from "expo-router";
import { Copy } from "../../src/copy";
import { usePullToSync } from "../../src/state/pull";
import { listSurface, metaWhen } from "../../src/state/surface";
import { useTheme } from "../../src/theme";
import { useFilesStamp, useMessageBody, useWorld, type WorldMail } from "../../src/state/world";
import { Empty, Panel, Screen, Tail, TapRow, Txt, ViewHead, Waterline, useListInsets } from "../../src/ui/base";
import { BodyPages } from "../../src/ui/BodyPages";
import { mailboxStatusOf, withheldNote } from "../../src/ui/body-note";
import { TopBar } from "../../src/ui/chrome";
import { ListDetail, useListDetail } from "../../src/ui/list-detail";
import { MailList, type ListPlace, type RowFrame } from "../../src/ui/MailList";
import { AttachmentTiles, MessageReader } from "../../src/ui/MessageReader";
import { EventCards } from "../../src/ui/EventCard";
import { FadeOut } from "../../src/ui/FadeOut";
import { MailCalendarSwitch } from "../../src/ui/MailCalendarSwitch";
import { MailListMenu } from "../../src/ui/MailListMenu";
import { MarkAllRead } from "../../src/ui/MarkAllRead";
import { SkeletonList } from "../../src/ui/Skeleton";
import { StreamCardHead, StreamListTools, paperStreamCardStyle } from "../../src/ui/StreamMailFacts";
import { MailboxChip } from "../../src/ui/MailboxChip";
import { StreamCardBody } from "../../src/ui/StreamCardBody";
import { StreamCardVerbs } from "../../src/ui/StreamCardVerbs";
import { MailAvatar } from "../../src/ui/MailAvatar";
import { useLocale } from "../../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../../src/ui/ErrorBoundary";
import { PileNote } from "../../src/ui/PileNote";
import { useRetainedList } from "../../src/ui/use-retained-list";

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
  const t = useTheme();
  const { height } = useWindowDimensions();
  const pull = usePullToSync();
  /* Two panes: an issue OPENS BESIDE the stream instead of unclamping in place — list-detail
     with the selection in the route's `open` param; the compact stream is untouched. */
  const { open, openRow, close, twoPane } = useListDetail((id) => `/message/${id}`);
  const { items, waterlineAboveId, waterLabel, meta, unreadIds, newCount } = w.reads;
  const actions = w.actions;
  // Unknown ≠ empty — the stream shows card silhouettes until this mirror has settled once.
  const surface = listSurface({ settled: w.boot.settled, count: items.length });
  const onViewableItemsChanged = useStreamPreview(Boolean(t.mail) && surface === "content");

  /* A mounted card's frame in scroll-content coordinates, as its cell lays out (`MailList#onRowFrame`). */
  const bounds = useRef(new Map<string, SweepFrame>());
  const onRowFrame = useCallback((m: WorldMail, frame: RowFrame) => {
    bounds.current.set(m.id, { id: m.id, top: frame.y, bottom: frame.y + frame.height });
  }, []);
  const onRowGone = useCallback((m: WorldMail) => {
    bounds.current.delete(m.id);
  }, []);
  // A card turns read once it rests on screen in a visit the person drove; the dock's strip is not on screen.
  const foot = useListInsets().paddingBottom;
  const { run, gestures } = useSeenRun(
    () => bounds.current.values(),
    (ids) => actions.markSeenThrough("reads", ids),
    () => foot,
    items,
  );

  // Leaving the stream (tab switch, back) is the waterline commit — and so is the APP going
  // to the background while this stream is focused: on a phone that is how a visit usually
  // ends, and a process killed from the switcher gets no unmount. The verb itself rides the
  // engine's durable outbox, so even a kill right after the flush delivers it on the next
  // boot. Backgrounding then RETURNING starts a fresh visit pool — a second commit at the
  // real leave carries only what accrued after, and a commit that says nothing new is skipped.
  // The reader's place comes back by its letter when the stream is in front again.
  const place = useRef<ListPlace | null>(null);
  useFocusEffect(
    useCallback(() => {
      run.restart();
      place.current?.back();
      const sub = AppState.addEventListener("change", (s) => {
        if (s === "background") {
          run.restart();
          void actions.leaveFeed("reads");
        }
        if (s === "active") run.restart();
      });
      return () => {
        sub.remove();
        run.restart();
        place.current?.leave();
        void actions.leaveFeed("reads");
      };
    }, [actions, run]),
  );

  const markStream = () => actions.markAllSeen(unreadIds, items[0] ? { place: "reads", upToId: items[0].id } : undefined);

  const list = (
    <Screen>
      <TopBar />
      <MailList
        jumpToTop
        initialNumToRender={Platform.OS === "android" && t.mail && height <= 850 ? 7 : undefined}
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
              onRead={() => openRow(m.id)}
              onOpenBeside={twoPane ? () => openRow(m.id) : undefined}
            />
          </>
        )}
        // Each issue is its own card: no panel under the stream.
        surface={false}
        onRowFrame={onRowFrame}
        onRowGone={onRowGone}
        onViewableItemsChanged={onViewableItemsChanged}
        {...gestures}
        place={place}
        scrollEventThrottle={64}
        refresh={pull}
        head={
          <ViewHead
            style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: t.mail ? 10 : 4 }}
            title={Copy.reads}
            attention={newCount > 0}
            meta={t.mail ? undefined : metaWhen(surface, meta) ?? " "}
            metaBeside
            /* The web app's stream press, both halves: flip the stream's unread AND commit the
               waterline above the newest issue — a fresh-only stream ("2 new", nothing
               unread) still gets its clearing control. */
            leading={t.mail ? <MailCalendarSwitch /> : null}
            right={t.mail ? (
              <StreamListTools settled={surface === "content"} fresh={newCount}>
                <MailListMenu unread={unreadIds.length} fresh={newCount} onMarkAll={markStream} />
              </StreamListTools>
            ) : (
              <MarkAllRead unreadCount={unreadIds.length} freshCount={newCount} onPress={markStream} />
            )}
          >
            {/* Its own sentence under the meta, never a run-on of it. */}
            {!t.mail ? (
              <Txt variant="hint" tone="ink3" style={{ marginTop: 4 }}>{Copy.streamSeenHint}</Txt>
            ) : null}
            {/* Letters here from senders nobody let in, and the press — the web's note. */}
            <PileNote pile="news" />
          </ViewHead>
        }
        empty={
          surface === "skeleton" ? (
            <SkeletonList kind="card" stalled={w.boot.syncFailure} />
          ) : surface === "empty" ? (
            <Empty title={t.mail ? Copy.mailEmptyTitle : Copy.readsEmptyTitle} hint={t.mail ? undefined : Copy.readsEmptyHint} />
          ) : null
        }
        tail={!t.mail && surface === "content" ? <Tail>{Copy.readsTail(items.length)}</Tail> : null}
      />
    </Screen>
  );

  const focused = useIsFocused();
  const shownList = useRetainedList(list, focused, w.worldKey);
  return (
    <ListDetail
      open={open}
      onClose={close}
      toRoute={(id) => `/message/${id}`}
      list={shownList}
      renderDetail={(id, ctx) => <MessageReader id={id} inPane={ctx.inPane} onClose={ctx.onClose} />}
    />
  );
}

interface StreamCardProps {
  m: WorldMail;
  onExpand: () => void;
  onRead: () => void;
  onOpenBeside?: () => void;
}

function StreamCard(props: StreamCardProps) {
  const { m, onRead } = props;
  const t = useTheme();
  if (!t.mail) return <ExpandableStreamCard {...props} />;
  return (
    <Panel level="l1" radius={t.radius.card} style={paperStreamCardStyle}>
      <StreamCardHead m={m} onRead={onRead} />
      <View style={{ paddingTop: 16 }}>
        <StreamCardBody m={m} onRead={onRead}>
          {m.subject ? <Txt variant="streamTitle" textBreakStrategy="balanced">{m.subject}</Txt> : null}
        </StreamCardBody>
      </View>
    </Panel>
  );
}

function ExpandableStreamCard({ m: row, onExpand, onOpenBeside }: StreamCardProps) {
  /* THE CARD DRAWS THE ISSUE'S TEXT, so it reads the body itself: the list's rows carry none. */
  const body = useMessageBody(row.id);
  const m = body === null ? row : { ...row, ...body };
  const t = useTheme();
  const w = useWorld();
  const [open, setOpen] = useState(false);
  const clamped = !open;
  /* An open card shows the issue's files; the open is the list's ask, so a scroll past a closed
     card asks for nothing, and closing it lets the list go. */
  const { holdFiles, releaseFiles } = w.actions;
  const worldKey = w.worldKey;
  useEffect(() => {
    if (!open) return;
    holdFiles([m.id]);
    return () => releaseFiles([m.id]);
  }, [open, m.id, holdFiles, releaseFiles, worldKey]);
  useFilesStamp(open ? [m.id] : []);
  // What the open card is actually showing, said out loud — never a preview presented as
  // the whole issue.
  const bodyNote =
    open && (m.bodyState === "snippet" || m.bodyState === "loading")
      ? Copy.liveBodyLoading
      : open && m.bodyState === "withheld"
        ? withheldNote(m, true, mailboxStatusOf(w.mailboxes.all, m.mailboxId))
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
        accessibilityLabel={[Copy.readsCardAria(m.subject, open), m.mailboxLabel && Copy.deliveredTo(m.mailboxLabel)].filter(Boolean).join(" ")}
        style={{ borderRadius: t.radius.card }}
      >
        <View style={{ padding: 20, paddingTop: 24 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <MailAvatar person={m.from} unread={m.unread} mailbox={m.mailbox} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Txt variant="rowSender" numberOfLines={1}>{m.from.name}</Txt>
              <Txt variant="caption" tone="ink2" numberOfLines={1}>{m.from.address}</Txt>
            </View>
            {m.mailboxLabel ? <MailboxChip label={m.mailboxLabel} withinRow /> : null}
            <Txt variant="caption" tone="ink2" tabular>{m.time}</Txt>
          </View>

          <Txt variant="cardTitle" tone={m.unread ? "ink" : "ink2"} style={{ marginTop: 16 }}>
            {m.subject}
          </Txt>

          <View style={{ marginTop: 10, gap: 8 }}>
            {bodyNote ? (
              <Txt variant="caption" tone="ink3" style={{ marginBottom: 8 }}>
                {bodyNote}
              </Txt>
            ) : null}
            {open ? <EventCards events={w.eventsOf(m.id)} /> : null}
            <BodyPages variant="streamBody" numberOfLines={clamped ? 6 : undefined} text={m.body} />
            {clamped ? <FadeOut color={t.c.panel} /> : null}
          </View>

          <View style={{ alignItems: "center", gap: 6, marginTop: 14 }}>
            <View style={{ backgroundColor: t.c.tint2, borderRadius: t.radius.pill, paddingHorizontal: 16, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 7 }}>
              <Txt variant="button">{open ? Copy.readsCollapse : Copy.readsReadInFull}</Txt>
            </View>
          </View>
        </View>
      </TapRow>
      {open ? (
        <View style={{ paddingHorizontal: 18, paddingBottom: 14, marginTop: -14 }}>
          <AttachmentTiles m={{ id: m.id, attachments: w.filesOf(m.id) }} />
        </View>
      ) : null}
      {open ? <View style={{ paddingHorizontal: 18, paddingBottom: 14 }}><StreamCardVerbs id={m.id} /></View> : null}
    </Panel>
  );
}
