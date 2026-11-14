/**
 * THE ROOM: the one press seam of a frame. A feature reaches it with `usePress()`, which throws where no room is on.
 * Whose seam it is, the host's record says, statically (`features.above`, whether that component says `handsSeam`,
 * and `features.reader`):
 *
 * - with a ground above the panes, or a reader handed: the room's own. One component calls `useShellDispatch` once,
 *   for the frame's life, whatever place is on screen. It stands around everything the room holds, says the held
 *   presses in its own render and binds `z` to its armed Undo. The delete journal a closed tab left is replayed once,
 *   at that one mount;
 * - where the old shell stands above the panes and says so: that shell hands its own (`useRoomHandOver`). The room
 *   mounts none and calls `useShellDispatch` never, and is on at every place the frame draws but the body that shell
 *   keeps, whose views press through the shell's seam themselves;
 * - on a host that hands nothing above the panes and no reader: none. Nothing there can press, so no seam reads the
 *   engine or asks the catalogue a sentence for nobody, and `usePress()` throws.
 *
 * What a room holds, and the readers of it, are `room-store.ts`.
 */
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { EngineContext } from "@ohmail/app-logic/engine";
import { useOptionalKeyBindings } from "@ohmail/app-logic/keys";
import { useShellDispatch, type ShellDispatch } from "@ohmail/app-logic/press/shell-dispatch";
import { placeLabelOver, pressWords } from "@ohmail/app-logic/reader";
import { rosterStateOf } from "@ohmail/app-logic/mail-state/mail-state";
import type { OhmailEngine } from "@ohmail/client-engine";
import { useText } from "../text/index.js";
import { NONE, type HostReads } from "../host/index.js";
import { useFrame, useReport } from "./commands.js";
import {
  factsStore,
  HeldContext,
  holdStore,
  NO_RESURFACE,
  ownStore,
  resurfaceStore,
  RoomContext,
  useHandedHolds,
  useRoomFill,
  wordStore,
  type Facts,
  type HandedFacts,
  type ResurfaceTime,
  type Room,
  type RoomHolds,
  type RoomSeam,
} from "./room-store.js";

export {
  useMailboxStatus,
  useMailboxWord,
  useOwnAddresses,
  useResurfaceTime,
  useRoomHolds,
  type MailboxStatus,
  type MailboxWord,
  type ResurfaceTime,
  type RoomHolds,
} from "./room-store.js";

/**
 * The account's mailbox facts as the room reads them off the host itself: who organizes each mailbox (a reader
 * install's delete is refused at the press) and the re-read a filing press asks for. `none`: no roster, the wire is
 * the authority, and a refresh reads nothing. While a part above the panes hands the facts (`useRoomFacts`) the room
 * reads the host never: one reader of them stands in a frame.
 */
function useFacts(
  read: HostReads["mailboxes"],
  handed: Room["facts"],
  isHanded: boolean,
): { facts: Facts; refresh: () => void } {
  const [facts, setFacts] = useState<Facts>(null);
  const refresh = useCallback(() => {
    /* What is handed NOW, not what this render read: the part that hands fills the cell in the layout phase of the
       commit this effect belongs to. */
    if (read === NONE || handed.get() !== null) return;
    read().then(
      (rows) => setFacts(rows as Facts),
      () => undefined,
    );
  }, [read, handed]);
  /* At the mount, and again when a part that handed the facts goes. */
  useEffect(refresh, [refresh, isHanded]);
  return { facts, refresh };
}

/**
 * THE ROOM'S OWN SEAM, around everything the room holds: mounted with the frame and unmounted with it, so
 * `useShellDispatch` runs once per frame. The held presses are a context value written here, in the render in which
 * the seam's state moves: a list composed over them never draws a letter under the report of its delete. What it
 * stands around is one stable element, so a move of the seam's state renders the readers of that value and no other
 * part. It draws no node of its own: a frame with a seam and one without draw the same nodes.
 */
function Seam({
  engine,
  demo,
  scope,
  room,
  mailboxes,
  children,
}: {
  engine: OhmailEngine;
  demo: boolean;
  /** Whose journals the seam's windows keep their presses in: the scope of the frame it stands in. */
  scope: string | null;
  room: Room;
  mailboxes: HostReads["mailboxes"];
  children: ReactNode;
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
  /* The mailbox facts: a part above the panes hands the ones it holds, else the room reads the host itself. */
  const handed = useSyncExternalStore(room.facts.subscribe, room.facts.get, room.facts.get);
  const read = useFacts(mailboxes, room.facts, handed !== null);
  const rows = handed !== null ? handed.rows : read.facts;
  const refresh = handed !== null ? handed.refresh : read.refresh;
  /* The seam takes one constant door: it reads the latest re-read through a ref. */
  const refreshNow = useRef(refresh);
  refreshNow.current = refresh;
  const refreshFacts = useRef(() => refreshNow.current()).current;
  const seam = useShellDispatch({ engine, reader, toast: report, t, placeLabel, demo, refreshFacts, scope });
  const roster = seam.rosterRef;
  roster.current = rosterStateOf(mailboxes !== NONE, rows);
  /* The room's own seam keeps no resurface hour: the reader offers its own, and nothing is stored. */
  useRoomFill(room, { seam, rows, resurface: NO_RESURFACE });
  const held = seam.deleting.held;
  const places = seam.routing.places;
  const holds = useMemo((): RoomHolds => ({ held, places }), [held, places]);
  const into = room.seam;
  /* `z` takes back the armed Undo, wherever the person is in the room but a field: a binding of the key map's
     registry for as long as this seam stands, named in the frame's own word. */
  const tf = useText("frame");
  useOptionalKeyBindings(
    [{ chord: "z", group: "app", label: tf("report.undo"), run: () => void into.current?.runArmedUndo() }],
    "view",
  );
  return <HeldContext.Provider value={holds}>{children}</HeldContext.Provider>;
}

/**
 * The room of a frame. `whose` is read off the host's record, never off what a child did in a render: where the old
 * shell stands above the panes and says `handsSeam`, it hands its own seam (`useRoomHandOver`), and the room mounts
 * none and calls `useShellDispatch` never. A room that first mounted a seam of its own and then met a handed one would
 * run two for one commit, and the delete journal's replay at mount would run twice. Where the host hands a ground or a
 * reader the room's own seam stands around what the room holds for the frame's life: no walk between places mounts it
 * again. Where it hands neither, no seam stands. `on` says where `usePress()` answers.
 */
export function RoomGate({
  on,
  whose,
  children,
}: {
  on: boolean;
  whose: RoomSeam;
  children: ReactNode;
}): ReactNode {
  const seam = useRef<ShellDispatch | null>(null);
  const holds = useMemo(holdStore, []);
  const addresses = useMemo(ownStore, []);
  const words = useMemo(wordStore, []);
  const resurface = useMemo(resurfaceStore, []);
  const facts = useMemo(factsStore, []);
  const binding = useContext(EngineContext);
  const { host } = useFrame();
  const room = useMemo(
    (): Room => ({ on, whose, seam, holds, own: addresses, words, resurface, facts }),
    [on, whose, holds, addresses, words, resurface, facts],
  );
  return (
    <RoomContext.Provider value={room}>
      {whose === "own" && binding ? (
        <Seam
          engine={binding.engine}
          demo={binding.demo}
          scope={host.session.scope}
          room={room}
          mailboxes={host.reads.mailboxes}
        >
          {children}
        </Seam>
      ) : (
        children
      )}
    </RoomContext.Provider>
  );
}

const NO_SEAM = "this room has no seam: its host hands nothing above the panes and no reader";

/**
 * A SHELL HANDS ITS OWN SEAM TO THE ROOM, once, from what it stands above the panes: the seam every press of its own
 * leaves through, the mailbox facts it holds, and the account's stored resurface hour. At every place the frame draws
 * but the body that shell keeps, the room serves that same seam, so one seam stands per frame, with its undo windows,
 * for the frame's life. It sets no roster (the shell sets its own), binds no key (`z` is the shell's) and reads no
 * host. Throws in a room that mounts its own seam: two seams would stand. Throws in a room with none: its host's record
 * names no shell that hands one.
 */
export function useRoomHandOver(input: { seam: ShellDispatch; rows: Facts; resurface: ResurfaceTime }): void {
  const room = useContext(RoomContext);
  if (room === null) throw new Error("useRoomHandOver: no room stands here");
  if (room.whose === "own") throw new Error("useRoomHandOver: this room mounts its own seam");
  if (room.whose === "none") throw new Error(`useRoomHandOver: ${NO_SEAM}`);
  useRoomFill(room, input);
  useHandedHolds(room, input.seam);
}

/**
 * A PART ABOVE THE PANES HANDS THE ROOM THE MAILBOX FACTS IT HOLDS: the mail ground hands the mail state's rows and
 * its re-read. The room's seam then reads its roster, the account's own addresses and the mailbox words off those
 * rows, asks that re-read after a filing press, and reads the host never: one reader of the mailbox facts stands in a
 * frame. With nothing handed the room reads the host itself. Throws with no room, in a room whose seam a shell hands
 * (there the facts come with the hand-over), and in a room with no seam (nothing there reads them).
 */
export function useRoomFacts({ rows, refresh }: HandedFacts): void {
  const room = useContext(RoomContext);
  if (room === null) throw new Error("useRoomFacts: no room stands here");
  if (room.whose === "handed")
    throw new Error("useRoomFacts: this room's seam is handed, and its facts with it");
  if (room.whose === "none") throw new Error(`useRoomFacts: ${NO_SEAM}`);
  const { facts } = room;
  /* In the layout phase: the room's own read is a passive effect of the same commit, and finds these handed. */
  useLayoutEffect(() => facts.set({ rows, refresh }), [facts, rows, refresh]);
  useLayoutEffect(() => () => facts.set(null), [facts]);
}

/**
 * The room's press seam. Every member is read at the moment it is used, so a press always reaches the seam that
 * stands now. Throws where no room is on: under a shell that hands its seam, over the body that shell keeps; and
 * everywhere on a host whose room has no seam.
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
