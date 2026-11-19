import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  hueOf,
  pressAndHear,
  viewOnlyOf,
  type CalendarConnectionRecord,
  type CalendarPort,
  type CalendarRecord,
} from "@ohmail/app-logic/calendar";
import { newEventsCalendarOf } from "@ohmail/app-logic/calendar/setup";
import { QuickAdd } from "@ohmail/ui/calendar";
import { RefusalLine } from "@ohmail/ui/base";
import { useFrame, useReport } from "../frame/commands.js";
import { useText, useTimeZone } from "../text/index.js";
import { DraftFields } from "./DraftFields.js";
import { fieldsOfDraft, previewOfDraft, startDraft, type EventDraft } from "./event-draft.js";

import type { CalendarEventFace } from "./faces.js";

interface Props {
  readonly onPreview: (event: CalendarEventFace | null) => void;
  readonly port: CalendarPort;
  readonly anchor: string;
  readonly today: string;
  readonly minute: number;
  readonly calendars: readonly CalendarRecord[];
  readonly connections: ReadonlyMap<string, CalendarConnectionRecord>;
  readonly preferred: string | null | undefined;
}

export function NewEvent({
  port,
  anchor,
  today,
  minute,
  calendars,
  connections,
  preferred,
  onPreview,
}: Props) {
  const { host, route, commands } = useFrame();
  const t = useText("calendar"),
    e = useText("event");
  const report = useReport();
  const zone = useTimeZone();
  const [draft, setDraft] = useState(() => startDraft(anchor, minute));
  const choices = calendars.filter((c) => c.shown && !viewOnlyOf(c, connections.get(c.connectionId)));
  const proposed =
    preferred === undefined && choices.length !== 1 ? null : newEventsCalendarOf(preferred ?? null, choices);
  const [chosen, choose] = useState<string | null>(null);
  const target = choices.find((c) => c.id === chosen);
  useEffect(() => {
    if (chosen === null && proposed) choose(proposed.id);
  }, [chosen, proposed]);
  const untitled = t("create.title");
  useEffect(() => {
    onPreview(target ? previewOfDraft(draft, target, zone, untitled) : null);
    return () => onPreview(null);
  }, [draft, target, zone, untitled, onPreview]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const request = useRef<symbol | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus();
    return () => {
      request.current = null;
    };
  }, [host.engine, port]);
  const change = (edit: Partial<EventDraft>) => {
    setDraft((was) => ({ ...was, ...edit }));
    setFailure(null);
  };
  const add = async () => {
    if (request.current || !target) return;
    const actual = host.engine.store.get<CalendarRecord>("calendar", target.id);
    if (
      !actual?.shown ||
      viewOnlyOf(
        actual,
        host.engine.store.get<CalendarConnectionRecord>("calendar_connection", actual.connectionId),
      )
    ) {
      setFailure(e("refusal.readOnly"));
      return;
    }
    const event = fieldsOfDraft(draft, actual, zone);
    if (!event) return;
    const ticket = Symbol();
    request.current = ticket;
    setBusy(true);
    try {
      const heard = await pressAndHear(port, {
        kind: "calendar_event_create",
        eventId: port.newId(),
        calendarId: actual.id,
        event,
      });
      if (request.current !== ticket) return;
      if (heard.verdict?.kind === "refused") {
        setFailure(e(heard.say!));
        return;
      }
      if (heard.say) report(e(heard.say));
      commands.go({ place: "week", sub: draft.day }, { replace: true });
    } catch {
      if (request.current === ticket) setFailure(e("refusal.unknown"));
    } finally {
      if (request.current === ticket) {
        request.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <QuickAdd
      busy={busy}
      label={t("create.title")}
      tone={hueOf(target?.color ?? null)}
      line={{
        label: t("create.name"),
        placeholder: t("create.name"),
        value: draft.title,
        onChange: (title) => change({ title }),
        ref: input,
      }}
      close={{
        label: t("closeEvent"),
        onPress: () => commands.go({ place: route.place, sub: route.sub }, { replace: true }),
      }}
      onAdd={() => void add()}
    >
      <DraftFields
        draft={draft}
        today={today}
        calendar={target}
        choices={choices}
        choose={choose}
        change={change}
        ready={!busy && Boolean(target && fieldsOfDraft(draft, target, zone))}
        add={() => void add()}
      />
      {failure || !choices.length ? <RefusalLine>{failure ?? t("create.noCalendar")}</RefusalLine> : null}
    </QuickAdd>
  );
}
