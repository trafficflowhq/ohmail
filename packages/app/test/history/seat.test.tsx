/** @vitest-environment jsdom */
/**
 * HISTORY'S OWN SEAT, over the tests' door of a mount (`../places/list-seat.tsx`): every letter, newest first with
 * the place it is in, opened in place beside the reader; a letter's verbs through the frame's one seam; the store
 * that does not answer said with its way back; its rail entry and its key.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineMessage } from "@ohmail/wire";
import { letter } from "../reader/support/mail.js";
import { listSeat, sent } from "../places/list-seat.js";

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
/* Three letters: one of an undecided sender in the Ohbox's folder (the Ohbox does not present it; History does), one
   in News, one in a folder of the person's own. */
const THREE = [
  at(10, { id: "a", subject: "Kiln schedule", folder: "INBOX" }),
  at(11, { id: "b", subject: "Glaze order", folder: "ohmail/Reads" }),
  at(12, { id: "c", subject: "Studio keys", folder: "Projects/Clay" }),
];
/** The letters' sender, admitted by a rule: the partition presents a decided sender's mail in the Ohbox. */
const ADMITTED = {
  "rule:r1": {
    id: "r1",
    kind: "sender",
    match: "ben@kiln.example",
    destination: "INBOX",
    priority: 0,
    provenance: "manual",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};
const PAIR = [
  at(10, { id: "x1", threadId: "t1", subject: "Kiln" }),
  at(11, { id: "x2", threadId: "t1", subject: "Re: Kiln" }),
];

const rows = (): HTMLElement[] => screen.getAllByRole("option");
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => cleanup());

describe("History's own seat, over the mail ground", () => {
  it("lists every letter newest first, each with the place it is in, whoever sent it", () => {
    listSeat({ letters: THREE, first: "#/history" });
    expect(rows().map((r) => r.dataset.id)).toEqual(["c", "b", "a"]);
    const list = screen.getByRole("listbox", { name: "History" });
    expect(within(list).getByText("Clay")).toBeTruthy();
    expect(within(list).getByText("News")).toBeTruthy();
    expect(within(list).getByText("Ohbox")).toBeTruthy();
  });

  it("a row opens its letter beside the list, in place: the address stays History's", async () => {
    const { address } = listSeat({ letters: THREE, first: "#/history" });
    fireEvent.click(rows()[1]!);
    await settle();
    expect(address.read()).toBe("#/history/m/b");
    expect(screen.getByRole("heading", { name: "Glaze order" })).toBeTruthy();
  });

  it("a verb of the open letter's panel leaves through the frame's one seam", async () => {
    const { mail } = listSeat({ letters: THREE, first: "#/history/m/c" });
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Later" }));
    });
    expect(sent(mail)).toContain("triage_set c reply_later");
  });

  it("a letter inside a delete's Undo window is gone from History while the window stands", async () => {
    const { mail } = listSeat({ letters: THREE, first: "#/history/m/c" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    });
    await waitFor(() => expect(rows().map((r) => r.dataset.id)).toEqual(["b", "a"]));
    /* Nothing is sent before the window closes. */
    expect(sent(mail).filter((s) => s.startsWith("delete"))).toEqual([]);
  });

  it("a store that does not answer is said, the device's mail stands, and Try again asks the store again", async () => {
    let asked = 0;
    listSeat({
      letters: THREE,
      first: "#/history",
      engine: () => ({
        storePagesAvailable: () => true,
        storeChanges: () => 0,
        resetStorePages: () => undefined,
        timeline: () => {
          asked += 1;
          return Promise.resolve({ state: "failed", errorClass: "network" });
        },
        pageStore: () => Promise.resolve({ state: "failed", errorClass: "network" }),
        peekStorePage: () => undefined,
      }),
    });
    await waitFor(() => expect(screen.getByText(/did not answer/)).toBeTruthy());
    const was = asked;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(asked).toBeGreaterThan(was);
  });

  it("stands in the rail's More with the demo's key, and g h goes there", () => {
    const { address } = listSeat({ letters: THREE, first: "#/ohbox" });
    const rail = screen.getByRole("navigation", { name: "Places" });
    expect(within(rail).getByRole("button", { name: /^History/ })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "h" });
    /* History, its first letter standing open beside the list as it arrives. */
    expect(address.read()).toBe("#/history/m/c");
  });
});

/*
 * THE OLDER CASES OF TODAY'S HISTORY (apps/webapp/test/history-window.test.tsx, history-open-arrival.test.tsx), as
 * the seat holds them: the same claims, by the same names, over the seat's door. A letter arriving is the mirror's
 * (`mail.add`, as a drain brings it); the store that does not answer is the engine's own answer.
 */
describe("History is the store's timeline (today's cases, over the seat)", () => {
  /** The heading of the letter open in the reading column. */
  const reading = (): string =>
    screen.queryByRole("region", { name: "Reading" })?.querySelector(".oh-readinghead-subject")
      ?.textContent ?? "";
  const cursorRow = (): string | undefined =>
    screen.queryAllByRole("option", { selected: true })[0]?.dataset.id;
  const arrive = (mail: { add: (m: EngineMessage) => void }, m: EngineMessage) => act(() => mail.add(m));

  it("a store that does not answer says so, keeps the mirror's rows, and states no count", async () => {
    listSeat({
      letters: THREE,
      first: "#/history",
      engine: () => ({
        storePagesAvailable: () => true,
        storeChanges: () => 0,
        resetStorePages: () => undefined,
        timeline: () => Promise.resolve({ state: "failed", errorClass: "network" }),
        pageStore: () => Promise.resolve({ state: "failed", errorClass: "network" }),
        peekStorePage: () => undefined,
      }),
    });
    await waitFor(() => expect(screen.getByText(/did not answer/)).toBeTruthy());
    expect(rows().map((r) => r.dataset.id)).toEqual(["c", "b", "a"]);
    const head = screen.getByRole("listbox", { name: "History" }).closest("section")!;
    expect(head.querySelector(".oh-listhead-count")?.textContent ?? null, "no count is stated").toBeNull();
  });

  it("the demo, with no store doors, lists the mirror it is and counts it", () => {
    listSeat({ letters: THREE, first: "#/history" });
    expect(rows().map((r) => r.dataset.id)).toEqual(["c", "b", "a"]);
    const head = screen.getByRole("listbox", { name: "History" }).closest("section")!;
    expect(head.querySelector(".oh-listhead-count")?.textContent).toBe("3 messages");
  });

  it("a row picked below keeps its pick and its reading column when mail arrives above it", async () => {
    const { mail } = listSeat({ letters: THREE, first: "#/history" });
    await settle();
    fireEvent.click(rows()[1]!);
    await settle();
    expect(reading()).toBe("Glaze order");
    await arrive(mail, at(20, { id: "n1", subject: "The new one" }));
    await settle();
    expect(rows()[0]?.dataset.id).toBe("n1");
    expect(reading()).toBe("Glaze order");
    expect(cursorRow()).toBe("b");
    /* The cursor's row moved with its letter: ↓ reads the next letter, not the one its slot had become. */
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowDown" });
    await settle();
    expect(cursorRow()).toBe("a");
  });

  it("the column showing slot 0 keeps its message through two arrivals, and ↓ reads the one below it", async () => {
    const { mail } = listSeat({ letters: THREE, first: "#/history" });
    await settle();
    await arrive(mail, at(20, { id: "n1", subject: "The new one" }));
    await settle();
    await arrive(mail, at(21, { id: "n2", subject: "Newer still" }));
    await settle();
    expect(
      rows()
        .slice(0, 3)
        .map((r) => r.dataset.id),
    ).toEqual(["n2", "n1", "c"]);
    expect(reading()).toBe("Studio keys");
    expect(cursorRow()).toBe("c");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowDown" });
    await settle();
    expect(cursorRow()).toBe("b");
  });
});

describe("a list place's verb acts on the letter pressed", () => {
  it("Later on one letter of a conversation the Ohbox draws as one row files that letter alone", async () => {
    const { mail } = listSeat({ letters: PAIR, more: ADMITTED, first: "#/history/m/x2" });
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Later" }));
    });
    expect(sent(mail).filter((s) => s.startsWith("triage_set"))).toEqual(["triage_set x2 reply_later"]);
  });
});
