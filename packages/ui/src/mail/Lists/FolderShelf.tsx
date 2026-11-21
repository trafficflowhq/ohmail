import { Fragment, type ReactNode } from "react";
import { RailEntry } from "../Shell/RailEntry.js";
import "./folder-shelf.css";

export interface ShelfFolder {
  id: string;
  name: string;
  busy?: boolean;
  title?: string;
  after?: ReactNode;
  menu?: boolean;
  menuButton?: ReactNode;
  /**
   * What tells it from another folder of the same name, small after the name: the folder above it, else its
   * mailbox; for a hit of the find line, its way. Without a `label` it is said with the name, and with the count
   * the entry shows.
   */
  hint?: string;
  /** Its unread mail, and its name with that count for a screen reader: "Team, 3 unread". */
  count?: string;
  label?: string;
  /** The folder that is open. */
  current?: boolean;
  /** A row is being dragged and this folder takes it; `over` while the pointer is on it. */
  drop?: "ready" | "over";
}

export interface FolderShelfProps {
  /** The line that shuts and opens the group: "Folders". */
  label: string;
  expanded: boolean;
  onToggle?: () => void;
  /** The few folders the rail has room for: the pinned ones, the open one, the ones used last. */
  folders: readonly ShelfFolder[];
  onOpen?: (id: string) => void;
  /** A folder's own menu was asked for (a right click, the menu key): which folder, and where the pointer is. */
  onMenu?: (id: string, at: { x: number; y: number }) => void;
  /** The fold that opens the rest: its name, its name with the unread mail it hides, that count, whether it stands. */
  all?: { name: string; label: string; count?: string; expanded: boolean; onToggle?: () => void };
  /** The open fold. */
  children?: ReactNode;
}

/**
 * The name a folder with a hint is said by where the app hands none: its name, what tells it apart and the count
 * it shows, each heard apart. A folder without a hint is named by what it draws.
 */
export const hintedName = (folder: { name: string; hint?: string; count?: string }): string | undefined =>
  folder.hint ? [folder.name, folder.hint, folder.count].filter(Boolean).join(", ") : undefined;

/** The few folders the rail has room for, and the one fold that opens the rest. */
export function FolderShelf(props: FolderShelfProps) {
  const { label, expanded, onToggle, folders, onOpen, onMenu, all, children } = props;
  return (
    <div className="oh-foldershelf">
      <RailEntry kind="fold" expanded={expanded} onPress={onToggle}>
        {label}
      </RailEntry>
      {expanded
        ? folders.map((folder) => {
            const entry = (
              <RailEntry
                kind="sub"
                icon="folder"
                count={folder.count}
                hint={folder.hint}
                label={folder.label ?? hintedName(folder)}
                title={folder.title ?? folder.name}
                busy={folder.busy}
                current={folder.current}
                drop={folder.drop}
                onPress={() => onOpen?.(folder.id)}
                onMenu={onMenu && folder.menu !== false ? (at) => onMenu(folder.id, at) : undefined}
              >
                {folder.name}
              </RailEntry>
            );
            return (
              <Fragment key={folder.id}>
                {folder.menuButton ? (
                  <div className="oh-foldershelf-row">
                    {entry}
                    {folder.menuButton}
                  </div>
                ) : (
                  entry
                )}
                {folder.after}
              </Fragment>
            );
          })
        : null}
      {expanded && all ? (
        <span className="oh-foldershelf-all">
          <RailEntry
            kind="sub"
            expanded={all.expanded}
            count={all.count}
            label={all.label}
            onPress={all.onToggle}
          >
            {all.name}
          </RailEntry>
        </span>
      ) : null}
      {expanded ? children : null}
    </div>
  );
}
