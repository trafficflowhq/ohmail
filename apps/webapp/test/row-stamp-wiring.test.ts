/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import { headStamp, readerZone } from "@ohmail/app-logic/reader";
import { displayTime, fullDateTime } from "@ohmail/app-logic/text/format";
import { act, message, mountShell, NOW, storeWith, stubDom, unmountAll, waitFor } from "./_draft-shell.js";
/* These reads still cover the retained list fixtures' row stamps. Mounted places exercise their
   own stamp behavior in the list and reading-column tests. */

const read = (p: string) => readFileSync("apps/webapp/app/" + p, "utf8");

/** Every list surface that renders a mail row, and therefore stamps a flippable date. */
const MAIL_LISTS = [
  "ReadsView",
  "ReceiptsView",
  "HistoryView",
  "TagView",
  "TriageView",
] as const;

describe("the row stamp is wired into every mail list", () => {
  it.each(MAIL_LISTS)("%s takes the shell's flip and puts both forms on its rows", (view) => {
    const src = read(`views/${view}.tsx`);
    // (a) the props exist, with the shape the shell binds…
    expect(src).toMatch(/^\s*absoluteTime\?: boolean;$/m);
    expect(src).toMatch(/^\s*onToggleTime\?: \(\) => void;$/m);
    // …and are destructured rather than left on an unread props object.
    expect(src).toMatch(/^\s*absoluteTime,$/m);
    expect(src).toMatch(/^\s*onToggleTime,$/m);
    // (b) and a row is actually given the stamp derived from BOTH of them. `rowStamp` decides
    // which form shows and whether there is a second one to offer; `MessageRow` draws it.
    expect(src).toContain("rowStamp(");
    expect(src).toMatch(/rowStamp\([^)]*absoluteTime,\s*onToggleTime\)/);
  });

  /**
   * NO LIST MAY STILL BE STAMPING ROWS THE OLD WAY. `displayTime` is the relative form alone, so a
   * row still calling it directly renders a date that never flips and never names its instant —
   * the exact half-wired state this census exists to catch, and it would otherwise look normal.
   * `rowStamp` calls it internally; the views must not.
   */
  it.each(MAIL_LISTS)("%s no longer stamps a row with the bare relative form", (view) => {
    expect(read(`views/${view}.tsx`)).not.toMatch(/time=\{displayTime\(/);
  });

  beforeEach(() => {
    localStorage.clear();
    stubDom();
    vi.setSystemTime(NOW);
  });
  afterEach(async () => {
    await unmountAll();
    vi.useRealTimers();
  });

  const subject = "A dated letter";
  const letter = message("stamp", { subject, labels: ["work"] });
  const second = message("second-date", { subject: "A second dated letter", date: "2026-09-26T07:10:00.000Z" });
  const places = [
    { route: "ohbox", folder: "INBOX", name: "Ohbox", reading: "Open message" },
    { route: "reads", folder: "ohmail/News", name: "News", reading: "News stream" },
    { route: "receipts", folder: "ohmail/Receipts", name: "Receipts", reading: "Receipts stream" },
    { route: "history", folder: "INBOX", name: "History", reading: "Open message" },
    { route: "tag/work", folder: "INBOX", name: "Tags", reading: "Open message" },
    { route: "triage", folder: "INBOX", name: "Answer Later", reading: "Open message" },
  ] as const;

  async function mount(place: typeof places[number]) {
    const row = { ...letter, folder: place.folder,
      ...(place.route === "triage" ? { triage: { messageId: letter.id, state: "reply_later" as const, bubbleUpAt: null,
        setAt: NOW.toISOString(), updatedAt: NOW.toISOString() } } : {}),
    };
    const rows = place.route === "ohbox" ? [row, second] : [row];
    const store = await storeWith(rows, []);
    await store.applyChanges([{ type: "tag", op: "create", id: "work", seq: 100, updatedAt: NOW.toISOString(),
      entity: { id: "work", name: "Work", hue: "blue", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } }]);
    return within((await mountShell("#/" + place.route, rows, [], { store })).el);
  }

  async function stamp(page: ReturnType<typeof within>, word: string, name = /A dated letter$/) {
    const option = () => page.queryByRole("option", { name });
    await waitFor(() => option() !== null, "the dated letter in " + window.location.hash);
    return within(option()!).getByText(word, { selector: "time", exact: true });
  }

  async function openReader(page: ReturnType<typeof within>, name = "Open message") {
    await press(page.getByRole("option", { name: /A dated letter$/ }));
    if (name !== "Open message") {
      const region = () => page.queryByRole("region", { name });
      await waitFor(() => region() !== null, name);
      await press(within(region()!).getByRole("button", { name: "Expand" }));
    }
    const date = await readerStamp(page, undefined, name);
    expect(date.getAttribute("aria-pressed"), window.location.hash + " opens with the default date").toBe("false");
    return date;
  }

  async function readerStamp(page: ReturnType<typeof within>, pressed: boolean | undefined, name = "Open message") {
    const button = () => {
      const region = page.queryByRole("region", { name });
      return region && within(region).queryByRole("button", { name: /\d\d:\d\d/, pressed });
    };
    await waitFor(() => button() !== null, "the reader's date button");
    return button()!;
  }

  async function press(element: HTMLElement) {
    await act(async () => { fireEvent.click(element); });
  }

  async function visit(route: string) {
    await act(async () => {
      window.location.hash = "#/" + route;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

  function listTitle(place: typeof places[number]): string {
    if (place.route === "ohbox") return fullDateTime(letter);
    if (place.reading !== "Open message") return headStamp(letter.date, NOW, readerZone(), "en", { yesterday: (time) => "Yesterday " + time }).full;
    return "";
  }

  async function defaultListStamp(page: ReturnType<typeof within>, place: typeof places[number]) {
    const date = await stamp(page, displayTime(letter, NOW));
    expect(date.title, place.name + " date title").toBe(listTitle(place));
    return date;
  }

  // Keep the checklist's historical case identities. The studio scopes the reader date switch
  // to the reading column, so the cases exercise each mounted list's own stamp behavior.
  it("the shell hands its own flag and toggle to every one of them", async () => {
    for (const place of places) {
      const page = await mount(place);
      const short = displayTime(letter, NOW);
      const compact = await defaultListStamp(page, place);
      if (place.route === "ohbox") {
        const full = fullDateTime(letter);
        const secondShort = displayTime(second, NOW);
        const secondFull = fullDateTime(second);
        const secondName = /A second dated letter$/;
        expect((await stamp(page, secondShort, secondName)).title).toBe(secondFull);
        await press(compact);
        expect((await stamp(page, full)).title).toBe(short);
        expect((await stamp(page, secondFull, secondName)).title).toBe(secondShort);
      }
      await unmountAll();
      stubDom();
    }
  }, 30_000);

  it("the flip the rows are given IS the one the open message is given", async () => {
    const page = await mount(places[0]);
    const short = displayTime(letter, NOW);
    const full = fullDateTime(letter);
    const reader = await openReader(page);
    await press(reader);
    expect(await readerStamp(page, true)).toBeTruthy();
    expect((await stamp(page, short)).title).toBe(full);
    await press(await stamp(page, short));
    expect((await stamp(page, full)).title).toBe(short);
    expect(await readerStamp(page, true)).toBeTruthy();
    await press(await readerStamp(page, true));
    expect(await readerStamp(page, false)).toBeTruthy();
    expect((await stamp(page, full)).title).toBe(short);
    await unmountAll();

    for (const place of places.slice(1)) {
      stubDom();
      const list = await mount(place);
      await defaultListStamp(list, place);
      await press(await openReader(list, place.reading));
      expect(await readerStamp(list, true, place.reading)).toBeTruthy();
      await defaultListStamp(list, place);
      await unmountAll();
    }
  }, 30_000);

  it("the flip is reset on a view switch, for the rows as much as for the reader", async () => {
    for (const place of places) {
      const page = await mount(place);
      const compact = await defaultListStamp(page, place);
      const reader = await openReader(page, place.reading);
      const readerDefault = reader.textContent;
      const readerFull = reader.title;
      await press(reader);
      expect((await readerStamp(page, true, place.reading)).textContent, place.name).toBe(readerFull);
      if (place.route === "ohbox") {
        await press(compact);
        expect((await stamp(page, fullDateTime(letter))).title).toBe(displayTime(letter, NOW));
      } else {
        await defaultListStamp(page, place);
      }

      const away = place.route === "ohbox" ? "History" : "Ohbox";
      await visit(away.toLowerCase());
      const rail = within(page.getByRole("navigation", { name: "Places" }));
      await waitFor(() => rail.queryByRole("button", { name: away, current: "page" }) !== null, "arrive at " + away);
      await visit(place.route);
      await defaultListStamp(page, place);
      expect((await openReader(page, place.reading)).textContent, place.name + " reader after returning").toBe(readerDefault);
      await defaultListStamp(page, place);
      await unmountAll();
      stubDom();
    }
  }, 40_000);
});
