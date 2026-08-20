/**
 * More — everything the desktop rail holds below the mail places.
 *
 * The rail is typographic on desktop: names and counts, no icons. That holds
 * up here too, so this screen is a list of destinations with their real
 * numbers rather than a grid of tiles. A feature that is not live yet gets a
 * plain sentence, never a control that goes nowhere.
 */
import { View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../../src/copy";
import { useTheme } from "../../src/theme";
import { useWorld } from "../../src/state/world";
import { Panel, Rule, Screen, Scroller, Section, TapRow, Txt } from "../../src/ui/base";
import { TopBar } from "../../src/ui/chrome";
import { Icon } from "../../src/ui/Icon";

export default function MoreScreen() {
  const w = useWorld();
  const pileCountOf = (kind: string) => w.piles.find((p) => p.kind === kind)?.items.length ?? 0;

  return (
    <Screen>
      <TopBar />
      <Scroller>
        {/* The header names whose mail this is: the paired server and account. */}
        <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 14 }}>
          <Txt variant="h1" numberOfLines={1}>{w.account.name}</Txt>
          <Txt variant="meta" tone="ink3" style={{ marginTop: 4 }} numberOfLines={1}>
            {w.account.email}
          </Txt>
        </View>

        <Panel style={{ paddingBottom: 8 }}>
          <Section style={{ paddingTop: 16 }}>Piles</Section>
          <Nav
            label={Copy.replyLater}
            count={pileCountOf("replyLater")}
            onPress={() => router.push("/triage")}
          />
          <Nav
            label={Copy.setAside}
            count={pileCountOf("setAside")}
            onPress={() => router.push("/triage")}
          />
          <Nav
            label={Copy.resurface}
            count={pileCountOf("resurface")}
            onPress={() => router.push("/triage")}
          />

          <Rule inset={20} />

          {/* Search over the synced mirror is not built yet. Said in words, not a dead row. */}
          <View
            style={{
              marginHorizontal: 8,
              paddingHorizontal: 12,
              paddingVertical: 12,
              minHeight: 46,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Txt variant="navLabel" tone="ink3">{Copy.search}</Txt>
            <View style={{ flex: 1 }} />
            <Txt variant="caption" tone="ink3">{Copy.searchLater}</Txt>
          </View>
          <Nav label={Copy.settings} onPress={() => router.push("/settings")} chevron />
          {/* The pairing door: the server picker (QR scan, own-server, managed). */}
          <Nav label={Copy.serversRow} onPress={() => router.push("/servers")} chevron />
        </Panel>
      </Scroller>
    </Screen>
  );
}

function Nav({
  label,
  count,
  chevron,
  onPress,
}: {
  label: string;
  count?: number;
  chevron?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <TapRow
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={count === undefined ? label : `${label}, ${count}`}
      style={{
        marginHorizontal: 8,
        paddingHorizontal: 12,
        paddingVertical: 12,
        minHeight: 46,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
    >
      <Txt variant="navLabel">{label}</Txt>
      <View style={{ flex: 1 }} />
      {count !== undefined ? (
        <Txt variant="caption" tone="ink3" tabular>
          {count}
        </Txt>
      ) : null}
      {chevron ? <Icon name="chev" size={13} color={t.c.ink3} /> : null}
    </TapRow>
  );
}
