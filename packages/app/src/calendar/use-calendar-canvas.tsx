import { useState } from "react";
import {
  addDays,
  clockOf,
  dayOfIso,
  isoOfDay,
  weekdayNames,
  weekdayOfDay,
  type HeldEdge,
  type PlainDate,
  type RangeActs,
  type RangeInput,
} from "@ohmail/app-logic/calendar";
import { newEventsCalendarOf } from "@ohmail/app-logic/calendar/setup";
import { EventChip } from "@ohmail/ui/calendar";
import { useCalendarInvitation, useFrame } from "../frame/commands.js";
import type { CalendarPlaceId, FrameCommands, Route } from "../frame/contract.js";
import type { CalendarSurfaceProps } from "./CalendarBody.js";
import { slotOnDay, useSlotDraft } from "./use-slot-draft.js";
import { DRAFT_EVENT, draftCalendars } from "./event-draft.js";
import type { CalendarViewProps } from "./view.js";
import type { DraftPreview } from "./NewEvent.js";
import { useLocale } from "../text/index.js";
import { shifted } from "./where.js";
import type { CalendarEventFace } from "./faces.js";
import { useEventActions } from "./use-event-actions.js";
import { PROPOSAL_DRAFT } from "./use-event-proposals.js";
import { useEventLetters } from "./use-event-letters.js";
import { useEventDrag } from "./use-event-drag.js";
import { calendarDragHandler, calendarResizeHandler, canvasClickHandler } from "./canvas-gestures.js";

export function useCalendarCanvas(
  props: CalendarSurfaceProps,
  commands: FrameCommands,
  opened: CalendarEventFace | undefined,
) {
  const { host } = useFrame();
  const locale = useLocale();
  const { route, port, zones, where, found, zone } = props;
  const { settings, plan, agendaPanel, cursor, create, sources } = props;
  const { current: invitation } = useCalendarInvitation();
  const actions = useEventActions(port, zones);
  const stepWeek = weekEdgeStep(props, commands);
  const { startSlot, preview: slot } = useSlotDraft(
    !actions.proposal.draft && route.open === null && route.words.panel !== "new" ? create : null,
    where.place,
    stepWeek,
  );
  const {
    drag,
    preview: dragged,
    suppressClick,
    rangePreview,
  } = useEventDrag(actions, where.place, zone, zones, stepWeek);
  const canvasClick = canvasClickHandler(
    !actions.proposal.draft && route.open !== null,
    () => commands.event(null),
    suppressClick,
  );
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  const { place, anchor, anchorDay, today, now, nowMs } = where;
  const go = (to: Partial<Route> & { place: CalendarPlaceId }) =>
    commands.go({ words: route.words.panel ? { panel: route.words.panel } : {}, ...to });
  const closePanel = () => commands.go({ place, sub: route.sub, open: route.open, words: {} });
  const shown = sources.calendars.filter((calendar) => calendar.shown);
  const edge: HeldEdge = {
    ...found.edge,
    load: port.load,
    provider:
      shown.length > 0 &&
      shown.every((calendar) => sources.connections.get(calendar.connectionId)?.provider === "microsoft")
        ? "microsoft"
        : undefined,
  };
  const extra =
    actions.proposal.preview(opened, useEventLetters(opened).letters) ??
    (route.words.panel === "new" ? preview?.face : null);
  const events = extra || invitation ? [...found.events, ...(extra ? [extra] : [])] : found.events;
  if (invitation?.id === route.words.invitation && invitation) events.push(invitation);
  const open: FrameCommands["event"] = (ref) => {
    if (ref && [DRAFT_EVENT, PROPOSAL_DRAFT].includes(ref.event)) return;
    commands.event(ref);
  };
  const input: RangeInput = {
    events,
    anchor,
    today,
    nowMinute: now.minutes,
    zone,
    zones,
    weekStart: settings.weekStart,
    weekNumbers: settings.weekNumbers,
    open: route.open,
    device: plan.device,
  };
  const acts: RangeActs = {
    event: (e) => open(e === null ? null : e.ref),
    pick: (day) => go({ place, sub: day }),
    view: (view, day) => go({ place: view, sub: day }),
    reveal: (e) => go({ place: "week", sub: e.ref.day, open: e.id }),
  };
  const onDrag = calendarDragHandler(actions, drag, route.words.panel === "new", preview, found.events);
  const draftTone = slot && newEventTone(settings, sources);
  const dragPreview = slot?.kind === "time" ? draftSlotChip(slot, draftTone, locale) : dragged;
  const timeProps: CalendarViewProps = {
    anchor: anchorDay,
    events,
    hiddenBusy: found.hiddenBusy,
    capped: found.capped,
    edge,
    openId: route.open,
    revealOpen:
      route.open !== null &&
      (route.open === route.words.invitation ||
        (plan.device === "phone" && route.words.panel === "invitations")),
    clock: { zone, zones, nowMs },
    settings,
    plan,
    fixedHourHeight: host.device.build.surface === "phone" && plan.device === "phone",
    panel: agendaPanel.visible,
    cursor,
    stepDay:
      plan.device === "phone" && route.words.panel !== "new"
        ? (direction: -1 | 1) => go({ place, sub: addDays(anchor, direction) })
        : undefined,
    onOpen: open,
    onSlot: startSlot,
    monthSelection: slot?.kind === "month" ? { ...slot, tone: draftTone } : undefined,
    onResizeTime:
      onDrag && route.words.panel !== "new" ? calendarResizeHandler(actions, found.events) : undefined,
    onDrag,
    dragPreview: dragPreview ?? undefined,
    onDay: (day: PlainDate) => go({ place: "day", sub: isoOfDay(day) }),
  };
  return {
    actions,
    canvasClick,
    setPreview,
    rangePreview,
    go,
    closePanel,
    edge,
    input,
    acts,
    timeProps,
    dragging: !!(slot || dragged || rangePreview || actions.proposal.draft),
  };
}

function newEventTone(settings: CalendarSurfaceProps["settings"], sources: CalendarSurfaceProps["sources"]) {
  const target = newEventsCalendarOf(
    settings.newEventsCalendarId ?? null,
    draftCalendars(sources.calendars, sources.connections),
  );
  return target ? (sources.tones.get(target.id) ?? "neutral") : null;
}

function weekEdgeStep({ where, route, plan }: CalendarSurfaceProps, commands: FrameCommands) {
  if (where.place !== "week") return undefined;
  const one = plan.device === "phone" && plan.size === "compact";
  return (direction: -1 | 1) =>
    commands.go({
      place: "week",
      sub: shifted("week", where.anchor, direction, one),
      words: route.words,
    });
}

function draftSlotChip(
  slot: Extract<NonNullable<ReturnType<typeof useSlotDraft>["preview"]>, { kind: "time" }>,
  tone: CalendarEventFace["tone"],
  locale: string,
) {
  const dayMinutes = 24 * 60;
  const through = Math.floor((slot.to - 1) / dayMinutes);
  const endDay = through ? dayOfIso(addDays(slot.day, through)) : null;
  const dayWord = endDay ? weekdayNames(locale, 0, "short")[weekdayOfDay(endDay)] : null;
  const title = `${clockOf(slot.from)}–${clockOf(slot.to % dayMinutes)}${dayWord ? ` ${dayWord}` : ""}`;
  return (day: string, hourHeight: number) => {
    const part = slotOnDay(slot, day);
    return (
      part && (
        <EventChip
          size="block"
          state="draft"
          drag="copy"
          title={title}
          tone={tone}
          place={{ top: (part.from * hourHeight) / 60, height: ((part.to - part.from) * hourHeight) / 60 }}
        />
      )
    );
  };
}
