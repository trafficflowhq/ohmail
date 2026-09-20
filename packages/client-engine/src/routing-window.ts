import type { EngineMutation } from "./types.js";
import type { StorageDoor } from "./durable.js";
import {
  armRoutingIntent,
  disarmRoutingIntent,
  routingSubject,
  takeRoutingIntents,
  type RoutingIntent,
} from "./routing-intents.js";

/**
 * A ROUTING PRESS, HELD OPEN. Move, File and Junk file mail through a screening plan — a rule
 * written or retargeted, and a capped pass over mail already filed — and no rule mutation has a
 * wire inverse, so the press had no way back. It is now TWO HALVES: the mail moves at once
 * through the ordinary `move` (the engine builds that reversal, `undo.ts`), and the ROUTING is a
 * DELAYED COMMIT held here. The press lands in a journal before the timer, Undo drops it, the
 * window's close sends it exactly as it was sent before, and a launch after a kill finishes what
 * the window started — the delete key's answer and the Screener's, one verb over. The window
 * length is the caller's `UNDO_MS`: ONE constant, never a second number.
 */

/**
 * THE PLAN IS RE-READ AT THE COMMIT, NEVER REPLAYED FROM THE RECORD — `routing-intents.ts` says
 * why (a journalled `rule_create` mints a second row under a second key). It also makes the
 * window honest about a mirror that moved underneath it: a sender another device has already
 * ruled re-plans to nothing and the window says so, rather than writing a duplicate rule because
 * that is what the press decided eight seconds ago.
 */

/**
 * ONE TAB OWNS AN OPEN WINDOW, and a tab about to replay ASKS first. The journal is per ORIGIN,
 * so a second tab's boot otherwise finds a press the FIRST tab is still counting down, commits
 * it, and the first tab's Undo then reports "Undone" over a rule that has been written — measured
 * for the Screener's own window and the same here. Structural, so no package imports an app: the
 * webapp passes its coordinator on a channel of its own, and a surface with one window
 * (the phone, the desktop) passes nothing and means it.
 */
export interface TabWindows {
  serve: (open: () => Array<{ id: string; at: number }>) => void;
  claim: (rows: Array<{ id: string; at: number }>) => void;
  release: (ids: string[]) => void;
  ask: () => Promise<void>;
  elsewhere: (nowMs: number, windowMs: number) => ReadonlySet<string>;
  resolved: () => ReadonlySet<string>;
}

/**
 * What the window answered. `held` is the one thing a surface reads BEYOND the class:
 * `UNDO_CLASS.routing_plan` says an undo is offerable at all, and this says whether THIS press
 * can honour one. A jar that refused the record commits at once — the window is only reversible
 * because nothing has been sent, and what made postponing safe was the record.
 */
export interface RoutingOpen {
  held: boolean;
  superseded: boolean;
}

export interface RoutingWindowDeps {
  /** The jar. REQUIRED: a defaulted door is how a surface silently stops keeping records. */
  door: StorageDoor;
  /** The journal key — owner-scoped by the caller, whose account rule this is. */
  key: string;
  /** The undo window — the caller's ONE constant (`UNDO_MS`), never a second number. */
  windowMs: number;
  /**
   * THE ROUTING HALF, RE-PLANNED FROM THE MIRROR at the moment of commit. Empty is a real
   * answer — the rule is already standing, or the sender has moved past this press — and the
   * caller says so rather than dispatching nothing in silence.
   */
  plan: (intent: RoutingIntent) => readonly EngineMutation[];
  /** What the routing half is committed THROUGH. The surface's own filing dispatch. */
  dispatch: (mutations: readonly EngineMutation[], intent: RoutingIntent) => Promise<void>;
  /** The cross-tab coordinator, where there is more than one window. */
  windows?: TabWindows | undefined;
  /** Called whenever the open set changes, with the intents still held. */
  onPending?: (open: readonly RoutingIntent[]) => void;
  /** Epoch ms. Injected so the TTL and the resume are testable without a fake clock. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
}

export interface RoutingWindow {
  /** One press. Opens a window, or commits at once when the jar refused the record. */
  open: (intent: RoutingIntent) => RoutingOpen;
  /** Take the press on this subject back. `true` ONLY when a window was open. */
  undo: (subject: string) => boolean;
  /** Commit every open window now, without waiting. Unmount, `pagehide`, sign-out. */
  flush: () => void;
  /** The intents a window is open over. */
  pending: () => readonly RoutingIntent[];
  /**
   * BOOT. Commits what elapsed while the app was closed, RESUMES what did not with the time it
   * has left, hands back what died of age so the caller can say so, and SKIPS what another tab
   * is holding or has already resolved. Once per mount.
   */
  replay: (nowMs: number) => Promise<{
    committed: RoutingIntent[];
    resumed: RoutingIntent[];
    expired: RoutingIntent[];
    elsewhere: RoutingIntent[];
  }>;
}

/**
 * A jar that keeps nothing past this session — the phone's, and the honest name for it.
 *
 * React Native has no `localStorage`, and the real door answers "lost" for every write, so every
 * phone press would commit at once and no routing press would ever be undoable. This keeps the
 * record for as long as the process lives, which is exactly what `held-delete.ts` already ships:
 * leaving the app commits, and a hard kill inside the window loses the PRESS, not the mail.
 * Named rather than inlined so the posture is greppable and a gap row can point at it.
 */
export function memoryRoutingDoor(): StorageDoor {
  const jar = new Map<string, string>();
  return {
    get: (k) => jar.get(k) ?? null,
    set: (k, v) => { jar.set(k, v); return "stored"; },
    remove: (k) => { jar.delete(k); return "stored"; },
  };
}

export function createRoutingWindow(deps: RoutingWindowDeps): RoutingWindow {
  const arm = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const disarm = deps.clearTimer ?? ((h) => clearTimeout(h));
  const clock = deps.now ?? (() => Date.now());

  /** One entry per OPEN press, by subject. */
  const open = new Map<string, { intent: RoutingIntent; timer: ReturnType<typeof setTimeout> }>();

  const publish = (): void => { deps.onPending?.([...open.values()].map((e) => e.intent)); };

  deps.windows?.serve(() => [...open.values()].map((e) => ({ id: e.intent.id, at: e.intent.at })));

  /**
   * SEND IT. The journal row is cleared only once the dispatch has SETTLED, never before it
   * leaves: the engine persists a verb to its outbox ahead of the wire, so between here and that
   * write this journal is the only durable copy of the press.
   */
  const send = (intent: RoutingIntent): void => {
    const done = (): void => {
      disarmRoutingIntent(deps.door, deps.key, intent.id);
      /* AND NO OTHER TAB MAY REPLAY IT — resolved means resolved, whichever tab boots next. */
      deps.windows?.release([intent.id]);
    };
    let mutations: readonly EngineMutation[];
    try {
      mutations = deps.plan(intent);
    } catch {
      /* A PLANNER THAT THREW IS NOT A PRESS THAT HAPPENED. The record stands for the next
         launch rather than being consumed by a read that could not be made. */
      return;
    }
    void deps.dispatch(mutations, intent).then(done, done);
  };

  const close = (subject: string): void => {
    const entry = open.get(subject);
    if (!entry) return;
    disarm(entry.timer);
    open.delete(subject);
    publish();
    send(entry.intent);
  };

  const hold = (intent: RoutingIntent, ms: number): void => {
    const timer = arm(() => close(routingSubject(intent)), ms);
    open.set(routingSubject(intent), { intent, timer });
    deps.windows?.claim([{ id: intent.id, at: intent.at }]);
    publish();
  };

  return {
    open(intent) {
      const subject = routingSubject(intent);
      /* THE EARLIER PRESS ON THIS SUBJECT IS DROPPED, TIMER AND ROW TOGETHER — not committed.
         Committing it would write the rule the reader has just replaced and then the later one
         over the top: two rules on the wire for one change of mind. The mail the earlier press
         moved is NOT moved back: mail a press did not name never moves, and the later press
         moved what it named itself. */
      const prior = open.get(subject);
      if (prior) {
        disarm(prior.timer);
        open.delete(subject);
        deps.windows?.release([prior.intent.id]);
      }
      const written = armRoutingIntent(deps.door, deps.key, intent);
      if (written === "lost") {
        /* A REFUSED JAR TAKES THE UNDO AWAY, NOT THE ROUTING. With no record a kill inside the
           window loses a change the toast has already reported — the very defect the journal
           closes, arriving through a private window instead of through a crash. */
        publish();
        send(intent);
        return { held: false, superseded: prior != null };
      }
      hold(intent, deps.windowMs);
      return { held: true, superseded: prior != null };
    },

    /**
     * NOTHING HELD IS NOT AN UNDO. `false` where no window was open, so a late press cannot be
     * reported as having taken something back. The journal row goes in the SAME synchronous act
     * as the timer, or the next boot would re-commit a press the reader had just reversed.
     */
    undo(subject) {
      const entry = open.get(subject);
      if (!entry) return false;
      disarm(entry.timer);
      open.delete(subject);
      disarmRoutingIntent(deps.door, deps.key, entry.intent.id);
      deps.windows?.release([entry.intent.id]);
      publish();
      return true;
    },

    flush() {
      const entries = [...open.values()];
      open.clear();
      for (const e of entries) disarm(e.timer);
      publish();
      for (const e of entries) send(e.intent);
    },

    pending() { return [...open.values()].map((e) => e.intent); },

    async replay(nowMs) {
      /* ASK BEFORE ACTING. A claim broadcast after the fact cannot reach a tab that was not yet
         open, so the question comes first and the answer is waited for. */
      await deps.windows?.ask();
      const { live, expired } = takeRoutingIntents(deps.door, deps.key, nowMs);
      const committed: RoutingIntent[] = [];
      const resumed: RoutingIntent[] = [];
      const foreign: RoutingIntent[] = [];
      const heldElsewhere = deps.windows?.elsewhere(nowMs, deps.windowMs) ?? new Set<string>();
      const settledElsewhere = deps.windows?.resolved() ?? new Set<string>();
      for (const intent of live) {
        /* Already open in THIS session — a second replay, or a press made since the read. */
        if (open.has(routingSubject(intent))) continue;
        if (heldElsewhere.has(intent.id) || settledElsewhere.has(intent.id)) {
          foreign.push(intent);
          continue;
        }
        if (nowMs - intent.at >= deps.windowMs) committed.push(intent);
        else resumed.push(intent);
      }
      for (const intent of committed) send(intent);
      /* AND THE WINDOW RESUMES WITH WHAT IT HAS LEFT, rather than restarting: the reader pressed
         at `at`, and a fresh full window would extend an offer they have already half spent. */
      for (const intent of resumed) hold(intent, Math.max(0, deps.windowMs - (nowMs - intent.at)));
      return { committed, resumed, expired, elsewhere: foreign };
    },
  };
}
