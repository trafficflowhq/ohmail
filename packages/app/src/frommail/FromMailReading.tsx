/**
 * THE OPEN EVENT FOUND IN A LETTER: its time and place, the letter's words it was read from, the calendar it goes to,
 * and Add; or, on a calendar already, the way to it. Nothing open: the column says how many wait to be added.
 */
import { useRef } from "react";
import { ActionPanel, BlankColumn, Sheet, type PanelVerb } from "@ohmail/ui/mail";
import { AnswerSwitch, EventBridge, EventCard } from "@ohmail/ui/calendar";
import type { CalendarPort } from "@ohmail/app-logic/calendar";
import { foundCountOf } from "@ohmail/app-logic/calendar/found";
import { useFrame } from "../frame/commands.js";
import type { PaneProps } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useLocale, useText } from "../text/index.js";
import { eventRefString } from "../frame/product.js";
import { useEventPlacement } from "../calendar/use-event-placement.js";
import { useMaps } from "../calendar/use-place-suggestions.js";
import { useCalendarLetter } from "../calendar/use-event-letters.js";
import { whenOf } from "../invitations/index.js";
import { useAdd, useDismissFound, useFound } from "./use-found.js";
import "./from-mail-card.css";

export function FromMailReading(props: PaneProps) {
  const { host } = useFrame();
  const port = host.wires.calendar;
  return port === NONE ? null : <ReadingOn port={port} {...props} />;
}

function ReadingOn({ port, route, plan }: PaneProps & { readonly port: CalendarPort }) {
  const { commands } = useFrame();
  const t = useText("frommail");
  const cal = useText("calendar");
  const locale = useLocale();
  const found = useFound(port);
  const { add, busy } = useAdd(port, found);
  const dismiss = useDismissFound(port);
  const row = found?.rows.find((item) => item.id === route.open);
  const maps = useMaps(row?.place ?? null);
  const letter = useCalendarLetter(row?.messageId, row?.mailboxId);
  const cardRef = useRef<HTMLDivElement>(null);
  const phone = plan.device === "phone";
  const seat = useEventPlacement(cardRef, !phone && row !== undefined, row?.id, true);
  if (found === null) return null;
  const { rows, today, target, toneOf, onCalendar } = found;
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
      ? []
      : [
          ...(target !== null && !busy
            ? [{ id: "add", label: t("add"), primary: true, onPress: () => void add([row], target.id) }]
            : []),
          ...(dismiss && !busy
            ? [{ id: "dismiss", label: t("dismiss"), onPress: () => void dismiss(row.id) }]
            : []),
        ];
  const footer: PanelVerb[] = [
    ...(letter
      ? [{ id: "letter", label: cal("actions.openLetter"), icon: "mail" as const, onPress: letter.open }]
      : []),
    {
      id: "show",
      label: t("show"),
      icon: "calendar",
      onPress: () =>
        commands.go({
          place: "week",
          sub: row.day,
          open: on ? eventRefString(on) : null,
        }),
    },
  ];
  const ways = <ActionPanel label={cal("actions.panel")} items={footer} />;
  const card = (
    <EventCard
      ref={cardRef}
      {...seat?.card}
      frame={phone ? "sheet" : "reading"}
      neutralHead
      title={row.title}
      tone={on === null ? null : tone}
      when={whenOf(row.when, row.day, today, locale, t, true)}
      {...(row.place ? { where: [{ text: row.place, maps }] } : {})}
      tags={[{ text: t(on === null ? "source" : "onCalendar") }]}
      close={{ label: t("close"), onPress: () => commands.go({ place: "frommail", open: null }) }}
      foot={phone ? ways : undefined}
      answers={acts.length > 0 ? <AnswerSwitch label={t("add")} acts={acts} on="sheet" /> : undefined}
      rows={[
        ...(on === null && target !== null
          ? [{ label: t("goesTo"), tone: toneOf(target.id), text: target.name }]
          : []),
        ...(row.sourceWords === null ? [] : [{ label: t("words"), words: [row.sourceWords] }]),
        ...(letter
          ? [
              {
                label: cal("letters", { count: 1 }),
                link: { label: letter.subject || cal("actions.openLetter"), onPress: letter.open },
              },
            ]
          : []),
      ]}
    />
  );
  return phone ? (
    card
  ) : (
    <div className="cal-found-card">
      {card}
      {seat?.bridge && <EventBridge {...seat.bridge} tone={null} />}
      <div className="cal-found-ways">{ways}</div>
    </div>
  );
}
