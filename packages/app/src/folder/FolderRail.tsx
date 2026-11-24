/**
 * THE RAIL'S FOLDERS: the shelf (the pinned ones, the open one, the ones used last, then the tree's first; seven at
 * most) and under it the fold All folders, which opens every folder in place in the rail: never a place. A folder's
 * own menu pins it to the shelf or takes the pin off; while a row is dragged, each folder that takes it says so, and
 * the one under the pointer most. The frame mounts it as the Folders group's body; the device's record of the pins
 * and the recent ones is the seat's, handed in.
 */
import type { EngineMessage, FolderEntity } from "@ohmail/wire";
import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  folderCommandProblem,
  folderCommands,
  foldOf,
  hasManyFolderRoots,
  shelfKeyOf,
  shelfOf,
} from "@ohmail/app-logic/folder";
import {
  folderLeafOf,
  folderParentOf,
  folderUnreadCounts,
  folderUnreadDeep,
} from "@ohmail/app-logic/lists/folders";
import type { StorageScope } from "@ohmail/app-logic/storage/scope";
import { FolderFold, FolderShelf } from "@ohmail/ui/mail";
import {
  FolderRailPrompts,
  folderNameForm,
  folderRowCommands,
  type FolderCommands,
  type FolderMenu,
} from "./FolderRailPrompts.js";
import type { FolderSummaryWire } from "../host/index.js";
import { useText, type Text } from "../text/index.js";

import { useFolderBranches } from "./use-folder-branches.js";

export interface FolderRailShelf {
  /** The pinned folders by their key (`mailboxId|path`), as they were pinned. */
  readonly pinned: readonly string[];
  /** The folders used last by their key, newest first. */
  readonly recent: readonly string[];
  readonly pin: (key: string) => void;
  readonly unpin: (key: string) => void;
}

export interface FolderRailProps {
  readonly narrow?: boolean;
  readonly writable?: FolderCommands;
  readonly tapMenus?: boolean;
  /** The frame owner's branch preferences. Without a scope the branches live for the mount alone. */
  readonly scope?: StorageScope;
  /** The mirror's folders, every mailbox's. */
  readonly folders: readonly FolderEntity[];
  readonly mailboxCount?: number;
  readonly children?: ReactNode;
  /** The mirror's letters: each folder's unread count is read off them. */
  readonly messages: readonly EngineMessage[];
  readonly shelf: FolderRailShelf;
  /** The key of the folder that is open, if a folder place stands. */
  readonly open: string | null;
  /** The addressed folder id, even before its entity arrives in the mirror. */
  readonly visitId?: string | null;
  readonly go: (folder: FolderEntity) => void;
  /** A row is being dragged: which folders take it, and the one under the pointer. */
  readonly drag: { readonly over: string | null; readonly takes: (folder: FolderEntity) => boolean } | null;
}

export type NameEdit = {
  mailbox: string;
  parent: string | null;
  folder?: FolderEntity;
  value: string;
};

type DeleteAsk = {
  folder: FolderEntity;
  request: object;
  counts?: Awaited<ReturnType<FolderSummaryWire>>;
};

function useFolderEdits({
  folders,
  writable,
  branches,
  rail,
  fromShelf,
  setFind,
  setAll,
  setMenu,
}: {
  folders: readonly FolderEntity[];
  writable?: FolderCommands;
  branches: { has: (key: string) => boolean; toggle: (key: string) => void };
  rail: Text;
  fromShelf?: true;
  setFind: (value: string) => void;
  setAll: (value: boolean) => void;
  setMenu: (menu: null) => void;
}) {
  const [nameEdit, setNameEdit] = useState<NameEdit | null>(null);
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const countRequest = useRef<object | null>(null);
  const [asking, setAsking] = useState<DeleteAsk | null>(null);
  const closeAsk = () => {
    countRequest.current = null;
    setAsking(null);
  };
  const mayEdit = (id: string) => writable?.mailboxes.some((mailbox) => mailbox.id === id) === true;
  const beginName = (next: NameEdit) => {
    if (fromShelf) setFind("");
    setNameProblem(null);
    setNameEdit(next);
    setAll(true);
    setMenu(null);
  };
  const commitName = (edit: NameEdit) => {
    if (!writable || !mayEdit(edit.mailbox)) return;
    const leaf = edit.value.trim();
    const path = edit.parent === null ? leaf : `${edit.parent}/${leaf}`;
    if (leaf.length === 0 || edit.folder?.name === path) {
      setNameEdit(null);
      return;
    }
    const problem = folderCommandProblem(folders, edit.mailbox, path);
    if (problem !== null) {
      setNameProblem(rail(problem));
      return;
    }
    setNameEdit(null);
    if (edit.folder) writable.run(folderCommands.rename(edit.folder.id, path), edit.folder);
    else {
      if (edit.parent !== null && !branches.has(`${edit.mailbox}|${edit.parent}`))
        branches.toggle(`${edit.mailbox}|${edit.parent}`);
      writable.run(folderCommands.create(edit.mailbox, path));
    }
  };
  const askDelete = (folder: FolderEntity) => {
    if (!writable || !mayEdit(folder.mailboxId) || folder.op !== undefined) return;
    setMenu(null);
    const request = {};
    countRequest.current = request;
    setAsking({ folder, request });
    void Promise.resolve()
      .then(() => writable.summary(folder.id))
      .catch(() => null)
      .then((counts) => {
        if (countRequest.current === request) setAsking({ folder, request, counts });
      });
  };
  const form = (edit: NameEdit) =>
    folderNameForm({
      edit,
      rail,
      nameProblem,
      commit: () => commitName(edit),
      change: (value) => {
        setNameProblem(null);
        setNameEdit({ ...edit, value });
      },
      close: () => setNameEdit(null),
    });
  return {
    nameEdit,
    form,
    mayEdit,
    beginName,
    askDelete,
    closeAsk,
    asking,
    isCurrent: ({ request }: DeleteAsk) => countRequest.current === request,
  };
}

export type FolderRailEdits = ReturnType<typeof useFolderEdits>;

function useFolderRail(props: FolderRailProps) {
  const { folders, messages, shelf, open, visitId = open, go, drag, scope = null, writable } = props;
  const t = useText("folder");
  const rail = useText("rail");
  const [shown, setShown] = useState(true);
  const [all, setAll] = useState(false);
  const branches = useFolderBranches(scope, open, visitId);
  const [find, setFind] = useState("");
  const [menu, setMenu] = useState<FolderMenu | null>(null);
  const edits = useFolderEdits({
    folders,
    writable,
    branches,
    rail,
    fromShelf: menu?.fromShelf,
    setFind,
    setAll,
    setMenu,
  });
  const { mayEdit } = edits;
  const counts = useMemo(() => folderUnreadCounts(messages), [messages]);
  const byKey = useMemo(() => new Map(folders.map((f) => [shelfKeyOf(f), f] as const)), [folders]);
  const shelfed = shelfOf(folders, { pinned: shelf.pinned, recent: shelf.recent, open });
  const canFind = useMemo(() => hasManyFolderRoots(folders), [folders]);
  const query = canFind ? find.trim() : "";
  const groups = all ? foldOf(folders, branches, query) : [];
  if (all && query === "" && writable) {
    for (const mailbox of writable.mailboxes) {
      if (!groups.some((group) => group.mailboxId === mailbox.id))
        groups.push({ mailboxId: mailbox.id, mailbox: mailbox.label, rows: [] });
    }
  }
  const many = (props.mailboxCount ?? groups.length) > 1;

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
  const target = menu === null ? undefined : byKey.get(menu.key);
  const openMenu = (key: string, at: { x: number; y: number }, fromShelf?: true, opener?: HTMLElement) =>
    setMenu({ key, at, fromShelf, opener });
  const rowCommand = folderRowCommands({
    tapMenus: props.tapMenus,
    menu,
    t,
    rail,
    writable,
    mayEdit,
    openMenu,
  });
  return {
    t,
    rail,
    shown,
    setShown,
    all,
    setAll,
    find,
    setFind,
    menu,
    setMenu,
    edits,
    shelfed,
    canFind,
    query,
    groups,
    many,
    unread,
    said,
    dropOf,
    goTo,
    hidden,
    hiddenUnread,
    pinned,
    target,
    branches,
    openMenu,
    rowCommand,
  };
}

export function FolderRail(props: FolderRailProps) {
  const { shelf, open, writable } = props;
  const {
    t,
    rail,
    shown,
    setShown,
    all,
    setAll,
    find,
    setFind,
    menu,
    setMenu,
    edits,
    shelfed,
    canFind,
    query,
    groups,
    many,
    unread,
    said,
    dropOf,
    goTo,
    hidden,
    hiddenUnread,
    pinned,
    target,
    branches,
    openMenu,
    rowCommand,
  } = useFolderRail(props);
  const { beginName, mayEdit, nameEdit, form } = edits;
  return (
    <>
      <FolderShelf
        label={t("rail.label")}
        expanded={shown}
        onToggle={() => setShown((was) => !was)}
        folders={shelfed.map((f) => ({
          id: shelfKeyOf(f),
          ...rowCommand(f, true),
          ...said(f, unread(f, false)),
          current: shelfKeyOf(f) === open,
          drop: dropOf(f),
        }))}
        onOpen={goTo}
        onMenu={(key, at, opener) => openMenu(key, at, true, opener)}
        all={
          hidden.length > 0 || writable !== undefined
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
            narrow={props.narrow}
            label={t("rail.all")}
            find={canFind ? { label: t("rail.find"), value: find, onChange: setFind } : undefined}
            none={query === "" ? undefined : t("rail.none")}
            groups={groups.map((g) => ({
              mailbox: many ? g.mailbox : undefined,
              add:
                mayEdit(g.mailboxId) && !query
                  ? {
                      label: rail("folderNew"),
                      onPress: () => beginName({ mailbox: g.mailboxId, parent: null, value: "" }),
                    }
                  : undefined,
              form: writable && nameEdit?.mailbox === g.mailboxId ? form(nameEdit) : undefined,
              folders: g.rows.map((row) => {
                const key = shelfKeyOf(row.folder);
                const name = folderLeafOf(row.folder.name);
                const isOpen = branches.has(key);
                const parent = query ? folderParentOf(row.folder.name) : null;
                const hint = parent?.split("/").join(" › ");
                const unreadWords = said(row.folder, unread(row.folder, row.branch && !isOpen));
                return {
                  id: key,
                  ...rowCommand(row.folder),
                  depth: row.depth,
                  ...unreadWords,
                  hint,
                  label: hint && unreadWords.label ? `${unreadWords.label}, ${hint}` : unreadWords.label,
                  current: key === open,
                  drop: dropOf(row.folder),
                  branch: row.branch
                    ? { expanded: isOpen, label: t(isOpen ? "rail.collapse" : "rail.expand", { name }) }
                    : undefined,
                };
              }),
            }))}
            onOpen={goTo}
            onBranch={branches.toggle}
            onMenu={(key, at, opener) => openMenu(key, at, undefined, opener)}
          />
        ) : null}
        {props.children}
      </FolderShelf>
      <FolderRailPrompts
        menu={menu}
        target={target}
        pinned={pinned}
        shelf={shelf}
        t={t}
        rail={rail}
        dismiss={() => setMenu(null)}
        edits={edits}
        writable={writable}
        onOpen={goTo}
      />
    </>
  );
}
