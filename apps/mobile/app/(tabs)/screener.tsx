/**
 * Screener — the consent gate, and the heart of the product.
 *
 * On the phone this is the list half only: three shelves (waiting, screened
 * out, spam) of senders. Tapping a sender opens the mail itself plus the
 * decision bar, full screen, because you never decide about a sender you
 * cannot see.
 *
 * A row's AI suggestion badge renders only where the server sent one — no
 * classifier runs client-side, and a row without a suggestion honestly has none.
 */
import { useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../../src/copy";
import { useTheme } from "../../src/theme";
import { destDone, type ScreenerSeg } from "../../src/state/model";
import { usePullToSync } from "../../src/state/pull";
import { listSurface, metaWhen } from "../../src/state/surface";
import { useWorld, type ScreenerRow } from "../../src/state/world";
import { Badge, Empty, Panel, Screen, Scroller, Tail, TapRow, Txt } from "../../src/ui/base";
import { TopBar } from "../../src/ui/chrome";
import { Segmented } from "../../src/ui/Segmented";
import { SkeletonList } from "../../src/ui/Skeleton";

const EMPTY: Record<ScreenerSeg, { glyph: string; title: string; hint: string }> = {
  waiting: { glyph: "🚪", title: Copy.waitingEmptyTitle, hint: Copy.waitingEmptyHint },
  screened: { glyph: "🚪", title: Copy.screenedEmptyTitle, hint: Copy.screenedEmptyHint },
  spam: { glyph: "🛡", title: Copy.spamEmptyTitle, hint: Copy.spamEmptyHint },
};

export default function ScreenerScreen() {
  const w = useWorld();
  const pull = usePullToSync();
  const [seg, setSeg] = useState<ScreenerSeg>("waiting");
  const empty = EMPTY[seg];
  const { waiting, screened, spam, meta } = w.screener;
  // Unknown ≠ empty, per SEGMENT: the active shelf's own count against the one settled fact.
  const counts: Record<ScreenerSeg, number> = { waiting: waiting.length, screened: screened.length, spam: spam.length };
  const surface = listSurface({ settled: w.boot.settled, count: counts[seg] });
  const shelfEmpty = surface === "empty" ? <Empty {...empty} /> : <SkeletonList kind="screener" stalled={w.boot.syncFailure} />;

  return (
    <Screen>
      <TopBar />
      <Scroller refresh={pull}>
        <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 14 }}>
          <Txt variant="h1">{Copy.screener}</Txt>
          <Txt variant="meta" tone="ink3" style={{ marginTop: 4 }}>
            {metaWhen(surface, meta) ?? " "}
          </Txt>
        </View>

        <Segmented
          style={{ marginHorizontal: 10, marginBottom: 14 }}
          value={seg}
          onChange={setSeg}
          segments={[
            // Counts speak only over a settled mirror — a "0" badge beside a shelf that is
            // still rendering its skeleton would be an invented count (`state/surface.ts`).
            { value: "waiting", label: Copy.segWaiting, ...(w.boot.settled ? { count: waiting.length } : {}) },
            { value: "screened", label: Copy.segScreened, ...(w.boot.settled ? { count: screened.length } : {}) },
            { value: "spam", label: Copy.segSpam, ...(w.boot.settled ? { count: spam.length } : {}) },
          ]}
        />

        <Panel style={{ paddingBottom: 4 }}>
          {seg === "waiting" ? (
            waiting.length === 0 ? (
              shelfEmpty
            ) : (
              <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
                {waiting.map((row) => (
                  <WaitingRow key={row.id} row={row} />
                ))}
              </View>
            )
          ) : null}

          {seg === "screened" ? (
            screened.length === 0 ? (
              shelfEmpty
            ) : (
              <>
                <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
                  {screened.map((row) => (
                    <TapRow
                      key={row.id}
                      onPress={() => router.push(`/sender/screened/${encodeURIComponent(row.routeKey)}`)}
                      accessibilityRole="button"
                      style={{ paddingHorizontal: 12, paddingVertical: 12 }}
                    >
                      <Txt variant="rowSubject" numberOfLines={1}>
                        {row.address}
                      </Txt>
                      <Txt variant="caption" tone="ink3" style={{ marginTop: 4, lineHeight: 16 }}>
                        {Copy.screenedNote(row.screenedOn, row.held.length)}
                      </Txt>
                    </TapRow>
                  ))}
                </View>
                <Tail>Nothing was deleted. Every held message is one tap away, in full.</Tail>
              </>
            )
          ) : null}

          {seg === "spam" ? (
            spam.length === 0 ? (
              shelfEmpty
            ) : (
              <>
                <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
                  {spam.map((row) => (
                    <TapRow
                      key={row.id}
                      onPress={() => router.push(`/sender/spam/${encodeURIComponent(row.routeKey)}`)}
                      accessibilityRole="button"
                      style={{ paddingHorizontal: 12, paddingVertical: 12 }}
                    >
                      <Txt variant="rowSubjectSeen" tone="ink2" numberOfLines={1}>
                        {row.address}
                      </Txt>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
                        {row.detection ? <Badge icon="shield">{row.detection}</Badge> : null}
                        <Badge>{Copy.heldCaption(row.held.length)}</Badge>
                      </View>
                    </TapRow>
                  ))}
                </View>
                <Tail>{Copy.spamNote}</Tail>
              </>
            )
          ) : null}
        </Panel>
      </Scroller>
    </Screen>
  );
}

function WaitingRow({ row }: { row: ScreenerRow }) {
  const t = useTheme();
  return (
    <TapRow
      onPress={() => router.push(`/sender/waiting/${encodeURIComponent(row.routeKey)}`)}
      accessibilityRole="button"
      accessibilityLabel={`${row.name}, ${row.address}, ${row.held.length} held`}
      style={{ paddingHorizontal: 12, paddingVertical: 12 }}
    >
      <View style={{ flexDirection: "row", gap: 12 }}>
        <View
          style={[
            {
              width: 34,
              height: 34,
              borderRadius: 17,
              backgroundColor: t.c.float,
              alignItems: "center",
              justifyContent: "center",
            },
            t.lift("l0"),
          ]}
        >
          <Txt variant="settingsLabel" tone={row.dull ? "ink3" : "ink2"}>
            {row.initial}
          </Txt>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Txt
              variant={row.dull ? "rowSenderSeen" : "rowSender"}
              tone={row.dull ? "ink2" : "ink"}
              numberOfLines={1}
              style={{ flexShrink: 1 }}
            >
              {row.name}
            </Txt>
            <View style={{ flex: 1 }} />
            <Txt variant="caption" tone="ink3" tabular>
              {row.time}
            </Txt>
          </View>
          <Txt variant="caption" tone="ink3" numberOfLines={1} style={{ marginTop: 1 }}>
            {row.address}
          </Txt>
          <Txt
            variant={row.dull ? "rowSubjectSeen" : "rowSubject"}
            tone={row.dull ? "ink2" : "ink"}
            numberOfLines={1}
            style={{ marginTop: 5 }}
          >
            {row.newestSubject}
          </Txt>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
            {row.ai ? (
              <Badge icon="spark" tone="accent">
                {Copy.aiSuggests(destDone(row.ai.dest), row.ai.confidence)}
              </Badge>
            ) : null}
            <Badge>{Copy.heldCaption(row.held.length)}</Badge>
          </View>
        </View>
      </View>
    </TapRow>
  );
}
