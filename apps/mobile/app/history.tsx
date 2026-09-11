/**
 * HISTORY — mail from people nobody ever decided about, who then went quiet.
 *
 * The phone's half of the browser's own place (`apps/webapp/app/views/HistoryView.tsx`, which
 * carries the whole argument). Three of its facts decide this screen:
 *
 *  · **Nothing here has moved.** History is a presentation over the mailbox, never a folder, so
 *    every row states the server folder it is still sitting in (`MailRow`'s place chip off
 *    `historyPlace`). A place the product invented must not be mistaken for a place mail was put.
 *  · **Everything here is read**, and by construction rather than by arrangement: a sender with
 *    any unread mail is ACTIVE whatever its age, so an unread message pulls its sender into the
 *    Screener queue instead. So there is no unread state, no badge and no NEW group — one list.
 *  · **It is not called Archive.** "Archive" is a verb in every other mail client, an action this
 *    mail never received, and a mailbox with a real server-side Archive folder would be shown a
 *    view by that name whose contents are not that folder's.
 *
 * The explainer stands ABOVE the list and is not dismissible: "History" is a word this product
 * uses in a way no other mail client does, and the sentence is as true on the hundredth visit as
 * the first. The other two sentences — all read, nothing moved — sit behind the disclosure, the
 * browser's own split, because as a block of three they push the first row off a phone window.
 */
import { useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../src/copy";
import { usePullToSync } from "../src/state/pull";
import { listSurface, metaWhen } from "../src/state/surface";
import { useWorld } from "../src/state/world";
import { Empty, Panel, Screen, Scroller, Tail, Tap, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
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
  const [more, setMore] = useState(false);
  const { items, total, meta } = w.history;
  // Unknown ≠ empty (`state/surface.ts`): before this mirror has settled a drain, an empty
  // History shows the row silhouette. "Nothing has settled here yet" over an unsynced database
  // would be the product asserting a fact about a mailbox it has not read.
  const surface = listSurface({ settled: w.boot.settled, count: total });

  return (
    <Screen>
      <DetailBar title={Copy.history} />
      <Scroller refresh={pull}>
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

        {surface === "skeleton" ? (
          <Panel style={{ paddingBottom: 4 }}>
            <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
              <SkeletonList stalled={w.boot.syncFailure} />
            </View>
          </Panel>
        ) : surface === "empty" ? (
          <Empty glyph="🕰" title={Copy.historyEmptyTitle} hint={Copy.historyEmptyHint} />
        ) : (
          <>
            {/* ONE GROUP, and that is the read-by-construction rule showing through: there is no
                NEW half to split off, because an unread message is never here. */}
            <Panel style={{ paddingBottom: 4, marginTop: 8 }}>
              {items.map((m) => (
                <MailRow key={m.id} m={m} onPress={() => router.push(`/message/${m.id}`)} />
              ))}
            </Panel>
            <Tail>{Copy.historyTail(total)}</Tail>
          </>
        )}
      </Scroller>
    </Screen>
  );
}
