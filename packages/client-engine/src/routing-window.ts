import type { EngineMutation } from "./types.js";
import { type DurableWrite, type StorageDoor } from "./durable.js";

/**
 * A ROUTING PRESS, HELD OPEN. Move, File and Junk file mail through a screening PLAN — a rule
 * written or retargeted, sometimes a Screener decision, and a capped pass over mail already
 * filed — and none of those three has a wire inverse. So the press is split: the MAIL moves now
 * through the ordinary `move` (the engine builds that reversal, `undo.ts`), and the ROUTING is a
 * DELAYED COMMIT held here. The plan lands in a journal synchronously, a timer commits it when
 * the window closes, Undo drops it, and a launch after a kill finishes what the window started —
 * the delete key's answer (`delete-intents.ts`) and the Screener's (`screener-intents.ts`), one
 * verb over. The window length is the caller's `UNDO_MS`: ONE constant, never a second number.
 */

/**
 * The jar is a PARAMETER, and that is what makes this the engine's rather than the webapp's. A
 * browser passes `localStorageDoor`, so a routing press survives a killed tab exactly as a
 * delete does; the phone passes {@link memoryRoutingDoor}, where the window lives as long as the
 * session does — the posture its delete window already ships with, stated rather than implied.
 */

/** One press's routing half, on disk before its timer is armed. */
export interface RoutingIntent {
  v: 1;
  /**
   * WHOSE ROUTING THIS IS — and the key supersession is decided on. A second press about the
   * same sender inside one window is not two decisions: it is the reader changing their mind,
   * and only the LAST one may ever be written. Keyed on the subject and NOT on subject+place,
   * because Reads-then-Receipts is exactly that change of mind, and keeping both would write two
   * rules for one sender — the outcome the window exists to make impossible.
   */
  subject: string;
  /** Where this press files. Carried for the sentence and the boot report, never for the key. */
  dest: string;
  /** Epoch ms at the press, from the caller's clock. */
  at: number;
  /** The plan's ROUTING half, in the planner's own dispatch order. Never the moves. */
  mutations: EngineMutation[];
}

/**
 * How long a stranded routing intent is still the reader's word. A day, the horizon the delete
 * and Screener journals already keep: inside it the press is obviously still meant, and past it
 * the account has moved on — rules revoked, mail refiled elsewhere, the sender decided on
 * another device — and writing a day-old rule into it is a surprise rather than a restoration.
 * An expired intent is REPORTED and never swept in silence — the Screener journal's own rule.
 */
export const ROUTING_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Every owner's journal key starts here. Exported so a sign-out can sweep them. */
export const ROUTING_INTENTS_PREFIX = "ohmail.routing.intents.";

export function routingIntentsKey(owner: string | null): string {
  return `${ROUTING_INTENTS_PREFIX}${owner ?? "local"}`;
}

/**
 * How many open routing presses one jar holds. A bound rather than a cap anybody reaches: a
 * reader filing faster than the window closes is walking a pile, and past this the OLDEST is
 * dropped rather than the write refused — a quota rejection would take the whole journal with
 * it, which is the failure the journal exists to prevent.
 */
export const ROUTING_INTENTS_MAX = 100;

function isIntent(x: unknown): x is RoutingIntent {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return r.v === 1
    && typeof r.subject === "string" && r.subject.length > 0
    && typeof r.dest === "string"
    && typeof r.at === "number" && Number.isFinite(r.at)
    && Array.isArray(r.mutations) && r.mutations.length > 0
    && r.mutations.every((m) => typeof m === "object" && m !== null
      && typeof (m as Record<string, unknown>).kind === "string");
}

/**
 * THE JOURNAL, AND A ROW THIS BUILD CANNOT READ IS DROPPED. The opposite of the outbox's rule,
 * deliberately: an outbox entry is a verb the server may already have seen, where a journal entry
 * has not been expressed at all — and replaying a shape we cannot read would write a rule nobody
 * chose. `v` names the shape so a later build migrates rather than guesses.
 */
function read(door: StorageDoor, key: string): RoutingIntent[] {
  try {
    const raw = door.get(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isIntent) : [];
  } catch {
    return [];
  }
}

/** Write the journal, and say whether it landed — `screener-intents.ts#save`'s reason. */
function write(door: StorageDoor, key: string, rows: RoutingIntent[]): DurableWrite {
  return rows.length === 0
    ? door.remove(key)
    : door.set(key, JSON.stringify(rows.slice(-ROUTING_INTENTS_MAX)));
}

/** What a press asks the window to hold. */
export interface RoutingPress {
  subject: string;
  dest: string;
  /** The routing half only — the caller splits it (`splitRoutingPlan`). Empty is refused. */
  mutations: readonly EngineMutation[];
}

/**
 * What the window answered. `held` is the only thing a surface may key its Undo on BEYOND the
 * class: {@link UNDO_CLASS}'s `routing_plan` says an undo is offerable at all, and this says
 * whether THIS press can honour one. A jar that refused the record commits at once — the window
 * is only reversible because nothing has been sent, and what made postponing safe was the
 * record. `superseded` names the subject's earlier press this one replaced, for the sentence.
 */
export interface RoutingOpen {
  held: boolean;
  superseded: boolean;
}

export interface RoutingWindow {
  /** One press. Opens a window, or commits at once when the jar refused the record. */
  open: (press: RoutingPress) => RoutingOpen;
  /** Take the press on this subject back. `true` ONLY when a window was open — see below. */
  undo: (subject: string) => boolean;
  /** Commit every open window now, without waiting. Unmount, `pagehide`, sign-out. */
  flush: () => void;
  /** The subjects a window is open over. A NEW set per change, `useSyncExternalStore`'s contract. */
  pending: () => ReadonlySet<string>;
  /**
   * BOOT. Commits what elapsed while the app was closed, RESUMES what did not with the time it
   * has left, and hands back what died of age so the caller can say so. Once per mount.
   */
  replay: (nowMs: number) => { committed: RoutingIntent[]; resumed: RoutingIntent[]; expired: RoutingIntent[] };
}

export interface RoutingWindowDeps {
  /** The jar. A browser's `localStorageDoor`, or {@link memoryRoutingDoor} where there is none. */
  door: StorageDoor;
  /** The journal key — owner-scoped by the caller, whose account rule this is. */
  key: string;
  /**
   * What the routing half is committed THROUGH, one mutation at a time, in order. The engine's
   * ordinary `mutate`: the outbox, the optimistic overlay and the refusal vocabulary all apply,
   * and nothing about the wire changes. It answers, so the caller can correct its own sentence.
   */
  commit: (mutations: readonly EngineMutation[], intent: RoutingIntent) => Promise<void>;
  /** The undo window — the caller's ONE constant (`UNDO_MS`), never a second number. */
  windowMs: number;
  /** Called whenever {@link RoutingWindow.pending} changes, with a NEW set. */
  onPending?: (open: ReadonlySet<string>) => void;
  /** Epoch ms. Injected so the TTL and the resume are testable without a fake clock. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
}

/**
 * A jar that keeps nothing past this session — the phone's, and the honest name for it.
 *
 * React Native has no `localStorage`, and the real door would answer "lost" for every write, so
 * every phone press would commit at once and no routing press would ever be undoable. This keeps
 * the record for as long as the process lives, which is exactly what `held-delete.ts` already
 * ships: leaving the app commits, and a hard kill inside the window loses the PRESS, not the
 * mail. Named rather than inlined so the posture is greppable and a gap row can point at it.
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

  /** One entry per OPEN press, by subject. The intent it holds, and the timer that commits it. */
  const open = new Map<string, { intent: RoutingIntent; timer: ReturnType<typeof setTimeout> }>();

  const publish = (): void => { deps.onPending?.(new Set(open.keys())); };

  /** Drop this subject's row from the journal. Called on Undo, and after a commit has settled. */
  const forget = (subject: string): void => {
    const rows = read(deps.door, deps.key);
    const kept = rows.filter((r) => r.subject !== subject);
    if (kept.length !== rows.length) write(deps.door, deps.key, kept);
  };

  /**
   * SEND IT. The journal row is cleared only once `commit` has SETTLED, never before it
   * dispatches: the engine persists a verb to its outbox ahead of the wire, so between here and
   * that write this journal is the only durable copy of the press and dropping it early reopens
   * the hole one step along — `disarmDeleteIntent`'s own rule.
   */
  const send = (intent: RoutingIntent): void => {
    void deps.commit(intent.mutations, intent).then(
      () => { forget(intent.subject); },
      () => { forget(intent.subject); },
    );
  };

  /** Close one open window and dispatch it. Undo never reaches here — it disarms the timer. */
  const close = (subject: string): void => {
    const entry = open.get(subject);
    if (!entry) return;
    disarm(entry.timer);
    open.delete(subject);
    publish();
    send(entry.intent);
  };

  /** Arm the timer for `ms` and register the window. The journal write is the caller's. */
  const hold = (intent: RoutingIntent, ms: number): void => {
    const timer = arm(() => close(intent.subject), ms);
    open.set(intent.subject, { intent, timer });
    publish();
  };

  return {
    open(press) {
      const intent: RoutingIntent = {
        v: 1,
        subject: press.subject,
        dest: press.dest,
        at: clock(),
        mutations: [...press.mutations],
      };
      /* THE EARLIER PRESS ON THIS SUBJECT IS GONE, TIMER AND ROW TOGETHER — and it is dropped
         rather than committed. Committing it would write the rule the reader has just replaced,
         and then the later one over the top: two rules on the wire for one change of mind. */
      const prior = open.get(intent.subject);
      if (prior) {
        disarm(prior.timer);
        open.delete(intent.subject);
      }
      const rows = read(deps.door, deps.key).filter((r) => r.subject !== intent.subject);
      const written = write(deps.door, deps.key, [...rows, intent]);
      if (written === "lost") {
        /* A REFUSED JAR TAKES THE UNDO AWAY, NOT THE ROUTING. With no record a kill inside the
           window loses a change the toast has already reported — the very defect the journal
           closes, arriving through a private window instead of through a crash. So it goes now
           and the sentence says the undo is not on offer. */
        publish();
        send(intent);
        return { held: false, superseded: prior != null };
      }
      hold(intent, deps.windowMs);
      return { held: true, superseded: prior != null };
    },

    /**
     * NOTHING HELD IS NOT AN UNDO. `false` where no window was open, so a late press cannot be
     * reported as having taken something back — the control the Screener's own `toastUndoExpired`
     * exists for. The journal row goes in the SAME synchronous act as the
     * timer, or the next boot would re-commit a press the reader had just reversed.
     */
    undo(subject) {
      const entry = open.get(subject);
      if (!entry) return false;
      disarm(entry.timer);
      open.delete(subject);
      forget(subject);
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

    pending() { return new Set(open.keys()); },

    replay(nowMs) {
      const rows = read(deps.door, deps.key);
      if (rows.length === 0) return { committed: [], resumed: [], expired: [] };
      const expired: RoutingIntent[] = [];
      const committed: RoutingIntent[] = [];
      const resumed: RoutingIntent[] = [];
      for (const intent of rows.slice().sort((a, b) => a.at - b.at)) {
        /* Already open in THIS session — a second replay, or a press made since the read. The
           live window owns it; re-arming would double the commit. */
        if (open.has(intent.subject)) continue;
        const age = nowMs - intent.at;
        if (age > ROUTING_INTENT_TTL_MS) { expired.push(intent); continue; }
        if (age >= deps.windowMs) { committed.push(intent); continue; }
        resumed.push(intent);
      }
      /* THE EXPIRED ARE SWEPT AND REPORTED, in that order and in one write — a row left in place
         is re-read and re-rejected on every launch for ever, which is a journal that only grows.
         The caller says what died; this only stops it being said twice. */
      if (expired.length > 0) {
        const dead = new Set(expired.map((r) => r.subject));
        write(deps.door, deps.key, rows.filter((r) => !dead.has(r.subject)));
      }
      for (const intent of committed) send(intent);
      /* AND THE WINDOW RESUMES WITH WHAT IT HAS LEFT, rather than restarting: the reader pressed
         at `at`, and a fresh full window would extend an offer they have already half spent. */
      for (const intent of resumed) hold(intent, Math.max(0, deps.windowMs - (nowMs - intent.at)));
      return { committed, resumed, expired };
    },
  };
}
