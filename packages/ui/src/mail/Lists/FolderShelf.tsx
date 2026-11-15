import type { ReactNode } from "react";
import { RailEntry } from "../Shell/RailEntry.js";
import "./folder-shelf.css";

export interface ShelfFolder {
  id: string;
  name: string;
  /** Its unread mail, and its name with that count for a screen reader: "Team, 3 unread". */
  count?: string;
  label?: string;
  /** The folder that is open. */
  current?: boolean;
}

export interface FolderShelfProps {
  /** The line that shuts and opens the group: "Folders". */
  label: string;
  expanded: boolean;
  onToggle?: () => void;
  /** The few folders the rail has room for: the pinned ones, the open one, the ones used last. */
  folders: readonly ShelfFolder[];
  onOpen?: (id: string) => void;
  /** The fold that opens the rest: its name, its name with the unread mail it hides, that count, whether it stands. */
  all?: { name: string; label: string; count?: string; expanded: boolean; onToggle?: () => void };
  /** The open fold. */
  children?: ReactNode;
}

/** The few folders the rail has room for, and the one fold that opens the rest. */
export function FolderShelf({ label, expanded, onToggle, folders, onOpen, all, children }: FolderShelfProps) {
  return (
    <div className="oh-foldershelf">
      <RailEntry kind="fold" expanded={expanded} onPress={onToggle}>
        {label}
      </RailEntry>
      {expanded
        ? folders.map((folder) => (
            <RailEntry
              key={folder.id}
              kind="sub"
              icon="folder"
              count={folder.count}
              label={folder.label}
              title={folder.name}
              current={folder.current}
              onPress={() => onOpen?.(folder.id)}
            >
              {folder.name}
            </RailEntry>
          ))
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
