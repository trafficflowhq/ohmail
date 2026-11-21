import { createContext, useContext, useMemo, useRef, type ReactElement, type ReactNode } from "react";
import type { CalendarPort } from "@ohmail/app-logic/calendar";
import type { CalendarSuggestionRecord } from "@ohmail/app-logic/calendar/found";
import { isProtected } from "@ohmail/app-logic/reader";
import type { EngineMessage } from "@ohmail/wire";
import { FoundEventRow } from "@ohmail/ui/calendar";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import { useFrame, useReport } from "../frame/commands.js";
import { usePressWhereOn } from "../frame/room.js";
import { NONE } from "../host/index.js";
import { useAdd, useFound } from "../frommail/use-found.js";
import { whenOf } from "../invitations/index.js";
import { useLocale, useText } from "../text/index.js";

const ReceiptEventRows = createContext<(message: EngineMessage) => ReactElement[] | null>(() => null);

/** Use the same offers and calendar actions as From mail, associated with the receipt that supplied each offer. */
export function ReceiptEvents({ children }: { children: ReactNode }) {
  const { host } = useFrame();
  const port = host.wires.calendar;
  const calendar = host.features.calendar;
  if (port === NONE || calendar === NONE || calendar.places.frommail === NONE) return children;
  return <ReceiptEventsOn port={port}>{children}</ReceiptEventsOn>;
}

function useDismiss(port: CalendarPort) {
  const t = useText("frommail");
  const mailWords = useText("ohbox");
  const report = useReport();
  const retryWords = useText("viewError");
  const press = usePressWhereOn();
  const pending = useRef(new Set<string>());
  const setDismissed = port.setSuggestionDismissed;
  if (!setDismissed || !press) return undefined;

  return async (id: string) => {
    if (pending.current.has(id)) return;
    const reservation = press.reserveUndo();
    if (!reservation) return;
    const { claim, signal, drop } = reservation;
    const toast = press.undoToast;
    const restore = async () => {
      if (signal.aborted) return;
      try {
        await setDismissed(id, false);
      } catch {
        if (signal.aborted) return;
        toast(t("restoreFailed"), {
          action: retryWords("tryAgain"),
          undo: true,
          actionUntilPressed: true,
          signal,
          onAction: () => void restore(),
        });
      }
    };
    pending.current.add(id);
    try {
      await setDismissed(id, true);
      if (!signal.aborted) {
        toast(t("dismissed"), {
          action: mailWords("undo"),
          undo: true,
          duration: UNDO_MS,
          claim,
          signal,
          onAction: () => void restore(),
        });
      }
    } catch {
      if (!signal.aborted) report(t("dismissFailed"));
    } finally {
      drop();
      pending.current.delete(id);
    }
  };
}

function ReceiptEventsOn({ port, children }: { port: CalendarPort; children: ReactNode }) {
  const { commands, host } = useFrame();
  const t = useText("frommail");
  const dismiss = useDismiss(port);
  const locale = useLocale();
  const found = useFound(port);
  const { add } = useAdd(port, found);
  const source = useMemo(
    () =>
      new Map(
        (found?.rows.length
          ? host.engine.store.entries<CalendarSuggestionRecord | null>("calendar_suggestion")
          : []
        ).flatMap(({ entity }) => (entity ? [[entity.id, entity] as const] : [])),
      ),
    [found, host.engine],
  );
  const render = (message: EngineMessage) => {
    if (found === null || isProtected(message)) return null;
    const { onCalendar, rows, target, today, toneOf } = found;
    const own = rows.filter((row) => {
      const record = source.get(row.id);
      return record?.messageId === message.id && record.mailboxId === message.mailboxId;
    });
    if (own.length === 0) return null;
    return own.map((row) => {
      const on = row.alreadyOn;
      return (
        <FoundEventRow
          key={row.id}
          when={whenOf({ ...row.when, endMinute: null }, row.day, today, locale, t)}
          title={row.title}
          second={on === null ? (row.place ?? undefined) : t("onCalendar")}
          add={
            on === null && target !== null
              ? { label: t("add"), onPress: () => void add([row], target.id) }
              : undefined
          }
          dismiss={
            on === null && dismiss ? { label: t("dismiss"), onPress: () => void dismiss(row.id) } : undefined
          }
          on={
            on === null
              ? undefined
              : {
                  tone: toneOf(onCalendar(row)),
                  show: { label: t("show"), onPress: () => commands.event(on) },
                }
          }
        />
      );
    });
  };
  return <ReceiptEventRows.Provider value={render}>{children}</ReceiptEventRows.Provider>;
}

export function useReceiptEventRows(message: EngineMessage) {
  return useContext(ReceiptEventRows)(message);
}
