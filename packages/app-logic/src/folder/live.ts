/**
 * A FOLDER, LIVE: what a folder's seat calls once (`packages/app/src/folder/Seat.tsx`), and what the rail's Folders
 * group reads for the frame's life (`useFolderRailLive`). The mailbox's own folders stand only while the account
 * uses folders (the consent row's `foldersEnabled`): with folders off there is no folder to open and no group.
 *
 * A folder's letters are the ones the ground presents in it, in its mailbox, newest first in two groups (the model's).
 * A letter's Move into another of its mailbox's folders is the one act `moveIntoFolder` sends through the frame's
 * seam, offered over the folders `foldersToMoveInto` reads (never Junk, never where it is).
 * The device mirror paints first. The older-mail hook holds the remaining pages for this Folder visit.
 */
import { useEffect, useMemo, useRef } from "react";
import { storeInstantOf, storeKeyOf } from "@ohmail/client-engine";
import type { EngineMessage, FolderEntity } from "@ohmail/wire";
import { useConsent } from "../consent/consent-row.js";
import { atStamp, useDerivedVersion, useEngine, useSyncStatus } from "../engine/context.js";
import { folderTailVerdict } from "../lists/folders.js";
import { useOlderMail } from "../lists/older-mail.js";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import { useMailState } from "../mail-state/mail-state-binding.js";
import { usePlaceListFeed, usePlaceListKeys, type PlaceListLiveOwn } from "../place-list/live.js";
import { useStableCallback } from "../press/stable-callback.js";
import { usePresented } from "../reading/presented-mirror.js";
import { useDayClock } from "../session/day-clock.js";
import { stampOver } from "../text/format.js";
import { useFolderList, type FolderModel, type FolderMove } from "./model.js";
import { foldersToMoveInto, moveIntoFolder, type FolderMoveWords } from "./move.js";

/** What only a folder's seat can read. */
export interface FolderLiveOwn extends PlaceListLiveOwn {
  /** The zone the reader's clock runs in. */
  readonly zone: string;
  /** What a move into a folder says, in the folder place's own words. */
  readonly moveWords: FolderMoveWords;
}

const NO_FOLDERS: readonly FolderEntity[] = [];

/** The mailbox's folders as the mirror holds them, while the account uses folders; none while it does not. */
function useFolders(): readonly FolderEntity[] {
  const engine = useEngine();
  const derived = useDerivedVersion();
  const { foldersEnabled } = useConsent(); // throws where no ground stands above
  return useMemo(
    () => (foldersEnabled ? atStamp(derived, engine.read().list<FolderEntity>("folder")) : NO_FOLDERS),
    [engine, derived, foldersEnabled],
  );
}

export function useFolderLive(args: PlaceLiveArgs, own: FolderLiveOwn): FolderModel {
  const presented = usePresented(); // throws where no ground stands above
  const engine = useEngine();
  const derived = useDerivedVersion();
  const now = useDayClock(null, own.zone);
  const folders = useFolders();
  const folderId = args.route.sub;
  const folder = folderId === null ? null : (folders.find((f) => f.id === folderId) ?? null);
  const messages = useMemo(
    () =>
      folder === null
        ? []
        : atStamp(
            derived,
            presented
              .list<EngineMessage>("message")
              .filter((m) => m.mailboxId === folder.mailboxId && m.folder === folder.name),
          ),
    [presented, derived, folder],
  );
  const below = useMemo(() => {
    let oldest: EngineMessage | undefined;
    for (const message of messages) {
      if (
        oldest === undefined ||
        storeInstantOf(message) < storeInstantOf(oldest) ||
        (storeInstantOf(message) === storeInstantOf(oldest) && message.id < oldest.id)
      )
        oldest = message;
    }
    return oldest === undefined ? undefined : storeKeyOf(oldest);
  }, [messages]);
  const older = useOlderMail(engine, "folder", derived, folder?.id, below, (id) => {
    return folderTailVerdict(
      engine.read().get<EngineMessage>("message", id),
      folder?.id,
      folder ?? undefined,
    );
  });
  const { held } = args.press.deleting;
  const tail = useMemo(() => older.items.filter((message) => !held.has(message.id)), [older.items, held]);
  const surface = useMemo(() => [...messages, ...tail], [messages, tail]);
  const feed = usePlaceListFeed(args, own, surface);
  const probe =
    folder !== null &&
    messages.length === 0 &&
    older.available &&
    !older.pending &&
    !older.loading &&
    !older.exhausted &&
    older.error === null &&
    older.items.length === 0;
  const { loadMore } = older;
  const probed = useRef<string | null>(null);
  useEffect(() => {
    if (probed.current !== folder?.id) probed.current = null;
    if (!probe || folder === null || probed.current === folder.id) return;
    probed.current = folder.id;
    loadMore();
  }, [folder, probe, loadMore]);
  const { commands } = args;
  const move = useFolderMove(args, own.moveWords);
  const model = useFolderList({
    ...feed.list,
    /* A folder opens no letter on arrival: its list stands alone until a row is chosen. */
    arrival: "rest",
    folder,
    folderId,
    folders,
    openFolder: useStableCallback((id: string) => commands.go({ place: "folder", sub: id })),
    messages,
    older,
    tail,
    settled: feed.settled,
    owed: feed.owed,
    stamp: useMemo(() => stampOver(now), [now]),
    move,
  });
  usePlaceListKeys(model.list, own);
  return model;
}

/**
 * A LETTER'S MOVE INTO ANOTHER FOLDER: the folders of its own mailbox it may go to, Junk and what lies under it left
 * out by the mailbox's own word for it (none offered until that word is known), and the one act a press sends, said
 * in the place's words. The move goes through the frame's one seam and its filing door; Undo is the engine's own way
 * back.
 */
function useFolderMove(args: PlaceLiveArgs, words: FolderMoveWords): FolderMove {
  const engine = useEngine();
  const { mailboxes: facts } = useMailState();
  const { press, report } = args;
  const into = useStableCallback((m: EngineMessage) => {
    /* Until the mail state's facts answer, the mailbox's word for its Junk is unknown: no folder is offered. */
    if (facts === null) return [];
    const junkFolder = facts.find((f) => f.id === m.mailboxId)?.junkFolder ?? null;
    return foldersToMoveInto(engine.verbRead(), m, { junkFolder });
  });
  const send = useStableCallback((source: string, m: EngineMessage, folder: FolderEntity) => {
    const read = engine.verbRead();
    const from = read.get<FolderEntity>("folder", source);
    const current = read.get<EngineMessage>("message", m.id);
    if (
      from === undefined ||
      current === undefined ||
      current.mailboxId !== from.mailboxId ||
      current.folder !== from.name
    )
      return;
    const to = into(current).find(
      (offer) => offer.folder.id === folder.id && offer.folder.name === folder.name,
    );
    if (to !== undefined && !to.disabled) void moveIntoFolder(press, read, report, current, to.folder, words);
  });
  return useMemo(() => ({ into, send }), [into, send]);
}

/** What the rail's Folders group draws for the frame's life, off the ground alone: the folders, and the letters each
 * folder's unread count is read off. Null while the account does not use folders: then no group stands. */
export function useFolderRailLive(): {
  readonly folders: readonly FolderEntity[];
  readonly ready: boolean;
  readonly messages: readonly EngineMessage[];
} | null {
  const presented = usePresented(); // throws where no ground stands above
  const derived = useDerivedVersion();
  const folders = useFolders();
  const { foldersEnabled, known } = useConsent();
  const { bootstrapping } = useSyncStatus();
  const ready = known && !bootstrapping;
  const messages = useMemo(
    () => atStamp(derived, presented.list<EngineMessage>("message")),
    [presented, derived],
  );
  return useMemo(
    () => (foldersEnabled ? { folders, messages, ready } : null),
    [foldersEnabled, folders, messages, ready],
  );
}
