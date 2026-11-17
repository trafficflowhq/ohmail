import { describe, expect, it } from "vitest";
import { fragmentOf, isCalendarFragment, routeOf } from "../../src/frame/route.js";
import { eventRefOf, eventRefString, productOf } from "../../src/frame/product.js";

/** Every form today's addresses take, written as the app writes them. */
const CANONICAL = [
  "#/ohbox",
  "#/ohbox/m/a1",
  "#/reads",
  "#/reads/m/a1",
  "#/receipts",
  "#/history/m/a1",
  "#/search",
  "#/search/m/a1",
  "#/compose",
  "#/drafts",
  "#/trash",
  "#/trash/m/a1",
  "#/screener",
  "#/screener/screened",
  "#/screener/spam",
  "#/triage",
  "#/triage/m/a1",
  "#/triage/aside",
  "#/triage/resurface/m/a1",
  "#/tag/t-9",
  "#/tag/t-9/m/a1",
  "#/folder/f-2",
  "#/folder/f-2/m/a1",
  "#/address/lena%40example.com",
  "#/address/lena%40example.com/m/a1",
  "#/settings",
  "#/settings/general",
  "#/settings/mailboxes",
  "#/settings/mailboxes?mailbox=mb-1",
  "#/first-run",
  "#/first-run/again",
  "#/first-run/add",
  "#/first-run?mailbox=mb-1",
  "#/first-run/add?mailbox=mb-1",
];

describe("the route: one object for the place a person is in", () => {
  it("reads every canonical address and writes it back the same", () => {
    for (const fragment of CANONICAL) expect(fragmentOf(routeOf(fragment)), fragment).toBe(fragment);
  });

  it("names the place, its own word and the open letter", () => {
    expect(routeOf("#/reads/m/a1")).toEqual({ place: "news", sub: null, open: "a1", stage: null, words: {} });
    expect(routeOf("#/triage/aside")).toMatchObject({ place: "parked", sub: null, open: null });
    expect(routeOf("#/triage")).toMatchObject({ place: "later" });
    expect(routeOf("#/screener/spam")).toMatchObject({ place: "screener", sub: "spam" });
    expect(routeOf("#/tag/t-9/m/a1")).toMatchObject({ place: "tags", sub: "t-9", open: "a1" });
    expect(routeOf("#/address/lena%40example.com")).toMatchObject({
      place: "address",
      sub: "lena@example.com",
    });
    expect(routeOf("#/settings/mailboxes?mailbox=mb-1")).toMatchObject({
      place: "settings",
      sub: "mailboxes",
      words: { mailbox: "mb-1" },
    });
    expect(routeOf("#/compose")).toMatchObject({ place: "write" });
  });

  it("opens the first run as a stage over the Ohbox", () => {
    expect(routeOf("#/first-run/add?mailbox=mb-1")).toEqual({
      place: "ohbox",
      sub: null,
      open: null,
      stage: { id: "firstRun", words: { how: "add", mailbox: "mb-1" } },
      words: {},
    });
  });

  it("takes an open letter only where a place lists letters", () => {
    expect(routeOf("#/compose/m/a1")).toMatchObject({ place: "write", open: null });
    expect(routeOf("#/screener/m/a1")).toMatchObject({ place: "screener", open: null });
    expect(fragmentOf({ ...routeOf("#/settings"), open: "a1" })).toBe("#/settings");
  });

  it("reads an unknown address, an empty one and a pane it does not know as the plainest place", () => {
    expect(fragmentOf(routeOf(""))).toBe("#/ohbox");
    expect(fragmentOf(routeOf("#/nowhere"))).toBe("#/ohbox");
    expect(fragmentOf(routeOf("#/settings/nowhere"))).toBe("#/settings");
    expect(fragmentOf(routeOf("#/triage/nowhere"))).toBe("#/triage");
    expect(fragmentOf(routeOf("#/screener/nowhere"))).toBe("#/screener");
    expect(fragmentOf(routeOf("#/tag/"))).toBe("#/ohbox");
  });

  it("keeps a malformed escape as it was typed", () => {
    expect(routeOf("#/address/%E0%A4%A")).toMatchObject({ place: "address", sub: "%E0%A4%A" });
  });
});

/** The calendar's canonical addresses, the same on every host. */
const CALENDAR_CANONICAL = [
  "#/cal/week",
  "#/cal/week/2026-11-16",
  "#/cal/week/2026-11-16/e/ev-1",
  "#/cal/day/2026-03-29/e/ev-2%4020260329T010000",
  "#/cal/month/2026-11-01?panel=agenda",
  "#/cal/year",
  "#/cal/agenda",
  "#/cal/find?q=lunch+with+lena",
  "#/cal/from-mail",
  "#/cal/calendars",
  "#/cal/calendars/connections",
  "#/cal/cal-setup",
];

describe("the calendar's part of the route", () => {
  it("reads every canonical calendar address and writes it back the same", () => {
    for (const fragment of CALENDAR_CANONICAL) expect(fragmentOf(routeOf(fragment)), fragment).toBe(fragment);
  });

  it("names the place, the anchor day, the open event and the panel", () => {
    expect(routeOf("#/cal/week/2026-11-16/e/ev-1?panel=agenda")).toEqual({
      place: "week",
      sub: "2026-11-16",
      open: "ev-1",
      stage: null,
      words: { panel: "agenda" },
    });
    expect(routeOf("#/cal/find?q=lunch")).toMatchObject({ place: "calsearch", words: { q: "lunch" } });
    expect(routeOf("#/cal/cal-setup")).toMatchObject({ place: "week", stage: { id: "calSetup", words: {} } });
  });

  it("reads #/cal as the week of today, and a day that does not exist as today", () => {
    expect(routeOf("#/cal")).toMatchObject({ place: "week", sub: null, open: null });
    expect(routeOf("#/cal?")).toMatchObject({ place: "week", sub: null });
    expect(routeOf("#/cal/month/2026-02-30")).toMatchObject({ place: "month", sub: null });
    expect(routeOf("#/cal/day/2028-02-29")).toMatchObject({ place: "day", sub: "2028-02-29" });
    expect(routeOf("#/cal/day/tomorrow")).toMatchObject({ place: "day", sub: null });
    expect(routeOf("#/cal/nowhere")).toMatchObject({ place: "week", sub: null });
  });

  it("reads a fragment that starts with a calendar head as the calendar, and writes it in the canonical form", () => {
    expect(fragmentOf(routeOf("#/week/2026-11-16"))).toBe("#/cal/week/2026-11-16");
    expect(fragmentOf(routeOf("#/find?q=dentist"))).toBe("#/cal/find?q=dentist");
  });

  it("keeps a panel it does not know and the search's words out of every other place", () => {
    expect(routeOf("#/cal/week?panel=mail").words).toEqual({});
    expect(routeOf("#/cal/week?q=lunch").words).toEqual({});
  });

  it("tells a calendar fragment from mail's by its first segment alone", () => {
    for (const fragment of [
      ...CALENDAR_CANONICAL,
      "#/cal",
      "#/cal?panel=agenda",
      "#/week",
      "#/day/2026-11-16",
    ])
      expect(isCalendarFragment(fragment), fragment).toBe(true);
    for (const fragment of [...CANONICAL, "", "#/", "#/nowhere", "#/calendar", "#/search"])
      expect(isCalendarFragment(fragment), fragment).toBe(false);
  });

  it("knows no mail address as the calendar's, and no calendar address as mail's", () => {
    for (const fragment of CANONICAL) expect(productOf(routeOf(fragment).place), fragment).toBe("mail");
    for (const fragment of CALENDAR_CANONICAL)
      expect(productOf(routeOf(fragment).place), fragment).toBe("cal");
  });

  it("carries one day of a series as the event's id and its occurrence key", () => {
    const ref = { event: "ev-2", occurrence: "20260329T010000", day: "2026-03-29" };
    expect(eventRefString(ref)).toBe("ev-2@20260329T010000");
    expect(eventRefOf(eventRefString(ref), ref.day)).toEqual(ref);
    expect(eventRefOf("ev-1", "2026-11-16")).toEqual({ event: "ev-1", occurrence: null, day: "2026-11-16" });
    expect(eventRefOf("@20260329T010000", "2026-03-29")).toBeNull();
    expect(eventRefOf("ev-2@", "2026-03-29")).toBeNull();
    expect(eventRefOf(null, "2026-03-29")).toBeNull();
  });

  it("keeps an occurrence key whole when its zone's name, a stranger's text, holds an @", () => {
    const ref = { event: "ev-3", occurrence: "Team@Home Zone|20261116T0900|false", day: "2026-11-16" };
    expect(eventRefOf(eventRefString(ref), ref.day)).toEqual(ref);
  });
});
