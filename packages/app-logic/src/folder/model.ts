/**
 * A FOLDER'S MODEL: one of the mailbox's own folders, read in place. Its letters newest first in two groups, what is
 * new for the person and what came before; an empty folder is an answer (it exists and holds nothing), and a folder
 * that left the mail server while it was open is said by name, never shown as an empty list.
 */
import type { EngineMessage, FolderEntity } from "@ohmail/wire";
import { createContext, useContext, useMemo, useRef } from "react";
import { folderLeafOf } from "../lists/folders.js";
import { newestFirst, usePlaceList, type PlaceList, type PlaceListInput } from "../place-list/place-list.js";

export interface FolderInput extends Omit<PlaceListInput, "rows"> {
  /** The folder the route names, as the mirror holds it; null where the mirror holds no such folder. */
  readonly folder: FolderEntity | null;
  /** The folder's id the route names. */
  readonly folderId: string | null;
  /** The mailbox's folders as the mirror holds them: each part of the way finds its own there. */
  readonly folders: readonly FolderEntity[];
  /** Opens another folder of the mailbox (a part of the way), the seat's way. */
  readonly openFolder: (id: string) => void;
  /** The letters in it. */
  readonly messages: readonly EngineMessage[];
  readonly settled: boolean;
  readonly owed: boolean;
  readonly stamp: (iso: string) => string;
}

export interface FolderModel {
  readonly list: PlaceList;
  readonly folder: FolderEntity | null;
  /** The folder's path, part by part. */
  readonly path: readonly string[];
  /** Each folder above it, from the root: its name, and how to open it where the mirror holds it. */
  readonly way: readonly { readonly label: string; readonly open: (() => void) | null }[];
  readonly fresh: readonly EngineMessage[];
  readonly earlier: readonly EngineMessage[];
  readonly count: number;
  readonly loading: boolean;
  readonly empty: boolean;
  /** The name of the folder that was open here and left the mail server; null otherwise. */
  readonly goneName: string | null;
  readonly stamp: (iso: string) => string;
}

export function useFolderList(input: FolderInput): FolderModel {
  const { folder, folderId, messages, settled, owed } = input;
  const sorted = useMemo(() => [...messages].sort(newestFirst), [messages]);
  const fresh = useMemo(() => sorted.filter((m) => m.unread), [sorted]);
  const earlier = useMemo(() => sorted.filter((m) => !m.unread), [sorted]);
  const rows = useMemo(() => [...fresh, ...earlier], [fresh, earlier]);
  const list = usePlaceList({ ...input, rows: folder === null ? [] : rows });
  /* The folder seen under this route: its name stays to say it left. */
  const seen = useRef<{ id: string; name: string } | null>(null);
  if (folder !== null) seen.current = { id: folder.id, name: folderLeafOf(folder.name) };
  else if (seen.current !== null && seen.current.id !== folderId) seen.current = null;
  const goneName =
    folder === null && seen.current !== null && seen.current.id === folderId ? seen.current.name : null;
  const none = folder !== null && rows.length === 0;
  const path = useMemo(
    () => (folder === null ? [] : folder.name.split("/").filter((part) => part.length > 0)),
    [folder],
  );
  const { folders, openFolder } = input;
  const way = useMemo(
    () =>
      path.slice(0, -1).map((label, index) => {
        const above = path.slice(0, index + 1).join("/");
        const held = folders.find((f) => f.mailboxId === folder?.mailboxId && f.name === above);
        return { label, open: held ? () => openFolder(held.id) : null };
      }),
    [path, folders, folder, openFolder],
  );
  return {
    list,
    folder,
    path,
    way,
    fresh: folder === null ? [] : fresh,
    earlier: folder === null ? [] : earlier,
    count: folder === null ? 0 : rows.length,
    loading: (folder === null && goneName === null && (!settled || owed)) || (none && (!settled || owed)),
    empty: none && settled && !owed,
    goneName,
    stamp: input.stamp,
  };
}

export const FolderModelContext = createContext<FolderModel | null>(null);

export function useFolderModel(): FolderModel {
  const model = useContext(FolderModelContext);
  if (model === null) throw new Error("Folder was drawn with no model above it (FolderModelContext)");
  return model;
}
