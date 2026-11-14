/**
 * THE OPEN EVENT FOUND IN A LETTER: its time and place, the letter's words it was read from, the calendar it goes to,
 * and Add; or, on a calendar already, the way to it. Nothing open: the column says how many wait to be added.
 */
import { BlankColumn, Sheet } from "@ohmail/ui/mail";
import { AnswerSwitch, EventCard } from "@ohmail/ui/calendar";
import type { CalendarPort } from "@ohmail/app-logic/calendar";
import { foundCountOf } from "@ohmail/app-logic/calendar/found";
import { useFrame } from "../frame/commands.js";
import type { PaneProps } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useLocale, useText } from "../text/index.js";
import { whenOf } from "../invitations/index.js";
import { useAdd, useFound } from "./use-found.js";

export function FromMailReading(props: PaneProps) {
  const { host } = useFrame();
  const port = host.wires.calendar;
  return port === NONE ? null : <ReadingOn port={port} {...props} />;
}

function ReadingOn({ port, route, plan }: PaneProps & { readonly port: CalendarPort }) {
  const { commands } = useFrame();
  const t = useText("frommail");
  const locale = useLocale();
  const found = useFound(port);
  const { add, busy } = useAdd(port, found);
  if (found === null) return null;
  const { rows, today, target, toneOf, onCalendar } = found;
  const row = rows.find((r) => r.id === route.open);
  if (row === undefined) {
    const waiting = target === null ? 0 : foundCountOf(rows);
    return (
      <Sheet kind="plain">
        <BlankColumn hot={waiting > 0}>{t("waiting", { count: waiting })}</BlankColumn>
      </Sheet>
    );
  }
  const on = row.alreadyOn;
  const tone = toneOf(on === null ? (target?.id ?? null) : onCalendar(row));
  const acts =
    on !== null
      ? [{ id: "show", label: t("show"), onPress: () => commands.event(on) }]
      : target !== null && !busy
        ? [{ id: "add", label: t("add"), primary: true, onPress: () => void add([row], target.id) }]
        : [];
  const card = (
    <EventCard
      frame={plan.device === "phone" ? "sheet" : "inline"}
      title={row.title}
      tone={on === null ? null : tone}
      when={whenOf(row.when, row.day, today, locale, t, true)}
      {...(row.place ? { where: [{ text: row.place }] } : {})}
      {...(on !== null ? { tags: [{ text: t("onCalendar") }] } : {})}
      close={{ label: t("close"), onPress: () => commands.go({ place: "frommail", open: null }) }}
      answers={acts.length > 0 ? <AnswerSwitch label={t("add")} acts={acts} on="sheet" /> : undefined}
      rows={[
        ...(row.sourceWords === null ? [] : [{ label: t("words"), words: [row.sourceWords] }]),
        ...(on === null && target !== null
          ? [{ label: t("goesTo"), tone: toneOf(target.id), text: target.name }]
          : []),
      ]}
    />
  );
  return plan.device === "phone" ? card : <Sheet kind="plain">{card}</Sheet>;
}
