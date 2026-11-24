import { createContext, useContext, useMemo, type ReactElement, type ReactNode } from "react";
import type { CalendarPort } from "@ohmail/app-logic/calendar";
import type { CalendarSuggestionRecord } from "@ohmail/app-logic/calendar/found";
import { isProtected } from "@ohmail/app-logic/reader";
import type { EngineMessage } from "@ohmail/wire";
import { FoundEventRow } from "@ohmail/ui/calendar";
import { useFrame } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useAdd, useDismissFound, useFound } from "../frommail/use-found.js";
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

function ReceiptEventsOn({ port, children }: { port: CalendarPort; children: ReactNode }) {
  const { commands, host } = useFrame();
  const t = useText("frommail");
  const dismiss = useDismissFound(port);
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
