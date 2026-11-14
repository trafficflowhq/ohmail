/**
 * WHAT A ROOM HOLDS, and how a feature reads it: the held presses, the account's own addresses, the mailbox words and
 * the resurface hour; the one function that fills them from the room's own seam; the mailbox facts and the resurface
 * hour a part above the panes may hand; and the readers. The room itself (who mounts the seam, and the press through
 * it) is `room.tsx`.
 *
 * The held presses reach a reader as a context value the room's own seam says in its own render, so a reader draws
 * with them in the commit in which the seam's state moves.
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
 * the room's own stands around the reader.
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
const NO_OWN: readonly string[] = [];
export const ownStore = () =>
  cellOf<readonly string[] | null>(
    null,
    (a, b) => a === b || (a !== null && b !== null && a.join("\n") === b.join("\n")),
  );
/** Which mailbox a letter is in, as a word; null on an account with one. */
export type MailboxWord = (mailboxId: string, form?: "short" | "label") => string | null;
/** Where a mailbox stands (`active`, `removed`, …), as the facts say it; null where they do not. */
export type MailboxStatus = (mailboxId: string) => string | null;
const NO_WORD: {
  key: string;
  of: MailboxWord;
  statusOf: MailboxStatus;
  nameOf: (address: string) => string | null;
} = {
  key: "null",
  of: () => null,
  statusOf: () => null,
  nameOf: () => null,
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
type WordStore = ReturnType<typeof wordStore>;
type OwnStore = ReturnType<typeof ownStore>;
type ResurfaceStore = ReturnType<typeof resurfaceStore>;
type FactsStore = ReturnType<typeof factsStore>;

/**
 * Whose press seam a room has, read once off its host's record: the room's `own`, mounted for the frame's life; or
 * `none`, on a host that hands nothing above the panes and no reader, where nothing can press.
 */
export type RoomSeam = "own" | "none";

export interface Room {
  /** `usePress()` answers here. Over the room's own seam: always. With no seam: never. */
  readonly on: boolean;
  readonly whose: RoomSeam;
  readonly seam: MutableRefObject<ShellDispatch | null>;
  readonly own: OwnStore;
  readonly words: WordStore;
  readonly resurface: ResurfaceStore;
  readonly facts: FactsStore;
}

export const RoomContext = createContext<Room | null>(null);

/** What stands in a room: the seam its presses leave through, and the facts its words are read off. */
interface RoomFill {
  readonly seam: ShellDispatch;
  readonly rows: Facts;
}

/**
 * THE FILL, from the room's own seam: the seam goes into the room's ref in render, and the room's stores (the
 * account's own addresses, the mailbox words) are filled from the same values. Each is emptied again when the part
 * that filled it goes. The held presses are not among them: the room's own seam says them in its render. Nor is the
 * resurface hour: who holds the account's stored hour hands it (`useRoomHour`).
 */
export function useRoomFill(room: Room, { seam, rows }: RoomFill): void {
  const { seam: into, own, words } = room;
  into.current = seam;
  useEffect(
    () => () => {
      into.current = null;
    },
    [into],
  );
  /* The account's own addresses, as the shell reads them off the same facts: a head says "you" for them. */
  useEffect(() => own.set(rows === null ? null : ownAddressesOf(rows as never)), [own, rows]);
  useEffect(() => () => own.set(null), [own]);
  /* Which mailbox a letter is in, as a word, off the same facts. */
  useEffect(() => {
    const labels =
      rows === null
        ? null
        : (rows as readonly Partial<MailboxLabelFact>[]).filter(
            (m): m is MailboxLabelFact => typeof m.id === "string" && typeof m.address === "string",
          );
    const statuses = new Map((labels ?? []).map((m) => [m.id, (m as { status?: unknown }).status] as const));
    const names = new Map(
      (labels ?? []).flatMap((m) => {
        const name = m.displayName?.trim();
        return name ? [[m.address.toLowerCase(), name] as const] : [];
      }),
    );
    words.set({
      key: `${mailboxLabelKey(labels)}${JSON.stringify([...statuses])}`,
      of: mailboxLabelResolver(labels),
      nameOf: (address) => names.get(address.toLowerCase()) ?? null,
      statusOf: (id) => {
        const status = statuses.get(id);
        return typeof status === "string" ? status : null;
      },
    });
  }, [words, rows]);
  useEffect(() => () => words.set(NO_WORD), [words]);
}

/** The account's resurface hour, into the room's store; emptied again when the part that handed it goes. */
export function useRoomHour(room: Room, { stored, store }: ResurfaceTime): void {
  const kept = room.resurface;
  useEffect(() => kept.set({ stored, store }), [kept, stored, store]);
  useEffect(() => () => kept.set(NO_RESURFACE), [kept]);
}

const NO_STORE = (): (() => void) => () => undefined;

/**
 * The room's held deletes and held routing presses: what the mail ground composes the presented mirror from
 * (`presentedOver` of `@ohmail/app-logic/reading`), the seam's own, in the render in which they move. Nothing held
 * outside a room, or in a room with no seam.
 */
export function useRoomHolds(): RoomHolds {
  return useContext(HeldContext) ?? NO_HOLDS;
}

/** The account's own addresses once its mailbox facts arrive. */
export function useKnownOwnAddresses(): readonly string[] | null {
  const room = useContext(RoomContext);
  const store = room?.own;
  return useSyncExternalStore(store ? store.subscribe : NO_STORE, store ? store.get : () => null, () => null);
}

/** The addresses a reader can recognize so far. */
export function useOwnAddresses(): readonly string[] {
  return useKnownOwnAddresses() ?? NO_OWN;
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

/** The account display name associated with an address in its mailbox roster. */
export function useMailboxName(): (address: string) => string | null {
  const store = useContext(RoomContext)?.words;
  return useSyncExternalStore(
    store ? store.subscribe : NO_STORE,
    store ? store.get : () => NO_WORD,
    () => NO_WORD,
  ).nameOf;
}

/**
 * The stored resurface hour and the way to store another, as a part above the panes handed them to the room
 * (`useRoomResurface`). With nothing handed, or with no room:
 * nothing stored and nothing kept, and a resurfaced letter comes back at the reader's own hour.
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
