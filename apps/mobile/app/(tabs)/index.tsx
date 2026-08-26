/**
 * Ohbox — mail from people you said Yes to.
 *
 * The list splits new / previously seen and never re-sorts under the reader.
 * The split is the engine's own `ohboxView` — new-for-you / earlier, plus the
 * resurfaced pin group above both (mail whose "show me this again" moment has
 * come).
 *
 * The screen renders what `useWorld()` answers and holds no logic of its own.
 * An empty mailbox renders an honest empty state, never sample mail.
 */
import { View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../../src/copy";
import { usePullToSync } from "../../src/state/pull";
import { listSurface, metaWhen } from "../../src/state/surface";
import { useWorld, type WorldMail } from "../../src/state/world";
import { Empty, Panel, Screen, Scroller, Section, Tail, Txt } from "../../src/ui/base";
import { Doorbell, TopBar } from "../../src/ui/chrome";
import { MailRow } from "../../src/ui/MailRow";
import { SkeletonList } from "../../src/ui/Skeleton";

export default function OhboxScreen() {
  const w = useWorld();
  const pull = usePullToSync();
  const { resurfaced, fresh, seen, total, meta } = w.ohbox;
  // Unknown ≠ empty: before this mirror has ever settled a drain, a zero-row Ohbox shows
  // the shape of what is coming, never "All quiet" — `state/surface.ts` is the whole rule.
  const surface = listSurface({ settled: w.boot.settled, count: total });

  const group = (rows: WorldMail[]) => (
    <View style={{ paddingHorizontal: 6 }}>
      {rows.map((m) => (
        <MailRow key={m.id} m={m} onPress={() => router.push(`/message/${m.id}`)} />
      ))}
    </View>
  );

  return (
    <Screen>
      <TopBar />
      <Scroller refresh={pull}>
        <ViewHeadOhbox meta={metaWhen(surface, meta)} />
        <Doorbell initials={w.doorbell.initials} count={w.doorbell.count} />

        <Panel style={{ paddingBottom: 4 }}>
          {surface === "skeleton" ? (
            <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
              <SkeletonList stalled={w.boot.syncFailure} />
            </View>
          ) : surface === "empty" ? (
            <Empty glyph="📭" title={Copy.ohboxEmptyTitle} hint={Copy.ohboxEmptyHint} />
          ) : (
            <>
              {resurfaced.length > 0 ? (
                <>
                  <Section style={{ paddingTop: 18 }}>{Copy.groupResurfaced}</Section>
                  {group(resurfaced)}
                </>
              ) : null}

              {fresh.length > 0 ? (
                <>
                  <Section style={resurfaced.length === 0 ? { paddingTop: 18 } : undefined}>
                    {Copy.groupNew}
                  </Section>
                  {group(fresh)}
                </>
              ) : null}

              {seen.length > 0 ? (
                <>
                  <Section>{Copy.groupSeen}</Section>
                  {group(seen)}
                </>
              ) : null}

              <Tail>{Copy.ohboxTail(total)}</Tail>
            </>
          )}
        </Panel>
      </Scroller>
    </Screen>
  );
}

function ViewHeadOhbox({ meta }: { meta: string | undefined }) {
  return (
    <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 14 }}>
      <Txt variant="h1">{Copy.ohbox}</Txt>
      {/* Silenced over a skeleton (`metaWhen`): "0 unread of 0" about an unread mirror
          would be an invented count. The line keeps its slot so nothing shifts. */}
      <Txt variant="meta" tone="ink3" tabular style={{ marginTop: 4 }}>
        {meta ?? " "}
      </Txt>
    </View>
  );
}
