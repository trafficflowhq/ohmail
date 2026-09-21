/**
 * Ohbox — mail from people you said Yes to.
 *
 * The list splits new / previously seen and never re-sorts under the reader.
 * The split is the engine's own `ohboxView` — new-for-you / earlier, plus the
 * resurfaced pin group above both (mail whose "show me this again" moment has
 * come). The screen renders what `useWorld()` answers and holds no logic of
 * its own. An empty mailbox renders an honest empty state, never sample mail.
 * The rows go through `MailList`, which mounts a window of them, not the mailbox.
 */
import { View } from "react-native";
import { Copy } from "../../src/copy";
import { usePullToSync } from "../../src/state/pull";
import { listSurface, metaWhen } from "../../src/state/surface";
import { useWorld, type WorldMail } from "../../src/state/world";
import { Empty, Screen, Tail, Txt } from "../../src/ui/base";
import { Doorbell, TopBar } from "../../src/ui/chrome";
import { ListDetail, useListDetail } from "../../src/ui/list-detail";
import { MailList, type ListGroup } from "../../src/ui/MailList";
import { MailRow } from "../../src/ui/MailRow";
import { MarkAllRead } from "../../src/ui/MarkAllRead";
import { MessageReader } from "../../src/ui/MessageReader";
import { SkeletonList } from "../../src/ui/Skeleton";
import { useLocale } from "../../src/i18n/LocaleProvider";

export default function OhboxScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  const w = useWorld();
  const pull = usePullToSync();
  /* Two panes: a row SELECTS and the reader opens beside the list; one pane: it pushes, as
     ever. The selection is the route's `open` param — `src/ui/list-detail.tsx` is the rule. */
  const { open, openRow, close } = useListDetail((id) => `/message/${id}`);
  const { resurfaced, fresh, seen, total, meta } = w.ohbox;

  // Unknown ≠ empty: before this mirror has ever settled a drain, a zero-row Ohbox shows
  // the shape of what is coming, never "All quiet" — `state/surface.ts` is the whole rule.
  const surface = listSurface({ settled: w.boot.settled, count: total });

  const groups: ListGroup<WorldMail>[] = [
    { key: "resurfaced", title: Copy.groupResurfaced, rows: resurfaced },
    { key: "fresh", title: Copy.groupNew, rows: fresh },
    { key: "seen", title: Copy.groupSeen, rows: seen },
  ];

  const list = (
    <Screen>
      <TopBar />
      <MailList
        groups={groups}
        rowKey={(m) => m.id}
        renderRow={(m) => <MailRow m={m} onPress={() => openRow(m.id)} swipe />}
        rowInset={6}
        refresh={pull}
        head={
          <>
            <ViewHeadOhbox
              meta={metaWhen(surface, meta)}
              unread={w.ohbox.unreadIds.length}
              onMarkAll={() => w.actions.markAllSeen(w.ohbox.unreadIds)}
            />
            <Doorbell initials={w.doorbell.initials} count={w.doorbell.count} />
          </>
        }
        empty={
          surface === "skeleton" ? (
            <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
              <SkeletonList stalled={w.boot.syncFailure} />
            </View>
          ) : surface === "empty" ? (
            <Empty title={Copy.ohboxEmptyTitle}
              /* NO MAIL AND NOTHING READABLE ARE NOT THE SAME EMPTY SCREEN. The hint below
                 promised that mail "lands here as it syncs", which is false for a mailbox whose
                 first sync produced nothing — and that mailbox looked exactly like a quiet one.
                 The engine's own answer chooses (`live.ts#firstSyncSay`); `null` and every other
                 verdict keep the ordinary line. */
              hint={w.boot.firstSync === "nothingReadable"
                ? Copy.ohboxEmptyNothingReadable
                : Copy.ohboxEmptyHint}
            />
          ) : null
        }
        foot={surface === "content" ? <Tail>{Copy.ohboxTail(total)}</Tail> : null}
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

function ViewHeadOhbox({
  meta,
  unread,
  onMarkAll,
}: {
  meta: string | undefined;
  unread: number;
  onMarkAll: () => void;
}) {
  return (
    <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Txt variant="h1">{Copy.ohbox}</Txt>
        <View style={{ flex: 1 }} />
        {/* Renders nothing over a cleared list — the component's own rule. */}
        <MarkAllRead unreadCount={unread} onPress={onMarkAll} />
      </View>
      {/* Silenced over a skeleton (`metaWhen`): "0 unread of 0" about an unread mirror
          would be an invented count. The line keeps its slot so nothing shifts. */}
      <Txt variant="meta" tone="ink3" tabular style={{ marginTop: 4 }}>
        {meta ?? " "}
      </Txt>
    </View>
  );
}
