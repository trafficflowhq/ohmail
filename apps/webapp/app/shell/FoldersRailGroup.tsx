"use client";

/**
 * THE RAIL'S FOLDERS GROUP — the whole feature's rail presence (FOLDERS-SPEC.md §3/§14/§15 and
 * stage 2; the clickable prototype is the interaction reference and this transcribes its
 * verified behaviour into the rail's own vocabulary).
 *
 * Rendered ONLY while "Use folders" is on — the caller withholds the node entirely otherwise,
 * so a flag-off rail is byte-identical to the pre-feature rail (spec §10, guarded by test).
 *
 * What it renders, per mailbox (a small address label above each tree when 2+ mailboxes exist;
 * one mailbox ⇒ no labels at all):
 *
 *  · the folder TREE, first level only by default — a branch with children starts closed and
 *    opens when the user opens it; the state is an OPENED-set persisted per device
 *    (`UI_KEYS.foldersOpened`), so the default needs no seeding and an opened branch survives
 *    a reload. Navigating to a folder opens its ancestors, so a row reached through the filter
 *    is visible in the tree once the filter clears.
 *  · unread badges, with ROLL-UP on a collapsed parent: own + hidden descendants, in the same
 *    badge idiom — collapsing must never hide unread truth. Expanded, every folder shows its
 *    own count again.
 *  · the MANY-FOLDERS treatment above {@link FOLDER_FILTER_AT} roots: a type-to-filter line in
 *    the rail's own inline-input idiom, the first 12 roots + a "Show all N…" expander, and the
 *    expanded list scrolling in its OWN bounded region — the piles, tags, Settings and the
 *    dock never leave reach. Filtered matches render flat wearing their parent path.
 *
 * ── STAGE 2 — THE VERBS (owner-ordered): create, rename, delete, new subfolder ─────────────
 *
 * These are USER-COMMANDED REAL IMAP OPERATIONS in the user's own mailbox; the group only
 * DISPATCHES them (the injected {@link FolderVerbs} — the shell owns the engine) and renders
 * the honest middle:
 *
 *  · `+ New folder` per mailbox section — the create names WHICH mailbox by construction: it
 *    is the section's own affordance (spec §14's per-mailbox "New folder"). The inline-input
 *    idiom is the filter line's own.
 *  · a `…` menu per row (hover/focus-revealed): Rename (inline, in place), New subfolder
 *    (inline, under the parent, which opens), Delete.
 *  · DELETE asks BEFORE the act, inside the menu surface, with the SERVER-truth numbers
 *    ("N messages across M folders move to Trash") — the client mirror is windowed, so only
 *    `GET /folders/:id/summary` can count honestly. The message-delete confirm strip's
 *    ceremony: there is no un-delete on the wire, so the ask precedes the act and no Undo is
 *    offered after it.
 *  · PENDING rows (`op` without `error`) render dimmed with the sentence in their title —
 *    optimistically-pending, never pretended-done; the wake channel settles them in seconds.
 *    FAILED rows (`op.error`) carry the refusal sentence inline and a dismiss — the only way
 *    past a refusal is reading it.
 *  · names are validated with the SAME `folderNameError` the server runs, BEFORE the wire —
 *    the honest sentence appears under the input, and the server's 400 is the race, not the
 *    normal path.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { folderNameError } from "@trafficflow/core/folder-name";
import type { FolderEntity } from "@ohmail/client-engine";
import { Icon } from "@ohmail/ui";
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
} from "./folders";
import { UI_KEYS, usePersistedFlag, usePersistedIdSet } from "./persisted-ui";

const branchKey = (mailboxId: string, path: string): string => `${mailboxId}|${path}`;

/** The stage-2 verbs, dispatched by the shell (the engine's mutations + the summary read). */
export interface FolderVerbs {
  /** `folder_create` — `name` is the FULL canonical path. Resolves once the wire answered. */
  create: (mailboxId: string, name: string) => Promise<void>;
  /** `folder_rename` — `name` is the new FULL canonical path. */
  rename: (folderId: string, name: string) => Promise<void>;
  /** `folder_delete` — the caller has already confirmed. */
  remove: (folderId: string) => Promise<void>;
  /** `folder_op_dismiss` — a FAILED command's refusal was read. */
  dismiss: (folderId: string) => void;
  /** The delete confirm's server-truth numbers; null when the read failed (say so, generically). */
  summary: (folderId: string) => Promise<{ folders: number; messages: number } | null>;
}

/** The delete confirm's state, rendered inside the menu surface. */
type ConfirmState = { counts: { folders: number; messages: number } | null; loading: boolean };

export function FoldersRailGroup({
  folders,
  unread,
  mailboxCount,
  accountMailboxes,
  activeFolderId,
  onNavigate,
  verbs,
  settled = true,
}: {
  /** The mirror's `folder` entities — already post-exclusion, already flag-gated. */
  folders: FolderEntity[];
  /**
   * CAN AN EMPTY LIST BE BELIEVED — the group's third render. With "Use folders" on and zero
   * entities, two different sentences are true at different times: "no folders on your mail
   * server yet" (a settled mirror that heard the inventory) and "the inventory has not arrived"
   * (a first drain still running, or a consent answer still cache-painted). The caller passes
   * `consent.known && !bootstrapping`; while false, an empty group renders SKELETON rows rather
   * than the empty line — the same rule the reach-past probe follows one file over: an empty
   * mirror is a question, not an answer. Defaults true so a host with no sync posture (tests,
   * the demo) keeps the settled behaviour.
   */
  settled?: boolean;
  /** Per-folder unread, keyed `mailboxId|path` — `folderUnreadCounts` over the projected mirror. */
  unread: ReadonlyMap<string, number>;
  /**
   * How many mailboxes the ACCOUNT has — the sectioning rule's real subject (spec §14: "with
   * more than one mailbox on the account"). Deliberately not derived from `folders` alone: two
   * connected mailboxes where only one currently has user folders must still wear the address
   * label, or the lone tree is ambiguous about whose it is. Absent (demo, a host with no
   * probe) falls back to what the entities themselves show.
   */
  mailboxCount?: number;
  /**
   * The account's PARTICIPATING mailboxes (id + address) — what lets a mailbox with ZERO
   * folders still offer `+ New folder`: a section derived from entities alone cannot exist
   * before the first folder does. Absent (demo, tests without verbs) ⇒ sections come from the
   * entities, exactly the foundation behaviour.
   */
  accountMailboxes?: Array<{ id: string; label: string }>;
  activeFolderId?: string;
  onNavigate: (folderId: string) => void;
  /** Absent ⇒ the read-only foundation group, byte-for-byte (no menus, no create). */
  verbs?: FolderVerbs;
}) {
  const t = useTranslations("rail");
  const [open, setOpen] = usePersistedFlag(UI_KEYS.foldersOpen, true);
  const opened = usePersistedIdSet(UI_KEYS.foldersOpened);
  /** Transient chrome: the per-mailbox filter text and the per-mailbox "Show all" expansion. */
  const [filter, setFilter] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** The … menu: which folder, plus the delete confirm once Delete was pressed. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  /** Inline inputs: rename-in-place, new-subfolder-under, new-root-folder-per-mailbox. */
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [subFor, setSubFor] = useState<{ id: string; value: string } | null>(null);
  const [creating, setCreating] = useState<{ mailboxId: string; value: string } | null>(null);
  /** The honest sentence under whichever input is active; cleared on every keystroke. */
  const [problem, setProblem] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /** Mailboxes in a stable order, each with its sorted tree — entity-derived, then the
   *  account's own list merged in so a mailbox with zero folders still has a section (its
   *  `+ New folder` is the only way it ever gets one). */
  const mailboxes = useMemo(() => {
    const byId = new Map<string, { id: string; label: string; folders: FolderEntity[] }>();
    for (const f of folders) {
      const mb = byId.get(f.mailboxId) ?? { id: f.mailboxId, label: f.mailbox, folders: [] };
      mb.folders.push(f);
      byId.set(f.mailboxId, mb);
    }
    // Only a SETTLED mirror grows sections from the account list: while the inventory may
    // simply not have arrived, the skeleton is the honest render — a create affordance over a
    // question would invite naming a folder the drain may be about to show.
    if (verbs && accountMailboxes && settled) {
      for (const mb of accountMailboxes) {
        if (!byId.has(mb.id)) byId.set(mb.id, { id: mb.id, label: mb.label, folders: [] });
      }
    }
    return [...byId.values()]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((mb) => ({ ...mb, tree: folderTree(mb.folders) }));
  }, [folders, verbs, accountMailboxes, settled]);

  const active = activeFolderId ? folders.find((f) => f.id === activeFolderId) : undefined;

  /**
   * NAVIGATION REVEALS — opening a folder opens its ancestors (spec §15), so a folder reached
   * through the filter, a deep link or the History lens is visible in the tree afterwards. An
   * effect keyed on the active folder: the user's own act, applied once per arrival.
   */
  useEffect(() => {
    if (!active) return;
    let parent = folderParentOf(active.name);
    while (parent !== null) {
      const key = branchKey(active.mailboxId, parent);
      if (!opened.has(key)) opened.set(key, true);
      parent = folderParentOf(parent);
    }
    // `opened.has` reads component state; re-running on its identity would loop the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  /** The menu dismisses on any press outside it — the MoreMenu's own mousedown rule. */
  useEffect(() => {
    if (menuFor === null) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuFor(null);
        setConfirm(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuFor]);

  /**
   * A key an open menu handles is the menu's, and nothing else's — Escape here must not also
   * close the reader sheet underneath (the MoreMenu measurement). A NATIVE listener on the
   * menu node runs before every document-level listener and stops the event whole.
   */
  useEffect(() => {
    const el = menuRef.current;
    if (!el || menuFor === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
        setMenuFor(null);
        setConfirm(null);
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [menuFor]);

  /** The pre-wire honest sentence, or null when the name may go out — the server's own rules. */
  const nameProblem = (mb: { folders: FolderEntity[] }, path: string): string | null => {
    const err = folderNameError(path);
    if (err !== null) {
      const key = ({
        empty: "folderNameEmpty", spaces: "folderNameSpaces", control: "folderNameChars",
        wildcard: "folderNameChars", long: "folderNameLong", reserved: "folderNameReserved",
      } as const)[err];
      return t(key);
    }
    if (mb.folders.some((x) => x.name === path && !(x.op?.kind === "create" && x.op.error !== undefined))) {
      return t("folderNameTaken");
    }
    return null;
  };

  /** Commit the rename input: leaf → full path, validate, swap the opened keys, dispatch. */
  const commitRename = (mb: { id: string; folders: FolderEntity[] }, f: FolderEntity, leaf: string) => {
    const trimmed = leaf.trim();
    const parent = folderParentOf(f.name);
    const next = parent ? `${parent}/${trimmed}` : trimmed;
    if (trimmed === "" || next === f.name) {
      setRenaming(null);
      setProblem(null);
      return;
    }
    const bad = nameProblem(mb, next);
    if (bad !== null) {
      setProblem(bad);
      return;
    }
    // The OPENED-set follows the new name (spec §15's guarded rewrite, the client-local half):
    // only this device can translate its own keys, and only for paths it can enumerate — the
    // subtree it is looking at.
    for (const x of mb.folders) {
      if (x.name === f.name || isFolderDescendant(x.name, f.name)) {
        const oldKey = branchKey(mb.id, x.name);
        if (opened.has(oldKey)) {
          opened.set(oldKey, false);
          opened.set(branchKey(mb.id, next + x.name.slice(f.name.length)), true);
        }
      }
    }
    setRenaming(null);
    setProblem(null);
    void verbs?.rename(f.id, next);
  };

  /** Commit a create input (root or subfolder): validate the full path, open the parent, go. */
  const commitCreate = (mb: { id: string; folders: FolderEntity[] }, parent: string | null, leaf: string) => {
    const trimmed = leaf.trim();
    if (trimmed === "") {
      setCreating(null);
      setSubFor(null);
      setProblem(null);
      return;
    }
    const next = parent ? `${parent}/${trimmed}` : trimmed;
    const bad = nameProblem(mb, next);
    if (bad !== null) {
      setProblem(bad);
      return;
    }
    if (parent !== null) opened.set(branchKey(mb.id, parent), true);
    setCreating(null);
    setSubFor(null);
    setProblem(null);
    void verbs?.create(mb.id, next);
  };

  /** One inline-input line in the rail's own idiom — the filter line's chrome, a pen's job. */
  const inputRow = (opts: {
    key: string;
    depth: number;
    label: string;
    value: string;
    onChange: (v: string) => void;
    onCommit: () => void;
    onCancel: () => void;
  }) => (
    <div key={opts.key}>
      <div className="frow" style={opts.depth > 0 ? { paddingLeft: opts.depth * 14 } : undefined}>
        <span className="ftw" />
        <div className="ritem ritem-new" style={{ flex: "1 1 auto" }}>
          <Icon name="folder" className="fglyph" />
          <input
            className="ritem-new-input"
            /* eslint-disable-next-line jsx-a11y/no-autofocus -- the input replaced the control
               the user just pressed; NOT focusing it is the disorienting branch. */
            autoFocus
            placeholder={opts.label}
            aria-label={opts.label}
            value={opts.value}
            onChange={(e) => {
              setProblem(null);
              opts.onChange(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                opts.onCommit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                opts.onCancel();
              }
            }}
            onBlur={() => {
              // A press elsewhere abandons the input; Enter is the only commit. The menu's
              // own rule: nothing writes to a mailbox because focus wandered.
              opts.onCancel();
            }}
          />
        </div>
      </div>
      {problem !== null ? <p className="fproblem" role="alert">{problem}</p> : null}
    </div>
  );

  /** The op marker's sentence — the row's title while pending, the inline strip when failed. */
  const opSentence = (f: FolderEntity): string | null => {
    if (!f.op) return null;
    if (f.op.error !== undefined) {
      const key = ({
        bad_name: "folderErrBadName", exists: "folderErrExists", gone: "folderErrGone",
        no_trash_folder: "folderErrNoTrash",
      } as Record<string, string>)[f.op.error] ?? "folderErrRefused";
      return t(key);
    }
    if (f.op.kind === "create") return t("folderCreating");
    if (f.op.kind === "rename") return t("folderRenaming", { name: folderLeafOf(f.op.to ?? f.name) });
    return t("folderDeleting");
  };

  const row = (
    mb: { id: string; label: string; folders: FolderEntity[] },
    r: FolderTreeRow,
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
    const on = f.id === activeFolderId;
    const pending = f.op !== undefined && f.op.error === undefined;
    const failed = f.op !== undefined && f.op.error !== undefined;
    const sentence = opSentence(f);
    /* A rename in flight wears its TARGET leaf — the commanded name, in the pending idiom —
       while `name` (every join) stays the mailbox's truth until the worker lands the swap. */
    const shownLeaf = pending && f.op!.kind === "rename" && f.op!.to ? folderLeafOf(f.op!.to) : leaf;

    if (renaming?.id === f.id) {
      return inputRow({
        key: f.id,
        depth: r.depth,
        label: t("folderRenamePlaceholder"),
        value: renaming.value,
        onChange: (v) => setRenaming({ id: f.id, value: v }),
        onCommit: () => commitRename(mb, f, renaming.value),
        onCancel: () => {
          setRenaming(null);
          setProblem(null);
        },
      });
    }

    return (
      <div key={f.id}>
        <div
          className={menuFor === f.id ? "frow menu-on" : "frow"}
          style={r.depth > 0 ? { paddingLeft: r.depth * 14 } : undefined}
        >
          {kids ? (
            <button
              type="button"
              className={shut ? "ftw" : "ftw open"}
              aria-expanded={!shut}
              aria-label={t(shut ? "folderExpand" : "folderCollapse", { name: leaf })}
              onClick={() => opened.set(key, shut)}
            >
              <Icon name="chev" className="chev" />
            </button>
          ) : (
            <span className="ftw" />
          )}
          <button
            type="button"
            className={`ritem${on ? " on" : ""}${pending ? " fpend" : ""}${failed ? " ffail" : ""}`}
            title={sentence ?? f.name}
            aria-current={on ? "page" : undefined}
            data-rail-folder-id={f.id}
            onClick={() => onNavigate(f.id)}
          >
            <Icon name="folder" className="fglyph" />
            <span className="flabel">
              {flat && parent ? <span className="fpath">{parent}/</span> : null}
              {shownLeaf}
            </span>
            <span className={count > 0 ? "cnt num hot" : "cnt num"}>{count > 0 ? count : ""}</span>
          </button>
          {/* The … menu — stage 2's verbs. Absent while a command is in flight (two commands
              on one folder have no defined order; the server refuses them too) and on the
              read-only foundation render (no `verbs`). */}
          {verbs && !f.op ? (
            <button
              type="button"
              className="fmore"
              aria-haspopup="menu"
              aria-expanded={menuFor === f.id}
              aria-label={t("folderMenuAria", { name: leaf })}
              title={t("folderMenuAria", { name: leaf })}
              onClick={() => {
                setConfirm(null);
                setMenuFor(menuFor === f.id ? null : f.id);
              }}
            >
              …
            </button>
          ) : null}
          {menuFor === f.id ? menu(mb, f) : null}
        </div>
        {failed && sentence !== null ? (
          <div className="fproblem" role="alert">
            {sentence}
            <button type="button" className="fdismiss" onClick={() => verbs?.dismiss(f.id)}>
              {t("folderDismiss")}
            </button>
          </div>
        ) : null}
        {subFor?.id === f.id
          ? inputRow({
              key: `${f.id}-sub`,
              depth: r.depth + 1,
              label: t("folderNamePlaceholder"),
              value: subFor.value,
              onChange: (v) => setSubFor({ id: f.id, value: v }),
              onCommit: () => commitCreate(mb, f.name, subFor.value),
              onCancel: () => {
                setSubFor(null);
                setProblem(null);
              },
            })
          : null}
      </div>
    );
  };

  /** The … menu, anchored in the row; Delete swaps it for the ask-first confirm. */
  const menu = (mb: { id: string; label: string; folders: FolderEntity[] }, f: FolderEntity) => (
    <div ref={menuRef} className="scn-act-menu fmenu" role="menu" aria-label={t("folderMenuAria", { name: folderLeafOf(f.name) })}>
      {confirm === null ? (
        <>
          <button
            type="button"
            role="menuitem"
            className="scn-act-dest"
            onClick={() => {
              setMenuFor(null);
              setProblem(null);
              setRenaming({ id: f.id, value: folderLeafOf(f.name) });
            }}
          >
            {t("folderRename")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="scn-act-dest"
            onClick={() => {
              setMenuFor(null);
              setProblem(null);
              setCreating(null);
              setSubFor({ id: f.id, value: "" });
            }}
          >
            {t("folderNewSub")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="scn-act-dest fdanger"
            onClick={() => {
              // The ask comes BEFORE the act, with the server's own numbers — the mirror is
              // windowed and a local count would understate what the delete moves.
              setConfirm({ counts: null, loading: true });
              void verbs!.summary(f.id).then((counts) => {
                setConfirm({ counts, loading: false });
              });
            }}
          >
            {t("folderDelete")}
          </button>
        </>
      ) : (
        <>
          <div className="fconfirm" role="alert">
            {confirm.loading
              ? t("folderDeleteCounting")
              : confirm.counts !== null
                ? t("folderDeleteConfirm", { messages: confirm.counts.messages, folders: confirm.counts.folders })
                : t("folderDeleteConfirmUncounted")}
          </div>
          <button
            type="button"
            role="menuitem"
            className="scn-act-dest fdanger"
            disabled={confirm.loading}
            onClick={() => {
              setMenuFor(null);
              setConfirm(null);
              void verbs!.remove(f.id);
            }}
          >
            {t("folderDeleteGo")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="scn-act-dest"
            onClick={() => {
              setMenuFor(null);
              setConfirm(null);
            }}
          >
            {t("folderDeleteCancel")}
          </button>
        </>
      )}
    </div>
  );

  return (
    <div className={open ? "rgroup rsub" : "rgroup rsub closed"}>
      <button
        type="button"
        className="rlabel-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="chev" className="chev" />
        {t("folders")}
      </button>
      <div className="rgroup-body">
        {/* No folders discovered anywhere: while the mirror is UNSETTLED, skeleton rows (the
            inventory may simply not have arrived — see `settled`); once settled, the invite
            line, not a blank group — the tags group's empty-state rule. */}
        {mailboxes.length === 0 && !settled ? (
          <div className="fskel" aria-hidden="true" data-testid="folders-skeleton">
            {/* `boot-sk-bar` is the boot skeleton's own idiom — a breath, not a shimmer — so
                the rail's not-yet reads exactly like the deck's. */}
            {[0, 1, 2].map((i) => (
              <div className="frow" key={i}>
                <span className="ftw" />
                <span className="ritem">
                  <Icon name="folder" className="fglyph" />
                  <span className="flabel boot-sk-bar" style={{ width: `${72 - i * 14}%` }} />
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {mailboxes.length === 0 && settled ? <p className="rsub-empty">{t("folderEmpty")}</p> : null}
        {mailboxes.map((mb) => {
          const hasKids = (path: string): boolean =>
            mb.folders.some((f) => folderParentOf(f.name) === path);
          const roots = mb.tree.filter((r) => r.depth === 0).length;
          const many = roots > FOLDER_FILTER_AT;
          const q = many ? (filter[mb.id] ?? "").trim() : "";
          const rows = visibleFolderRows(mb.tree, (p) => opened.has(branchKey(mb.id, p)), hasKids);

          let list;
          if (q) {
            // FILTER MODE: flat matches wearing their parent path, in their own bounded scroller.
            const hits = mb.tree.filter((r) => folderMatches(r.folder.name, q));
            list = hits.length === 0 ? (
              <p className="rsub-empty">{t("folderNoMatch")}</p>
            ) : (
              <div className="fscroll">
                {hits.map((r) => row(mb, { folder: r.folder, depth: 0 }, true, false))}
              </div>
            );
          } else {
            // TREE MODE. Above the threshold: the first 12 roots + "Show all N…"; expanded, the
            // whole list scrolls in its own region so the rest of the rail stays in reach.
            const cap = many && !expanded[mb.id];
            let shown = rows;
            if (cap) {
              let seen = 0;
              const cut: FolderTreeRow[] = [];
              for (const r of rows) {
                if (r.depth === 0) {
                  seen += 1;
                  if (seen > FOLDER_FILTER_AT) break;
                }
                cut.push(r);
              }
              shown = cut;
            }
            const tree = shown.map((r) => row(mb, r, false, hasKids(r.folder.name)));
            list = (
              <>
                {many && !cap ? <div className="fscroll">{tree}</div> : tree}
                {cap ? (
                  <button
                    type="button"
                    className="ritem ritem-action"
                    onClick={() => setExpanded((e) => ({ ...e, [mb.id]: true }))}
                  >
                    <span>{t("folderShowAll", { count: roots })}</span>
                  </button>
                ) : many ? (
                  <button
                    type="button"
                    className="ritem ritem-action"
                    onClick={() => setExpanded((e) => ({ ...e, [mb.id]: false }))}
                  >
                    <span>{t("folderShowFewer")}</span>
                  </button>
                ) : null}
              </>
            );
          }

          return (
            <div key={mb.id}>
              {(mailboxCount ?? mailboxes.length) > 1 ? (
                <div className="rmblab" title={mb.label}>{mb.label}</div>
              ) : null}
              {/* Settled and empty still SAYS so — the create affordance below is the answer
                  to the sentence, not a replacement for it. */}
              {mb.tree.length === 0 ? <p className="rsub-empty">{t("folderEmpty")}</p> : null}
              {many ? (
                <div className="frow">
                  <span className="ftw" />
                  <div className="ritem ritem-new" style={{ flex: "1 1 auto" }}>
                    <Icon name="search" className="fglyph" />
                    <input
                      className="ritem-new-input"
                      placeholder={t("folderFilter")}
                      aria-label={t("folderFilter")}
                      value={filter[mb.id] ?? ""}
                      onChange={(e) => setFilter((v) => ({ ...v, [mb.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        // Escape clears the filter and stays here — the innermost open thing.
                        if (e.key === "Escape" && (filter[mb.id] ?? "") !== "") {
                          e.preventDefault();
                          e.stopPropagation();
                          setFilter((v) => ({ ...v, [mb.id]: "" }));
                        }
                      }}
                    />
                  </div>
                </div>
              ) : null}
              {list}
              {/* `+ New folder` — the section's own affordance, so the create names WHICH
                  mailbox by construction (spec §14). Swaps for the inline input in place. */}
              {verbs ? (
                creating !== null && creating.mailboxId === mb.id
                  ? inputRow({
                      key: `${mb.id}-new`,
                      depth: 0,
                      label: t("folderNamePlaceholder"),
                      value: creating.value,
                      onChange: (v) => setCreating({ mailboxId: mb.id, value: v }),
                      onCommit: () => commitCreate(mb, null, creating.value),
                      onCancel: () => {
                        setCreating(null);
                        setProblem(null);
                      },
                    })
                  : (
                    <button
                      type="button"
                      className="ritem ritem-action"
                      data-testid={`folder-new-${mb.id}`}
                      onClick={() => {
                        setProblem(null);
                        setSubFor(null);
                        setCreating({ mailboxId: mb.id, value: "" });
                      }}
                    >
                      <Icon name="plus" className="ritem-plus" />
                      <span>{t("folderNew")}</span>
                    </button>
                  )
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
