/**
 * THE STEPS AFTER A SIGN-IN, read from the mirror and never from a guess: the connection's calendars appearing is
 * success, its fault is the refusal, and until either arrives the step says it is still checking and offers the way
 * out. Nothing here times out into a failure, and a refused sign-in is asked again only on a press.
 */
import { useRef, useState, type ReactNode } from "react";
import { Button, Dot, Menu, MenuItem, Page, Sentence, Slot } from "@ohmail/ui/base";
import type { CalendarRecord } from "@ohmail/app-logic/calendar";
import {
  connectFaultKeyOf,
  newEventsCalendarOf,
  writableOf,
  type CalendarSetupPort,
} from "@ohmail/app-logic/calendar/setup";
import { useReport } from "../frame/commands.js";
import { useText } from "../text/index.js";
import { CalendarLine } from "./CalendarLine.js";
import type { CalendarMirror } from "./mirror.js";

interface StepBase {
  readonly mirror: CalendarMirror;
  readonly connection: string;
  readonly port: CalendarSetupPort;
  readonly leave: ReactNode;
}

const ownOf = (mirror: CalendarMirror, connection: string) =>
  mirror.calendars.filter((k) => k.connectionId === connection);

export function CalendarsStep({
  mirror,
  connection,
  port,
  leave,
  again,
  next,
}: StepBase & { readonly again: () => void; readonly next: () => void }) {
  const t = useText("calsetup");
  const report = useReport();
  const record = mirror.connections.find((c) => c.id === connection) ?? null;
  const own = ownOf(mirror, connection);
  if (record?.errorCode) {
    return (
      <Page
        acts={
          <Button kind="ink" size="l" onPress={again}>
            {t("calendars.again")}
          </Button>
        }
        refusal={[t(connectFaultKeyOf(record.errorCode))]}
      >
        <Sentence size="xl" level={1}>
          {t("calendars.refused")}
          <Dot kind="hot" product="cal" />
        </Sentence>
      </Page>
    );
  }
  if (own.length === 0) {
    return (
      <Page acts={leave} line={t("calendars.checkingLine")}>
        <Sentence size="xl" level={1}>
          {t("calendars.checking")}
          <Dot kind="hot" product="cal" />
        </Sentence>
      </Page>
    );
  }
  const setCalendar = port.setCalendar;
  const show = (k: CalendarRecord, shown: boolean) => {
    if (setCalendar === "none") return;
    setCalendar(k.id, { shown }).catch(() => report(t("calendars.notSaved")));
  };
  return (
    <Page
      acts={
        <Button kind="ink" size="l" keyHint="↵" onPress={next}>
          {t("continue")}
        </Button>
      }
      material={
        <div role="group" aria-label={t("calendars.group")}>
          {own.map((k) => (
            <CalendarLine
              key={k.id}
              calendar={k}
              switchLabel={t("calendars.show", { name: k.name })}
              onToggle={setCalendar === "none" ? undefined : (on) => show(k, on)}
            />
          ))}
        </div>
      }
    >
      <Sentence size="xl" level={1}>
        {t("calendars.sentence")}
        <Dot kind="hot" product="cal" />
      </Sentence>
    </Page>
  );
}

export function DefaultStep({
  mirror,
  connection,
  port,
  next,
}: Omit<StepBase, "leave"> & { readonly next: () => void }) {
  const t = useText("calsetup");
  const report = useReport();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const writable = writableOf(mirror.calendars, mirror.connections);
  const [picked, setPicked] = useState<string | null>(null);
  const proposed = picked ?? ownOf(mirror, connection).find((k) => writable.includes(k))?.id ?? null;
  const chosen = newEventsCalendarOf(proposed, writable);
  const save = port.saveSettings;
  const go = () => {
    if (save === "none" || chosen === null) return next();
    save({ newEventsCalendarId: chosen.id }).then(next, () => report(t("default.notSaved")));
  };
  return (
    <Page
      acts={
        <Button kind="ink" size="l" keyHint="↵" onPress={go}>
          {t("continue")}
        </Button>
      }
    >
      <Sentence size="xl" level={1}>
        {t.rich("default.sentence", {
          calendar: () => (
            <Slot
              key="calendar"
              ref={anchor}
              kind={picked ? "done" : "fill"}
              label={t("default.label")}
              expanded={open}
              onPress={() => setOpen(true)}
            >
              {chosen?.name ?? t("default.none")}
            </Slot>
          ),
        })}
        <Dot kind="hot" product="cal" />
      </Sentence>
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} label={t("default.label")}>
        {writable.map((k) => (
          <MenuItem
            key={k.id}
            checked={k.id === chosen?.id}
            onPress={() => {
              setPicked(k.id);
              setOpen(false);
            }}
          >
            {k.name}
          </MenuItem>
        ))}
      </Menu>
    </Page>
  );
}

export function WaitStep({
  mirror,
  connection,
  done,
}: Pick<StepBase, "mirror" | "connection"> & { readonly done: () => void }) {
  const t = useText("calsetup");
  const own = ownOf(mirror, connection);
  const events = mirror.eventsOn(new Set(own.map((k) => k.id)));
  return (
    <Page
      acts={
        <Button kind="ink" size="l" keyHint="↵" onPress={done}>
          {t("wait.open")}
        </Button>
      }
    >
      <Sentence size="xl" level={1}>
        {t("wait.counts", { events, calendars: own.length })}
        <Dot kind="ink" product="cal" />
      </Sentence>
    </Page>
  );
}
