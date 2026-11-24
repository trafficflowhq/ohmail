/**
 * The calendar leaves the phone's engine. A phone that organizes on its own keeps no calendar in
 * 2.0, and its engine is one bundle under a ceiling that may only fall, so none of the calendar's
 * code and none of its tables may enter it: its builders, its sweeps, its time model and its
 * providers live behind entries of their own that the phone's entry never reaches, and the one
 * calendar module a mail module there imports (a mailbox erasure's calendar step) is swapped for a
 * twin by a `WORKSPACE_MODULE_SUBSTITUTES` row in `apps/sidecar/src/phone/aliases.js`.
 *
 * Read from the artifact: no calendar module is an input, the twin is, and no calendar table's name
 * is in the text, while the feed's four kind words still are.
 *
 * The patterns match a path wherever it stands, not only from the tree's root: a workspace module
 * that resolved OUTSIDE the tree (a build run in a copy whose `node_modules` links into another
 * checkout) is recorded as `../…/packages/…`, and a pattern anchored at the root reads such a
 * calendar module as absent. And the mail module whose import the twin replaces must be read from
 * this tree, under its own name: the substitution applies only to an importer inside the tree, so
 * a build that read it from elsewhere carries the calendar whatever the alias table says.
 */
import { describe, expect, it } from "vitest";

import { buildPhoneEngine } from "../scripts/bundle-engine.mjs";

const LEFT_OUT = [
  /(?:^|\/)packages\/(?:db|services|api)\/(?:src|dist)\/calendar\//,
  /(?:^|\/)packages\/cal-(?:core|providers)\//,
  /(?:^|\/)apps\/sidecar\/(?:src|dist)\/cloud-mirror-calendar\.[jt]s$/,
  /(?:^|\/)packages\/db\/(?:src|dist)\/schema-mail\.[jt]s$/,
];
const TWIN = "apps/sidecar/src/phone/calendar-erasure.ts";
/** The mail module that imports the calendar's erasure step; the alias row names it. */
const TWIN_IMPORTER = "packages/db/src/mailbox-erasure.ts";
const TABLES = [
  "cal_connections", "cal_credentials", "cal_calendars", "cal_events", "cal_attendees", "cal_alarms",
  "cal_writes", "cal_links", "cal_suggestions", "cal_settings", "cal_push_channels",
];

describe("the phone engine carries no calendar", () => {
  it("no calendar module is an input, the erasure's twin is, and no calendar table is named in it", async () => {
    const { inputs, applied, text } = await buildPhoneEngine({ write: false });
    expect(inputs).toContain(TWIN_IMPORTER);
    expect(inputs.filter((p: string) => LEFT_OUT.some((re) => re.test(p)))).toEqual([]);
    expect(inputs).toContain(TWIN);
    const rows = applied.filter(([, to]: [string, string]) => to.endsWith(TWIN));
    expect(rows.map(([from]: [string, string]) => from)).toEqual(["./calendar/erasure.js"]);
    expect(TABLES.filter((t) => text.includes(t))).toEqual([]);
    // Not vacuous: the feed's own words for the four kinds stand in the text, which the phone's
    // reader names to skip them.
    for (const kind of ["calendar_connection", "calendar_event", "calendar_suggestion"]) expect(text).toContain(kind);
  }, 120_000);
});
