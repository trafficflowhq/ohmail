/**
 * THE SESSION'S PER-DRAIN READS, one closure, renderer-free so a test drives the shipped cadence.
 * The flag machine calls it at boot and after every drain. The queue shelf (with the relayed
 * decisions on its first page) goes every time; the mailboxes and the consent answer only when the
 * mirror moved since they were last read, after {@link MAILBOXES_REREAD_MS} and {@link FACTS_REREAD_MS},
 * or when the app came back to the front ({@link DrainRead.factsDue}): an idle phone asked both every 8 s. The ENGINE's queue page and
 * undecided-sender offer are asked once per session here — the web's once-per-mount shape — and
 * after that by the engine's own settle when a drain touched the gate, a rule, the settings or a
 * mailbox. Asked on every drain they re-derived every list several times per poll.
 */
import { CHECKED_FACTS_MAX_AGE_MS } from "./live";
import { IDLE_DRAIN_CAP_MS } from "../net/drain-cadence";

export interface EngineQueues {
  refreshScreenerWaiting(): Promise<void>;
  refreshUnscreened(): Promise<void>;
}

/** Ask the engine for its queue page and its offer; a refusal waits for the next ask. */
export function askEngineQueues(engine: EngineQueues): void {
  void engine.refreshScreenerWaiting().catch(() => { /* the settle or the next focus asks again */ });
  void engine.refreshUnscreened().catch(() => { /* an offer the door cannot make is absent */ });
}

/** How long the consent answer stands while the mirror does not move. */
export const FACTS_REREAD_MS = 5 * 60_000;

/**
 * How long the mailboxes stand: the Ohbox's "Checked" line hides facts older than 90 s, so they are
 * re-read once they could lapse before the slowest idle round — about once a minute when idle.
 */
export const MAILBOXES_REREAD_MS = CHECKED_FACTS_MAX_AGE_MS - IDLE_DRAIN_CAP_MS;

export interface DrainReadDeps<C> {
  /** The fire-and-forget reads of every drain, in the order they leave. */
  rest: ReadonlyArray<() => void>;
  /** The fire-and-forget mailbox reads, only when they are due. */
  facts?: ReadonlyArray<() => void>;
  /** The consent read the flag machine awaits (stamped before it leaves — see face-scope.ts). */
  consent: () => Promise<C | null>;
  engine: EngineQueues;
  /** The mirror's change stamp (`store.version()`). Absent, the facts go every time. */
  stamp?: () => number;
  now?: () => number;
  factsEveryMs?: number;
  mailboxesEveryMs?: number;
}

export interface DrainRead<C> {
  (): Promise<C | null>;
  /** The next read asks the mailboxes and the consent whatever the stamp says (the app came back to the front). */
  factsDue(): void;
}

export function drainReads<C>(deps: DrainReadDeps<C>): DrainRead<C> {
  let armed = false;
  const now = deps.now ?? Date.now;
  const mailboxes = gate(deps.mailboxesEveryMs ?? MAILBOXES_REREAD_MS);
  const consent = gate(deps.factsEveryMs ?? FACTS_REREAD_MS);
  const read = (): Promise<C | null> => {
    for (const r of deps.rest) r();
    if (!armed) {
      armed = true;
      askEngineQueues(deps.engine);
    }
    const stamp = deps.stamp?.();
    const at = now();
    if (mailboxes.due(stamp, at)) for (const r of deps.facts ?? []) r();
    // `null` is "could not ask" to the flag machine: it keeps what it last applied.
    if (!consent.due(stamp, at)) return Promise.resolve(null);
    const mine = consent.last();
    const asked = deps.consent();
    // A consent read that got no answer is owed again at the next drain, not in minutes.
    const owed = (): void => consent.owe(mine);
    void asked.then((ans) => { if (ans === null) owed(); }, owed);
    return asked;
  };
  return Object.assign(read, { factsDue: () => { mailboxes.owe(); consent.owe(); } });
}

/**
 * A sent copy landed in a folder this phone does not know as Sent (`OhmailEngine.sentFolderAsks`): the
 * mailbox's Sent folder was recorded since the last read, so the mailboxes are owed and asked now
 * (`ask`, the flag machine's refresh), not at the next round. Answers the unsubscribe.
 */
export function readOnSentFolderAsk(
  engine: { subscribe(l: () => void): () => void; sentFolderAsks(): number },
  read: Pick<DrainRead<unknown>, "factsDue">,
  ask: () => void,
): () => void {
  let seen = engine.sentFolderAsks();
  return engine.subscribe(() => {
    const n = engine.sentFolderAsks();
    if (n <= seen) return;
    seen = n;
    read.factsDue();
    ask();
  });
}

/** One read's due rule: the stamp moved, `everyMs` passed, or it is owed. No stamp: always due. */
function gate(everyMs: number) {
  type Last = { stamp: number; at: number } | null;
  let last: Last = null;
  return {
    due(stamp: number | undefined, at: number): boolean {
      if (stamp === undefined) return true;
      if (last !== null && last.stamp === stamp && at - last.at < everyMs) return false;
      last = { stamp, at };
      return true;
    },
    last: (): Last => last,
    /** Owed again; with `which`, only while that read is still the last one. */
    owe(which?: Last): void { if (which === undefined || (which !== null && last === which)) last = null; },
  };
}
