/**
 * THE MORE SCREEN'S FOLDERS GROUP — the webapp rail's Folders group (FoldersRailGroup.tsx is
 * the reference), in the phone's list idiom (FOLDERS-SPEC.md §14/§15, verbs §18).
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
 * ── STAGE 2 — THE VERBS (spec §18): create, rename, delete, new subfolder ──────────────────
 *
 * USER-COMMANDED REAL IMAP OPERATIONS, dispatched through the injected {@link FolderVerbs}
 * (the world layer owns the engine) and rendered in the phone's idiom — bottom sheets, never
 * an anchored menu:
 *
 *  · `+ New folder` per mailbox section — the create names WHICH mailbox by construction.
 *  · a `…` control per row → the VERB SHEET: Rename / New subfolder / Delete…. ABSENT while
 *    a command is in flight (two commands on one folder have no defined order; the server
 *    refuses them too) and on the read-only render (no `verbs` — the foundation group,
 *    byte-for-byte).
 *  · DELETE asks BEFORE the act, inside the sheet, with the SERVER-truth numbers ("N messages
 *    across M folders move to Trash") — the phone's mirror is windowed, so only
 *    `GET /folders/:id/summary` can count honestly; a failed count states the uncounted
 *    sentence rather than inventing numbers. No Undo after (there is no un-delete on the wire).
 *  · PENDING rows (`op` without `error`) render dimmed with the sentence under their leaf —
 *    optimistically-pending, never pretended-done; a rename in flight wears its TARGET leaf
 *    while `name` (every join) stays the mailbox's truth. FAILED rows carry the refusal
 *    sentence inline and an OK dismiss — the only way past a refusal is reading it.
 *  · names are validated with the SAME `folderNameError` the server runs (shared through the
 *    engine), BEFORE the wire — the honest sentence appears in the name sheet, and the
 *    server's 400 is the race, not the normal path.
 *
 * The one stated degradation against the webapp: a mailbox with ZERO folders has no section
 * to hang `+ New folder` on — the webapp grows one from its `GET /mailboxes` facts, which
 * this phone does not read. When the WHOLE account shows no folder entities and the mirror's
 * mail names exactly one mailbox, the caller passes {@link soleMailboxId} and the invite line
 * gains the create affordance; two ambiguous mailboxes wait for a mailbox read.
 */
import { useRef, useState } from "react";
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
  isFolderDescendant,
  visibleFolderRows,
  type FolderTreeRow,
} from "../state/folders";
import { folderNameError } from "../state/live";
import type { FolderEntity } from "../state/world";
import { Rule, Section, Tap, TapRow, Txt } from "./base";
import { Icon } from "./Icon";
import { CancelRow, Sheet, SheetRow } from "./Sheet";

const branchKey = (mailboxId: string, path: string): string => `${mailboxId}|${path}`;

/** The stage-2 verbs, dispatched by the world layer (the engine's mutations + the summary read). */
export interface FolderVerbs {
  /** `folder_create` — `name` is the FULL canonical path. */
  create(mailboxId: string, name: string): void;
  /** `folder_rename` — `name` is the new FULL canonical path. */
  rename(folderId: string, name: string): void;
  /** `folder_delete` — the caller has already confirmed. */
  remove(folderId: string): void;
  /** `folder_op_dismiss` — a FAILED command's refusal was read. */
  dismiss(folderId: string): void;
  /** The delete confirm's server-truth numbers; `null` when the read failed (say so, uncounted). */
  summary(folderId: string): Promise<{ folders: number; messages: number } | null>;
}

/** Which sheet is up. One at a time — a union, so two sheets cannot stack. */
type Open =
  | null
  | { kind: "menu"; folder: FolderEntity }
  | {
      kind: "confirm";
      folder: FolderEntity;
      counts: { folders: number; messages: number } | null;
      loading: boolean;
      /**
       * WHICH ask these counts answer — a cancelled confirm's slow read must not settle a
       * LATER confirm for the same folder with its stale numbers (codex round 1): each open
       * mints a generation, and a settle applies only to its own.
       */
      seq: number;
    }
  | { kind: "name"; mailboxId: string; parent: string | null; renaming: FolderEntity | null; value: string };

export function FoldersGroup({
  folders,
  unread,
  onOpen,
  verbs,
  soleMailboxId,
}: {
  /** The mirror's `folder` entities — already flag-gated by the world layer. */
  folders: FolderEntity[];
  /** Per-folder unread, keyed `mailboxId|name` — the world's one map, no second number. */
  unread: ReadonlyMap<string, number>;
  onOpen: (folderId: string) => void;
  /** Absent ⇒ the read-only foundation group, byte-for-byte (no menus, no create). */
  verbs?: FolderVerbs;
  /**
   * The account's ONE mailbox id when no folder entities exist to derive a section from —
   * what lets a fresh account create its first folder. `null` when the mirror names none or
   * several (see the header's stated degradation).
   */
  soleMailboxId?: string | null;
}) {
  const t = useTheme();
  /** The opened branches, per visit — the spec's opened-set, see the header on persistence. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** The verb chrome: which sheet is up, and the name sheet's honest problem sentence. */
  const [open, setOpen] = useState<Open>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** The delete confirm's generation mint — see the confirm variant's `seq`. */
  const confirmSeq = useRef(0);
  const close = () => {
    setOpen(null);
    setProblem(null);
  };

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

  const toggleBranch = (key: string, want: boolean) =>
    setOpened((held) => {
      const next = new Set(held);
      if (want) next.add(key);
      else next.delete(key);
      return next;
    });

  /** The pre-wire honest sentence, or null when the name may go out — the server's own rules. */
  const nameProblem = (own: readonly FolderEntity[], path: string): string | null => {
    const err = folderNameError(path);
    if (err !== null) {
      return {
        empty: Copy.folderNameEmpty,
        spaces: Copy.folderNameSpaces,
        control: Copy.folderNameChars,
        wildcard: Copy.folderNameChars,
        long: Copy.folderNameLong,
        reserved: Copy.folderNameReserved,
      }[err];
    }
    // A FAILED create's row STILL holds the name: the server retains the command row until
    // the user dismisses it, and `assertNoOpOverlap` answers 409 for any overlapping path —
    // offering the spelling here would promise a create the server deterministically refuses
    // (codex round 1). Dismissing the refusal is what frees the name.
    if (own.some((x) => x.name === path)) {
      return Copy.folderNameTaken;
    }
    return null;
  };

  /** Commit the name sheet: leaf → full path, validate, dispatch — rename or create. */
  const commitName = (sheet: Extract<Open, { kind: "name" }>) => {
    const trimmed = sheet.value.trim();
    const own = byId.get(sheet.mailboxId)?.folders ?? [];
    if (sheet.renaming !== null) {
      const f = sheet.renaming;
      const parent = folderParentOf(f.name);
      const next = parent ? `${parent}/${trimmed}` : trimmed;
      if (trimmed === "" || next === f.name) {
        close(); // nothing said — the webapp's own silent abandon
        return;
      }
      const bad = nameProblem(own, next);
      if (bad !== null) {
        setProblem(bad);
        return;
      }
      // The OPENED-set follows the new name (spec §15's guarded rewrite, the client-local
      // half): only this device can translate its own keys, for the subtree it can see.
      setOpened((held) => {
        const out = new Set(held);
        for (const x of own) {
          if (x.name === f.name || isFolderDescendant(x.name, f.name)) {
            const oldKey = branchKey(sheet.mailboxId, x.name);
            if (out.delete(oldKey)) out.add(branchKey(sheet.mailboxId, next + x.name.slice(f.name.length)));
          }
        }
        return out;
      });
      close();
      verbs?.rename(f.id, next);
      return;
    }
    if (trimmed === "") {
      close();
      return;
    }
    const next = sheet.parent ? `${sheet.parent}/${trimmed}` : trimmed;
    const bad = nameProblem(own, next);
    if (bad !== null) {
      setProblem(bad);
      return;
    }
    // A subfolder's parent opens so the pending row is visible where it will live.
    if (sheet.parent !== null) toggleBranch(branchKey(sheet.mailboxId, sheet.parent), true);
    close();
    verbs?.create(sheet.mailboxId, next);
  };

  /** The op marker's sentence — under the leaf while pending, the inline strip when failed. */
  const opSentence = (f: FolderEntity): string | null => {
    if (!f.op) return null;
    if (f.op.error !== undefined) {
      return ({
        bad_name: Copy.folderErrBadName,
        exists: Copy.folderErrExists,
        gone: Copy.folderErrGone,
        no_trash_folder: Copy.folderErrNoTrash,
      } as Record<string, string>)[f.op.error] ?? Copy.folderErrRefused;
    }
    if (f.op.kind === "create") return Copy.folderCreating;
    if (f.op.kind === "rename") return Copy.folderRenaming(folderLeafOf(f.op.to ?? f.name));
    return Copy.folderDeleting;
  };

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
    const pending = f.op !== undefined && f.op.error === undefined;
    const failed = f.op !== undefined && f.op.error !== undefined;
    const sentence = opSentence(f);
    /* A rename in flight wears its TARGET leaf — the commanded name, in the pending idiom —
       while `name` (every join) stays the mailbox's truth until the worker lands the swap. */
    const shownLeaf = pending && f.op!.kind === "rename" && f.op!.to ? folderLeafOf(f.op!.to) : leaf;
    return (
      <View key={f.id}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingLeft: r.depth * 14,
            opacity: pending ? 0.55 : 1,
          }}
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
            <View style={{ flexShrink: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                {flat && parent ? (
                  <Txt variant="caption" tone="ink3" numberOfLines={1}>
                    {parent}/
                  </Txt>
                ) : null}
                <Txt variant="navLabel" numberOfLines={1}>
                  {shownLeaf}
                </Txt>
              </View>
              {pending && sentence !== null ? (
                <Txt variant="caption" tone="ink3" numberOfLines={1}>
                  {sentence}
                </Txt>
              ) : null}
            </View>
            <View style={{ flex: 1 }} />
            {count > 0 ? (
              <Txt variant="caption" tone="ink3" tabular>
                {count}
              </Txt>
            ) : null}
          </TapRow>
          {/* The … control — stage 2's verbs. Absent while a command is in flight and on the
              read-only render, exactly the webapp's two absences. */}
          {verbs && !f.op ? (
            <Tap
              onPress={() => {
                setProblem(null);
                setOpen({ kind: "menu", folder: f });
              }}
              accessibilityRole="button"
              accessibilityLabel={Copy.folderMenuAria(leaf)}
              style={{ paddingHorizontal: 10, paddingVertical: 12 }}
            >
              <Icon name="more" size={14} color={t.c.ink3} />
            </Tap>
          ) : null}
        </View>
        {/* A FAILED command's refusal, inline with its dismiss — reading it is the way past. */}
        {failed && sentence !== null ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingLeft: 28 + r.depth * 14,
              paddingRight: 8,
              paddingBottom: 8,
            }}
          >
            <Txt variant="caption" tone="ink3" style={{ flexShrink: 1 }}>
              {sentence}
            </Txt>
            <View style={{ flex: 1 }} />
            {verbs ? (
              <Tap
                onPress={() => verbs.dismiss(f.id)}
                accessibilityRole="button"
                accessibilityLabel={Copy.folderDismiss}
                style={{ paddingHorizontal: 10, paddingVertical: 6 }}
              >
                <Txt variant="button" tone="ink2">{Copy.folderDismiss}</Txt>
              </Tap>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  };

  /** `+ New folder` — the section's own affordance, so the create names WHICH mailbox. */
  const newFolderRow = (mailboxId: string) => (
    <TapRow
      onPress={() => {
        setProblem(null);
        setOpen({ kind: "name", mailboxId, parent: null, renaming: null, value: "" });
      }}
      accessibilityRole="button"
      accessibilityLabel={Copy.folderNew}
      style={{ marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 12, minHeight: 46, flexDirection: "row", alignItems: "center", gap: 10 }}
    >
      <Icon name="plus" size={13} color={t.c.ink2} />
      <Txt variant="navLabel" tone="ink2">{Copy.folderNew}</Txt>
    </TapRow>
  );

  return (
    <>
      <Rule inset={20} />
      <Section>{Copy.folders}</Section>
      {/* No folders discovered anywhere: the invite line, not a blank group — discovery is
          the server's. With the verbs and an unambiguous mailbox, the first create stands
          beside the sentence (the answer to it, not a replacement — the webapp's own rule). */}
      {mailboxes.length === 0 ? (
        <>
          <Txt variant="note" tone="ink3" style={{ paddingHorizontal: 20, paddingVertical: 10 }}>
            {Copy.folderEmpty}
          </Txt>
          {verbs && soleMailboxId ? newFolderRow(soleMailboxId) : null}
        </>
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
            {verbs ? newFolderRow(mb.id) : null}
          </View>
        );
      })}

      {/* ── the verb sheet: Rename / New subfolder / Delete… — one folder's commands ──────── */}
      {open !== null && open.kind === "menu" ? (
        <Sheet open onClose={close} label={Copy.folderMenuAria(folderLeafOf(open.folder.name))}>
          <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
            {folderLeafOf(open.folder.name)}
          </Txt>
          <SheetRow
            icon="pen"
            label={Copy.folderRename}
            onPress={() =>
              setOpen({
                kind: "name",
                mailboxId: open.folder.mailboxId,
                parent: folderParentOf(open.folder.name),
                renaming: open.folder,
                value: folderLeafOf(open.folder.name),
              })
            }
          />
          <SheetRow
            icon="plus"
            label={Copy.folderNewSub}
            onPress={() =>
              setOpen({
                kind: "name",
                mailboxId: open.folder.mailboxId,
                parent: open.folder.name,
                renaming: null,
                value: "",
              })
            }
          />
          <SheetRow
            icon="trash"
            label={Copy.folderDelete}
            onPress={() => {
              // The ask comes BEFORE the act, with the server's own numbers — the mirror is
              // windowed and a local count would understate what the delete moves.
              const f = open.folder;
              const seq = ++confirmSeq.current;
              setOpen({ kind: "confirm", folder: f, counts: null, loading: true, seq });
              void verbs?.summary(f.id).then((counts) => {
                // Guarded on the GENERATION, not just the folder — a cancelled confirm's slow
                // read settling into a reopened one would enable Delete under stale counts.
                setOpen((held) =>
                  held !== null && held.kind === "confirm" && held.seq === seq
                    ? { kind: "confirm", folder: f, counts, loading: false, seq }
                    : held,
                );
              });
            }}
          />
          <CancelRow onPress={close} />
        </Sheet>
      ) : null}

      {/* ── the delete confirm — the stated numbers, then the one deliberate press ────────── */}
      {open !== null && open.kind === "confirm" ? (
        <Sheet open onClose={close} label={Copy.folderDelete}>
          <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
            {folderLeafOf(open.folder.name)}
          </Txt>
          <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
            {open.loading
              ? Copy.folderDeleteCounting
              : open.counts !== null
                ? Copy.folderDeleteConfirm(open.counts.messages, open.counts.folders)
                : Copy.folderDeleteConfirmUncounted}
          </Txt>
          {/* The go row appears when the count settled either way — never mid-count, the
              webapp's own disabled window, expressed as absence. */}
          {!open.loading ? (
            <SheetRow
              icon="trash"
              label={Copy.folderDeleteGo}
              onPress={() => {
                close();
                verbs?.remove(open.folder.id);
              }}
            />
          ) : null}
          <SheetRow icon="x" label={Copy.folderDeleteCancel} onPress={close} />
        </Sheet>
      ) : null}

      {/* ── the name sheet — create (root or sub) and rename share one input ──────────────── */}
      {open !== null && open.kind === "name" ? (
        <Sheet
          open
          onClose={close}
          avoidKeyboard
          label={open.renaming ? Copy.folderRename : open.parent ? Copy.folderNewSub : Copy.folderNew}
        >
          <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
            {open.renaming
              ? Copy.folderRename
              : open.parent
                ? `${Copy.folderNewSub} — ${open.parent}/`
                : Copy.folderNew}
          </Txt>
          <TextInput
            value={open.value}
            onChangeText={(text) => {
              setProblem(null);
              setOpen({ ...open, value: text });
            }}
            placeholder={open.renaming ? Copy.folderRenamePlaceholder : Copy.folderNamePlaceholder}
            placeholderTextColor={t.c.ink3}
            accessibilityLabel={open.renaming ? Copy.folderRenamePlaceholder : Copy.folderNamePlaceholder}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => commitName(open)}
            style={[
              t.type.body,
              {
                color: t.c.ink,
                backgroundColor: t.c.tint2,
                borderRadius: t.radius.pill,
                paddingHorizontal: 14,
                paddingVertical: 9,
                marginHorizontal: 14,
                marginBottom: 8,
              },
            ]}
          />
          {problem !== null ? (
            <Txt variant="caption" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
              {problem}
            </Txt>
          ) : null}
          <SheetRow
            icon="check"
            label={open.renaming ? Copy.folderRename : open.parent ? Copy.folderNewSub : Copy.folderNew}
            onPress={() => commitName(open)}
          />
          <CancelRow onPress={close} />
        </Sheet>
      ) : null}
    </>
  );
}
