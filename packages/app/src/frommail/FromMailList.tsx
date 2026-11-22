/**
 * FROM MAIL: the events found in letters that may be offered, one row each with Add, and Add for all of them at the
 * list's head. An event already on a shown calendar says so and leads to it, and offers no Add. With no calendar that
 * can be written, Add is not drawn. Nothing is added without a press.
 */
import { useState, type MouseEventHandler } from "react";
import { Button, Empty, RefusalLine, Slot } from "@ohmail/ui/base";
import { AgendaRow, CalendarSquare, type CalendarTone } from "@ohmail/ui/calendar";
import { ListHead, Sheet } from "@ohmail/ui/mail";
import type { CalendarPort } from "@ohmail/app-logic/calendar";
import type { FoundRow } from "@ohmail/app-logic/calendar/found";
import { useFrame } from "../frame/commands.js";
import { ProductSwitch } from "../frame/ProductSwitch.js";
import type { PaneProps } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useLocale, useText } from "../text/index.js";
import { whenOf } from "../invitations/index.js";
import { DraftCalendarMenu } from "../calendar/DraftCalendarMenu.js";
import { useAdd, useFound } from "./use-found.js";
import "./from-mail-list.css";

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
  const [selected, setSelected] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [menu, setMenu] = useState<{ row: string; anchor: HTMLButtonElement } | null>(null);
  if (found === null) return <RefusalLine>{t("noZone")}</RefusalLine>;
  const { rows, today, target, choices, toneOf, onCalendar } = found;
  const phone = plan.device === "phone";
  const destination = (row: string, reading: NonNullable<typeof found>) =>
    reading.choices.find(({ id }) => id === selected.get(row)) ?? reading.target;
  const addable = target === null ? [] : rows.filter((r) => r.alreadyOn === null);
  const head = (
    <ListHead
      title={t("title")}
      lead={plan.rail === "dock" ? <ProductSwitch kind="round" /> : undefined}
      hot={addable.length > 0}
      aside={
        target !== null && addable.length > 1 ? (
          <Button
            kind="two"
            size="s"
            disabled={busy}
            onPress={() =>
              void add(
                addable,
                phone ? (row, reading) => destination(row.id, reading)?.id ?? null : target.id,
              )
            }
          >
            {t("addAll", { count: addable.length })}
          </Button>
        ) : null
      }
    />
  );
  const item = (row: FoundRow) => {
    const on = row.alreadyOn;
    const calendar = phone ? destination(row.id, found) : target;
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
        tailAtEnd={plan.device === "desktop"}
        tail={
          on !== null ? (
            <Button kind="quiet" size="s" onPress={() => commands.event(on)}>
              {t("show")}
            </Button>
          ) : calendar === null ? undefined : phone ? (
            <PhoneAddActions
              calendarName={calendar.name}
              tone={toneOf(calendar.id) ?? "neutral"}
              expanded={menu?.row === row.id}
              busy={busy}
              onPick={(event) => setMenu({ row: row.id, anchor: event.currentTarget })}
              onAdd={() => void add([row], calendar.id)}
            />
          ) : (
            <Button kind="ink" size="s" disabled={busy} onPress={() => void add([row], calendar.id)}>
              {t("add")}
            </Button>
          )
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
  return phone ? (
    <div className="cal-frommail-phone">
      {head}
      <Sheet kind="plain" scroll flushBottom>
        {list}
      </Sheet>
      {menu && addable.some(({ id }) => id === menu.row) ? (
        <DraftCalendarMenu
          anchor={menu.anchor}
          choices={choices}
          current={destination(menu.row, found)?.id}
          choose={(id) => {
            setSelected((previous) => new Map(previous).set(menu.row, id));
            setMenu(null);
          }}
          close={() => setMenu(null)}
        />
      ) : null}
    </div>
  ) : (
    <>
      {head}
      <div className="cal-frommail-results">{list}</div>
    </>
  );
}

function PhoneAddActions({
  calendarName,
  tone,
  expanded,
  busy,
  onPick,
  onAdd,
}: {
  calendarName: string;
  tone: CalendarTone;
  expanded: boolean;
  busy: boolean;
  onPick: MouseEventHandler<HTMLButtonElement>;
  onAdd: () => void;
}) {
  const t = useText("frommail");
  return (
    <span className="cal-frommail-actions">
      <span className="cal-frommail-target">
        <CalendarSquare tone={tone} />
        <Slot
          label={t("goesToCalendar", { name: calendarName })}
          expanded={expanded}
          disabled={busy}
          onPress={onPick}
        >
          {calendarName}
        </Slot>
      </span>
      <Button kind="two" size="s" disabled={busy} onPress={onAdd}>
        {t("add")}
      </Button>
    </span>
  );
}
