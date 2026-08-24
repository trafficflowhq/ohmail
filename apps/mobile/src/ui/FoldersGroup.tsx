/**
 * THE MORE SCREEN'S FOLDERS GROUP — the webapp rail's Folders group (FoldersRailGroup.tsx is
 * the reference), in the phone's list idiom (FOLDERS-SPEC.md §14/§15).
 *
 * Rendered ONLY while "Use folders" is on — the caller withholds the node entirely otherwise,
 * so a flag-off More screen is the pre-feature screen (spec §10). What it renders, per mailbox
 * (an address label above each tree when 2+ mailboxes exist; one mailbox ⇒ no labels):
 *
 *  · the folder TREE, first level only by default — a branch with children starts closed and
 *    opens when the user opens it (the OPENED-set walk; spec §15). The set is view state for
 *    the visit: this app persists no UI preference yet (`store.tsx`'s own posture — the theme
 *    itself resets), so persisting one set here would be a new mechanism, not parity.
 *  · unread badges, with ROLL-UP on a collapsed parent: own + hidden descendants — collapsing
 *    must never hide unread truth. Expanded, every folder shows its own count again.
 *  · the MANY-FOLDERS treatment above {@link FOLDER_FILTER_AT} roots: a type-to-filter line,
 *    the first 12 roots + a "Show all N…" expander. Filtered matches render flat wearing
 *    their parent path.
 *
 * Read-only, exactly like the webapp's foundation stage: no create, no rename, no menu.
 */
import { useState } from "react";
import { TextInput, View } from "react-native";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import {
  FOLDER_FILTER_AT,
  folderLeafOf,
  folderMatches,
  folderParentOf,
  folderTree,
  folderUnreadDeep,
  visibleFolderRows,
  type FolderTreeRow,
} from "../state/folders";
import type { FolderEntity } from "../state/world";
import { Rule, Section, Tap, TapRow, Txt } from "./base";
import { Icon } from "./Icon";

const branchKey = (mailboxId: string, path: string): string => `${mailboxId}|${path}`;

export function FoldersGroup({
  folders,
  unread,
  onOpen,
}: {
  /** The mirror's `folder` entities — already flag-gated by the world layer. */
  folders: FolderEntity[];
  /** Per-folder unread, keyed `mailboxId|name` — the world's one map, no second number. */
  unread: ReadonlyMap<string, number>;
  onOpen: (folderId: string) => void;
}) {
  const t = useTheme();
  /** The opened branches, per visit — the spec's opened-set, see the header on persistence. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  /** Mailboxes in a stable order, each with its sorted tree — the reference's own grouping. */
  const byId = new Map<string, { id: string; label: string; folders: FolderEntity[] }>();
  for (const f of folders) {
    const mb = byId.get(f.mailboxId) ?? { id: f.mailboxId, label: f.mailbox, folders: [] };
    mb.folders.push(f);
    byId.set(f.mailboxId, mb);
  }
  const mailboxes = [...byId.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((mb) => ({ ...mb, tree: folderTree(mb.folders) }));

  const toggleBranch = (key: string, open: boolean) =>
    setOpened((held) => {
      const next = new Set(held);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });

  const row = (
    mb: { id: string; folders: FolderEntity[] },
    r: FolderTreeRow<FolderEntity>,
    flat: boolean,
    kids: boolean,
  ) => {
    const f = r.folder;
    const key = branchKey(mb.id, f.name);
    const shut = kids && !opened.has(key);
    const count = shut
      ? folderUnreadDeep(mb.id, f.name, unread, mb.folders)
      : (unread.get(key) ?? 0);
    const leaf = folderLeafOf(f.name);
    const parent = folderParentOf(f.name);
    return (
      <View
        key={f.id}
        style={{ flexDirection: "row", alignItems: "center", paddingLeft: r.depth * 14 }}
      >
        {kids ? (
          <Tap
            onPress={() => toggleBranch(key, shut)}
            accessibilityRole="button"
            accessibilityLabel={shut ? Copy.folderExpand(leaf) : Copy.folderCollapse(leaf)}
            style={{ paddingHorizontal: 8, paddingVertical: 12 }}
          >
            <Icon
              name="chev"
              size={12}
              color={t.c.ink3}
              style={{ transform: [{ rotate: shut ? "0deg" : "90deg" }] }}
            />
          </Tap>
        ) : (
          <View style={{ width: 28 }} />
        )}
        <TapRow
          onPress={() => onOpen(f.id)}
          accessibilityRole="link"
          accessibilityLabel={count > 0 ? `${f.name}, ${count}` : f.name}
          style={{
            flex: 1,
            paddingHorizontal: 8,
            paddingVertical: 12,
            minHeight: 46,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Icon name="folder" size={14} color={t.c.ink2} />
          <View style={{ flexDirection: "row", alignItems: "baseline", flexShrink: 1 }}>
            {flat && parent ? (
              <Txt variant="caption" tone="ink3" numberOfLines={1}>
                {parent}/
              </Txt>
            ) : null}
            <Txt variant="navLabel" numberOfLines={1}>
              {leaf}
            </Txt>
          </View>
          <View style={{ flex: 1 }} />
          {count > 0 ? (
            <Txt variant="caption" tone="ink3" tabular>
              {count}
            </Txt>
          ) : null}
        </TapRow>
      </View>
    );
  };

  return (
    <>
      <Rule inset={20} />
      <Section>{Copy.folders}</Section>
      {/* No folders discovered anywhere: the invite line, not a blank group — discovery is
          the server's; there is nothing to press. */}
      {mailboxes.length === 0 ? (
        <Txt variant="note" tone="ink3" style={{ paddingHorizontal: 20, paddingVertical: 10 }}>
          {Copy.folderEmpty}
        </Txt>
      ) : null}
      {mailboxes.map((mb) => {
        const hasKids = (path: string): boolean =>
          mb.folders.some((f) => folderParentOf(f.name) === path);
        const roots = mb.tree.filter((r) => r.depth === 0).length;
        const many = roots > FOLDER_FILTER_AT;
        const q = many ? (filter[mb.id] ?? "").trim() : "";
        const rows = visibleFolderRows(mb.tree, (p) => opened.has(branchKey(mb.id, p)), hasKids);

        let list;
        if (q) {
          // FILTER MODE: flat matches wearing their parent path.
          const hits = mb.tree.filter((r) => folderMatches(r.folder.name, q));
          list =
            hits.length === 0 ? (
              <Txt variant="note" tone="ink3" style={{ paddingHorizontal: 20, paddingVertical: 10 }}>
                {Copy.folderNoMatch}
              </Txt>
            ) : (
              hits.map((r) => row(mb, { folder: r.folder, depth: 0 }, true, false))
            );
        } else {
          // TREE MODE. Above the threshold: the first 12 roots + "Show all N…".
          const cap = many && !expanded[mb.id];
          let shown = rows;
          if (cap) {
            let seen = 0;
            const cut: FolderTreeRow<FolderEntity>[] = [];
            for (const r of rows) {
              if (r.depth === 0) {
                seen += 1;
                if (seen > FOLDER_FILTER_AT) break;
              }
              cut.push(r);
            }
            shown = cut;
          }
          list = (
            <>
              {shown.map((r) => row(mb, r, false, hasKids(r.folder.name)))}
              {cap ? (
                <TapRow
                  onPress={() => setExpanded((e) => ({ ...e, [mb.id]: true }))}
                  accessibilityRole="button"
                  accessibilityLabel={Copy.folderShowAll(roots)}
                  style={{ marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 12, minHeight: 46 }}
                >
                  <Txt variant="navLabel" tone="ink2">{Copy.folderShowAll(roots)}</Txt>
                </TapRow>
              ) : many ? (
                <TapRow
                  onPress={() => setExpanded((e) => ({ ...e, [mb.id]: false }))}
                  accessibilityRole="button"
                  accessibilityLabel={Copy.folderShowFewer}
                  style={{ marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 12, minHeight: 46 }}
                >
                  <Txt variant="navLabel" tone="ink2">{Copy.folderShowFewer}</Txt>
                </TapRow>
              ) : null}
            </>
          );
        }

        return (
          <View key={mb.id} style={{ paddingHorizontal: 8 }}>
            {mailboxes.length > 1 ? (
              <Txt variant="caption" tone="ink3" numberOfLines={1} style={{ paddingHorizontal: 12, paddingTop: 8 }}>
                {mb.label}
              </Txt>
            ) : null}
            {many ? (
              <TextInput
                value={filter[mb.id] ?? ""}
                onChangeText={(text) => setFilter((v) => ({ ...v, [mb.id]: text }))}
                placeholder={Copy.folderFilter}
                placeholderTextColor={t.c.ink3}
                accessibilityLabel={Copy.folderFilter}
                autoCapitalize="none"
                autoCorrect={false}
                style={[
                  t.type.body,
                  {
                    color: t.c.ink,
                    backgroundColor: t.c.tint2,
                    borderRadius: t.radius.pill,
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    marginHorizontal: 12,
                    marginVertical: 6,
                  },
                ]}
              />
            ) : null}
            {list}
          </View>
        );
      })}
    </>
  );
}
