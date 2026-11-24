/**
 * THE STEPS AFTER A SIGN-IN, read from the mirror and never from a guess. While a new connection is read the step says
 * what is happening, each mark following a record: the connection is there (connected), its calendars are being found
 * until the first arrives, each calendar stands ready to choose as it arrives, and its events are counted until every
 * calendar has been read once. The person chooses and goes on while the events still come. Past 8 seconds with nothing
 * found, one line offers to keep going; the frame's report then says when the calendars are there. The connection's
 * fault is the refusal, asked again only on a press. Nothing here times out into a failure.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, Dot, EndDot, Menu, MenuItem, Page, Sentence, Slot, Spinner } from "@ohmail/ui/base";
import type { CalendarConnectionRecord, CalendarPort, CalendarRecord } from "@ohmail/app-logic/calendar";
import {
  newEventsCalendarOf,
  connectFaultKeyOf,
  writableOf,
  wayOfConnection,
  type CalendarWay,
  type SteppedWay,
  type CalendarSetupPort,
} from "@ohmail/app-logic/calendar/setup";
import { useFrame, useReport } from "../frame/commands.js";
import { useText } from "../text/index.js";
import { CalendarLine } from "./CalendarLine.js";
import { setupFaultKeyOf } from "./setup-fault.js";
import { readMirror, type CalendarMirror } from "./mirror.js";
import "./reading.css";

/** How long the calendars may take to be found before the step offers to go on without them. */
export const SLOW_AFTER_MS = 8_000;

interface StepBase {
  readonly mirror: CalendarMirror;
  readonly connection: string;
  readonly port: CalendarSetupPort;
}

const ownOf = (mirror: Pick<CalendarMirror, "calendars">, connection: string) =>
  mirror.calendars.filter((k) => k.connectionId === connection);

/** Every calendar of the connection has been read once, or has said why it could not be. */
const allRead = (own: readonly CalendarRecord[]) =>
  own.length > 0 && own.every((k) => k.lastSyncedAt !== null || k.errorCode !== null);

/**
 * A phase while it runs: the waiting mark, its words, what it has counted so far. Its words are said when they change;
 * the count is not said at every change, only the words of the finished phase.
 */
function Phase({ done, children, count }: { done?: boolean; children: string; count?: string }) {
  return (
    <div className="cal-read-phase" role="status" data-done={done ? "" : undefined}>
      <span className="cal-read-phase-mark">
        {done ? <Dot kind="ink" /> : <Spinner className="cal-read-spin" />}
      </span>
      <span className="cal-read-phase-words">{children}</span>
      {count === undefined ? null : (
        <span className="cal-read-phase-count" aria-live="off">
          {count}
        </span>
      )}
    </div>
  );
}

/** The calendars found so far, each ready to choose; one that could not be read says why under its name. */
function ReadLines({
  own,
  mirror,
  port,
  way,
}: {
  readonly own: readonly CalendarRecord[];
  readonly mirror: CalendarMirror;
  readonly port: CalendarSetupPort;
  readonly way: CalendarWay | null;
}) {
  const t = useText("calsetup");
  const report = useReport();
  const id = useId();
  const setCalendar = port.setCalendar;
  const show = (k: CalendarRecord, shown: boolean) => {
    if (setCalendar === "none") return;
    setCalendar(k.id, { shown }).catch(() => report(t("calendars.notSaved")));
  };
  const why = (fault: string) => t(way === null ? connectFaultKeyOf(fault) : setupFaultKeyOf(fault, way));
  return (
    <div className="cal-read-lines" role="group" aria-label={t("calendars.group")}>
      {own.map((k, i) => (
        <div key={k.id} className="cal-read-arrive">
          <CalendarLine
            calendar={k}
            tone={mirror.tones.get(k.id) ?? "neutral"}
            gutter="cal-read-sq"
            describedBy={k.errorCode === null ? undefined : `${id}-${i}`}
            switchLabel={t("calendars.show", { name: k.name })}
            onToggle={setCalendar === "none" ? undefined : (on) => show(k, on)}
          />
          {k.errorCode === null ? null : (
            <p id={`${id}-${i}`} className="cal-read-why">
              <span className="cal-read-why-words">{why(k.errorCode)}</span>
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

export function CalendarsStep({
  mirror,
  connection,
  port,
  close,
  again,
  next,
  keepGoing,
  out,
  way,
}: StepBase & {
  readonly way: SteppedWay | null;
  /** The way out, at the top. */
  readonly close: ReactNode;
  readonly again: () => void;
  readonly next: () => void;
  /** Past the wait: the person goes on and the reading goes on without them. */
  readonly keepGoing: () => void;
  /** Leaves the setup: an account with no calendars has nothing more to choose. */
  readonly out: () => void;
}) {
  const t = useText("calsetup");
  const record = mirror.connections.find((c) => c.id === connection) ?? null;
  const own = ownOf(mirror, connection);
  // The connection's first listing has ended without a calendar: there is nothing more to wait for.
  const none = own.length === 0 && !record?.errorCode && record?.lastSyncedAt != null;
  const finding = own.length === 0 && !record?.errorCode && !none;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!finding) return;
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [finding]);
  if (record?.errorCode) {
    return (
      <Page
        aside={close}
        acts={
          <Button kind="ink" size="l" onPress={again}>
            {t("calendars.again")}
          </Button>
        }
        refusal={[t(setupFaultKeyOf(record.errorCode, way ?? wayOfConnection(record)))]}
      >
        <Sentence size="xl" level={1}>
          <EndDot kind="hot" product="cal">
            {t("calendars.refused")}
          </EndDot>
        </Sentence>
      </Page>
    );
  }
  const events = mirror.eventsOn(new Set(own.map((k) => k.id)));
  const theWay = way ?? (record ? wayOfConnection(record) : null);
  const wayName = theWay === null ? null : t(`way.${theWay}`);
  return (
    <Page
      columns={2}
      aside={close}
      note={finding && slow ? t("calendars.slow") : undefined}
      acts={
        none ? (
          <Button kind="ink" size="l" onPress={out}>
            {t("calendars.closeNone")}
          </Button>
        ) : finding ? (
          slow ? (
            <Button kind="two" size="l" onPress={keepGoing}>
              {t("calendars.keepGoing")}
            </Button>
          ) : null
        ) : (
          <Button kind="ink" size="l" keyHint="↵" onPress={next}>
            {t("continue")}
          </Button>
        )
      }
      material={
        <div className="cal-read-sheet">
          {wayName === null ? null : (
            <div className="cal-read-acct">
              <b className="cal-read-acct-name">{wayName}</b>
              {record?.label ? <span className="cal-read-acct-label">{record.label}</span> : null}
              <span className="cal-read-acct-new">
                <EndDot kind="ink">{t("calendars.connected")}</EndDot>
              </span>
            </div>
          )}
          {none ? (
            <Phase done>{t("calendars.none")}</Phase>
          ) : finding ? (
            <Phase>{t("calendars.finding")}</Phase>
          ) : (
            <>
              <ReadLines own={own} mirror={mirror} port={port} way={theWay} />
              {allRead(own) ? (
                <Phase done>{t("calendars.events", { count: events })}</Phase>
              ) : (
                <Phase count={String(events)}>{t("calendars.reading")}</Phase>
              )}
            </>
          )}
        </div>
      }
    >
      <Sentence size="xl" level={1}>
        <EndDot kind="hot" product="cal">
          {finding ? t("calendars.checking") : t("calendars.sentence")}
        </EndDot>
      </Sentence>
    </Page>
  );
}

/**
 * Keep going: the step leaves, and the frame's report says once what became of the reading, with the way to the
 * calendar accounts, where the choice waits.
 */
export function useKeepGoing(
  port: CalendarPort | null,
  connection: string | null,
  out: () => void,
): () => void {
  const { host, commands } = useFrame();
  const report = useReport();
  const t = useText("calsetup");
  return () => {
    if (port !== null && connection !== null)
      sayWhenRead(host.engine, port, connection, (read) => {
        const show = {
          action: t("calendars.readyShow"),
          onAction: () => commands.go({ place: "calsettings", sub: "calaccounts" }),
          yields: true,
          duration: 8000,
        };
        if ("fault" in read) return report(t(setupFaultKeyOf(read.fault, read.way)), show);
        report(t("calendars.ready", { provider: t(`way.${read.way}`), count: read.calendars }), show);
      });
    out();
  };
}

/**
 * After Keep going: one word when the connection's calendars are there, or its refusal, then nothing more is heard.
 * It reads the same records the step reads; a connection that goes away ends it in silence.
 */
function sayWhenRead(
  engine: Parameters<typeof readMirror>[0],
  port: CalendarPort,
  connection: string,
  say: (
    outcome: { readonly record: CalendarConnectionRecord; readonly way: CalendarWay } & (
      { readonly calendars: number } | { readonly fault: string }
    ),
  ) => void,
): void {
  let over = false;
  let seen = false;
  const look = () => {
    if (over) return;
    const now = readMirror(engine, port);
    const record = now.connections.find((c) => c.id === connection);
    // A connection not on the device yet is waited for; one that was seen and went away ends it.
    if (!record) {
      if (seen) end();
      return;
    }
    seen = true;
    const way = wayOfConnection(record);
    if (record.errorCode) {
      end();
      return say({ record, way, fault: record.errorCode });
    }
    const calendars = ownOf(now, connection).length;
    if (calendars > 0) {
      end();
      say({ record, way, calendars });
    }
  };
  const off = port.subscribe(look);
  function end() {
    over = true;
    off();
  }
  look();
}

export function DefaultStep({ mirror, connection, port, next }: StepBase & { readonly next: () => void }) {
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
        <EndDot kind="ink" product="cal">
          {t("wait.counts", { events, calendars: own.length })}
        </EndDot>
      </Sentence>
    </Page>
  );
}
