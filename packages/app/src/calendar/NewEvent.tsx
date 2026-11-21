import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  calendarInviteeSuggestions,
  dayOfIso,
  isoOfDay,
  nowIn,
  pressAndHear,
  readerZones,
  viewOnlyOf,
  type CalendarConnectionRecord,
  type CalendarPort,
  type CalendarRecord,
  type PlainDate,
} from "@ohmail/app-logic/calendar";
import { newEventsCalendarOf } from "@ohmail/app-logic/calendar/setup";
import { QuickAdd } from "@ohmail/ui/calendar";
import { RefusalLine } from "@ohmail/ui/base";
import { useCalendarDraftSeed, useFrame, useReport, type CalendarGuest } from "../frame/commands.js";
import { useOwnAddresses } from "../frame/room.js";
import { fragmentOf, routeOf } from "../frame/route.js";
import { useText, useTimeZone } from "../text/index.js";
import { useDiscardReport, useDraftRestore } from "./draft-undo.js";
import { DraftTimeNotice } from "./DraftTimeNotice.js";
import { DraftFields, readDraftEntry, type NewEventDraft } from "./DraftFields.js";
import { DraftInvitation, useDraftInvitation, useGuestConfirmation } from "./DraftInvitation.js";
import {
  draftCalendars,
  draftTimes,
  fieldsOfDraft,
  previewOfDraft,
  startDraft,
  type EventDraft,
} from "./event-draft.js";

import type { CalendarTones } from "./tones.js";
import type { CalendarEventFace } from "./faces.js";

interface Props {
  readonly onPreview: (event: DraftPreview | null) => void;
  readonly port: CalendarPort;
  readonly now: { readonly day: PlainDate; readonly minutes: number };
  readonly calendars: readonly CalendarRecord[];
  readonly tones: CalendarTones;
  readonly connections: ReadonlyMap<string, CalendarConnectionRecord>;
  readonly preferred: string | null | undefined;
}

export type DraftPreview = {
  face: CalendarEventFace;
  moveRange: (first: string, last: string) => void;
};

export function NewEvent({ port, now, calendars, tones, connections, preferred, onPreview }: Props) {
  const { route, commands } = useFrame();
  const t = useText("calendar");
  const e = useText("event");
  const zone = useTimeZone();
  const seed = useCalendarDraftSeed();
  const invitation = useDraftInvitation(seed.current?.guests ?? []);
  const [written, setDraft] = useState<NewEventDraft>(() => {
    const clock = nowIn(Date.now(), zone, readerZones()) ?? now;
    const day = dayOfIso(route.sub) ?? clock.day;
    return {
      ...startDraft(isoOfDay(day), clock.minutes, route.words.slot),
      title: seed.current?.title ?? "",
    };
  });
  const today = isoOfDay(now.day);
  const parsed = useMemo(() => readDraftEntry(written, today), [written, today]);
  const draft = parsed?.draft ?? written;
  const choices = draftCalendars(calendars, connections);
  const proposed = newEventsCalendarOf(preferred ?? null, choices);
  const [chosen, choose] = useState<string | null>(null);
  const discardReport = useDiscardReport(port);
  useDraftRestore("new", port, ({ draft, calendar }) => {
    setDraft(draft);
    choose(calendar);
  });
  const target = chosen === null ? (proposed ?? undefined) : choices.find((c) => c.id === chosen);
  const tone = target ? (tones.get(target.id) ?? "neutral") : null;
  const unavailable = chosen ?? preferred;
  const readOnly = calendars.some(
    (calendar) =>
      calendar.shown &&
      (calendar.id === unavailable || choices.length === 0) &&
      viewOnlyOf(calendar, connections.get(calendar.connectionId)),
  );
  const { create, request, committed, busy, failure, setFailure } = useCreateEvent(port);
  const input = useNewDraftPreview(port, draft, target, zone, tone, request, onPreview, setDraft);
  const selectCalendar = (id: string) => {
    choose(id);
    setFailure(null);
  };
  const change = (edit: Partial<NewEventDraft>) => {
    if (chosen === null && target) choose(target.id);
    const override = Object.keys(edit).some((key) => QUICK_FIELDS.has(key));
    setDraft({ ...(override ? { ...draft, typed: undefined } : written), ...edit });
    setFailure(null);
  };
  const proposedGuest = useQuickGuest(parsed?.guest, draft, invitation.selected, change);
  const formDraft =
    target && draft.alarms === undefined
      ? { ...draft, alarms: target.defaultAlarms.map((alarm) => alarm.minutesBefore) }
      : draft;
  const provider = target && connections.get(target.connectionId)?.provider;
  const extraAlert = (formDraft.alarms?.length ?? 0) > 1;
  const tooManyAlerts = provider === "microsoft" && (draft.alarms?.length ?? 0) > 1;
  const ready = !!target && !tooManyAlerts && !!fieldsOfDraft(draft, target, draft.zone ?? zone);
  const { add, confirmation } = useGuestConfirmation(
    draft,
    invitation.selected,
    () => ready && !request.current,
    (confirmedDraft) => void create(confirmedDraft, target),
  );
  const refusal = failure ?? (tooManyAlerts ? e("fault.notAllowed") : null);
  useNewDraftDeparture(written, chosen ?? target?.id ?? null, discardReport, busy, request, committed);
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
        value: written.title,
        found: parsed?.marks,
        onChange: (title) => change({ title, typed: true }),
        ref: input,
      }}
      close={{
        label: t("closeEvent"),
        onPress: close,
      }}
      onAdd={add}
    >
      <DraftInvitation invitation={invitation} />
      <DraftTimeNotice issue={draftTimes(draft, draft.zone ?? zone).issue} />
      <DraftFields
        draft={formDraft}
        proposedGuest={proposedGuest}
        edit={{
          canInvite: true,
          canAddAlert: target !== undefined,
          canAddSecondAlert: extraAlert || (provider !== "microsoft" && !draft.allDay),
        }}
        today={today}
        calendar={target}
        tone={tone}
        choices={choices}
        choose={selectCalendar}
        timeZone={draft.zone}
        change={change}
        cancel={{ label: t("edit.cancel"), onPress: close }}
        submit={{
          label: t("create.add"),
          keyHint: "↵",
          disabled: busy || !ready,
          onPress: add,
        }}
      />
      {confirmation}
      {refusal || readOnly || !choices.length ? (
        <RefusalLine>{refusal ?? (readOnly ? e("refusal.readOnly") : t("create.noCalendar"))}</RefusalLine>
      ) : null}
    </QuickAdd>
  );
}

const QUICK_FIELDS = new Set(["day", "endDay", "from", "to", "allDay", "place", "zone", "alarms"]);

function useQuickGuest(
  name: string | undefined,
  draft: EventDraft,
  selected: readonly CalendarGuest[],
  change: (edit: Partial<EventDraft>) => void,
) {
  const { host } = useFrame();
  const own = useOwnAddresses();
  if (!name) return undefined;
  const guests = draft.invitees ?? [];
  const exclude = [...own, ...[...guests, ...selected].map(({ address }) => address)].map((address) =>
    address.toLowerCase(),
  );
  const person = calendarInviteeSuggestions(host.engine.read(), name, exclude).find(
    ({ name: display }) => display.split(/\s+/)[0]?.toLowerCase() === name.toLowerCase(),
  );
  return (
    person && {
      name: person.name || person.address,
      take: () =>
        change({
          invitees: [
            ...guests,
            { address: person.address, name: person.name || null, role: "required", answer: "none" },
          ],
        }),
    }
  );
}

function useNewDraftPreview(
  port: CalendarPort,
  draft: NewEventDraft,
  target: CalendarRecord | undefined,
  zone: string,
  tone: CalendarEventFace["tone"],
  request: RefObject<symbol | null>,
  onPreview: Props["onPreview"],
  setDraft: Dispatch<SetStateAction<NewEventDraft>>,
) {
  const { host } = useFrame();
  const seed = useCalendarDraftSeed();
  const untitled = useText("calendar")("create.title");
  useEffect(() => {
    const face = target && previewOfDraft(draft, target, draft.zone ?? zone, untitled, tone);
    onPreview(
      face
        ? {
            face,
            moveRange: (day, last) => {
              if (!request.current)
                setDraft({ ...draft, typed: undefined, day, endDay: last === day ? null : last });
            },
          }
        : null,
    );
    return () => onPreview(null);
  }, [draft, target, zone, untitled, tone, onPreview, request, setDraft]);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    seed.current = null;
    input.current?.focus();
    return () => {
      request.current = null;
    };
  }, [host.engine, port, seed, request]);
  return input;
}

function useCreateEvent(port: CalendarPort) {
  const { host, commands, route } = useFrame();
  const e = useText("event");
  const report = useReport();
  const zone = useTimeZone();
  const request = useRef<symbol | null>(null);
  const committed = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const create = async (draft: NewEventDraft, target?: CalendarRecord) => {
    if (request.current || !target) return;
    const actual = host.engine.store.get<CalendarRecord>("calendar", target.id);
    const connection =
      actual && host.engine.store.get<CalendarConnectionRecord>("calendar_connection", actual.connectionId);
    if (!actual?.shown || viewOnlyOf(actual, connection)) {
      setFailure(e("refusal.readOnly"));
      return;
    }
    const event = fieldsOfDraft(draft, actual, draft.zone ?? zone);
    if (!event) return;
    if (connection?.provider === "microsoft" && (draft.alarms?.length ?? 0) > 1) {
      setFailure(e("fault.notAllowed"));
      return;
    }
    const ticket = Symbol();
    request.current = ticket;
    setBusy(true);
    try {
      const heard = await pressAndHear(port, {
        kind: "calendar_event_create",
        eventId: port.newId(),
        calendarId: actual.id,
        event: {
          ...event,
          invitees: (draft.invitees ?? []).flatMap(({ address, name, role }) =>
            role === "required" || role === "optional" ? [{ address, name, role }] : [],
          ),
        },
      });
      if (request.current !== ticket) return;
      if (heard.verdict?.kind === "refused") {
        setFailure(e(heard.say!));
        return;
      }
      if (heard.say) report(e(heard.say));
      committed.current = true;
      const now = nowIn(Date.now(), zone, readerZones());
      const staysOnToday = route.sub === null && now !== null && isoOfDay(now.day) === draft.day;
      commands.go({ place: "week", sub: staysOnToday ? null : draft.day }, { replace: true });
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
  const hasWords = Boolean(
    draft.title.trim() ||
    draft.place?.trim() ||
    draft.notes?.trim() ||
    draft.invitees?.length ||
    draft.alarms !== undefined,
  );
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
