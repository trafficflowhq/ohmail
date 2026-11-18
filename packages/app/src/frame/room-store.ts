/**
 * WHAT A ROOM HOLDS, and how a feature reads it: the held presses, the account's own addresses, the mailbox words and
 * the resurface hour; the one function that fills them, for the room's own seam and for a seam a shell hands over;
 * the mailbox facts a part above the panes may hand; and the readers. The room itself (who mounts the seam, and the
 * press through it) is `room.tsx`.
 *
 * The held presses reach a reader two ways, by whose seam it is. The room's own seam says them as a context value in
 * its own render, so a reader draws with them in the commit in which the seam's state moves. A seam a shell hands
 * over fills a store from a hook, a commit later: that shell composes what it draws from its own seam itself.
 */
import type { Folder } from "@ohmail/wire";
import { createContext, useContext, useEffect, useSyncExternalStore, type MutableRefObject } from "react";
import type { ShellDispatch } from "@ohmail/app-logic/press/shell-dispatch";
import { mailboxLabelKey, mailboxLabelResolver, type MailboxLabelFact } from "@ohmail/app-logic/reader";
import { ownAddressesOf, type rosterStateOf } from "@ohmail/app-logic/mail-state/mail-state";

/** What the seam holds back for its Undo, as the presented mirror needs it: deletes and routing presses. */
export interface RoomHolds {
  readonly held: ReadonlySet<string>;
  readonly places: ReadonlyMap<string, Folder>;
}

const NO_HOLDS: RoomHolds = { held: new Set(), places: new Map() };

/**
 * The held presses as the room's own seam says them, in the render in which its state moves. Null where no seam of
 * the room's own stands around the reader: under a handed seam, or outside a room.
 */
export const HeldContext = createContext<RoomHolds | null>(null);

/** A value as state: the seam writes it, a reader of it re-renders when it changes. */
function cellOf<T>(first: T, same: (a: T, b: T) => boolean) {
  let now = first;
  const listeners = new Set<() => void>();
  return {
    get: (): T => now,
    set(next: T): void {
      if (same(next, now)) return;
      now = next;
      for (const l of [...listeners]) l();
    },
    subscribe(l: () => void): () => void {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}
export const holdStore = () =>
  cellOf<RoomHolds>(NO_HOLDS, (a, b) => a.held === b.held && a.places === b.places);
const NO_OWN: readonly string[] = [];
export const ownStore = () => cellOf<readonly string[]>(NO_OWN, (a, b) => a.join("\n") === b.join("\n"));
/** Which mailbox a letter is in, as a word; null on an account with one. */
export type MailboxWord = (mailboxId: string, form?: "short" | "label") => string | null;
/** Where a mailbox stands (`active`, `removed`, …), as the facts say it; null where they do not. */
export type MailboxStatus = (mailboxId: string) => string | null;
const NO_WORD: { key: string; of: MailboxWord; statusOf: MailboxStatus } = {
  key: "null",
  of: () => null,
  statusOf: () => null,
};
export const wordStore = () => cellOf(NO_WORD, (a, b) => a.key === b.key);
/** The hour a resurfaced letter comes back at, as the account keeps it, and the way to keep another. */
export interface ResurfaceTime {
  /** `'HH:MM'` as stored; null where none is, and the reader offers its own hour. */
  readonly stored: string | null;
  /** Keeps another hour; null where nothing can be kept. */
  readonly store: ((hhmm: string) => Promise<unknown>) | null;
}
export const NO_RESURFACE: ResurfaceTime = { stored: null, store: null };
export const resurfaceStore = () =>
  cellOf<ResurfaceTime>(NO_RESURFACE, (a, b) => a.stored === b.stored && a.store === b.store);
/** The account's mailbox facts, as the roster reads them: null while nobody has answered. */
export type Facts = Parameters<typeof rosterStateOf>[1];
/** The mailbox facts a part above the panes hands the room: the rows it holds, and the re-read a filing press asks. */
export interface HandedFacts {
  readonly rows: Facts;
  readonly refresh: () => void;
}
/** Null while no part hands any: the room then reads the host itself. */
export const factsStore = () =>
  cellOf<HandedFacts | null>(
    null,
    (a, b) => a === b || (a !== null && b !== null && a.rows === b.rows && a.refresh === b.refresh),
  );
type HoldStore = ReturnType<typeof holdStore>;
type WordStore = ReturnType<typeof wordStore>;
type OwnStore = ReturnType<typeof ownStore>;
type ResurfaceStore = ReturnType<typeof resurfaceStore>;
type FactsStore = ReturnType<typeof factsStore>;

/**
 * Whose press seam a room has, read once off its host's record: the room's `own`, mounted for the frame's life; one
 * the host's shell `handed`; or `none`, on a host that hands nothing above the panes and no reader, where nothing can
 * press.
 */
export type RoomSeam = "own" | "handed" | "none";

export interface Room {
  /**
   * `usePress()` answers here. Over the room's own seam: always. Under a handed one: off over the kept body. With no
   * seam: never.
   */
  readonly on: boolean;
  readonly whose: RoomSeam;
  readonly seam: MutableRefObject<ShellDispatch | null>;
  /** The held presses of a HANDED seam. The room's own seam says its own in `HeldContext`. */
  readonly holds: HoldStore;
  readonly own: OwnStore;
  readonly words: WordStore;
  readonly resurface: ResurfaceStore;
  readonly facts: FactsStore;
}

export const RoomContext = createContext<Room | null>(null);

/** What stands in a room: the seam its presses leave through, the facts its words are read off, the resurface hour. */
interface RoomFill {
  readonly seam: ShellDispatch;
  readonly rows: Facts;
  readonly resurface: ResurfaceTime;
}

/**
 * THE FILL, one function for the room's own seam and for a seam a shell hands over: the seam goes into the room's ref
 * in render, and the room's stores (the account's own addresses, the mailbox words, the resurface hour) are filled
 * from the same values. Each is emptied again when the part that filled it goes. The held presses are not among them:
 * the room's own seam says them in its render, a handed one fills their store (`useHandedHolds`).
 */
export function useRoomFill(room: Room, { seam, rows, resurface }: RoomFill): void {
  const { seam: into, own, words } = room;
  into.current = seam;
  useEffect(
    () => () => {
      into.current = null;
    },
    [into],
  );
  /* The account's own addresses, as the shell reads them off the same facts: a head says "you" for them. */
  useEffect(() => own.set(rows === null ? NO_OWN : ownAddressesOf(rows as never)), [own, rows]);
  useEffect(() => () => own.set(NO_OWN), [own]);
  /* Which mailbox a letter is in, as a word, off the same facts. */
  useEffect(() => {
    const labels =
      rows === null
        ? null
        : (rows as readonly Partial<MailboxLabelFact>[]).filter(
            (m): m is MailboxLabelFact => typeof m.id === "string" && typeof m.address === "string",
          );
    const statuses = new Map((labels ?? []).map((m) => [m.id, (m as { status?: unknown }).status] as const));
    words.set({
      key: `${mailboxLabelKey(labels)}${JSON.stringify([...statuses])}`,
      of: mailboxLabelResolver(labels),
      statusOf: (id) => {
        const status = statuses.get(id);
        return typeof status === "string" ? status : null;
      },
    });
  }, [words, rows]);
  useEffect(() => () => words.set(NO_WORD), [words]);
  const kept = room.resurface;
  const { stored, store } = resurface;
  useEffect(() => kept.set({ stored, store }), [kept, stored, store]);
  useEffect(() => () => kept.set(NO_RESURFACE), [kept]);
}

/** The held presses of a seam a shell hands over, into the room's store: a hook of that shell provides no context. */
export function useHandedHolds(room: Room, seam: ShellDispatch): void {
  const { holds } = room;
  const held = seam.deleting.held;
  const places = seam.routing.places;
  useEffect(() => holds.set({ held, places }), [holds, held, places]);
  useEffect(() => () => holds.set(NO_HOLDS), [holds]);
}

const NO_STORE = (): (() => void) => () => undefined;

/**
 * The room's held deletes and held routing presses: what the mail ground composes the presented mirror from
 * (`presentedOver` of `@ohmail/app-logic/reading`). Over the room's own seam they are the seam's own, in the render
 * in which they move; under a handed seam, what that shell handed. Nothing held outside a room, or in a room with no
 * seam.
 */
export function useRoomHolds(): RoomHolds {
  const said = useContext(HeldContext);
  const room = useContext(RoomContext);
  const store = room?.holds;
  const handed = useSyncExternalStore(
    store ? store.subscribe : NO_STORE,
    store ? store.get : () => NO_HOLDS,
    () => NO_HOLDS,
  );
  return said ?? handed;
}

/** The account's own addresses, as the room read them off the mailbox facts; none where no room is on. */
export function useOwnAddresses(): readonly string[] {
  const room = useContext(RoomContext);
  const store = room?.own;
  return useSyncExternalStore(
    store ? store.subscribe : NO_STORE,
    store ? store.get : () => NO_OWN,
    () => NO_OWN,
  );
}

/** Which mailbox a letter is in, as a word, off the room's mailbox facts: null on an account with one, or no room. */
export function useMailboxWord(): MailboxWord {
  const room = useContext(RoomContext);
  const store = room?.words;
  return useSyncExternalStore(
    store ? store.subscribe : NO_STORE,
    store ? store.get : () => NO_WORD,
    () => NO_WORD,
  ).of;
}

/**
 * The stored resurface hour and the way to store another, as the shell handed them. Over the room's own seam, or with
 * no room: nothing stored and nothing kept, and a resurfaced letter comes back at the reader's own hour.
 */
export function useResurfaceTime(): ResurfaceTime {
  const room = useContext(RoomContext);
  const store = room?.resurface;
  return useSyncExternalStore(
    store ? store.subscribe : NO_STORE,
    store ? store.get : () => NO_RESURFACE,
    () => NO_RESURFACE,
  );
}

/** Where each mailbox stands, off the room's mailbox facts: null for one the facts do not name, or with no room. */
export function useMailboxStatus(): MailboxStatus {
  const room = useContext(RoomContext);
  const store = room?.words;
  return useSyncExternalStore(
    store ? store.subscribe : NO_STORE,
    store ? store.get : () => NO_WORD,
    () => NO_WORD,
  ).statusOf;
}
