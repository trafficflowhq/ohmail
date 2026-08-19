/**
 * More — everything the desktop rail holds below the mail places.
 *
 * The rail is typographic on desktop: names and counts, no icons. That holds
 * up here too, so this screen is a list of destinations with their real
 * numbers rather than a grid of tiles.
 */
import { View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../../src/copy";
import { useTheme } from "../../src/theme";
import { taggedMail } from "../../src/state/derived";
import { world } from "../../src/state/model";
import { useApp } from "../../src/state/store";
import { useWorld } from "../../src/state/world";
import { Panel, Rule, Screen, Scroller, Section, TapRow, Txt } from "../../src/ui/base";
import { TopBar } from "../../src/ui/chrome";
import { Icon } from "../../src/ui/Icon";
import { PreviewNote } from "./index";

export default function MoreScreen() {
  const t = useTheme();
  const s = useApp();
  const w = useWorld();
  const pileCountOf = (kind: string) => w.piles.find((p) => p.kind === kind)?.items.length ?? 0;

  return (
    <Screen>
      <TopBar />
      <Scroller>
        {/* The header names whose mail this is: Mila's fixture account in the demo, the
            paired server + account on a live session — never the fixture identity over
            somebody's real mailbox. */}
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

          {/* Tags are the demo world's until they arrive on live accounts — fixture rows
              over a real account would be counts about mail that is not there. */}
          {!w.live ? (
            <>
              <Section>{Copy.tags}</Section>
              {world.tags.map((tag) => {
                const hue = t.c.tag[tag.hue];
                return (
                  <Nav
                    key={tag.id}
                    label={tag.name}
                    dot={hue.ink}
                    count={taggedMail(s, tag.id).length}
                    onPress={() => router.push(`/tag/${tag.id}`)}
                  />
                );
              })}
              <View style={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8 }}>
                <Txt variant="caption" tone="ink3" style={{ lineHeight: 16 }}>
                  {Copy.tagsNote}
                </Txt>
              </View>
            </>
          ) : null}

          <Rule inset={20} />

          <Nav label={Copy.search} onPress={() => router.push("/search")} chevron />
          <Nav label={Copy.settings} onPress={() => router.push("/settings")} chevron />
          {/* The pairing door: the server picker (QR scan, own-server, managed) that
              replaced the dev-only manual bearer entry. A release feature, not a dev one. */}
          <Nav label={Copy.serversRow} onPress={() => router.push("/servers")} chevron />
        </Panel>

        <PreviewNote />
      </Scroller>
    </Screen>
  );
}

function Nav({
  label,
  count,
  dot,
  chevron,
  onPress,
}: {
  label: string;
  count?: number;
  dot?: string;
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
      {dot ? <View style={{ width: 7, height: 7, borderRadius: t.radius.dot, backgroundColor: dot }} /> : null}
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
