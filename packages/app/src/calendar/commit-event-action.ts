import { pressAndHear, type CalendarPort } from "@ohmail/app-logic/calendar";
import type { ToastFn } from "@ohmail/app-logic/press/report";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import type { CalendarAct } from "@ohmail/wire";
import type { Text } from "../text/index.js";

export async function commitAction(
  port: CalendarPort,
  act: CalendarAct,
  guests: readonly string[],
  locale: string,
  e: Text,
  report: ToastFn,
  current: () => boolean,
  close: () => void,
  updated?: (act: Extract<CalendarAct, { kind: "calendar_event_update" }>) => void,
  destination?: string,
) {
  if (act.kind === "calendar_event_delete" && guests.length === 0 && port.holdDelete) {
    const held = await port.holdDelete(act, UNDO_MS);
    if (!current()) return;
    const remaining = held.remainingMs();
    report(
      e(act.hide ? "taken.hide" : "taken.delete"),
      remaining > 0
        ? {
            action: e("undoDelete"),
            duration: remaining,
            actionDeadline: held.deadline,
            onAction: () => {
              if (held.remainingMs() <= 0) {
                report(e("undoLate"));
                return;
              }
              void held.undo().then(
                (restored) => report(e(restored ? "deleteUndone" : "undoLate")),
                () => report(e("refusal.unknown")),
              );
            },
          }
        : undefined,
    );
    close();
    return;
  }
  const heard = await pressAndHear(port, act);
  if (!current()) return;
  if (heard.verdict?.kind === "refused" && heard.verdict.word === "version_stale")
    report(e("refusal.changed"));
  else if (heard.verdict?.kind === "taken" && act.kind === "calendar_event_delete" && act.hide)
    report(e("taken.hide"));
  else if (heard.verdict?.kind === "taken" && act.kind === "calendar_event_delete" && guests.length)
    report(e("taken.deleteAudience", { guests: new Intl.ListFormat(locale).format(guests) }));
  else if (heard.verdict?.kind === "taken" && act.kind === "calendar_event_update" && updated) updated(act);
  else if (heard.verdict?.kind === "taken" && act.kind === "calendar_event_move" && destination)
    report(act.copyThenRemove && heard.verdict.write?.state !== "applied" ? e("movePending") : destination);
  else if (heard.say) report(e(heard.say));
  if (heard.verdict?.kind !== "refused") close();
}
