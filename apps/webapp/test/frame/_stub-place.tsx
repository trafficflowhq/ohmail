/**
 * ONE STUB PLACE OF ANOTHER BODY, for the cases that walk today's views to a place they do not draw and back: two
 * columns, a list that says where it is, its reading column the reader's. It takes the id of News (`#/reads`), which
 * these walks do not need of today's. No host seats such a place yet; the day one does, the walks take that place.
 */
import { createElement } from "react";
import type { PlaceEntry } from "@ohmail/app/frame";

export const STUB_SAYS = "The stub place's list";
export const STUB_ADDRESS = "#/reads";

function StubList() {
  return createElement("p", null, STUB_SAYS);
}

export const STUB_PLACE: PlaceEntry = {
  id: "news",
  body: "stub",
  rail: null,
  panes: { kind: "columns", List: StubList, Reading: "reader" },
};
