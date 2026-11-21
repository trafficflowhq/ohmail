/**
 * THE CALENDAR'S REGISTRATION: the one record a shell hands the frame as `FrameSupplies.calendar`. Every slot is the
 * entry or `none`. The invitations, From mail, setup and the calendar's settings plug into their four lines below
 * (`places.frommail`, `places.calsettings`, `stage`, `panels.invitations`), and into nothing else of this folder.
 * The Agenda beside a view is drawn by the body itself, from the same occurrences as the view.
 */
import { NONE } from "../host/index.js";
import { CALENDAR_HOME } from "../frame/product.js";
import { useFrame } from "../frame/commands.js";
import type { CalendarEntry, CalendarPlaceId, PlaceEntry } from "../frame/contract.js";
import { calsettingsPlace } from "../calsettings/index.js";
import { calSetupStage } from "../calsetup/index.js";
import { fromMailPlace } from "../frommail/index.js";
import { InvitationsPanel, useInvitations } from "../invitations/index.js";
import { CalendarRail } from "./CalendarRail.js";
import { CalendarAbove } from "./CalendarAbove.js";
import { useCalendarSwitchOffered } from "../calsettings/settings-read.js";
import { useCalendarFirstStep } from "./CalendarFirstStep.js";
import { CalendarBody } from "./CalendarBody.js";
import { CalendarNoticeBody } from "./CalendarNoticeBody.js";

/** The six views are places of one mounted body: the hours in view and the open event stay across a change of view. */
const view = (id: CalendarPlaceId): PlaceEntry => ({
  id,
  body: "calendar",
  rail: null,
  panes: { kind: "wide", Wide: CalendarBody },
});

function useCalendarWants(): boolean {
  const { host } = useFrame();
  return Boolean(useInvitations(host.wires.calendar)?.groups.waiting);
}

function useCalendarSwitchHome(): CalendarPlaceId | undefined {
  return useCalendarFirstStep() ? CALENDAR_HOME : undefined;
}

export const calendar: CalendarEntry = {
  places: {
    week: view("week"),
    day: view("day"),
    month: view("month"),
    year: view("year"),
    agenda: view("agenda"),
    calsearch: view("calsearch"),
    frommail: fromMailPlace,
    calsettings: calsettingsPlace,
  },
  stage: calSetupStage,
  panels: { agenda: NONE, invitations: InvitationsPanel },
  Rail: CalendarRail,
  Above: CalendarAbove,
  useSwitchOffered: useCalendarSwitchOffered,
  useSwitchHome: useCalendarSwitchHome,
  useWants: useCalendarWants,
};

export const calendarNoticePlace: PlaceEntry = {
  ...view("week"),
  panes: { kind: "wide", Wide: CalendarNoticeBody },
};
