/**
 * THE CALENDAR'S REGISTRATION: the one record a shell hands the frame as `FrameSupplies.calendar`. Every slot is the
 * entry or `none`. The invitations, From mail, setup and the calendar's settings plug into their four lines below
 * (`places.frommail`, `places.calsettings`, `stage`, `panels.invitations`), and into nothing else of this folder.
 * The Agenda beside a view is drawn by the body itself, from the same occurrences as the view.
 */
import { NONE } from "../host/index.js";
import type { CalendarEntry, CalendarPlaceId, PlaceEntry } from "../frame/contract.js";
import { calsettingsPlace } from "../calsettings/index.js";
import { calSetupStage } from "../calsetup/index.js";
import { fromMailPlace } from "../frommail/index.js";
import { InvitationsPanel } from "../invitations/index.js";
import { CalendarBody } from "./CalendarBody.js";

/** The six views are places of one mounted body: the hours in view and the open event stay across a change of view. */
const view = (id: CalendarPlaceId): PlaceEntry => ({
  id,
  body: "calendar",
  rail: null,
  panes: { kind: "wide", Wide: CalendarBody },
});

const NoRail: CalendarEntry["Rail"] = () => null;
const Through: CalendarEntry["Above"] = ({ children }) => children;
const nothingWaits = () => false;

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
  Rail: NoRail,
  Above: Through,
  useWants: nothingWaits,
};
