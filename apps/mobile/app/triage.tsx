/**
 * Piles — Answer Later, Parked, Resurface.
 *
 * On the desktop the three piles sit side by side as stacked sheets. A phone
 * has one column, so they stack vertically and keep the sheet edge: the thin
 * upward shadow under each pile that says there is paper beneath the top one.
 * Counts are derived from the items, never stored, so a pile cannot claim a
 * number it does not hold.
 */
import { View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../src/copy";
import { useTheme } from "../src/theme";
import { useWorld } from "../src/state/world";
import { Badge, Panel, Screen, Scroller, TapRow, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { Icon, type IconName } from "../src/ui/Icon";

const PILE_ICON: Record<string, IconName> = {
  replyLater: "clock",
  setAside: "pause",
  resurface: "up",
};

export default function TriageScreen() {
  const t = useTheme();
  const w = useWorld();

  return (
    <Screen>
      <DetailBar title={Copy.triage} />
      <Scroller>
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 16 }}>
          <Txt variant="h1">{Copy.triage}</Txt>
          <Txt variant="meta" tone="ink3" tabular style={{ marginTop: 4 }}>
            {w.pilesMeta}
          </Txt>
        </View>

        {w.piles.map((p) => (
          <View key={p.kind} style={{ marginBottom: 16 }}>
            {/*
              `.pile-stack::before/::after` — two sheets of paper under the top
              one, each narrower than the sheet above it and carrying the
              `sheetEdge` shadow (which points *upward*: light falls between
              sheets, not onto them). A pile that is literally a stack is the
              one place Blanc lets a surface be decorative, because the shape
              is the meaning.
            */}
            <View style={{ alignItems: "center" }}>
              <View
                style={[
                  {
                    height: 7,
                    width: "88%",
                    borderTopLeftRadius: t.radius.card,
                    borderTopRightRadius: t.radius.card,
                    backgroundColor: t.c.panel,
                  },
                  t.lift("sheetEdge"),
                ]}
              />
              <View
                style={[
                  {
                    height: 7,
                    width: "94%",
                    marginTop: -1,
                    borderTopLeftRadius: t.radius.card,
                    borderTopRightRadius: t.radius.card,
                    backgroundColor: t.c.panel,
                  },
                  t.lift("sheetEdge"),
                ]}
              />
            </View>
            <Panel radius={t.radius.card} style={{ paddingBottom: 10, marginTop: -1 }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingHorizontal: 18,
                  paddingTop: 16,
                  paddingBottom: 4,
                }}
              >
                <Icon name={PILE_ICON[p.kind]} size={14} color={t.c.accentInk} />
                <Txt variant="pileTitle">{p.title}</Txt>
                <View style={{ flex: 1 }} />
                <Badge>{p.items.length}</Badge>
              </View>
              <Txt variant="caption" tone="ink3" style={{ paddingHorizontal: 18, lineHeight: 16 }}>
                {p.note}
              </Txt>

              <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
                {p.items.length === 0 ? (
                  <Txt variant="note" tone="ink3" style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
                    {Copy.pileEmpty}
                  </Txt>
                ) : (
                  p.items.map((i) => (
                    <TapRow
                      key={i.id}
                      onPress={i.messageId ? () => router.push(`/message/${i.messageId}`) : undefined}
                      accessibilityRole={i.messageId ? "button" : undefined}
                      style={{ paddingHorizontal: 12, paddingVertical: 11 }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
                        <Txt variant="rowSender" style={{ flexShrink: 1 }} numberOfLines={1}>
                          {i.title}
                        </Txt>
                        <View style={{ flex: 1 }} />
                        {i.resurfaceAt ? (
                          <Txt variant="caption" tone="accent" tabular>
                            {i.resurfaceAt}
                          </Txt>
                        ) : null}
                      </View>
                      {i.subtitle ? (
                        <Txt variant="rowSubjectSeen" tone="ink2" numberOfLines={1} style={{ marginTop: 2 }}>
                          {i.subtitle}
                        </Txt>
                      ) : null}
                      {i.preview ? (
                        <Txt variant="meta" tone="ink3" numberOfLines={1} style={{ marginTop: 1 }}>
                          {i.preview}
                        </Txt>
                      ) : null}
                    </TapRow>
                  ))
                )}
              </View>
            </Panel>
          </View>
        ))}
      </Scroller>
    </Screen>
  );
}
