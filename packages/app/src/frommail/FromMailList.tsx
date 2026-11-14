/**
 * FROM MAIL: the events found in letters that may be offered, one row each with Add, and Add for all of them at the
 * list's head. An event already on a shown calendar says so and leads to it, and offers no Add. With no calendar that
 * can be written, Add is not drawn. Nothing is added without a press.
 */
import { Button, Empty, RefusalLine } from "@ohmail/ui/base";
import { AgendaRow } from "@ohmail/ui/calendar";
import { ListHead, Sheet } from "@ohmail/ui/mail";
import type { CalendarPort } from "@ohmail/app-logic/calendar";
import type { FoundRow } from "@ohmail/app-logic/calendar/found";
import { useFrame } from "../frame/commands.js";
import type { PaneProps } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useLocale, useText } from "../text/index.js";
import { whenOf } from "../invitations/index.js";
import { useAdd, useFound } from "./use-found.js";

export function FromMailList(props: PaneProps) {
  const { host } = useFrame();
  const t = useText("frommail");
  const port = host.wires.calendar;
  if (port === NONE) return <RefusalLine>{t("unreadable")}</RefusalLine>;
  return <ListOn port={port} {...props} />;
}

function ListOn({ port, route, plan }: PaneProps & { readonly port: CalendarPort }) {
  const { commands } = useFrame();
  const t = useText("frommail");
  const locale = useLocale();
  const found = useFound(port);
  const { add, busy } = useAdd(port, found);
  if (found === null) return <RefusalLine>{t("noZone")}</RefusalLine>;
  const { rows, today, target, toneOf, onCalendar } = found;
  const addable = target === null ? [] : rows.filter((r) => r.alreadyOn === null);
  const head = (
    <ListHead
      title={t("title")}
      hot={addable.length > 0}
      aside={
        target !== null && addable.length > 1 ? (
          <Button kind="two" size="s" disabled={busy} onPress={() => void add(addable, target.id)}>
            {t("addAll", { count: addable.length })}
          </Button>
        ) : null
      }
    />
  );
  const item = (row: FoundRow) => {
    const on = row.alreadyOn;
    return (
      <AgendaRow
        key={row.id}
        mark={on === null ? { kind: "found" } : { kind: "calendar", tone: toneOf(onCalendar(row)) }}
        title={row.title}
        time={whenOf(row.when, row.day, today, locale, t)}
        second={on === null ? (row.sourceWords ?? row.place ?? "") : t("onCalendar")}
        quiet={on === null}
        open={route.open === row.id}
        onOpen={() => commands.go({ place: "frommail", open: row.id })}
        tail={
          on !== null ? (
            <Button kind="quiet" size="s" onPress={() => commands.event(on)}>
              {t("show")}
            </Button>
          ) : target !== null ? (
            <Button kind="ink" size="s" disabled={busy} onPress={() => void add([row], target.id)}>
              {t("add")}
            </Button>
          ) : undefined
        }
      />
    );
  };
  const list =
    rows.length === 0 ? (
      <Empty label={t("empty")} />
    ) : (
      <div role="list" aria-label={t("title")}>
        {rows.map((row) => (
          <div role="listitem" key={row.id}>
            {item(row)}
          </div>
        ))}
      </div>
    );
  return (
    <>
      {head}
      {plan.device === "phone" ? <Sheet kind="plain">{list}</Sheet> : list}
    </>
  );
}
