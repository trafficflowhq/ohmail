/**
 * THE RAIL'S FOLDERS: the shelf (the pinned ones, the open one, the ones used last, then the tree's first; seven at
 * most) and under it the fold All folders, which opens every folder in place in the rail: never a place. A folder's
 * own menu pins it to the shelf or takes the pin off; while a row is dragged, each folder that takes it says so, and
 * the one under the pointer most. The frame mounts it as the Folders group's body; the device's record of the pins
 * and the recent ones is the seat's, handed in.
 */
import type { EngineMessage, FolderEntity } from "@ohmail/wire";
import { useMemo, useState } from "react";
import { FIND_FROM, foldOf, shelfKeyOf, shelfOf } from "@ohmail/app-logic/folder";
import { folderLeafOf, folderUnreadCounts, folderUnreadDeep } from "@ohmail/app-logic/lists/folders";
import { Menu, MenuItem } from "@ohmail/ui/base";
import { FolderFold, FolderShelf } from "@ohmail/ui/mail";
import { useText } from "../text/index.js";

export interface FolderRailShelf {
  /** The pinned folders by their key (`mailboxId|path`), as they were pinned. */
  readonly pinned: readonly string[];
  /** The folders used last by their key, newest first. */
  readonly recent: readonly string[];
  readonly pin: (key: string) => void;
  readonly unpin: (key: string) => void;
}

export interface FolderRailProps {
  /** The mirror's folders, every mailbox's. */
  readonly folders: readonly FolderEntity[];
  /** The mirror's letters: each folder's unread count is read off them. */
  readonly messages: readonly EngineMessage[];
  readonly shelf: FolderRailShelf;
  /** The key of the folder that is open, if a folder place stands. */
  readonly open: string | null;
  readonly go: (folder: FolderEntity) => void;
  /** A row is being dragged: which folders take it, and the one under the pointer. */
  readonly drag: { readonly over: string | null; readonly takes: (folder: FolderEntity) => boolean } | null;
}

export function FolderRail({ folders, messages, shelf, open, go, drag }: FolderRailProps) {
  const t = useText("folder");
  const [shown, setShown] = useState(true);
  const [all, setAll] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [find, setFind] = useState("");
  const [menu, setMenu] = useState<{ key: string; at: { x: number; y: number } } | null>(null);
  const counts = useMemo(() => folderUnreadCounts(messages), [messages]);
  const byKey = useMemo(() => new Map(folders.map((f) => [shelfKeyOf(f), f] as const)), [folders]);
  const shelfed = shelfOf(folders, { pinned: shelf.pinned, recent: shelf.recent, open });
  const groups = all ? foldOf(folders, opened, find) : [];
  const many = groups.length > 1;

  const unread = (f: FolderEntity, deep: boolean): number =>
    deep ? folderUnreadDeep(f.mailboxId, f.name, counts, folders) : (counts.get(shelfKeyOf(f)) ?? 0);
  const said = (f: FolderEntity, n: number) => {
    const name = folderLeafOf(f.name);
    return n > 0 ? { count: String(n), label: t("rail.unread", { name, count: n }) } : {};
  };
  const dropOf = (f: FolderEntity): "ready" | "over" | undefined =>
    drag === null || !drag.takes(f) ? undefined : drag.over === shelfKeyOf(f) ? "over" : "ready";
  const goTo = (key: string): void => {
    const folder = byKey.get(key);
    if (folder !== undefined) go(folder);
  };
  const hidden = folders.filter((f) => !shelfed.includes(f));
  const hiddenUnread = hidden.reduce((n, f) => n + unread(f, false), 0);
  const pinned = menu !== null && shelf.pinned.includes(menu.key);

  return (
    <>
      <FolderShelf
        label={t("rail.label")}
        expanded={shown}
        onToggle={() => setShown((was) => !was)}
        folders={shelfed.map((f) => ({
          id: shelfKeyOf(f),
          name: folderLeafOf(f.name),
          ...said(f, unread(f, false)),
          current: shelfKeyOf(f) === open,
          drop: dropOf(f),
        }))}
        onOpen={goTo}
        onMenu={(key, at) => setMenu({ key, at })}
        all={
          hidden.length > 0
            ? {
                name: t("rail.all"),
                label:
                  all || hiddenUnread === 0 ? t("rail.all") : t("rail.allUnread", { count: hiddenUnread }),
                count: !all && hiddenUnread > 0 ? String(hiddenUnread) : undefined,
                expanded: all,
                onToggle: () => setAll((was) => !was),
              }
            : undefined
        }
      >
        {all ? (
          <FolderFold
            label={t("rail.all")}
            find={
              folders.length > FIND_FROM
                ? { label: t("rail.find"), value: find, onChange: setFind }
                : undefined
            }
            none={t("rail.none")}
            groups={groups.map((g) => ({
              mailbox: many ? g.mailbox : undefined,
              folders: g.rows.map((row) => {
                const key = shelfKeyOf(row.folder);
                const name = folderLeafOf(row.folder.name);
                const isOpen = opened.has(key);
                return {
                  id: key,
                  name,
                  depth: row.depth,
                  ...said(row.folder, unread(row.folder, row.branch && !isOpen)),
                  current: key === open,
                  drop: dropOf(row.folder),
                  branch: row.branch
                    ? { expanded: isOpen, label: t(isOpen ? "rail.collapse" : "rail.expand", { name }) }
                    : undefined,
                };
              }),
            }))}
            onOpen={goTo}
            onBranch={(key) =>
              setOpened((was) => {
                const next = new Set(was);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            onMenu={(key, at) => setMenu({ key, at })}
          />
        ) : null}
      </FolderShelf>
      <Menu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchor={menu?.at}
        kind="context"
        label={menu === null ? "" : t("rail.menu", { name: folderLeafOf(byKey.get(menu.key)?.name ?? "") })}
      >
        <MenuItem
          icon="pin"
          onPress={() => {
            if (menu === null) return;
            setMenu(null);
            if (pinned) shelf.unpin(menu.key);
            else shelf.pin(menu.key);
          }}
        >
          {pinned ? t("rail.unpin") : t("rail.pin")}
        </MenuItem>
      </Menu>
    </>
  );
}
