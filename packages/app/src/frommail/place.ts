/**
 * FROM MAIL AS A PLACE of the calendar: the found events in the list's column, the open one beside it. Registered as
 * the calendar entry's `places.frommail`; it draws no rail of its own.
 */
import type { PlaceEntry } from "../frame/contract.js";
import { FromMailList } from "./FromMailList.js";
import { FromMailReading } from "./FromMailReading.js";

export const fromMailPlace: PlaceEntry = {
  id: "frommail",
  body: "frommail",
  rail: null,
  panes: { kind: "columns", List: FromMailList, Reading: FromMailReading },
};
