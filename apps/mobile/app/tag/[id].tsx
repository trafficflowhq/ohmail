/**
 * Tag — one tag, across every place, opened from the More screen's Tags group (the webapp's
 * `TagView.tsx` is the reference): one list, newest first, a row opening its message. The rows
 * are `liveTagged`'s — every message carrying the tag, which the mirror holds whatever its age
 * (the engine pins tagged mail and the snapshot serves it), so the count is the account's own.
 */
import { useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { Copy } from "../../src/copy";
import { usePullToSync } from "../../src/state/pull";
import { listSurface, metaWhen } from "../../src/state/surface";
import { useWorld } from "../../src/state/world";
import { tagHueOf } from "../../src/theme/palette";
import { useTheme } from "../../src/theme";
import { Empty, Screen, Scroller, TagDot, Txt } from "../../src/ui/base";
import { DetailBar } from "../../src/ui/chrome";
import { ListDetail, useListDetail } from "../../src/ui/list-detail";
import { MailList } from "../../src/ui/MailList";
import { MessageReader } from "../../src/ui/MessageReader";
import { Gated } from "../../src/ui/Gated";
import { MailRow } from "../../src/ui/MailRow";
import { SkeletonList } from "../../src/ui/Skeleton";
import { useLocale } from "../../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../../src/ui/ErrorBoundary";

/** Gated like the tabs: a restored route must land on the connect flow, not an empty list. */
export default function TagScreen() {
  useLocale();
  return (
    <SurfaceBoundary surface="tag">
      <Gated>
        <TagBody />
      </Gated>
    </SurfaceBoundary>
  );
}

function TagBody() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const w = useWorld();
  const t = useTheme();
  const pull = usePullToSync();
  const { open, openRow, close } = useListDetail((mid) => `/message/${mid}`);
  const tag = w.tags.find((x) => x.id === id);

  // Deleted elsewhere, or a URL naming a tag this account does not have.
  if (!tag) {
    return (
      <Screen>
        <DetailBar />
        <Scroller>
          <Txt variant="note" tone="ink3" style={{ padding: 20 }}>
            {Copy.tagGone}
          </Txt>
        </Scroller>
      </Screen>
    );
  }

  const { rows, total } = w.tagged.items(tag.id);
  const surface = listSurface({ settled: w.boot.settled, count: total });

  const list = (
    <Screen>
      {/* The page carries its own heading, so the bar carries only the way back. */}
      <DetailBar />
      <MailList
        groups={[{ key: "tagged", rows }]}
        rowKey={(m) => m.id}
        renderRow={(m) => <MailRow m={m} onPress={() => openRow(m.id)} swipe />}
        surface={surface !== "empty"}
        refresh={pull}
        head={
          <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <TagDot ink={t.c.tag[tagHueOf(tag.hue)].ink} />
              <Txt variant="h1" numberOfLines={1} style={{ flexShrink: 1 }}>
                {tag.name}
              </Txt>
              <Txt variant="meta" tone="ink3" tabular>
                {metaWhen(surface, Copy.tagMeta(total)) ?? " "}
              </Txt>
            </View>
          </View>
        }
        empty={
          surface === "skeleton" ? (
            <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
              <SkeletonList stalled={w.boot.syncFailure} />
            </View>
          ) : surface === "empty" ? (
            <Empty title={Copy.tagEmptyTitle} hint={Copy.tagEmptyHint} />
          ) : null
        }
      />
    </Screen>
  );

  return (
    <ListDetail
      open={open}
      onClose={close}
      toRoute={(mid) => `/message/${mid}`}
      list={list}
      renderDetail={(mid, ctx) => <MessageReader id={mid} inPane={ctx.inPane} onClose={ctx.onClose} />}
    />
  );
}
