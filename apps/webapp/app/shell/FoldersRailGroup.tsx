"use client";

/**
 * THE RAIL'S FOLDERS GROUP — the whole feature's rail presence (FOLDERS-SPEC.md §3/§14/§15;
 * the clickable prototype is the interaction reference and this transcribes its verified
 * behaviour into the rail's own vocabulary).
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
 * Deliberately NOT here in the foundation stage: `+ New folder`, the per-folder menu (rename /
 * move / new subfolder / add rule) — later stages per the spec's plan. The group is read-only.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { FolderEntity } from "@ohmail/client-engine";
import { Icon } from "@ohmail/ui";
import {
  FOLDER_FILTER_AT,
  folderLeafOf,
  folderMatches,
  folderParentOf,
  folderTree,
  folderUnreadDeep,
  visibleFolderRows,
  type FolderTreeRow,
} from "./folders";
import { UI_KEYS, usePersistedFlag, usePersistedIdSet } from "./persisted-ui";

const branchKey = (mailboxId: string, path: string): string => `${mailboxId}|${path}`;

export function FoldersRailGroup({
  folders,
  unread,
  mailboxCount,
  activeFolderId,
  onNavigate,
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
  activeFolderId?: string;
  onNavigate: (folderId: string) => void;
}) {
  const t = useTranslations("rail");
  const [open, setOpen] = usePersistedFlag(UI_KEYS.foldersOpen, true);
  const opened = usePersistedIdSet(UI_KEYS.foldersOpened);
  /** Transient chrome: the per-mailbox filter text and the per-mailbox "Show all" expansion. */
  const [filter, setFilter] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  /** Mailboxes in a stable order, each with its sorted tree. */
  const mailboxes = useMemo(() => {
    const byId = new Map<string, { id: string; label: string; folders: FolderEntity[] }>();
    for (const f of folders) {
      const mb = byId.get(f.mailboxId) ?? { id: f.mailboxId, label: f.mailbox, folders: [] };
      mb.folders.push(f);
      byId.set(f.mailboxId, mb);
    }
    return [...byId.values()]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((mb) => ({ ...mb, tree: folderTree(mb.folders) }));
  }, [folders]);

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

  const row = (
    mb: { id: string; folders: FolderEntity[] },
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
    return (
      <div className="frow" key={f.id} style={r.depth > 0 ? { paddingLeft: r.depth * 14 } : undefined}>
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
          className={on ? "ritem on" : "ritem"}
          title={f.name}
          aria-current={on ? "page" : undefined}
          data-rail-folder-id={f.id}
          onClick={() => onNavigate(f.id)}
        >
          <Icon name="folder" className="fglyph" />
          <span className="flabel">
            {flat && parent ? <span className="fpath">{parent}/</span> : null}
            {leaf}
          </span>
          <span className={count > 0 ? "cnt num hot" : "cnt num"}>{count > 0 ? count : ""}</span>
        </button>
      </div>
    );
  };

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
            line, not a blank group — the tags group's empty-state rule. Discovery is the
            server's; there is nothing to press. */}
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
