/**
 * One tag, across every view.
 *
 * A tag is not a folder: the mail below still lives in Ohbox, Reads or
 * Receipts, and the place badge on each row says which. That is the whole
 * point of the screen, so the badge is not optional decoration.
 */
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import type { TagId } from "@ohmail/fixtures";
import { Copy } from "../../src/copy";
import { useTheme } from "../../src/theme";
import { tagMeta, taggedMail, tagsOfMessage } from "../../src/state/derived";
import { world } from "../../src/state/model";
import { useApp } from "../../src/state/store";
import { Empty, Panel, Screen, Scroller, Tail, Txt } from "../../src/ui/base";
import { DetailBar } from "../../src/ui/chrome";
import { MailRow } from "../../src/ui/MailRow";

const PLACE: Record<string, string> = { ohbox: "Ohbox", reads: "Reads", receipts: "Receipts" };

export default function TagScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const s = useApp();
  const tag = world.tags.find((x) => x.id === id);
  const items = tag ? taggedMail(s, tag.id as TagId) : [];

  if (!tag) {
    return (
      <Screen>
        <DetailBar title={Copy.tags} />
        <Scroller>
          <Empty glyph="🏷" title={Copy.tagEmpty} hint={Copy.tagEmptySub} />
        </Scroller>
      </Screen>
    );
  }

  const hue = t.c.tag[tag.hue];

  return (
    <Screen>
      <DetailBar title={Copy.tags} />
      <Scroller>
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>
            <View style={{ width: 9, height: 9, borderRadius: t.radius.dot, backgroundColor: hue.ink }} />
            <Txt variant="h1" style={{ flexShrink: 1 }}>
              {tag.name}
            </Txt>
          </View>
          <Txt variant="meta" tone="ink3" style={{ marginTop: 4 }}>
            {tagMeta(s, tag.id as TagId)}
          </Txt>
        </View>

        <Panel style={{ paddingBottom: 4, paddingTop: 8 }}>
          {items.length === 0 ? (
            <Empty glyph="🏷" title={Copy.tagEmpty} hint={Copy.tagEmptySub} />
          ) : (
            <>
              <View style={{ paddingHorizontal: 6 }}>
                {items.map((m) => (
                  <MailRow
                    key={m.id}
                    m={m}
                    tags={tagsOfMessage(s, m.id).filter((x) => x !== tag.id)}
                    place={PLACE[m.place]}
                    onPress={() => router.push(`/message/${m.id}`)}
                  />
                ))}
              </View>
              <Tail>{Copy.tagsNote}</Tail>
            </>
          )}
        </Panel>
      </Scroller>
    </Screen>
  );
}
