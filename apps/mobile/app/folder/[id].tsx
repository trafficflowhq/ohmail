/**
 * FOLDER — one of the mailbox's OWN folders, opened from the More screen's Folders group
 * (FOLDERS-SPEC.md §3: "a user folder opens as a parameterized view — a list filtered on
 * `m.folder`"; the webapp's `FolderView.tsx` is the reference).
 *
 * The list wears the standard NEW / EARLIER grouping the other lists wear, and it is
 * READ-ONLY at this stage exactly like the webapp's foundation: no move verb, no menu — a
 * row opens its message, whose action bar carries the ordinary verbs.
 *
 * WHAT THIS SCREEN MAY NOT CLAIM: this build has no reach-past on any screen — the phone's
 * mirror is a window over the server — so an empty list here is "no mail from this folder on
 * this phone", never "nothing in this folder" (the webapp earns that sentence by asking the
 * server past the mirror; see `Copy.folderEmptyTitle`'s header). The tail states the same
 * boundary under a populated list.
 */
import { router, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { Copy } from "../../src/copy";
import { folderLeafOf, folderParentOf } from "../../src/state/folders";
import { useWorld } from "../../src/state/world";
import { Empty, Panel, Screen, Scroller, Section, Tail, Txt } from "../../src/ui/base";
import { DetailBar } from "../../src/ui/chrome";
import { Gated } from "../../src/ui/Gated";
import { MailRow } from "../../src/ui/MailRow";

/** Gated like the tabs: a restored route must land on the connect flow, not an empty list. */
export default function FolderScreen() {
  return (
    <Gated>
      <FolderBody />
    </Gated>
  );
}

function FolderBody() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const w = useWorld();
  const folder = w.folders.byId(id ?? "");

  // The flag went off, the entity left the mirror, or the URL names a folder this account
  // does not have — the same honest sentence the message screen gives a gone id.
  if (!folder) {
    return (
      <Screen>
        <DetailBar />
        <Scroller>
          <Txt variant="note" tone="ink3" style={{ padding: 20 }}>
            That folder is no longer here.
          </Txt>
        </Scroller>
      </Screen>
    );
  }

  const { fresh, seen, unread, total } = w.folders.items(folder.id);
  const leaf = folderLeafOf(folder.name);
  const parent = folderParentOf(folder.name);

  return (
    <Screen>
      <DetailBar title={leaf} />
      <Scroller>
        <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
            <Txt variant="h1" numberOfLines={1} style={{ flexShrink: 1 }}>
              {leaf}
            </Txt>
            <Txt variant="meta" tone="ink3" tabular>
              {`${unread} unread of ${total}`}
            </Txt>
          </View>
          {/* The full path when the folder is nested, so "Q1" says where it lives — the
              webapp's meta line, one namespace over. */}
          {parent ? (
            <Txt variant="caption" tone="ink3" numberOfLines={1} style={{ marginTop: 4 }}>
              {folder.name}
            </Txt>
          ) : null}
        </View>

        {total === 0 ? (
          <Empty glyph="📁" title={Copy.folderEmptyTitle} hint={Copy.folderEmptyHint} />
        ) : (
          <>
            {fresh.length > 0 ? (
              <Panel style={{ marginBottom: 12 }}>
                <Section style={{ paddingTop: 14 }}>{Copy.groupNew}</Section>
                {fresh.map((m) => (
                  <MailRow key={m.id} m={m} onPress={() => router.push(`/message/${m.id}`)} />
                ))}
              </Panel>
            ) : null}
            {seen.length > 0 ? (
              <Panel>
                <Section style={{ paddingTop: 14 }}>{Copy.groupSeen}</Section>
                {seen.map((m) => (
                  <MailRow key={m.id} m={m} onPress={() => router.push(`/message/${m.id}`)} />
                ))}
              </Panel>
            ) : null}
            <Tail>{Copy.folderTail(total)}</Tail>
          </>
        )}
      </Scroller>
    </Screen>
  );
}
