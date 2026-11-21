import { folderCommandWord } from "./command-words.js";
import { shelfKeyOf } from "@ohmail/app-logic/folder";
import type { FolderAct, FolderEntity } from "@ohmail/wire";
import { folderCommands } from "@ohmail/app-logic/folder";
import { folderLeafOf, folderParentOf } from "@ohmail/app-logic/lists/folders";
import { Button, Dialog, Menu, MenuItem, RefusalLine } from "@ohmail/ui/base";
import { cssRect, TextField } from "@ohmail/ui";
import type { FolderSummaryWire } from "../host/index.js";
import type { Text } from "../text/index.js";
import type { FolderRailShelf, FolderRailEdits, NameEdit } from "./FolderRail.js";

export interface FolderCommands {
  readonly mailboxes: readonly { id: string; label: string }[];
  readonly summary: FolderSummaryWire;
  readonly run: (act: FolderAct, target?: FolderEntity) => void;
}

export interface FolderMenu {
  key: string;
  at: { x: number; y: number };
  fromShelf?: true;
}

export function FolderRailPrompts({
  menu,
  target,
  pinned,
  shelf,
  t,
  rail,
  dismiss,
  edits,
  writable,
}: {
  menu: FolderMenu | null;
  target: FolderEntity | undefined;
  pinned: boolean;
  shelf: FolderRailShelf;
  t: Text;
  rail: Text;
  dismiss: () => void;
  edits: FolderRailEdits;
  writable?: FolderCommands;
}) {
  const { mayEdit, beginName, askDelete, closeAsk, asking, isCurrent } = edits;
  return (
    <>
      <Menu
        open={menu !== null}
        onClose={() => dismiss()}
        anchor={menu?.at}
        kind="context"
        label={menu === null ? "" : t("rail.menu", { name: folderLeafOf(target?.name ?? "") })}
      >
        <MenuItem
          icon="pin"
          onPress={() => {
            if (menu === null) return;
            dismiss();
            if (pinned) shelf.unpin(menu.key);
            else shelf.pin(menu.key);
          }}
        >
          {pinned ? t("rail.unpin") : t("rail.pin")}
        </MenuItem>
        {target && mayEdit(target.mailboxId) && target.op === undefined ? (
          <>
            <MenuItem
              icon="plus"
              onPress={() =>
                beginName({
                  mailbox: target.mailboxId,
                  parent: target.name,
                  value: "",
                })
              }
            >
              {rail("folderNewSub")}
            </MenuItem>
            <MenuItem
              icon="write"
              onPress={() =>
                beginName({
                  mailbox: target.mailboxId,
                  parent: folderParentOf(target.name),
                  folder: target,
                  value: folderLeafOf(target.name),
                })
              }
            >
              {rail("folderRename")}
            </MenuItem>
            <MenuItem icon="trash" onPress={() => askDelete(target)}>
              {rail("folderDelete")}
            </MenuItem>
          </>
        ) : null}
      </Menu>
      {asking !== null && writable && mayEdit(asking.folder.mailboxId) ? (
        <Dialog
          open
          alert
          keysOn="cancel"
          announceLine
          title={rail("folderDeleteGo")}
          line={
            asking.counts === undefined
              ? rail("folderDeleteCounting")
              : asking.counts === null
                ? rail("folderDeleteConfirmUncounted")
                : rail("folderDeleteConfirm", asking.counts)
          }
          onClose={closeAsk}
          cancel={{ label: rail("folderDeleteCancel") }}
          confirm={{
            label: rail("folderDeleteGo"),
            disabled: asking.counts === undefined,
            onPress: () => {
              if (asking.counts === undefined || !isCurrent(asking)) return;
              closeAsk();
              writable.run(folderCommands.remove(asking.folder.id), asking.folder);
            },
          }}
        />
      ) : null}
    </>
  );
}

export function folderNameForm({
  edit,
  rail,
  nameProblem,
  commit,
  change,
  close,
}: {
  edit: NameEdit;
  rail: Text;
  nameProblem: string | null;
  commit: () => void;
  change: (value: string) => void;
  close: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <TextField
        shape="line"
        autoFocus
        aria-label={rail(edit.folder ? "folderRenamePlaceholder" : "folderNamePlaceholder")}
        value={edit.value}
        onChange={(event) => {
          change(event.target.value);
        }}
        onFocusLeft={close}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
      />
      {nameProblem ? <RefusalLine alert>{nameProblem}</RefusalLine> : null}
    </form>
  );
}

export function folderRowCommands({
  tapMenus,
  menu,
  t,
  rail,
  writable,
  mayEdit,
  openMenu,
}: {
  tapMenus?: boolean;
  menu: FolderMenu | null;
  t: Text;
  rail: Text;
  writable?: FolderCommands;
  mayEdit: (id: string) => boolean;
  openMenu: (key: string, at: FolderMenu["at"], fromShelf?: true) => void;
}) {
  return (folder: FolderEntity, fromShelf?: true) => {
    const busy = folder.op !== undefined && folder.op.error === undefined;
    const word = folderCommandWord(rail, folder);
    const key = shelfKeyOf(folder);
    return {
      busy,
      title: word ?? folder.name,
      name: folderLeafOf(busy && folder.op?.kind === "rename" ? (folder.op.to ?? folder.name) : folder.name),
      menu: !busy,
      menuButton:
        tapMenus && !busy ? (
          <Button
            kind="quiet"
            size="s"
            icon="more"
            opens="menu"
            label={t("rail.menu", { name: folderLeafOf(folder.name) })}
            expanded={menu?.key === key && menu.fromShelf === fromShelf}
            onPress={({ currentTarget }) => {
              const { right, bottom } = cssRect(currentTarget);
              openMenu(key, { x: right, y: bottom }, fromShelf);
            }}
          />
        ) : undefined,
      after:
        word !== undefined && folder.op?.error !== undefined && writable && mayEdit(folder.mailboxId) ? (
          <RefusalLine
            way={{
              label: rail("folderDismiss"),
              onPress: () => writable.run(folderCommands.dismiss(folder.id), folder),
            }}
          >
            {word}
          </RefusalLine>
        ) : undefined,
    };
  };
}
