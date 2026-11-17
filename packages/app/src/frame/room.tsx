/**
 * THE ROOM: the one press seam of a frame whose current place draws the reader. While `on`, one headless child calls
 * `useShellDispatch` once and binds `z` to its armed Undo; a feature reaches it with `usePress()`, which throws where no
 * room is on. Off, nothing runs: the old shell's own seam stands alone on today's places. The provider is always the
 * same element, so the columns under it never mount again when the place changes.
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
type HoldStore = ReturnType<typeof holdStore>;
type WordStore = ReturnType<typeof wordStore>;
type OwnStore = ReturnType<typeof ownStore>;

interface Room {
  readonly on: boolean;
  readonly seam: MutableRefObject<ShellDispatch | null>;
  readonly holds: HoldStore;
  readonly own: OwnStore;
  readonly words: WordStore;
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

/** The seam itself: mounted only while the room is on, so `useShellDispatch` runs once per frame or not at all. */
type Facts = Parameters<typeof rosterStateOf>[1];

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
  into,
  holds,
  own,
  words,
  mailboxes,
}: {
  engine: OhmailEngine;
  demo: boolean;
  /** Whose journals the seam's windows keep their presses in: the scope of the frame it stands in. */
  scope: string | null;
  into: MutableRefObject<ShellDispatch | null>;
  holds: HoldStore;
  own: OwnStore;
  words: WordStore;
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
  /* The account's own addresses, as the shell reads them off the same facts: a head says "you" for them. */
  const rows = facts.facts;
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
  into.current = seam;
  useEffect(
    () => () => {
      into.current = null;
    },
    [into],
  );
  const held = seam.deleting.held;
  const places = seam.routing.places;
  useEffect(() => holds.set({ held, places }), [holds, held, places]);
  useEffect(() => () => holds.set(NO_HOLDS), [holds]);
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

export function RoomGate({ on, children }: { on: boolean; children: ReactNode }): ReactNode {
  const seam = useRef<ShellDispatch | null>(null);
  const holds = useMemo(holdStore, []);
  const own = useMemo(ownStore, []);
  const words = useMemo(wordStore, []);
  const binding = useContext(EngineContext);
  const { host } = useFrame();
  const room = useMemo(() => ({ on, seam, holds, own, words }), [on, holds, own, words]);
  return (
    <RoomContext.Provider value={room}>
      {on && binding ? (
        <Seam
          engine={binding.engine}
          demo={binding.demo}
          scope={host.session.scope}
          into={seam}
          holds={holds}
          own={own}
          words={words}
          mailboxes={host.reads.mailboxes}
        />
      ) : null}
      {children}
    </RoomContext.Provider>
  );
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
