/**
 * A STORE READ THE SESSION REFUSED IS ASKED AGAIN ONCE THE SESSION RENEWS — one rule, for the
 * browser and the phone. A 401 on a History or Search page is the credential's answer, not the
 * store's: the read asks for the renewal itself, counts as loading while it is out, and asks again
 * on the renewal the platform publishes. Bounded three ways: one renewal per refusal, one re-ask
 * per renewal, and the store's own ceiling ends the wait. A server fault is said at once.
 */
import { STORE_ANSWER_TIMEOUT_MS } from "./store-timeline.js";

/** A platform's session, as far as a refused read needs it. */
export interface SessionRenewalDoor {
  /** Ask for a renewal now: single-flight on the platform, a no-op where nothing renews. */
  renew(): void;
  /** Hear every renewed session. Returns the unsubscribe. */
  onRenewed(cb: () => void): () => void;
  /** The session is confirmed over: a refusal is then said, never waited on. */
  ended(): boolean;
}

/** One store read, as the walkers expose it. */
export interface StoreReadSource {
  subscribe(cb: () => void): () => void;
  /** The read's failure class (`failureCause()`), or `null`. */
  cause(): string | null;
  /** Page one landed. */
  answered(): boolean;
  /** Ask the store again. */
  reask(): void;
}

/** Is this failure a refused credential? The engine's `errorClassOf` reads `<name> <status> <code>`. */
export function sessionRefused(cause: string | null): boolean {
  return cause !== null && cause.split(" ").includes("401");
}

export interface SessionReask {
  /** Watch the read and the session. Returns the stop; a second attach re-reads the read. */
  attach(): () => void;
  /** Show the read as still loading: it was refused and its renewal is out. */
  renewing(): boolean;
  subscribe(cb: () => void): () => void;
  revision(): number;
}

type Phase = "idle" | "waiting" | "reasked" | "overdue";

export function createSessionReask(
  door: SessionRenewalDoor | null,
  read: StoreReadSource,
  ceilingMs: number = STORE_ANSWER_TIMEOUT_MS,
): SessionReask {
  let phase: Phase = "idle";
  let refused = false;
  let answered = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rev = 0;
  const listeners = new Set<() => void>();
  const set = (next: Phase): void => {
    if (next === phase) return;
    phase = next;
    rev += 1;
    for (const l of [...listeners]) l();
  };
  const stopTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  /** The read moved: an answer ends the episode; a new refusal starts one or ends the last. */
  const observe = (): void => {
    const nowAnswered = read.answered();
    if (nowAnswered && !answered) set("idle");
    answered = nowAnswered;
    const nowRefused = sessionRefused(read.cause());
    if (nowRefused === refused) return;
    refused = nowRefused;
    stopTimer();
    if (!refused || door === null) return;
    // Refused again after a renewal: said, and no further renewal (a server refusing every session).
    if (phase === "reasked") return set("overdue");
    if (phase !== "waiting") {
      set("waiting");
      door.renew();
    }
    timer = setTimeout(() => {
      timer = null;
      if (phase === "waiting") set("overdue");
    }, ceilingMs);
  };

  return {
    attach() {
      const offRead = read.subscribe(observe);
      const offDoor = door?.onRenewed(() => {
        if (!refused) return;
        set("reasked");
        read.reask();
      });
      refused = false;
      observe();
      return () => {
        offRead();
        offDoor?.();
        stopTimer();
      };
    },
    renewing() {
      if (door === null || door.ended() || !sessionRefused(read.cause())) return false;
      return phase === "idle" || phase === "waiting";
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    revision: () => rev,
  };
}
