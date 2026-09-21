/**
 * History — mail from people nobody ever decided about, who then went quiet;
 * the phone's half of the webapp's `HistoryView.tsx`. Nothing has moved:
 * History is a presentation over the mailbox, never a folder — every row
 * states the server folder it still sits in (`MailRow`'s place chip off
 * `historyPlace`). Everything is read by construction (unread mail queues its
 * sender in the Screener), so one list, no badge. Not called Archive: that
 * verb never happened to this mail. The explainer stands above the list, not
 * dismissible; the other two sentences sit behind the browser's disclosure.
 */
import { useState } from "react";
import { View } from "react-native";

import { Copy } from "../src/copy";
import { usePullToSync } from "../src/state/pull";
import { listSurface, metaWhen } from "../src/state/surface";
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

/** Gated like the tabs — a deep-linked route must not render the empty world. */
export default function HistoryScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <Gated>
      <HistoryBody />
    </Gated>
  );
}

function HistoryBody() {
  const w = useWorld();
  const pull = usePullToSync();
  /* Two panes: a row SELECTS and the reader opens beside the list; one pane: it pushes, as
     ever. The selection is the route's `open` param — `src/ui/list-detail.tsx` is the rule. */
  const { open, openRow, close } = useListDetail((id) => `/message/${id}`);
  const [more, setMore] = useState(false);
  const { items, total, meta, pending } = w.history;
  // Unknown ≠ empty (`state/surface.ts`): before this mirror has settled a drain, an empty
  // History shows the row silhouette. "Nothing has settled here yet" over an unsynced database
  // would be the product asserting a fact about a mailbox it has not read — and so would the
  // same sentence over a settled mirror whose CUTLINE answer is still in flight, which is what
  // `pending` carries (nothing is retired until the account's own window is known).
  const surface = listSurface({ settled: w.boot.settled, count: total, pending });

  const list = (
    <Screen>
      <DetailBar title={Copy.history} />
      <MailList
        /* ONE GROUP, and that is the read-by-construction rule showing through: there is no
           NEW half to split off, because an unread message is never here. */
        groups={[{ key: "history", rows: items }]}
        rowKey={(m) => m.id}
        renderRow={(m) => <MailRow m={m} onPress={() => openRow(m.id)} swipe />}
        // The empty sentence stands on the canvas; the silhouette and the rows on the panel.
        surface={surface !== "empty"}
        gapAbove={surface === "content" ? 8 : 0}
        refresh={pull}
        head={
          <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
              <Txt variant="h1" numberOfLines={1} style={{ flexShrink: 1 }}>
                {Copy.history}
              </Txt>
              <Txt variant="meta" tone="ink3" tabular>
                {metaWhen(surface, meta) ?? " "}
              </Txt>
            </View>
            <Txt variant="note" tone="ink3" style={{ marginTop: 8 }}>
              {Copy.historyExplainer}
            </Txt>
            {/* The disclosure pattern this app already uses (`app/standalone.tsx`): a labelled
                press in the accent ink, the body below it, `expanded` announced. Collapsed, not
                deleted — a disclosure that is always in the same place is not a hint that
                disappears. */}
            <Tap
              onPress={() => setMore((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: more }}
              accessibilityLabel={Copy.historyExplainerMoreLabel}
              style={{ paddingVertical: 8 }}
            >
              <Txt variant="settingsLabel" tone="accent">
                {Copy.historyExplainerMoreLabel}
              </Txt>
            </Tap>
            {more ? (
              <Txt variant="note" tone="ink3" style={{ paddingBottom: 4 }}>
                {Copy.historyExplainerMore}
              </Txt>
            ) : null}
          </View>
        }
        empty={
          surface === "skeleton" || surface === "pending" ? (
            <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
              <SkeletonList
                {...(surface === "pending"
                  ? { note: Copy.cutlinePending }
                  : { stalled: w.boot.syncFailure })}
              />
            </View>
          ) : surface === "empty" ? (
            <Empty title={Copy.historyEmptyTitle} hint={Copy.historyEmptyHint} />
          ) : null
        }
        tail={surface === "content" ? <Tail>{Copy.historyTail(total)}</Tail> : null}
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
