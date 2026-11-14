/**
 * THE ONE REPORT SLOT. A pure reducer and the hook that runs its clock; the hook's `report` is the press
 * seam's `ToastFn`, so every answer to a press, and Undo, reach the one slot unchanged.
 *
 * 1. A report replaces the report that stands.
 * 2. A report with Undo uses its stored action deadline when supplied, or `UNDO_MS` from arrival.
 *    The press still checks whether the underlying act can be undone.
 * 3. A report with Undo is replaced only by another with Undo or by a `why`. A plain report that arrives
 *    inside the window waits and is drawn when the window ends; a newer waiting one replaces it. A report
 *    nobody pressed for (`yields`) waits behind any report a press raised, as it always has.
 * 4. A plain report stands 2600 ms, or the caller's `duration`. The fade is the kit's.
 * 5. `dismiss` stands until pressed. `signal` withdraws an Undo at once. The Undo's key is shown while it stands.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ToastFn, ToastOptions } from "@ohmail/app-logic/press/report";
import { UNDO_PRESSED } from "@ohmail/app-logic/press/undo-door";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";

export const PLAIN_MS = 2600;

export type ReportClass = "undo" | "why" | "plain" | "aside";
export interface SlotReport {
  readonly calendarScope?: symbol;
  readonly id: number;
  readonly message: string;
  readonly kind: ReportClass;
  /** `undo`: the way back. `why`: the one press that closes it. */
  readonly press: { readonly label: string; readonly keyHint?: string; readonly onPress: () => void } | null;
  /** Default time once drawn when no deadline is supplied; `null` until pressed. */
  readonly stands: number | null;
  readonly actionDeadline?: number;
}
export interface ReportState {
  readonly standing:
    | (SlotReport & {
        readonly since: number;
        readonly leaving: boolean;
        readonly dismissed?: boolean;
        readonly presented?: boolean;
      })
    | null;
  readonly waiting: SlotReport | null;
  readonly calendar: readonly SlotReport[];
}
export type ReportEvent =
  | { readonly type: "arrive"; readonly report: SlotReport; readonly now: number }
  | { readonly type: "end"; readonly id: number }
  | { readonly type: "dismissUndo"; readonly id: number }
  | { readonly type: "presented"; readonly id: number }
  | { readonly type: "retireCalendar"; readonly scope: symbol; readonly now: number }
  | { readonly type: "gone"; readonly id: number; readonly now: number };

export const EMPTY: ReportState = { standing: null, waiting: null, calendar: [] };

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
      ...(options.actionDeadline !== undefined ? { actionDeadline: options.actionDeadline } : {}),
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
  if (standing.leaving || standing.dismissed) return false;
  if (arriving.kind === "aside") return standing.kind !== "aside";
  if (arriving.kind === "plain") return standing.kind === "undo";
  return false;
}

function nextReport(state: ReportState, now: number): ReportState {
  // An explicit result that waited for Undo has first claim on the open slot.
  const calendarFirst = state.waiting?.kind !== "plain" && state.calendar.length > 0;
  const next = calendarFirst ? state.calendar[0] : state.waiting;
  return {
    standing: next ? { ...next, since: now, leaving: false } : null,
    waiting: calendarFirst ? state.waiting : null,
    calendar: calendarFirst ? state.calendar.slice(1) : state.calendar,
  };
}

export function reportSlot(state: ReportState, event: ReportEvent): ReportState {
  switch (event.type) {
    case "arrive": {
      const { report, now } = event;
      const standing = state.standing;
      if (report.calendarScope !== undefined)
        return standing
          ? { ...state, calendar: [...state.calendar, report] }
          : { ...state, standing: { ...report, since: now, leaving: false, presented: false } };
      if (standing && holds(standing, report)) return { ...state, waiting: report };
      // An explicit result can take the slot before React has drawn the Calendar report.
      const calendar =
        standing?.calendarScope !== undefined && !standing.presented
          ? [standing, ...state.calendar]
          : state.calendar;
      return { ...state, standing: { ...report, since: now, leaving: false }, calendar };
    }
    case "end":
      return state.standing?.id === event.id && !state.standing.leaving
        ? { ...state, standing: { ...state.standing, leaving: true } }
        : state;
    case "dismissUndo":
      return state.standing?.id === event.id
        ? { ...state, standing: { ...state.standing, dismissed: true } }
        : state;
    case "presented":
      return state.standing?.id === event.id && !state.standing.presented
        ? { ...state, standing: { ...state.standing, presented: true } }
        : state;
    case "retireCalendar": {
      const calendar = state.calendar.filter((report) => report.calendarScope !== event.scope);
      const kept = { ...state, calendar };
      return state.standing?.calendarScope === event.scope ? nextReport(kept, event.now) : kept;
    }
    case "gone":
      return state.standing?.id === event.id ? nextReport(state, event.now) : state;
  }
}

export interface ReportSlotApi {
  readonly state: ReportState;
  readonly report: ToastFn;
  readonly reportCalendar: (scope: symbol, message: string) => void;
  readonly retireCalendar: (scope: symbol) => void;
  readonly presented: (id: number) => void;
  /** The kit's fade has run: the report leaves the tree. */
  readonly gone: (id: number) => void;
}

export function useReportSlot(now: () => number = Date.now): ReportSlotApi {
  const [state, dispatch] = useReducer(reportSlot, EMPTY);
  const seq = useRef(0);
  const clock = useRef(now);
  clock.current = now;

  const gone = useCallback((id: number) => dispatch({ type: "gone", id, now: clock.current() }), []);
  const presented = useCallback((id: number) => dispatch({ type: "presented", id }), []);
  const retireCalendar = useCallback((scope: symbol) => {
    dispatch({ type: "retireCalendar", scope, now: clock.current() });
  }, []);
  const reportCalendar = useCallback((scope: symbol, message: string) => {
    const report = { ...reportOf(++seq.current, message, undefined, () => {}), calendarScope: scope };
    dispatch({ type: "arrive", report, now: clock.current() });
  }, []);
  const report = useCallback<ToastFn>((message, options) => {
    const id = ++seq.current;
    const finish = () => dispatch({ type: "gone", id, now: clock.current() });
    const made = reportOf(id, message, options, finish);
    const press = made.press;
    const dismiss = () => dispatch({ type: "dismissUndo", id });
    let pressed = false;
    const once =
      made.kind === "undo" && press
        ? {
            ...made,
            press: {
              ...press,
              onPress: () => {
                if (pressed) return;
                pressed = true;
                dismiss();
                try {
                  press.onPress();
                } finally {
                  finish();
                }
              },
            },
          }
        : made;
    const signal = options?.signal;
    signal?.addEventListener(
      "abort",
      () => {
        if (made.kind === "undo" && signal.reason === UNDO_PRESSED) {
          // A keyboard Undo aborts the offer before reporting its result in the same call.
          dismiss();
          void Promise.resolve().then(finish);
        } else {
          finish();
        }
      },
      { once: true },
    );
    dispatch({ type: "arrive", report: once, now: clock.current() });
  }, []);

  const standing = state.standing;
  useEffect(() => {
    if (!standing || standing.leaving || standing.dismissed || standing.stands === null) return;
    const until = standing.actionDeadline ?? standing.since + standing.stands;
    const left = Math.max(0, until - clock.current());
    const timer = setTimeout(() => dispatch({ type: "end", id: standing.id }), left);
    return () => clearTimeout(timer);
  }, [standing]);

  return useMemo(
    () => ({ state, report, gone, reportCalendar, retireCalendar, presented }),
    [state, report, gone, reportCalendar, retireCalendar, presented],
  );
}
