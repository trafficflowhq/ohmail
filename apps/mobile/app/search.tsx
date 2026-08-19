/**
 * Search — typo-tolerant, over the fixtures, on the device.
 *
 * The result line reports a real measurement over a real pass: there is no
 * index server and no network, so "11 ms · local index" is what the linear
 * scan actually cost, not a number copied from the prototype.
 *
 * The demo case is seeded: `invoce` is a misspelling with no exact match
 * anywhere in the corpus, and it still reaches *Invoice #078* through the
 * bounded edit-distance pass. The hit says so — `fuzzy match — "Invoice"` —
 * because search that quietly corrects you is search you stop trusting.
 *
 * ON A LIVE SESSION THIS SCREEN IS STILL THE DEMO'S: it searches the fixture
 * corpus, not the synced mirror, and the banner under the input says exactly
 * that. Claims are contracts — a search box over real mail that answered from
 * fixtures without saying so would be a lie with a working UI.
 */
import { useMemo, useState } from "react";
import { TextInput, View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../src/copy";
import { useTheme } from "../src/theme";
import { search } from "../src/state/derived";
import { useApp } from "../src/state/store";
import { useWorld } from "../src/state/world";
import { Badge, Empty, Panel, Screen, Scroller, TapRow, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { Icon } from "../src/ui/Icon";

export default function SearchScreen() {
  const t = useTheme();
  const s = useApp();
  const w = useWorld();
  const [query, setQuery] = useState("invoce");
  const result = useMemo(() => search(s, query), [s, query]);
  const idle = query.trim().length === 0;

  return (
    <Screen>
      <DetailBar title={Copy.search} />
      <Scroller keyboardShouldPersistTaps="handled">
        <View
          style={[
            {
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              marginHorizontal: 4,
              paddingHorizontal: 16,
              paddingVertical: 4,
              borderRadius: t.radius.input,
              backgroundColor: t.c.panel,
            },
            t.lift("l0"),
          ]}
        >
          <Icon name="search" size={16} color={t.c.ink3} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={Copy.searchPlaceholder}
            placeholderTextColor={t.c.ink3}
            autoCorrect={false}
            autoCapitalize="none"
            accessibilityLabel={Copy.searchPlaceholder}
            style={[t.type.msgBody, { flex: 1, color: t.c.ink, paddingVertical: 12 }]}
          />
        </View>

        {w.live ? (
          <Txt variant="caption" tone="ink2" style={{ paddingHorizontal: 18, paddingTop: 12, lineHeight: 16 }}>
            {Copy.searchDemoOnly}
          </Txt>
        ) : null}

        {!idle ? (
          <Txt variant="caption" tone="ink3" tabular style={{ paddingHorizontal: 18, paddingTop: 12 }}>
            {Copy.results(result.hits.length, result.tookMs)}
          </Txt>
        ) : null}

        {idle ? (
          <Empty glyph="🔎" title={Copy.searchIdleTitle} hint={Copy.searchIdleSub} />
        ) : result.hits.length === 0 ? (
          <Empty glyph="🔎" title={Copy.searchEmptyTitle} hint={Copy.searchEmptySub} />
        ) : (
          <>
            <Panel style={{ marginTop: 12, paddingVertical: 8 }}>
              <View style={{ paddingHorizontal: 6 }}>
                {result.hits.map((h) => (
                  <TapRow
                    key={h.id}
                    onPress={() => router.push(`/message/${h.id}`)}
                    accessibilityRole="button"
                    style={{ paddingHorizontal: 12, paddingVertical: 12 }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
                      <Txt variant="rowSender" numberOfLines={1} style={{ flexShrink: 1 }}>
                        {h.who}
                      </Txt>
                      <View style={{ flex: 1 }} />
                      <Txt variant="caption" tone="ink3">
                        {h.where}
                      </Txt>
                    </View>
                    <Txt variant="rowSubject" tone="ink" numberOfLines={2} style={{ marginTop: 3 }}>
                      {h.subject}
                    </Txt>
                    {h.fuzzyOf ? (
                      <View style={{ flexDirection: "row", marginTop: 7 }}>
                        <Badge icon="spark" tone="accent">
                          {Copy.fuzzyNote(h.fuzzyOf)}
                        </Badge>
                      </View>
                    ) : null}
                  </TapRow>
                ))}
              </View>
            </Panel>

            {result.facets.length > 0 ? (
              <View style={{ paddingHorizontal: 12, paddingTop: 18, gap: 10 }}>
                {result.facets.map((f) => (
                  <View key={f.title} style={{ gap: 6 }}>
                    <Txt variant="caption" tone="ink3">
                      {f.title}
                    </Txt>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                      {f.items.map((i) => (
                        <Badge key={i.label} tone="place">
                          {i.count === undefined ? i.label : `${i.label} · ${i.count}`}
                        </Badge>
                      ))}
                    </View>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        )}
      </Scroller>
    </Screen>
  );
}
