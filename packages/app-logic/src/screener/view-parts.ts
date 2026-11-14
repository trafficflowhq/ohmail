/**
 * THE VIEW'S PARTS: what is asked of the person before anything leaves (Mark all spam's question, the unsubscribe
 * question), the one way a decision leaves, what stands open beside the open sender, and the open letters' bodies.
 */
import { useEffect, useRef, useState } from "react";
import { senderKey, type ScreenerSenderDTO } from "@ohmail/client-engine";
import { useEngineOrNull } from "../engine/context.js";
import { isNothingOrganizes, type OrganizerRefusal } from "../press/organizer-refusal.js";
import type { DecisionDestination, DecisionScope } from "./decision.js";
import type { KeySegment } from "./keys.js";
import { nextAfterDecision } from "./next-sender.js";
import type { ScreenerState } from "./screener-state.js";
import type { ScreenerAsk, ScreenerShown } from "./view.js";

/**
 * A DECISION THIS INSTALL'S PRESS WOULD MEET REFUSED: the model's own guard, read by every place that offers a
 * decision. A reader that may not decide, or a mailbox nothing organizes yet, unless this install asked to take it over.
 */
export const refused = (
  r: ScreenerState["role"] & { pressRefusal?: OrganizerRefusal | null; takeoverAsked?: true },
) => r.takeoverAsked !== true && (r.mode === "blocked" || isNothingOrganizes(r.pressRefusal));

/**
 * Mark all spam's question: the senders it named when it opened. It closes once nobody it named is left, so a later
 * arrival never reopens it; the yes moves the senders it named, and only them.
 */
export function useAllSpamAsk(
  state: ScreenerState,
  scopeOf: (s: ScreenerSenderDTO) => DecisionScope,
  segment: KeySegment,
) {
  const [askSet, setAskSet] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => setAskSet(null), [segment]);
  const asked =
    askSet === null
      ? []
      : state.waiting.filter((w) => !state.isExiting(w.id) && askSet.has(senderKey(w.from.address)));
  useEffect(() => {
    if (askSet !== null && asked.length === 0) setAskSet(null);
  }, [askSet, asked.length]);
  return {
    asked,
    open: askSet !== null,
    close: () => setAskSet(null),
    ask: () => {
      const named = state.waiting.filter((w) => !state.isExiting(w.id));
      if (named.length > 0) setAskSet(new Set(named.map((w) => senderKey(w.from.address))));
    },
    answer: (yes: boolean) => {
      const set = askSet;
      setAskSet(null);
      if (yes && set !== null) state.markAllSpam(scopeOf, (w) => set.has(senderKey(w.from.address)));
    },
  };
}

/**
 * THE MOUNTED LETTERS' BODIES ASK AS ONE URGENT REQUEST: a person is reading them, so they do not queue behind
 * background work. Keyed on the exact ids, so it asks again when the open sender changes, never when a body lands.
 * Asking is all it does: no letter turns read.
 */
export function useHeldBodies(ids: readonly string[]): void {
  const engine = useEngineOrNull();
  const key = ids.join(",");
  useEffect(() => {
    if (engine !== null && key !== "") void engine.hydrateBodies(key.split(","), { urgent: true });
  }, [engine, key]);
}

/**
 * What stands open beside the open sender, for the sender it was opened on: opening another closes it, unless the
 * press that opened the sender opened it too (a right click). A section of its own starts with nothing open.
 */
export function useShown(openId: string | null, segment: KeySegment) {
  const [shown, setShown] = useState<ScreenerShown>(null);
  const after = useRef<ScreenerShown>(null);
  useEffect(() => setShown(null), [segment]);
  useEffect(() => {
    setShown(after.current);
    after.current = null;
  }, [openId]);
  /** Open `then` with the sender a press opens: at once where it is open already. */
  const openWith = (id: string, then: ScreenerShown) => {
    if (id === openId) setShown(then);
    else after.current = then;
  };
  return { shown, setShown, openWith };
}

export interface DecideInput {
  readonly state: ScreenerState;
  readonly segment: KeySegment;
  readonly openId: string | null;
  /** The open waiting sender nobody has decided yet. */
  readonly openWaiting: ScreenerSenderDTO | null;
  /** Every id the section walks, and whether one is still a row to move to. */
  readonly ids: readonly string[];
  readonly isRow: (id: string) => boolean;
  readonly scopeOf: (s: ScreenerSenderDTO) => DecisionScope;
  /** What follows a decision that left: the menus close, the next sender opens (none: nothing is open). */
  readonly left: (next: string | null) => void;
  readonly closeShown: () => void;
}

/**
 * THE ONE WAY A DECISION LEAVES: the model's `decide`, once any question before it has its yes. Screen out and Spam
 * that would send a one-click unsubscribe ask first: no request leaves before its yes. A refused press (a reader's
 * install that may not decide) moves nothing: the person stays on that sender.
 */
export function useDecide(input: DecideInput) {
  const { state, openWaiting, scopeOf } = input;
  const [unsub, setUnsub] = useState<Extract<ScreenerAsk, { kind: "unsub" }> | null>(null);
  useEffect(() => setUnsub(null), [input.segment, input.openId]);
  /* `stay`: a row's own press on a sender that is not the open one leaves the selection where it is. */
  const leave = (sender: ScreenerSenderDTO, dest: DecisionDestination, read: boolean, stay = false) => {
    const next = nextAfterDecision(input.ids, sender.id, (id) => input.isRow(id) && !state.isExiting(id));
    input.closeShown();
    state.decide(sender, dest, { read, scope: scopeOf(sender) });
    if (refused(state.role) || stay) return;
    input.left(next);
  };
  const decide = (dest: DecisionDestination, read: boolean) => {
    if (openWaiting === null) return;
    const demoting = dest === "screened" || dest === "spam";
    if (
      demoting &&
      !refused(state.role) &&
      state.unsubClaimOf(openWaiting, scopeOf(openWaiting)) !== "none"
    ) {
      input.closeShown();
      setUnsub({ kind: "unsub", sender: openWaiting, dest, read });
      return;
    }
    leave(openWaiting, dest, read);
  };
  /**
   * A row's accept: the open sender's goes the open sender's way. Another sender's asks first as well where an
   * unsubscribe would go out, about that sender; else the press alone files them, and the selection stays.
   */
  const decideRow = (sender: ScreenerSenderDTO, dest: DecisionDestination) => {
    if (sender.id === input.openId) return decide(dest, false);
    const demoting = dest === "screened" || dest === "spam";
    if (demoting && !refused(state.role) && state.unsubClaimOf(sender, scopeOf(sender)) !== "none") {
      input.closeShown();
      setUnsub({ kind: "unsub", sender, dest, read: false });
      return;
    }
    leave(sender, dest, false, true);
  };
  const answerUnsub = (yes: boolean) => {
    const asked = unsub;
    setUnsub(null);
    if (yes && asked !== null) leave(asked.sender, asked.dest, asked.read, asked.sender.id !== input.openId);
  };
  return { decide, decideRow, answerUnsub, unsub, dropUnsub: () => setUnsub(null) };
}

/** The first of the closers that stands, or null where nothing is open. */
export function firstOf(closers: readonly (false | (() => void))[]): (() => void) | null {
  return closers.find((c): c is () => void => c !== false) ?? null;
}

/** j and k: the row below and the row above the open one, clamped at the list's ends. */
export function walk(
  ids: readonly string[],
  openId: string | null,
  to: (id: string) => void,
): { down: (() => void) | null; up: (() => void) | null } {
  const at = openId === null ? -1 : ids.indexOf(openId);
  const next = ids[at + 1];
  const prev = at > 0 ? ids[at - 1] : undefined;
  return {
    down: next === undefined ? null : () => to(next),
    up: prev === undefined ? null : () => to(prev),
  };
}
