/**
 * THE ROOM: the one press seam of a frame, served to the place that draws the reader. A feature reaches it with
 * `usePress()`, which throws where no room is on. Whose seam it is, the host says:
 *
 * - where the host stands a shell above the panes, that shell hands its own (`useRoomHandOver`): the room mounts none
 *   and calls `useShellDispatch` never, and the seam's undo windows live for the frame, whatever place is on screen;
 * - where nothing stands above, the room's own: while `on`, one headless child calls `useShellDispatch` once and binds
 *   `z` to its armed Undo; off, nothing runs.
 *
 * The provider is always the same element, so nothing under it mounts again when the place changes.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { EngineContext } from "@ohmail/app-logic/engine";
import { useShellDispatch, type ShellDispatch } from "@ohmail/app-logic/press/shell-dispatch";
import {
  mailboxLabelKey,
  mailboxLabelResolver,
  placeLabelOver,
  pressWords,
  type MailboxLabelFact,
} from "@ohmail/app-logic/reader";
import { ownAddressesOf, rosterStateOf } from "@ohmail/app-logic/mail-state/mail-state";
import type { Folder, OhmailEngine } from "@ohmail/client-engine";
import { useText } from "../text/index.js";
import { NONE, type HostReads } from "../host/index.js";
import { useFrame, useReport } from "./commands.js";

/** What the seam holds back for its Undo, as the presented mirror needs it: deletes and routing presses. */
export interface RoomHolds {
  readonly held: ReadonlySet<string>;
  readonly places: ReadonlyMap<string, Folder>;
}

const NO_HOLDS: RoomHolds = { held: new Set(), places: new Map() };

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
const holdStore = () => cellOf<RoomHolds>(NO_HOLDS, (a, b) => a.held === b.held && a.places === b.places);
const NO_OWN: readonly string[] = [];
const ownStore = () => cellOf<readonly string[]>(NO_OWN, (a, b) => a.join("\n") === b.join("\n"));
/** Which mailbox a letter is in, as a word; null on an account with one. */
export type MailboxWord = (mailboxId: string, form?: "short" | "label") => string | null;
/** Where a mailbox stands (`active`, `removed`, …), as the facts say it; null where they do not. */
export type MailboxStatus = (mailboxId: string) => string | null;
const NO_WORD: { key: string; of: MailboxWord; statusOf: MailboxStatus } = {
  key: "null",
  of: () => null,
  statusOf: () => null,
};
const wordStore = () => cellOf(NO_WORD, (a, b) => a.key === b.key);
/** The hour a resurfaced letter comes back at, as the account keeps it, and the way to keep another. */
export interface ResurfaceTime {
  /** `'HH:MM'` as stored; null where none is, and the reader offers its own hour. */
  readonly stored: string | null;
  /** Keeps another hour; null where nothing can be kept. */
  readonly store: ((hhmm: string) => Promise<unknown>) | null;
}
const NO_RESURFACE: ResurfaceTime = { stored: null, store: null };
const resurfaceStore = () =>
  cellOf<ResurfaceTime>(NO_RESURFACE, (a, b) => a.stored === b.stored && a.store === b.store);
type HoldStore = ReturnType<typeof holdStore>;
type WordStore = ReturnType<typeof wordStore>;
type OwnStore = ReturnType<typeof ownStore>;
type ResurfaceStore = ReturnType<typeof resurfaceStore>;

interface Room {
  readonly on: boolean;
  /** The room mounts its own seam. False where the host's shell stands above the panes and hands its own. */
  readonly ownsSeam: boolean;
  readonly seam: MutableRefObject<ShellDispatch | null>;
  readonly holds: HoldStore;
  readonly own: OwnStore;
  readonly words: WordStore;
  readonly resurface: ResurfaceStore;
}

const RoomContext = createContext<Room | null>(null);

const editable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.isContentEditable ||
    t.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') !==
      null ||
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT");

/** The account's mailbox facts, as the roster reads them: null while nobody has answered. */
type Facts = Parameters<typeof rosterStateOf>[1];

/** What stands in a room: the seam its presses leave through, the facts its words are read off, the resurface hour. */
interface RoomFill {
  readonly seam: ShellDispatch;
  readonly rows: Facts;
  readonly resurface: ResurfaceTime;
}

/**
 * THE FILL, one function for the room's own seam and for a seam a shell hands over: the seam goes into the room's ref
 * in render, and the room's stores (the held presses, the account's own addresses, the mailbox words, the resurface
 * hour) are filled from the same values. Each is emptied again when the part that filled it goes.
 */
function useRoomFill(room: Room, { seam, rows, resurface }: RoomFill): void {
  const { seam: into, holds, own, words } = room;
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
  const held = seam.deleting.held;
  const places = seam.routing.places;
  useEffect(() => holds.set({ held, places }), [holds, held, places]);
  useEffect(() => () => holds.set(NO_HOLDS), [holds]);
  const kept = room.resurface;
  const { stored, store } = resurface;
  useEffect(() => kept.set({ stored, store }), [kept, stored, store]);
  useEffect(() => () => kept.set(NO_RESURFACE), [kept]);
}

/** The room's own seam: mounted only while the room is on, so `useShellDispatch` runs once per frame or not at all. */

/**
 * The account's mailbox facts as the seam reads them: who organizes each mailbox (a reader install's delete is
 * refused at the press) and the re-read a filing press asks for. `none`: no roster, the wire is the authority, and a
 * refresh reads nothing.
 */
function useFacts(read: HostReads["mailboxes"]): { facts: Facts; refresh: () => void } {
  const [facts, setFacts] = useState<Facts>(null);
  const refresh = useCallback(() => {
    if (read === NONE) return;
    read().then(
      (rows) => setFacts(rows as Facts),
      () => undefined,
    );
  }, [read]);
  useEffect(refresh, [refresh]);
  return { facts, refresh };
}

function Seam({
  engine,
  demo,
  scope,
  room,
  mailboxes,
}: {
  engine: OhmailEngine;
  demo: boolean;
  /** Whose journals the seam's windows keep their presses in: the scope of the frame it stands in. */
  scope: string | null;
  room: Room;
  mailboxes: HostReads["mailboxes"];
}) {
  const report = useReport();
  const ohbox = useText("ohbox");
  const screener = useText("screener");
  const trash = useText("trash");
  const screening = useText("screening");
  const session = useText("session");
  const shortcuts = useText("shortcuts");
  const place = useText("place");
  const t = useMemo(
    () => pressWords({ ohbox, screener, trash, screening, session, shortcuts }),
    [ohbox, screener, trash, screening, session, shortcuts],
  );
  const placeLabel = useMemo(() => placeLabelOver((view) => (place.has(view) ? place(view) : "")), [place]);
  /* The mirror the seam's refusals read: the engine's, read again on every change. */
  const subscribe = useCallback((changed: () => void) => engine.subscribe(changed), [engine]);
  useSyncExternalStore(
    subscribe,
    () => engine.read().version(),
    () => 0,
  );
  const reader = engine.read();
  const facts = useFacts(mailboxes);
  /* The seam takes one constant door: it reads the latest re-read through a ref. */
  const refreshNow = useRef(facts.refresh);
  refreshNow.current = facts.refresh;
  const refreshFacts = useRef(() => refreshNow.current()).current;
  const seam = useShellDispatch({ engine, reader, toast: report, t, placeLabel, demo, refreshFacts, scope });
  const roster = seam.rosterRef;
  roster.current = rosterStateOf(mailboxes !== NONE, facts.facts);
  /* The room's own seam keeps no resurface hour: the reader offers its own, and nothing is stored. */
  useRoomFill(room, { seam, rows: facts.facts, resurface: NO_RESURFACE });
  const into = room.seam;
  /* `z` takes back the armed Undo, wherever the person is in the room but a field: the room's own window. */
  const [mark, setMark] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const win = mark?.ownerDocument.defaultView;
    if (!win) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "z" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || editable(e.target))
        return;
      if (into.current?.runArmedUndo()) e.preventDefault();
    };
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [mark, into]);
  return <span hidden ref={setMark} />;
}

/**
 * The room of a frame. `own` is the host's word, never read off what a child did in a render: where the host's shell
 * stands above the panes (`features.above`) it hands its own seam (`useRoomHandOver`), and the room mounts none and
 * calls `useShellDispatch` never. A room that first mounted a seam of its own and then met a handed one would run two
 * for one commit, and the delete journal's replay at mount would run twice.
 */
export function RoomGate({
  on,
  own,
  children,
}: {
  on: boolean;
  own: boolean;
  children: ReactNode;
}): ReactNode {
  const seam = useRef<ShellDispatch | null>(null);
  const holds = useMemo(holdStore, []);
  const addresses = useMemo(ownStore, []);
  const words = useMemo(wordStore, []);
  const resurface = useMemo(resurfaceStore, []);
  const binding = useContext(EngineContext);
  const { host } = useFrame();
  const room = useMemo(
    (): Room => ({ on, ownsSeam: own, seam, holds, own: addresses, words, resurface }),
    [on, own, holds, addresses, words, resurface],
  );
  return (
    <RoomContext.Provider value={room}>
      {own && on && binding ? (
        <Seam
          engine={binding.engine}
          demo={binding.demo}
          scope={host.session.scope}
          room={room}
          mailboxes={host.reads.mailboxes}
        />
      ) : null}
      {children}
    </RoomContext.Provider>
  );
}

/**
 * A SHELL HANDS ITS OWN SEAM TO THE ROOM, once, from what it stands above the panes: the seam every press of its own
 * leaves through, the mailbox facts it holds, and the account's stored resurface hour. Where a reader's place is on
 * screen the room serves that same seam, so one seam stands per frame, with its undo windows, for the frame's life.
 * It sets no roster (the shell sets its own), binds no key (`z` is the shell's) and reads no host. Throws in a room
 * that mounts its own seam: two seams would stand.
 */
export function useRoomHandOver(input: { seam: ShellDispatch; rows: Facts; resurface: ResurfaceTime }): void {
  const room = useContext(RoomContext);
  if (room === null) throw new Error("useRoomHandOver: no room stands here");
  if (room.ownsSeam) throw new Error("useRoomHandOver: this room mounts its own seam");
  useRoomFill(room, input);
}

/**
 * The room's press seam. Every member is read at the moment it is used, so a press always reaches the seam that
 * stands now. Throws where no room is on: a feature drawn off a reader's place has no seam of its own to make.
 */
export function usePress(): ShellDispatch {
  const press = usePressWhereOn();
  if (press === null) throw new Error("usePress: no room is on here");
  return press;
}

/** {@link usePress}, or null where no room is on: for a part that a list's own visit may serve without a seam. */
export function usePressWhereOn(): ShellDispatch | null {
  const room = useContext(RoomContext);
  const on = room !== null && room.on;
  const seam = room?.seam ?? null;
  const press = useMemo(
    () =>
      new Proxy({} as ShellDispatch, {
        get(_, key) {
          const now = seam?.current ?? null;
          if (now === null) throw new Error("usePress: the room's seam is not mounted");
          return now[key as keyof ShellDispatch];
        },
      }),
    [seam],
  );
  return on ? press : null;
}

const NO_STORE = (): (() => void) => () => undefined;

/**
 * The room's held deletes and held routing presses, as state: what the frame's slot composes the presented mirror
 * from (`presentedOver` of `@ohmail/app-logic/reading`). Nothing held where no room is on.
 */
export function useRoomHolds(): RoomHolds {
  const room = useContext(RoomContext);
  const store = room?.holds;
  return useSyncExternalStore(
    store ? store.subscribe : NO_STORE,
    store ? store.get : () => NO_HOLDS,
    () => NO_HOLDS,
  );
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
