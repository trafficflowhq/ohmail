/**
 * THE ONE REPORT SLOT. A pure reducer and the hook that runs its clock; the hook's `report` is the press
 * seam's `ToastFn`, so every answer to a press, and Undo, reach the one slot unchanged.
 *
 * 1. A report replaces the report that stands.
 * 2. A report with Undo stands for `UNDO_MS`. The window is the guard's: replacing the capsule never
 *    shortens or ends the decision's own window, which runs on the press's timer, not here.
 * 3. A report with Undo is replaced only by another with Undo or by a `why`. A plain report that arrives
 *    inside the window waits and is drawn when the window ends; a newer waiting one replaces it. A report
 *    nobody pressed for (`yields`) waits behind any report a press raised, as it always has.
 * 4. A plain report stands 2600 ms, or the caller's `duration`. The fade is the kit's.
 * 5. `dismiss` stands until pressed. `signal` withdraws an Undo at once. The Undo's key is shown while it stands.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ToastFn, ToastOptions } from "@ohmail/app-logic/press/report";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";

export const PLAIN_MS = 2600;

export type ReportClass = "undo" | "why" | "plain" | "aside";
export interface SlotReport {
  readonly id: number;
  readonly message: string;
  readonly kind: ReportClass;
  /** `undo`: the way back. `why`: the one press that closes it. */
  readonly press: { readonly label: string; readonly keyHint?: string; readonly onPress: () => void } | null;
  /** How long it stands once drawn; `null` until pressed. */
  readonly stands: number | null;
}
export interface ReportState {
  readonly standing: (SlotReport & { readonly since: number; readonly leaving: boolean }) | null;
  readonly waiting: SlotReport | null;
}
export type ReportEvent =
  | { readonly type: "arrive"; readonly report: SlotReport; readonly now: number }
  | { readonly type: "end"; readonly id: number }
  | { readonly type: "gone"; readonly id: number; readonly now: number };

export const EMPTY: ReportState = { standing: null, waiting: null };

/** A report as the press seam hands it in. */
export function reportOf(
  id: number,
  message: string,
  options: ToastOptions | undefined,
  close: () => void,
): SlotReport {
  if (options?.action && options.onAction) {
    const onAction = options.onAction;
    return {
      id,
      message,
      kind: "undo",
      press: { label: options.action, keyHint: options.actionKey, onPress: onAction },
      stands: UNDO_MS,
    };
  }
  if (options?.dismiss)
    return { id, message, kind: "why", press: { label: options.dismiss, onPress: close }, stands: null };
  return {
    id,
    message,
    kind: options?.yields ? "aside" : "plain",
    press: null,
    stands: options?.duration ?? PLAIN_MS,
  };
}

/** Whether the report that stands holds the slot against one that arrives. */
function holds(standing: NonNullable<ReportState["standing"]>, arriving: SlotReport): boolean {
  if (standing.leaving) return false;
  if (arriving.kind === "aside") return standing.kind !== "aside";
  if (arriving.kind === "plain") return standing.kind === "undo";
  return false;
}

export function reportSlot(state: ReportState, event: ReportEvent): ReportState {
  switch (event.type) {
    case "arrive": {
      const { report, now } = event;
      if (state.standing && holds(state.standing, report)) return { ...state, waiting: report };
      return { ...state, standing: { ...report, since: now, leaving: false } };
    }
    case "end":
      return state.standing?.id === event.id && !state.standing.leaving
        ? { ...state, standing: { ...state.standing, leaving: true } }
        : state;
    case "gone": {
      if (state.standing?.id !== event.id) return state;
      const next = state.waiting;
      return { standing: next ? { ...next, since: event.now, leaving: false } : null, waiting: null };
    }
  }
}

export interface ReportSlotApi {
  readonly state: ReportState;
  readonly report: ToastFn;
  /** The kit's fade has run: the report leaves the tree. */
  readonly gone: (id: number) => void;
}

export function useReportSlot(now: () => number = Date.now): ReportSlotApi {
  const [state, dispatch] = useReducer(reportSlot, EMPTY);
  const seq = useRef(0);
  const clock = useRef(now);
  clock.current = now;

  const gone = useCallback((id: number) => dispatch({ type: "gone", id, now: clock.current() }), []);
  const report = useCallback<ToastFn>((message, options) => {
    const id = ++seq.current;
    const close = () => dispatch({ type: "gone", id, now: clock.current() });
    const made = reportOf(id, message, options, close);
    const press = made.press;
    /* The way back fires at most once, and the capsule leaves with the press. */
    const once =
      made.kind === "undo" && press
        ? { ...made, press: { ...press, onPress: () => (close(), press.onPress()) } }
        : made;
    options?.signal?.addEventListener("abort", close, { once: true });
    dispatch({ type: "arrive", report: once, now: clock.current() });
  }, []);

  const standing = state.standing;
  useEffect(() => {
    if (!standing || standing.leaving || standing.stands === null) return;
    const left = Math.max(0, standing.since + standing.stands - clock.current());
    const timer = setTimeout(() => dispatch({ type: "end", id: standing.id }), left);
    return () => clearTimeout(timer);
  }, [standing]);

  return useMemo(() => ({ state, report, gone }), [state, report, gone]);
}
