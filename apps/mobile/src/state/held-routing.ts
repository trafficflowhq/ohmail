/**
 * The routing window's held presses — the phone's binding of the engine's own window, beside
 * `held-delete.ts` and shaped like it. A Move writes the sender's ROUTING and no rule mutation
 * has a wire inverse, so the mail moves at the press and the rule is HELD: the pill carries Undo
 * while the window runs, and it is sent when the window closes. The WINDOW and the INTENT are the
 * engine's, so the phone and the desktop make one promise; the plan and the dispatch stay here,
 * because only this surface knows its ladder. NOT DURABLE, stated: the door is
 * {@link memoryRoutingDoor}, so leaving the app commits and a hard kill inside the window loses
 * the PRESS, not the mail — the boundary the delete window already ships with.
 */
import {
  FOLDER_OF_VIEW,
  createRoutingWindow,
  memoryRoutingDoor,
  routingIntentsKey,
  type EngineMutation,
  type Folder,
  type RoutingIntent,
  type RoutingOpen,
  type RoutingWindow,
} from "@ohmail/client-engine";

/** What one session's window needs to plan and to send. Supplied when the session opens. */
export interface RoutingSessionDeps {
  /** The ROUTING half, re-read from the mirror at the commit — never replayed from the record. */
  plan: (intent: RoutingIntent) => readonly EngineMutation[];
  dispatch: (mutations: readonly EngineMutation[], intent: RoutingIntent) => Promise<void>;
  windowMs: number;
}

let live: RoutingWindow | null = null;
const listeners = new Set<() => void>();
/** The snapshot the projection subscribes to — a NEW map per change, the store's contract. */
let snapshot: ReadonlyMap<string, Folder> = new Map();

function publish(open: readonly RoutingIntent[]): void {
  const next = new Map<string, Folder>();
  for (const i of open) {
    const folder = FOLDER_OF_VIEW[i.dest];
    if (!folder) continue;
    for (const id of i.messageIds) next.set(id, folder);
  }
  snapshot = next;
  for (const cb of listeners) cb();
}

export function subscribeRoutingPlaces(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Where held presses are showing their mail — composed into the projection. */
export function routingPlaces(): ReadonlyMap<string, Folder> {
  return snapshot;
}

/**
 * OPEN THE SESSION'S WINDOW. Replaces whatever the previous session had, committing it first:
 * a session ending is not a retraction, which is `flushHeldDeletes`' rule at the same seam.
 */
export function openRoutingSession(deps: RoutingSessionDeps): void {
  closeRoutingSession();
  live = createRoutingWindow({
    /* ONE JAR PER PROCESS AND NO KEY TO SHARE — the phone runs one account at a time, and the
       owner-keyed name is kept so the shape is the browser's even where the jar is not. */
    door: memoryRoutingDoor(),
    key: routingIntentsKey(null),
    windowMs: deps.windowMs,
    plan: deps.plan,
    dispatch: deps.dispatch,
    onPending: publish,
  });
}

/** Commit every open window and forget the session's. */
export function closeRoutingSession(): void {
  if (!live) return;
  live.flush();
  live = null;
  publish([]);
}

/** Hold one press. `held: false` where there is no session — nothing to undo, and said. */
export function holdRouting(intent: RoutingIntent): RoutingOpen {
  return live ? live.open(intent) : { held: false, superseded: false };
}

/** Take the press on this subject back. `false` where no window was open — nothing held is not an undo. */
export function undoRouting(subject: string): boolean {
  return live ? live.undo(subject) : false;
}

/** Commit every open window now — backgrounding, and the session teardown. Leaving is not undo. */
export function flushRouting(): void {
  live?.flush();
}
