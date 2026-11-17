import type { CSSProperties, KeyboardEvent } from "react";
import { Icon } from "../../icons/Icon.js";
import { RailEntry } from "../Shell/RailEntry.js";
import "./folder-fold.css";
import { hintedName } from "./FolderShelf.js";

export interface FoldFolder {
  id: string;
  name: string;
  /**
   * What tells it from another folder of the same name, small after the name: the folder above it, else its
   * mailbox; for a hit of the find line, its way. Without a `label` it is said with the name, and with the count
   * the entry shows.
   */
  hint?: string;
  /** How deep it lies: 0 for a mailbox's own folders. */
  depth?: number;
  /** Its unread mail (a shut branch adds its children's), and its name with that count for a screen reader. */
  count?: string;
  label?: string;
  current?: boolean;
  /** A row is being dragged and this folder takes it; `over` while the pointer is on it. */
  drop?: "ready" | "over";
  /** It has folders in it: whether they stand, and the name of the control that opens and shuts them. */
  branch?: { expanded: boolean; label: string };
}

export interface FolderFoldProps {
  /** The tree's name: "All folders". */
  label: string;
  /** The line that looks for a folder, once there are more than a few. */
  find?: { label: string; value: string; onChange?: (value: string) => void };
  /** Each mailbox's folders as they stand now, branches opened or shut, the best match first while a name is typed. */
  groups: readonly {
    mailbox?: string;
    folders: readonly FoldFolder[];
    /** The last line of a mailbox: New folder. */
    add?: { label: string; onPress?: () => void };
  }[];
  /** What it says where no folder has the typed name. */
  none?: string;
  onOpen?: (id: string) => void;
  onBranch?: (id: string) => void;
  /** A folder's own menu was asked for (a right click, the menu key): which folder, and where the pointer is. */
  onMenu?: (id: string, at: { x: number; y: number }) => void;
}

/** All the folders the shelf does not show, opened and shut in place in the sidebar. */
export function FolderFold({ label, find, groups, none, onOpen, onBranch, onMenu }: FolderFoldProps) {
  const first = groups.flatMap((group) => group.folders)[0];
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (first) onOpen?.(first.id);
    } else if (event.key === "Escape" && find?.value) {
      /* Esc empties the line first; with an empty line it is the rail's again. */
      event.preventDefault();
      event.stopPropagation();
      find.onChange?.("");
    }
  };
  return (
    <div className="oh-folderfold" role="tree" aria-label={label}>
      {find ? (
        <label className="oh-folderfold-find">
          <Icon name="search" size={16} />
          <input
            className="oh-control oh-folderfold-line"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-label={find.label}
            placeholder={find.label}
            value={find.value}
            onChange={(event) => find.onChange?.(event.target.value)}
            onKeyDown={keys}
          />
        </label>
      ) : null}
      <div className="oh-folderfold-scroll">
        {groups.map((group, g) => (
          <div key={group.mailbox ?? g} className="oh-folderfold-group">
            {group.mailbox ? <p className="oh-text oh-folderfold-mailbox">{group.mailbox}</p> : null}
            {group.folders.map((folder) => (
              <div
                key={folder.id}
                className="oh-folderfold-row"
                style={
                  folder.depth ? ({ "--oh-folderfold-depth": folder.depth } as CSSProperties) : undefined
                }
              >
                {folder.branch ? (
                  <button
                    type="button"
                    className="oh-control oh-folderfold-branch"
                    aria-expanded={folder.branch.expanded}
                    aria-label={folder.branch.label}
                    tabIndex={-1}
                    onClick={() => onBranch?.(folder.id)}
                  >
                    <Icon name="down" size={16} />
                  </button>
                ) : null}
                <RailEntry
                  kind="sub"
                  icon="folder"
                  count={folder.count}
                  hint={folder.hint}
                  label={folder.label ?? hintedName(folder)}
                  title={folder.name}
                  current={folder.current}
                  drop={folder.drop}
                  onPress={() => onOpen?.(folder.id)}
                  onMenu={onMenu ? (at) => onMenu(folder.id, at) : undefined}
                >
                  {folder.name}
                </RailEntry>
              </div>
            ))}
            {group.add ? (
              <RailEntry kind="sub" icon="plus" quiet onPress={group.add.onPress}>
                {group.add.label}
              </RailEntry>
            ) : null}
          </div>
        ))}
        {none && !first ? <p className="oh-text oh-folderfold-none">{none}</p> : null}
      </div>
    </div>
  );
}
