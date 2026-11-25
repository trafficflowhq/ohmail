import {
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
  readerZones,
  type CalendarConnectionRecord,
  type CalendarPort,
  type CalendarRecord,
  type PlainDate,
} from "@ohmail/app-logic/calendar";
import { newEventsCalendarOf, wayOfConnection } from "@ohmail/app-logic/calendar/setup";
import { QuickAdd } from "@ohmail/ui/calendar";
import { RefusalLine } from "@ohmail/ui/base";
import { useCalendarDraftSeed, useFrame, type CalendarGuest } from "../frame/commands.js";
import { useOwnAddresses } from "../frame/room.js";
import { fragmentOf, routeOf } from "../frame/route.js";
import { useText, useTimeZone, type Text } from "../text/index.js";
import { useDiscardReport, useDraftRestore, type DraftWriteFailure } from "./draft-undo.js";
import { useCreateEvent } from "./use-create-event.js";
import { repeatRefusal } from "./repeat.js";
import { DraftTimeNotice } from "./DraftTimeNotice.js";
import { DraftFields, readDraftEntry, type NewEventDraft } from "./DraftFields.js";
import { DraftInvitation, useDraftInvitation, useGuestConfirmation } from "./DraftInvitation.js";
import {
  draftCalendars,
  draftCalendarIsReadOnly,
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
  const t = useText("calendar");
  const e = useText("event");
  const zone = useTimeZone();
  const { seed, written, setDraft, chosen, choose, recovered } = useNewDraft(port, now, zone);
  const invitation = useDraftInvitation(seed.current?.guests ?? []);
  const today = isoOfDay(now.day);
  const parsed = useMemo(() => readDraftEntry(written, today), [written, today]);
  const draft = parsed?.draft ?? written;
  const choices = draftCalendars(calendars, connections);
  const proposed = newEventsCalendarOf(preferred ?? null, choices);
  const discardReport = useDiscardReport(port);
  const target = chosen === null ? (proposed ?? undefined) : choices.find((c) => c.id === chosen);
  const tone = target ? (tones.get(target.id) ?? "neutral") : null;
  const readOnly = draftCalendarIsReadOnly(calendars, connections, chosen ?? preferred, !choices.length);
  const card = useRef<HTMLDivElement>(null);
  const { create, close, request, committed, busy, failure, setFailure } = useCreateEvent(port, card);
  const input = useNewDraftPreview(
    { port, draft, target: busy ? undefined : target, zone, tone },
    request,
    onPreview,
    setDraft,
  );
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
  const connection = target && connections.get(target.connectionId);
  const provider = connection?.provider;
  const iCloud = connection !== undefined && wayOfConnection(connection) === "icloud";
  const inviteesRefused = recovered?.calendar === target?.id && recovered?.inviteesRefused;
  const canInvite = !!target && (provider !== "caldav" || target.autoSchedule === true) && !inviteesRefused;
  const selected = canInvite ? invitation.selected : [];
  const hasGuests = Boolean(draft.invitees?.length || invitation.selected.length);
  const saveWithoutGuests = !canInvite && hasGuests;
  const proposedGuest = useQuickGuest(canInvite ? parsed?.guest : undefined, draft, selected, change);
  const { formDraft, extraAlert, callNotSupported, ready, refused } = draftLimits(
    draft,
    target,
    connection,
    draft.zone ?? zone,
    t,
    e,
  );
  const { add, confirmation } = useGuestConfirmation(
    card,
    saveWithoutGuests ? { ...draft, invitees: [] } : draft,
    selected,
    () => ready && !request.current,
    (confirmedDraft) => void create(confirmedDraft, target, recovered?.writeId),
    iCloud && canInvite,
  );
  const refusal = failure ?? (recovered?.calendar === target?.id ? recovered?.reason : undefined) ?? refused;
  const noInvitations = target && provider === "caldav" && !canInvite && !inviteesRefused;
  const draftCalendar = chosen ?? target?.id ?? null;
  useNewDraftDeparture(written, draftCalendar, recovered, discardReport, busy, request, committed);
  return (
    <>
      <QuickAdd
        ref={card}
        busy={busy}
        label={t("create.title")}
        tone={tone}
        line={{
          label: t("create.title"),
          placeholder: t("create.example"),
          value: written.title,
          found: parsed?.marks,
          onChange: (title) => change({ title, typed: true }),
          ref: input,
        }}
        close={{ label: t("closeEvent"), onPress: close }}
        onAdd={add}
      >
        {canInvite && <DraftInvitation invitation={invitation} />}
        <DraftTimeNotice issue={draftTimes(draft, draft.zone ?? zone).issue} />
        <DraftFields
          draft={canInvite ? formDraft : { ...formDraft, invitees: [] }}
          repeatShapes={connection?.repeatShapes}
          proposedGuest={proposedGuest}
          edit={{
            canInvite,
            canAddAlert: target !== undefined,
            canAddSecondAlert: extraAlert || (provider !== "microsoft" && !draft.allDay),
            showCall: provider === "caldav" || callNotSupported,
            inviteesAbove: card,
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
            label: t(saveWithoutGuests ? "draft.saveWithoutGuests" : "create.add"),
            keyHint: "↵",
            disabled: busy || !ready,
            onPress: add,
          }}
        />
        {noInvitations && <RefusalLine start>{t("edit.noInvitations")}</RefusalLine>}
        {(refusal || readOnly) && (
          <RefusalLine start alert={!!failure || !!recovered}>
            {refusal ?? e("refusal.readOnly")}
          </RefusalLine>
        )}
      </QuickAdd>
      {confirmation}
    </>
  );
}

function useNewDraft(port: CalendarPort, now: Props["now"], zone: string) {
  const { route } = useFrame();
  const seed = useCalendarDraftSeed();
  const [written, setDraft] = useState<NewEventDraft>(() => {
    const clock = nowIn(Date.now(), zone, readerZones()) ?? now;
    const day = dayOfIso(route.sub) ?? clock.day;
    return {
      ...startDraft(isoOfDay(day), clock.minutes, route.words.slot),
      title: seed.current?.title ?? "",
    };
  });
  const [chosen, choose] = useState<string | null>(null);
  const [recovered, recover] = useState<DraftWriteFailure | undefined>();
  useDraftRestore("new", port, ({ draft, calendar, failure }) => {
    setDraft(draft);
    choose(calendar);
    recover(failure);
  });
  return { seed, written, setDraft, chosen, choose, recovered };
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
  {
    port,
    draft,
    target,
    zone,
    tone,
  }: {
    port: CalendarPort;
    draft: NewEventDraft;
    target: CalendarRecord | undefined;
    zone: string;
    tone: CalendarEventFace["tone"];
  },
  request: RefObject<symbol | null>,
  onPreview: Props["onPreview"],
  setDraft: Dispatch<SetStateAction<NewEventDraft>>,
) {
  const { host } = useFrame();
  const seed = useCalendarDraftSeed();
  const untitled = useText("calendar")("create.title");
  useLayoutEffect(() => {
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

/** What this calendar cannot keep of the draft (a repeat, a second alert, a call), and whether it can be added. */
function draftLimits(
  draft: NewEventDraft,
  target: CalendarRecord | undefined,
  connection: CalendarConnectionRecord | undefined,
  zone: string,
  t: Text,
  e: Text,
) {
  const provider = connection?.provider;
  const start = draftTimes(draft, zone).times?.start;
  const badRule = repeatRefusal(draft.repeat, start, connection?.repeatShapes, t);
  const formDraft =
    target && draft.alarms === undefined
      ? { ...draft, alarms: target.defaultAlarms.map((alarm) => alarm.minutesBefore) }
      : draft;
  const extraAlert = (formDraft.alarms?.length ?? 0) > 1;
  const tooManyAlerts = provider === "microsoft" && (draft.alarms?.length ?? 0) > 1;
  const callNotSupported = !!draft.callLink?.trim() && provider !== "caldav";
  const ready =
    !!target && !badRule && !tooManyAlerts && !callNotSupported && !!fieldsOfDraft(draft, target, zone);
  const refused = badRule ?? (tooManyAlerts || callNotSupported ? e("fault.notAllowed") : null);
  return { formDraft, extraAlert, callNotSupported, ready, refused };
}

function useNewDraftDeparture(
  draft: EventDraft,
  calendar: string | null,
  failure: DraftWriteFailure | undefined,
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
    draft.repeat ||
    draft.invitees?.length ||
    draft.alarms !== undefined,
  );
  const departure = useRef(() => {});
  departure.current = () => {
    if (hasWords && !committed.current) report({ kind: "new", draft, calendar, failure });
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
