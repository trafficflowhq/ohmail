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
 * 5. Retained recoveries resume newest first and keep their original deadlines.
 * 6. Window notices with `dismiss` stand alongside feedback until pressed.
 * 7. `signal` withdraws an Undo at once. The Undo's key is shown while it stands.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ToastOptions } from "@ohmail/app-logic/press/report";
import { UNDO_PRESSED } from "@ohmail/app-logic/press/undo-door";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";

export const PLAIN_MS = 2600;

export type ReportClass = "undo" | "why" | "plain" | "aside";
export interface SlotReport {
  readonly calendarScope?: symbol;
  readonly scope?: symbol;
  readonly id: number;
  readonly message: string;
  readonly kind: ReportClass;
  /** `undo`: the way back. `why`: the one press that closes it. */
  readonly press: { readonly label: string; readonly keyHint?: string; readonly onPress: () => void } | null;
  /** Default time once drawn when no deadline is supplied; `null` until pressed. */
  readonly stands: number | null;
  readonly actionDeadline?: number;
  readonly undoDuringFade?: boolean;
  readonly retainUndo?: boolean;
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
  readonly recoveries: readonly SlotReport[];
  readonly notices: readonly SlotReport[];
}
export type ReportEvent =
  | { readonly type: "arrive"; readonly report: SlotReport; readonly now: number; readonly notice?: boolean }
  | { readonly type: "end"; readonly id: number }
  | { readonly type: "dismissUndo"; readonly id: number }
  | { readonly type: "presented"; readonly id: number }
  | { readonly type: "retireCalendar"; readonly scope: symbol; readonly now: number }
  | { readonly type: "retireScope"; readonly scope: symbol; readonly now: number }
  | { readonly type: "gone"; readonly id: number; readonly now: number };

export const EMPTY: ReportState = {
  standing: null,
  waiting: null,
  calendar: [],
  recoveries: [],
  notices: [],
};

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
      stands: options.actionUntilPressed ? null : UNDO_MS,
      ...(options.actionDeadline !== undefined ? { actionDeadline: options.actionDeadline } : {}),
      ...(options.retainUndo ? { retainUndo: true } : {}),
      ...(options.undoDuringFade ? { undoDuringFade: true } : {}),
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

function liveRecoveries(recoveries: readonly SlotReport[], now: number) {
  return recoveries.filter((report) => (report.actionDeadline ?? 0) > now);
}

function nextReport(state: ReportState, now: number): ReportState {
  const [recovery, ...recoveries] = liveRecoveries(state.recoveries, now);
  if (recovery) return { ...state, recoveries, standing: { ...recovery, since: now, leaving: false } };
  // An explicit result that waited for Undo has first claim on the open slot.
  const calendarFirst = state.waiting?.kind !== "plain" && state.calendar.length > 0;
  const next = calendarFirst ? state.calendar[0] : state.waiting;
  return {
    ...state,
    standing: next ? { ...next, since: now, leaving: false } : null,
    waiting: calendarFirst ? state.waiting : null,
    calendar: calendarFirst ? state.calendar.slice(1) : state.calendar,
    recoveries,
  };
}

export function reportSlot(state: ReportState, event: ReportEvent): ReportState {
  switch (event.type) {
    case "arrive": {
      const { report, now } = event;
      if (event.notice)
        return state.notices.some((notice) => notice.message === report.message)
          ? state
          : { ...state, notices: [...state.notices, report] };
      const standing = state.standing;
      if (report.calendarScope !== undefined)
        return standing
          ? { ...state, calendar: [...state.calendar, report] }
          : { ...state, standing: { ...report, since: now, leaving: false, presented: false } };
      if (
        standing &&
        (holds(standing, report) ||
          (standing.dismissed && report.kind === "plain" && liveRecoveries(state.recoveries, now).length))
      ) {
        return { ...state, waiting: report };
      }
      // An explicit result can take the slot before React has drawn the Calendar report.
      const calendar =
        standing?.calendarScope !== undefined && !standing.presented
          ? [standing, ...state.calendar]
          : state.calendar;
      const recoveries = liveRecoveries(state.recoveries, now);
      if (
        standing?.retainUndo &&
        !standing.dismissed &&
        !standing.leaving &&
        (standing.actionDeadline ?? 0) > now
      ) {
        recoveries.unshift(standing);
      }
      return { ...state, standing: { ...report, since: now, leaving: false }, calendar, recoveries };
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
    case "retireScope": {
      const waiting = state.waiting?.scope === event.scope ? null : state.waiting;
      const recoveries = state.recoveries.filter((report) => report.scope !== event.scope);
      const kept = { ...state, waiting, recoveries };
      return state.standing?.scope === event.scope ? nextReport(kept, event.now) : kept;
    }
    case "gone":
      if (state.standing?.id === event.id) return nextReport(state, event.now);
      if (state.notices.some((notice) => notice.id === event.id))
        return { ...state, notices: state.notices.filter((notice) => notice.id !== event.id) };
      return state;
  }
}

export interface ReportSlotApi {
  readonly state: ReportState;
  readonly report: (message: string, options?: ToastOptions, scope?: symbol) => void;
  readonly reportCalendar: (scope: symbol, message: string) => void;
  readonly retireCalendar: (scope: symbol) => void;
  readonly retireScope: (scope: symbol) => void;
  readonly presented: (id: number) => void;
  /** The kit's fade has run: the report leaves the tree. */
  readonly gone: (id: number) => void;
}

export function useReportSlot(now: () => number = Date.now, keepWindowNotices = false): ReportSlotApi {
  const [state, dispatch] = useReducer(reportSlot, EMPTY);
  const seq = useRef(0);
  const clock = useRef(now);
  clock.current = now;

  const gone = useCallback((id: number) => dispatch({ type: "gone", id, now: clock.current() }), []);
  const presented = useCallback((id: number) => dispatch({ type: "presented", id }), []);
  const retireCalendar = useCallback((scope: symbol) => {
    dispatch({ type: "retireCalendar", scope, now: clock.current() });
  }, []);
  const retireScope = useCallback((scope: symbol) => {
    dispatch({ type: "retireScope", scope, now: clock.current() });
  }, []);
  const reportCalendar = useCallback((scope: symbol, message: string) => {
    const report = { ...reportOf(++seq.current, message, undefined, () => {}), calendarScope: scope };
    dispatch({ type: "arrive", report, now: clock.current() });
  }, []);
  const report = useCallback<ReportSlotApi["report"]>(
    (message, options, scope) => {
      const id = ++seq.current;
      const finish = () => dispatch({ type: "gone", id, now: clock.current() });
      const made = { ...reportOf(id, message, options, finish), ...(scope === undefined ? {} : { scope }) };
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
      dispatch({
        type: "arrive",
        report: once,
        now: clock.current(),
        notice: keepWindowNotices && scope === undefined && made.kind === "why",
      });
    },
    [keepWindowNotices],
  );

  const standing = state.standing;
  useEffect(() => {
    if (!standing || standing.leaving || standing.dismissed || standing.stands === null) return;
    const until = standing.actionDeadline ?? standing.since + standing.stands;
    const left = Math.max(0, until - clock.current());
    const timer = setTimeout(() => dispatch({ type: "end", id: standing.id }), left);
    return () => clearTimeout(timer);
  }, [standing]);

  return useMemo(
    () => ({ state, report, gone, reportCalendar, retireCalendar, retireScope, presented }),
    [state, report, gone, reportCalendar, retireCalendar, retireScope, presented],
  );
}
