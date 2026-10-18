/**
 * THE FIRST RUN'S PULL ENDS WHEN THE IMPORT IS OVER AND THE STORE HAS ANSWERED THE QUEUE SINCE.
 *
 * Two facts, two clocks: the import's end comes from the facts poll and the strip
 * (`importOver`), the Screener's waiting count from the store's queue page, asked at mount and
 * again only after a sync page that touched the gate. When the stamp's poll landed first, the
 * walk had no `decide` step, the run went to the summary, and "Open ohmail" closed the flow for
 * good while the held senders arrived seconds later.
 *
 * So the end of the import, seen while the run is open, asks the store once more and holds the
 * pull until it answers. The store answers from the database the stamp was written to, so one
 * ask after the edge is authoritative; the bound is only for a store that never answers.
 */
import { useEffect, useRef, useState } from "react";

/** How long the pull waits for the store's answer before it goes on with the count it has. */
export const QUEUE_SETTLE_MS = 8_000;

/**
 * THE AGREE'S OWN SWEEP. On Cloud the import often ends before Agree (a reader imports with no
 * consent), and the Screener's senders are written after the press, by the sweep the doorbell
 * starts: the hold above never fires there. The stage holds the pull for the senders its Agree
 * showed, re-asking every {@link AGREE_REREAD_MS}, until they land or this bound (from the press)
 * runs out. It covers the worker's doorbell, its pass and the sweep.
 */
export const AGREE_SWEEP_MS = 20_000;
export const AGREE_REREAD_MS = 3_000;

export type QueueSettleState =
  /* `armed`: this mailbox's import was seen NOT over while the run was open, so its end is an
     edge. A run that opens over a finished import holds nothing (a resume). */
  | { kind: "idle"; mailboxId: string | null; armed: boolean }
  /* `rearm`: the import went back to running while the ask was out, so the answer predates
     the next end and re-arms rather than settles. */
  | { kind: "asking"; mailboxId: string; since: number; rearm: boolean }
  | { kind: "answered"; mailboxId: string };

export type QueueSettleEvent =
  | { kind: "over"; mailboxId: string; now: number }
  | { kind: "notOver"; mailboxId: string }
  | { kind: "answered"; mailboxId: string }
  | { kind: "timeout"; mailboxId: string }
  | { kind: "inactive" };

export const QUEUE_SETTLE_START: QueueSettleState = { kind: "idle", mailboxId: null, armed: false };

/** The next state, and whether this event asks the store. Never asks while an ask is out. */
export function queueSettleNext(
  state: QueueSettleState,
  event: QueueSettleEvent,
): { state: QueueSettleState; ask: boolean } {
  const stay = { state, ask: false };
  switch (event.kind) {
    case "inactive":
      return { state: QUEUE_SETTLE_START, ask: false };
    case "notOver":
      if (state.kind === "asking" && state.mailboxId === event.mailboxId) {
        return { state: { ...state, rearm: true }, ask: false };
      }
      return { state: { kind: "idle", mailboxId: event.mailboxId, armed: true }, ask: false };
    case "over":
      if (state.mailboxId !== event.mailboxId) {
        // A mailbox seen for the first time, already over: nothing to wait for.
        return { state: { kind: "idle", mailboxId: event.mailboxId, armed: false }, ask: false };
      }
      if (state.kind === "asking") {
        // The pending answer post-dates this end too.
        return state.rearm ? { state: { ...state, rearm: false }, ask: false } : stay;
      }
      if (state.kind === "idle" && state.armed) {
        return { state: { kind: "asking", mailboxId: event.mailboxId, since: event.now, rearm: false }, ask: true };
      }
      return stay;
    case "answered":
    case "timeout":
      if (state.kind !== "asking" || state.mailboxId !== event.mailboxId) return stay;
      return {
        state: state.rearm
          ? { kind: "idle", mailboxId: state.mailboxId, armed: true }
          : { kind: "answered", mailboxId: state.mailboxId },
        ask: false,
      };
  }
}

/** Is the pull of this mailbox's run held for the store's answer. */
export function queueSettling(state: QueueSettleState, mailboxId: string | null): boolean {
  return mailboxId !== null && state.kind === "asking" && state.mailboxId === mailboxId;
}

/**
 * The strip's `importOver` as the run reads it: the hold only narrows `true` to `false`, and an
 * absent answer stays absent — absent is "cannot tell" and falls back to the stamp
 * (`importOverOf`), which a `false` or a `null` here would override.
 */
export function firstRunImportOver(stripOver: boolean | undefined, settling: boolean): boolean | undefined {
  return settling ? false : stripOver;
}

/**
 * The hold, for the shell. `over` is the run's own reading of the import (`importOverOf` over the
 * stamp and the strip), never the strip's alone: absent on a host that cannot tell, it would never
 * end and never hold. `reread` asks the store for the queue; one ask per end of the import.
 */
export function useFirstRunQueueSettle({ active, mailboxId, over, reread }: {
  active: boolean;
  mailboxId: string | null;
  over: boolean;
  reread: () => Promise<void>;
}): boolean {
  const rereadRef = useRef(reread);
  rereadRef.current = reread;
  const [state, setState] = useState<QueueSettleState>(QUEUE_SETTLE_START);
  const stateRef = useRef(state);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The ask in flight; an answer from an earlier one settles nothing. */
  const seq = useRef(0);
  const key = active ? mailboxId : null;
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    const step = (event: QueueSettleEvent): boolean => {
      const next = queueSettleNext(stateRef.current, event);
      stateRef.current = next.state;
      setState(next.state);
      return next.ask;
    };
    if (keyRef.current !== key) {
      keyRef.current = key;
      seq.current += 1;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      step({ kind: "inactive" });
    }
    if (key === null) return;
    if (!over) {
      step({ kind: "notOver", mailboxId: key });
      return;
    }
    if (!step({ kind: "over", mailboxId: key, now: Date.now() })) return;
    const mine = ++seq.current;
    const release = (kind: "answered" | "timeout") => {
      if (seq.current !== mine) return;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      step({ kind, mailboxId: key });
    };
    timer.current = setTimeout(() => release("timeout"), QUEUE_SETTLE_MS);
    void Promise.resolve()
      .then(() => rereadRef.current())
      .then(() => release("answered"), () => release("answered"));
  }, [key, over]);
  /* No unmount cleanup: a strict-mode remount would void the ask in flight and hold the pull for
     good. A release after unmount sets state on nothing. */

  /* THE RENDER THAT SEES THE END ALREADY HOLDS. The ask starts in the effect after it; without
     this, that one render reads the import over and the summary is drawn for a frame. */
  const edge = key !== null && over && keyRef.current === key
    && queueSettleNext(state, { kind: "over", mailboxId: key, now: 0 }).ask;
  return queueSettling(state, key) || edge;
}
