/**
 * Receipts — orders, invoices and tickets, grouped by day.
 *
 * The one list where a number is the point, so amounts get their own column,
 * right-aligned and tabular. Nothing else on the row competes with it.
 * Scrolling past marks seen here too, on the same read line as Reads — and on
 * a live account leaving the screen commits this stream's OWN waterline
 * (`feedPartition` keeps the two views' lines independent by construction),
 * which renders here exactly as Reads' does.
 *
 * THE SWEEP MEASURES IN SCROLL-CONTENT COORDINATES. `onLayout` answers a view's
 * offset inside its DIRECT PARENT, and these rows sit four levels deep (content
 * → panel → day group → rows container → row) — read raw, the first row of
 * every day group is `y ≈ 0` and the sweep marked mail in entirely off-screen
 * days as read the moment the top row passed the line. The
 * {@link GroupedSweepLedger} records each level's own offset and answers only
 * rows whose absolute foot has really cleared the line.
 */
import { useCallback, useEffect, useRef } from "react";
import { View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Copy } from "../../src/copy";
import { GroupedSweepLedger } from "../../src/state/sweep";
import { useWorld } from "../../src/state/world";
import { Panel, Screen, Scroller, Section, Tail, Txt, Waterline } from "../../src/ui/base";
import { TopBar } from "../../src/ui/chrome";
import { MailRow } from "../../src/ui/MailRow";

const READ_LINE = 0.62;

/**
 * A group's ledger identity is its FIRST ROW's id, never the display label: day labels
 * repeat across years ("10 Aug" names two different days once the list spans one), and two
 * groups sharing a key would overwrite each other's offsets — rows evaluated at the wrong
 * position. A first-row id belongs to exactly one group.
 */
const groupKeyOf = (g: { label: string; items: { id: string }[] }): string =>
  g.items[0]?.id ?? g.label;

export default function ReceiptsScreen() {
  const w = useWorld();
  const { groups, waterlineAboveId, waterLabel, total, meta } = w.receipts;
  const actions = w.actions;

  const ledger = useRef(new GroupedSweepLedger()).current;

  // PRUNE the ledger against the rendered generation: a projection change (a consent or
  // rule re-home) removes rows from `groups` without any onLayout firing for them, and a
  // stale measurement would sweep mail that is no longer on screen.
  useEffect(() => {
    ledger.retain(
      groups.flatMap((g) => g.items.map((m) => m.id)),
      groups.map(groupKeyOf),
    );
  }, [groups, ledger]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement } = e.nativeEvent;
      const line = contentOffset.y + layoutMeasurement.height * READ_LINE;
      const passed = ledger.passed(line);
      if (passed.length) actions.markSeenThrough("receipts", passed);
    },
    [actions, ledger],
  );

  // The leave commit for this stream's own waterline — live only, by the world's arm.
  useFocusEffect(
    useCallback(() => () => actions.leaveFeed("receipts"), [actions]),
  );

  return (
    <Screen>
      <TopBar />
      <Scroller onScroll={onScroll} scrollEventThrottle={64}>
        <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 14 }}>
          <Txt variant="h1">{Copy.receipts}</Txt>
          <Txt variant="meta" tone="ink3" tabular style={{ marginTop: 4 }}>
            {meta}
          </Txt>
        </View>

        <View onLayout={(e) => ledger.setPanel(e.nativeEvent.layout.y)}>
          <Panel style={{ paddingBottom: 4 }}>
            {groups.map((g, gi) => (
              <View key={groupKeyOf(g)} onLayout={(e) => ledger.setGroup(groupKeyOf(g), e.nativeEvent.layout.y)}>
                <Section style={gi === 0 ? { paddingTop: 18 } : undefined}>{g.label}</Section>
                <View
                  style={{ paddingHorizontal: 6 }}
                  onLayout={(e) => ledger.setItems(groupKeyOf(g), e.nativeEvent.layout.y)}
                >
                  {g.items.map((m) => (
                    <View
                      key={m.id}
                      onLayout={(e) =>
                        ledger.setRow(m.id, groupKeyOf(g), e.nativeEvent.layout.y, e.nativeEvent.layout.height)
                      }
                    >
                      {/* The line stands ABOVE the newest receipt already seen at the last
                          visit — this stream's own anchor, independent of Reads'. */}
                      {waterlineAboveId === m.id ? <Waterline label={waterLabel} meta="" /> : null}
                      <MailRow
                        m={m}
                        tags={w.tagsOf(m.id)}
                        onPress={() => router.push(`/message/${m.id}`)}
                      />
                    </View>
                  ))}
                </View>
              </View>
            ))}
            <Tail>{Copy.receiptsTail(total, w.live)}</Tail>
          </Panel>
        </View>
      </Scroller>
    </Screen>
  );
}
