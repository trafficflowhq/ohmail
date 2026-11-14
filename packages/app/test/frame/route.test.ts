import { describe, expect, it } from "vitest";
import { fragmentOf, routeOf } from "../../src/frame/route.js";

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
