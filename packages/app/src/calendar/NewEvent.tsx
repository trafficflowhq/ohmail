import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  pressAndHear,
  viewOnlyOf,
  type CalendarConnectionRecord,
  type CalendarPort,
  type CalendarRecord,
} from "@ohmail/app-logic/calendar";
import { newEventsCalendarOf } from "@ohmail/app-logic/calendar/setup";
import { QuickAdd } from "@ohmail/ui/calendar";
import { RefusalLine } from "@ohmail/ui/base";
import { useCalendarGuest, useFrame, useReport, type CalendarGuest } from "../frame/commands.js";
import { fragmentOf, routeOf } from "../frame/route.js";
import { useText, useTimeZone } from "../text/index.js";
import { useDiscardReport, useDraftRestore } from "./draft-undo.js";
import { DraftFields } from "./DraftFields.js";
import { DraftInvitation, useDraftInvitation } from "./DraftInvitation.js";
import { fieldsOfDraft, previewOfDraft, startDraft, type EventDraft } from "./event-draft.js";

import type { CalendarTones } from "./tones.js";
import type { CalendarEventFace } from "./faces.js";

interface Props {
  readonly onPreview: (event: DraftPreview | null) => void;
  readonly port: CalendarPort;
  readonly anchor: string;
  readonly today: string;
  readonly minute: number;
  readonly calendars: readonly CalendarRecord[];
  readonly tones: CalendarTones;
  readonly connections: ReadonlyMap<string, CalendarConnectionRecord>;
  readonly preferred: string | null | undefined;
}

export type DraftPreview = {
  face: CalendarEventFace;
  moveRange: (first: string, last: string) => void;
};

export function NewEvent({
  port,
  anchor,
  today,
  minute,
  calendars,
  tones,
  connections,
  preferred,
  onPreview,
}: Props) {
  const { host, route, commands } = useFrame();
  const t = useText("calendar");
  const zone = useTimeZone();
  const contact = useCalendarGuest();
  const invitation = useDraftInvitation(contact?.current ?? null);
  const [draft, setDraft] = useState(() => startDraft(anchor, minute));
  const choices = calendars.filter((c) => c.shown && !viewOnlyOf(c, connections.get(c.connectionId)));
  const proposed =
    preferred === undefined && choices.length !== 1 ? null : newEventsCalendarOf(preferred ?? null, choices);
  const [chosen, choose] = useState<string | null>(null);
  const discardReport = useDiscardReport(port);
  useDraftRestore("new", port, ({ draft, calendar }) => {
    setDraft(draft);
    choose(calendar);
  });
  const target = choices.find((c) => c.id === chosen);
  const tone = target ? (tones.get(target.id) ?? "neutral") : null;
  useEffect(() => {
    if (proposed) choose((current) => current ?? proposed.id);
  }, [proposed]);
  const { create, request, committed, busy, failure, setFailure } = useCreateEvent(
    port,
    invitation.needsConfirmation,
  );
  const untitled = t("create.title");
  useEffect(() => {
    const face = target && previewOfDraft(draft, target, zone, untitled, tone);
    onPreview(
      face
        ? {
            face,
            moveRange: (day, last) => {
              if (!request.current)
                setDraft((current) => ({ ...current, day, endDay: last === day ? null : last }));
            },
          }
        : null,
    );
    return () => onPreview(null);
  }, [draft, target, zone, untitled, tone, onPreview, request]);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (contact) contact.current = null;
    input.current?.focus();
    return () => {
      request.current = null;
    };
  }, [host.engine, port, contact, request]);
  const change = (edit: Partial<EventDraft>) => {
    setDraft((was) => ({ ...was, ...edit }));
    setFailure(null);
  };
  const add = () => void create(draft, target);
  useNewDraftDeparture(draft, chosen, discardReport, busy, request, committed);
  const close = () => {
    if (!request.current) commands.go({ place: route.place, sub: route.sub }, { history: "dismiss-dialog" });
  };
  return (
    <QuickAdd
      busy={busy}
      label={t("create.title")}
      tone={tone}
      line={{
        label: t("create.name"),
        placeholder: t("create.name"),
        value: draft.title,
        onChange: (title) => change({ title }),
        ref: input,
      }}
      close={{
        label: t("closeEvent"),
        onPress: close,
      }}
      onAdd={add}
    >
      <DraftInvitation invitation={invitation} onConfirm={(guest) => void create(draft, target, guest)} />
      <DraftFields
        draft={draft}
        today={today}
        calendar={target}
        tone={tone}
        choices={choices}
        choose={choose}
        change={change}
        cancel={{ label: t("edit.cancel"), onPress: close }}
        submit={{
          label: t("create.add"),
          keyHint: "↵",
          disabled: busy || !target || !fieldsOfDraft(draft, target, zone),
          onPress: add,
        }}
      />
      {failure || !choices.length ? <RefusalLine>{failure ?? t("create.noCalendar")}</RefusalLine> : null}
    </QuickAdd>
  );
}

function useCreateEvent(port: CalendarPort, needsConfirmation: (guest?: CalendarGuest) => boolean) {
  const { host, commands } = useFrame();
  const e = useText("event");
  const report = useReport();
  const zone = useTimeZone();
  const request = useRef<symbol | null>(null);
  const committed = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const create = async (draft: EventDraft, target?: CalendarRecord, guest?: CalendarGuest) => {
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
    if (!event || needsConfirmation(guest)) return;
    const ticket = Symbol();
    request.current = ticket;
    setBusy(true);
    try {
      const heard = await pressAndHear(port, {
        kind: "calendar_event_create",
        eventId: port.newId(),
        calendarId: actual.id,
        event: guest ? { ...event, invitees: [{ ...guest, role: "required" }] } : event,
      });
      if (request.current !== ticket) return;
      if (heard.verdict?.kind === "refused") {
        setFailure(e(heard.say!));
        return;
      }
      if (heard.say) report(e(heard.say));
      committed.current = true;
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
  return { create, request, committed, busy, failure, setFailure };
}

function useNewDraftDeparture(
  draft: EventDraft,
  calendar: string | null,
  report: ReturnType<typeof useDiscardReport>,
  busy: boolean,
  request: RefObject<symbol | null>,
  committed: RefObject<boolean>,
) {
  const { host, route } = useFrame();
  const address = host.device.address;
  const at = fragmentOf(route);
  const hasWords = Boolean(draft.title.trim() || draft.place?.trim() || draft.notes?.trim());
  const departure = useRef(() => {});
  departure.current = () => {
    if (hasWords && !committed.current) report({ kind: "new", draft, calendar });
  };
  useLayoutEffect(() => {
    if (!hasWords && !busy) return;
    return address.holdLeave(
      (resume) => {
        if (request.current && !committed.current) return;
        departure.current();
        resume();
      },
      at,
      (next) => routeOf(next).words.panel !== "new",
    );
  }, [address, at, busy, committed, hasWords, request]);
}
