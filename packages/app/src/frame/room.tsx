/**
 * THE ROOM: the one press seam of a frame. A feature reaches it with `usePress()`, which throws where no room is on.
 * Whose seam it is, the host's record says, statically (`features.above` and `features.reader`):
 *
 * - with a ground above the panes, or a reader handed: the room's own. One component calls `useShellDispatch` once,
 *   for the frame's life, whatever place is on screen. It stands around everything the room holds, says the held
 *   presses in its own render and binds `z` to its armed Undo. The delete journal a closed tab left is replayed once,
 *   at that one mount;
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
import { useRecordWhileSame } from "@ohmail/app-logic/press/stable-callback";
import { placeLabelOver, pressWords } from "@ohmail/app-logic/reader";
import { rosterStateOf } from "@ohmail/app-logic/mail-state/mail-state";
import type { OhmailEngine } from "@ohmail/client-engine";
import { useText } from "../text/index.js";
import { NONE, type HostReads } from "../host/index.js";
import { useFrame, useReport } from "./commands.js";
import {
  factsStore,
  HeldContext,
  ownStore,
  resurfaceStore,
  RoomContext,
  useRoomFill,
  useRoomHour,
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
  useKnownOwnAddresses,
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
  /* The engine's one reader, for its life: the seam asks it at a press, and its watch listens by itself while a press
     waits, so a change of the mirror renders nothing here (it once rendered this seam at every notice of a drain). */
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
  /* The seam's record, held while no member moved, handed whole to its one context: the room's seam slot. */
  const seam = useRecordWhileSame(
    useShellDispatch({ engine, reader, toast: report, t, placeLabel, demo, refreshFacts, scope }),
  );
  const roster = seam.rosterRef;
  roster.current = rosterStateOf(mailboxes !== NONE, rows);
  /* The account's resurface hour is not the seam's: what holds it above the panes hands it (`useRoomResurface`). */
  useRoomFill(room, { seam, rows });
  const held = seam.deleting.held;
  const places = seam.routing.places;
  const holds = useMemo((): RoomHolds => ({ held, places }), [held, places]);
  const into = room.seam;
  /* `z` takes back the armed Undo, wherever the person is in the room but a field: a binding of the key map's
     registry for as long as this seam stands, named as the key sheet has always listed it. */
  const keys = useText("shortcuts");
  useOptionalKeyBindings(
    [{ chord: "z", group: "app", label: keys("undo"), run: () => void into.current?.runArmedUndo() }],
    "view",
  );
  return <HeldContext.Provider value={holds}>{children}</HeldContext.Provider>;
}

/**
 * The room of a frame. `whose` is read off the host's record, never off what a child did in a render. Where the host
 * hands a ground or a reader the room's own seam stands around what the room holds for the frame's life: no walk
 * between places mounts it again. Where it hands neither, no seam stands. `on` says where `usePress()` answers.
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
  const addresses = useMemo(ownStore, []);
  const words = useMemo(wordStore, []);
  const resurface = useMemo(resurfaceStore, []);
  const facts = useMemo(factsStore, []);
  const binding = useContext(EngineContext);
  const { host } = useFrame();
  const room = useMemo(
    (): Room => ({ on, whose, seam, own: addresses, words, resurface, facts }),
    [on, whose, addresses, words, resurface, facts],
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
 * A PART ABOVE THE PANES HANDS THE ROOM THE MAILBOX FACTS IT HOLDS: the mail ground hands the mail state's rows and
 * its re-read. The room's seam then reads its roster, the account's own addresses and the mailbox words off those
 * rows, asks that re-read after a filing press, and reads the host never: one reader of the mailbox facts stands in a
 * frame. With nothing handed the room reads the host itself. Throws with no room, and in a room with no seam (nothing
 * there reads them).
 */
export function useRoomFacts({ rows, refresh }: HandedFacts): void {
  const room = useContext(RoomContext);
  if (room === null) throw new Error("useRoomFacts: no room stands here");
  if (room.whose === "none") throw new Error(`useRoomFacts: ${NO_SEAM}`);
  const { facts } = room;
  /* In the layout phase: the room's own read is a passive effect of the same commit, and finds these handed. */
  useLayoutEffect(() => facts.set({ rows, refresh }), [facts, rows, refresh]);
  useLayoutEffect(() => () => facts.set(null), [facts]);
}

/**
 * A PART ABOVE THE PANES HANDS THE ROOM THE ACCOUNT'S RESURFACE HOUR: the mail ground hands the consent row's stored
 * hour and its way to store another. The reader then books a letter's return at that hour and keeps a newly picked
 * one for the account. With nothing handed nothing is stored and nothing kept, and the reader offers its own hour.
 * Throws with no room, and in a room with no seam (nothing there books a return).
 */
export function useRoomResurface(hour: ResurfaceTime): void {
  const room = useContext(RoomContext);
  if (room === null) throw new Error("useRoomResurface: no room stands here");
  if (room.whose === "none") throw new Error(`useRoomResurface: ${NO_SEAM}`);
  useRoomHour(room, hour);
}

/**
 * The room's press seam. Every member is read at the moment it is used, so a press always reaches the seam that
 * stands now. Throws where no room is on: everywhere on a host whose room has no seam.
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
