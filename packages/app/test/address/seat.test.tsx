/** @vitest-environment jsdom */
/**
 * AN ADDRESS'S OWN SEAT, over the tests' door of a mount (`../places/list-seat.tsx`): every letter this device holds
 * from and to one address, as All, From them or To them with their counts, the place each is in, read in place.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineMessage } from "@ohmail/wire";
import { calendar } from "../../src/calendar/entry.js";
import { Frame } from "../../src/frame/Frame.js";
import { TextProvider } from "../../src/text/index.js";
import { calendarRecord, connectionRecord, mirror, WORDS as calendarWords } from "../calsetup/world.js";
import { letter } from "../reader/support/mail.js";
import { LIST_WORDS, listFrame, listSeat, sent } from "../places/list-seat.js";

/** A letter of a day of November; a folder by any name the mail server may give one. */
const at = (
  day: number,
  over: Omit<Partial<EngineMessage>, "folder"> & { folder?: string } = {},
): EngineMessage =>
  letter(over.id ?? `d${day}`, {
    date: new Date(Date.UTC(2026, 10, day, 9)).toISOString(),
    arrivedAt: new Date(Date.UTC(2026, 10, day, 9)).toISOString(),
    ...over,
    folder: (over.folder ?? "INBOX") as EngineMessage["folder"],
  });
const BEN = { name: "Ben Kiln", address: "ben@kiln.example" };
const ME = { name: null, address: "me@studio.example" };
/* Two from Ben (one in News), one to Ben, one that does not name him. */
const LETTERS = [
  at(10, { id: "a", subject: "Kiln schedule", from: BEN, to: [ME] }),
  at(11, { id: "b", subject: "Kiln newsletter", from: BEN, to: [ME], folder: "ohmail/Reads" }),
  at(12, { id: "c", subject: "Re: Kiln schedule", from: ME, to: [BEN], folder: "Sent" }),
  at(13, { id: "d", subject: "Unrelated", from: { name: "Ada", address: "ada@else.example" }, to: [ME] }),
];

const rows = (): HTMLElement[] => screen.queryAllByRole("option");
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => cleanup());

describe("an address's own seat, over the mail ground", () => {
  it("a direct address opens its first letter without adding a history entry and can return to the Ohbox", async () => {
    const { address } = listSeat({ letters: LETTERS, first: "#/address/ben%40kiln.example" });
    expect(address.writes).toEqual([{ next: "#/address/ben%40kiln.example/m/c", how: "replace" }]);
    fireEvent.click(screen.getByRole("button", { name: /^Close$/ }));
    await settle();
    expect(address.read()).toBe("#/ohbox");
  });

  it("Escape returns an address opened within the app to the place and letter it came from", async () => {
    const { address } = listSeat({ letters: LETTERS, first: "#/history/m/b" });
    act(() => address.visit("#/address/ben%40kiln.example"));
    expect(address.read()).toBe("#/address/ben%40kiln.example/m/c");
    fireEvent.keyDown(document.body, { key: "Escape" });
    await settle();
    expect(address.read()).toBe("#/history/m/b");
  });

  it.each(["direct link", "from History", "a different address"])(
    "keeps the Address return target after a Calendar visit: %s",
    async (start) => {
      const contact = "#/address/ben%40kiln.example";
      const history = "#/history/m/b";
      const dates = mirror();
      dates.put("calendar_connection", "conn-1", connectionRecord());
      dates.put("calendar", "cal-1", calendarRecord());
      const calendarPress = vi.fn(async () => ({ key: "unexpected" }));
      dates.port.press = calendarPress;
      const { host, address } = listFrame({
        first: start === "direct link" ? contact : history,
        letters: LETTERS,
        engine: () => ({ store: dates.engine.store }),
      });
      render(
        <TextProvider locale="en" messages={{ ...LIST_WORDS, ...calendarWords.en }} timeZone="Europe/Zurich">
          <Frame
            host={{
              ...host,
              capabilities: { ...host.capabilities, products: "both" },
              features: { ...host.features, calendar },
              wires: { ...host.wires, calendar: dates.port },
            }}
          />
        </TextProvider>,
      );
      if (start !== "direct link") act(() => address.visit(contact));
      expect(address.read()).toBe(`${contact}/m/c`);
      const press = (key: string) => fireEvent.keyDown(document.body, { key });
      press("g");
      press("c");
      expect(address.read()).toBe("#/cal/week");
      const views = within(await screen.findByRole("group", { name: "View" }));
      expect(views.getByRole("button", { name: "Week" }).getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
      expect(address.read()).toMatch(/^#\/cal\/week\/\d{4}-\d{2}-\d{2}$/);
      if (start === "a different address") {
        const other = `#/address/${encodeURIComponent(LETTERS[3]!.from.address)}`;
        act(() => address.visit(other));
        expect(address.read()).toBe(`${other}/m/d`);
      } else {
        press("g");
        press("m");
        expect(address.read()).toBe(`${contact}/m/c`);
      }
      press("Escape");
      expect(address.read()).toBe(start === "from History" ? history : "#/ohbox");
      await settle();
      expect(calendarPress).not.toHaveBeenCalled();
    },
  );

  it("lists every letter from and to the address, newest first, under the name it goes by", () => {
    listSeat({ letters: LETTERS, first: "#/address/ben%40kiln.example" });
    expect(rows().map((r) => r.dataset.id)).toEqual(["c", "b", "a"]);
    expect(screen.getByRole("heading", { name: "Ben Kiln" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "From them 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "To them 1" })).toBeTruthy();
  });

  it("From them narrows the list to the letters the address sent", () => {
    listSeat({ letters: LETTERS, first: "#/address/ben%40kiln.example" });
    fireEvent.click(screen.getByRole("button", { name: "From them 2" }));
    expect(rows().map((r) => r.dataset.id)).toEqual(["b", "a"]);
  });

  it("a row opens its letter beside the list, and its panel's verbs leave through the frame's one seam", async () => {
    const { address, mail } = listSeat({ letters: LETTERS, first: "#/address/ben%40kiln.example" });
    fireEvent.click(screen.getByRole("option", { name: "Ben Kiln: Kiln schedule" }));
    await settle();
    expect(address.read()).toBe("#/address/ben%40kiln.example/m/a");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Later" }));
    });
    expect(sent(mail)).toContain("triage_set a reply_later");
  });
});

/*
 * THE OLDER CASES OF TODAY'S ADDRESS VIEW (apps/webapp/test/address-view-render.test.tsx, address-view.test.tsx) that
 * state the device's half, as the seat holds them: the same claims, by the same names. The archive's half (the mail
 * server's own count and letters past this device) is not seated yet: its cases wait for it.
 */
describe("the address view — header, toggle, count line, rows (today's cases, over the seat)", () => {
  it("names the person, states the address beside them, and counts each direction on the toggle", () => {
    listSeat({ letters: LETTERS, first: "#/address/ben%40kiln.example" });
    const list = screen.getByRole("listbox", { name: "All" }).closest("section")!;
    expect(screen.getByRole("heading", { name: "Ben Kiln" })).toBeTruthy();
    expect(list.querySelector(".oh-listhead")!.textContent).toContain("ben@kiln.example");
    const toggle = screen.getByRole("group", { name: "Direction" });
    expect([...toggle.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "All 3",
      "From them 2",
      "To them 1",
    ]);
    expect(rows()).toHaveLength(3);
  });
});

describe("useAddressView — the device half (today's case, over the seat)", () => {
  it("re-derives the device half when the mirror moves", async () => {
    const { mail } = listSeat({ letters: LETTERS, first: "#/address/ben%40kiln.example" });
    const counts = () =>
      [...screen.getByRole("group", { name: "Direction" }).querySelectorAll("button")].map(
        (b) => b.textContent,
      );
    expect(counts()).toEqual(["All 3", "From them 2", "To them 1"]);
    /* A letter to them arrives in the mirror, as a send's copy does. */
    await act(async () =>
      mail.add(at(14, { id: "e", subject: "Re: Kiln", from: ME, to: [BEN], folder: "Sent" })),
    );
    await settle();
    expect(counts()).toEqual(["All 4", "From them 2", "To them 2"]);
  });
});
