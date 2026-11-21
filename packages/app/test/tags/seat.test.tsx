/** @vitest-environment jsdom */
/**
 * TAGS' OWN SEAT, over the tests' door of a mount (`../places/list-seat.tsx`): a tag's letters across every place,
 * read in place; its Rename and Delete, each one act through the frame's one seam with its sentence; and the rail's
 * Tags group, drawn by the place off the ground.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineMessage } from "@ohmail/wire";
import { letter } from "../reader/support/mail.js";
import { dwell, layOutLetter, listSeat, readerTime, sent } from "../places/list-seat.js";

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
const TAG = (id: string, name: string) => ({
  id,
  accountId: "acct-1",
  name,
  hue: "moss",
  createdAt: "2026-01-01",
});
const MORE = { "tag:t1": TAG("t1", "Invoices"), "tag:t2": TAG("t2", "Family") };
/* Two letters carry Invoices, one in News; one carries Family; one carries none. */
const LETTERS = [
  at(10, { id: "a", subject: "March invoice", labels: ["t1"] }),
  at(11, { id: "b", subject: "April invoice", labels: ["t1"], folder: "ohmail/Reads" }),
  at(12, { id: "c", subject: "Sunday lunch", labels: ["t2"] }),
  at(13, { id: "d", subject: "Untagged", labels: [] }),
];

const rows = (): HTMLElement[] => screen.queryAllByRole("option");
/** The row the list marks as its cursor's, by the letter it carries. */
const cursorRow = (): string | null =>
  screen.queryAllByRole("option", { selected: true }).map((r) => r.dataset.id ?? null)[0] ?? null;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
/** The sentence the frame's one report slot says now. */
const said = (): string => screen.getByRole("status").querySelector("span")?.textContent ?? "";

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Tags' own seat, over the mail ground", () => {
  it("a tag lists only the letters that carry it, newest first, from every place", () => {
    listSeat({ letters: LETTERS, more: MORE, first: "#/tag/t1" });
    expect(rows().map((r) => r.dataset.id)).toEqual(["b", "a"]);
    expect(screen.getByRole("heading", { name: "Invoices" })).toBeTruthy();
  });

  it("a row opens its letter beside the list: the address stays the tag's", async () => {
    const { address } = listSeat({ letters: LETTERS, more: MORE, first: "#/tag/t1" });
    fireEvent.click(rows()[0]!);
    await settle();
    expect(address.read()).toBe("#/tag/t1/m/b");
  });

  it("Rename sends one rename with the new name and says it; another tag's name is refused", async () => {
    const { mail } = listSeat({ letters: LETTERS, more: MORE, first: "#/tag/t1" });
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(field, { target: { value: "family" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "Bills" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(sent(mail)).toEqual(["tag_rename t1 Bills"]);
    await waitFor(() => expect(said()).toBe("Renamed to “Bills”."));
  });

  it("Delete says how many letters carry it and that they stay; it sends one delete and names the tag", async () => {
    const { mail } = listSeat({ letters: LETTERS, more: MORE, first: "#/tag/t1" });
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const ask = screen.getByRole("dialog");
    expect(within(ask).getByText(/2 messages carry it and stay where they are/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(ask).getByRole("button", { name: "Delete" }));
    });
    expect(sent(mail)).toEqual(["tag_delete t1"]);
    await waitFor(() => expect(said()).toBe("Tag “Invoices” deleted."));
  });

  it("makes a tag in the open sidebar without assigning it to any letter", async () => {
    const { mail, address } = listSeat({ letters: LETTERS, more: MORE, first: "#/ohbox" });
    const rail = within(screen.getByRole("navigation", { name: "Places" }));
    fireEvent.click(rail.getByRole("button", { name: "Tags", expanded: false }));
    fireEvent.click(rail.getByRole("button", { name: "New tag" }));
    const field = rail.getByRole("textbox", { name: "New tag" });
    expect(field).toBe(document.activeElement);
    fireEvent.change(field, { target: { value: " invoices " } });
    expect(rail.getByRole("status").textContent).toContain("invoices");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(mail.mutations).toHaveLength(0);
    expect(field.isConnected).toBe(true);
    fireEvent.change(field, { target: { value: "  Notes  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(mail.mutations).toEqual([{ kind: "tag_create", tagId: expect.any(String), name: "Notes" }]),
    );
    expect(rail.queryByRole("textbox", { name: "New tag" })).toBeNull();
    expect(address.read()).toBe("#/ohbox");
    fireEvent.click(rail.getByRole("button", { name: "New tag" }));
    fireEvent.keyDown(rail.getByRole("textbox", { name: "New tag" }), { key: "Escape" });
    expect(rail.queryByRole("textbox", { name: "New tag" })).toBeNull();
    expect(mail.mutations).toHaveLength(1);
  });

  it("the rail's Tags group lists every tag with its count, opens a tag's place, and shuts", () => {
    const { address } = listSeat({ letters: LETTERS, more: MORE, first: "#/ohbox" });
    const rail = screen.getByRole("navigation", { name: "Places" });
    fireEvent.click(within(rail).getByRole("button", { name: "Tags", expanded: false }));
    const labels = [...rail.querySelectorAll("[data-rail-tag-id]")].map((node) =>
      node.getAttribute("data-rail-tag-id"),
    );
    expect(labels).toEqual(["t1", "t2"]);
    expect(within(rail).getByRole("button", { name: "Family 1" })).toBeTruthy();
    fireEvent.click(within(rail).getByRole("button", { name: "Invoices 2" }));
    /* The tag's place, its first letter standing open beside the list as it arrives. */
    expect(address.read()).toBe("#/tag/t1/m/b");
    fireEvent.click(within(rail).getByRole("button", { name: "Tags", expanded: true }));
    expect(within(rail).queryByRole("button", { name: "Invoices 2" })).toBeNull();
    expect(
      within(rail).getByRole("button", { name: "Tags", expanded: false }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it.each([false, true])(
    "keeps sidebar tags in creation order across mirror arrival orders (%s)",
    (reversed) => {
      const tags = [
        { id: "legacy", name: "Older mirror", hue: "moss" },
        { ...TAG("z", "First"), createdAt: "2026-01-01T00:00:00.000Z" },
        { ...TAG("b", "Same time B"), createdAt: "2026-01-02T00:00:00.000Z" },
        { ...TAG("a", "Same time A"), createdAt: "2026-01-02T01:00:00.000+01:00" },
      ];
      const more = Object.fromEntries(
        (reversed ? tags.reverse() : tags).map((tag) => [`tag:${tag.id}`, tag]),
      );
      listSeat({ letters: [], more, first: "#/ohbox" });
      const places = screen.getByRole("navigation", { name: "Places" });
      fireEvent.click(within(places).getByRole("button", { name: "Tags", expanded: false }));
      expect(
        [...places.querySelectorAll<HTMLElement>("[data-rail-tag-id]")].map((row) => row.dataset.railTagId),
      ).toEqual(["legacy", "z", "a", "b"]);
    },
  );

  it("a letter held without its labels counts for no tag, and the rail and the place still stand", () => {
    /* An older mirror's row may lack the member: the group is drawn at every place, so it must not throw. */
    const bare = { ...at(14, { id: "e", subject: "Held bare" }) } as Partial<EngineMessage>;
    delete bare.labels;
    listSeat({ letters: [...LETTERS, bare as EngineMessage], more: MORE, first: "#/ohbox" });
    const rail = screen.getByRole("navigation", { name: "Places" });
    fireEvent.click(within(rail).getByRole("button", { name: "Tags", expanded: false }));
    expect(within(rail).getByRole("button", { name: "Invoices 2" })).toBeTruthy();
    expect(within(rail).getByRole("button", { name: "Family 1" })).toBeTruthy();
    fireEvent.click(within(rail).getByRole("button", { name: "Invoices 2" }));
    expect(screen.getByRole("heading", { name: "Invoices" })).toBeTruthy();
  });
});

describe("a tag's list, on arrival", () => {
  it("on arrival the first letter stands open beside the list, a preview that reads nothing until it is entered; closed, it stays closed", async () => {
    readerTime();
    const { mail, address } = listSeat({ letters: LETTERS, more: MORE, first: "#/tag/t1" });
    expect(address.read()).toBe("#/tag/t1/m/b");
    expect(cursorRow()).toBe("b");
    layOutLetter("b");
    await dwell(3000);
    expect(sent(mail)).toEqual([]);
    /* Entered where it stands, the same letter is read: what stood before was a preview. */
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Enter" });
    await dwell();
    expect(sent(mail)).toEqual(["mark_seen b read glance"]);
    /* The person goes back to the list alone: the place opens nothing a second time. */
    act(() => address.visit("#/tag/t1"));
    await dwell(3000);
    expect(address.read()).toBe("#/tag/t1");
    expect(cursorRow()).toBeNull();
  });

  it("the letter that stood open on arrival, closed before any row is chosen, stays closed", async () => {
    const { address } = listSeat({ letters: LETTERS, more: MORE, first: "#/tag/t1" });
    expect(address.read()).toBe("#/tag/t1/m/b");
    act(() => address.visit("#/tag/t1"));
    await settle();
    expect(address.read()).toBe("#/tag/t1");
    expect(cursorRow()).toBeNull();
  });
});

/* The Ohbox admits Ben Kiln's letters: its rule, as the Ohbox's own seat file hands it. */
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
const pointer = (type: string, target: EventTarget, x: number, y: number) =>
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
/** What the page answers under the pointer: the element the pointer is over. */
const hovering = (el: Element | null) => {
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => el;
};
const railTag = (name: string): HTMLElement =>
  within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name });

describe("a letter dragged from a list onto a tag in the rail", () => {
  afterEach(() => {
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    for (const g of document.querySelectorAll(".drag-ghost")) g.remove();
  });

  it("is tagged by the list's own verb, once, with that tag; a tag it carries already never lights and takes nothing", async () => {
    const { mail } = listSeat({
      letters: [at(15, { id: "o1", subject: "Kiln firing", labels: ["t2"] })],
      more: { ...MORE, ...ADMITTED },
      first: "#/ohbox",
    });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Tags", expanded: false }));
    const row = (): HTMLElement => rows().find((r) => r.dataset.id === "o1")!;
    expect(row(), "the Ohbox lists the letter").toBeTruthy();
    /* Past the threshold over Invoices: it lights, and the release tags the letter with it. */
    await pointer("pointerdown", row(), 10, 10);
    hovering(railTag("Invoices"));
    await pointer("pointermove", window, 60, 60);
    expect(railTag("Invoices").getAttribute("data-drop")).toBe("over");
    await pointer("pointerup", window, 60, 60);
    await settle();
    expect(sent(mail).filter((s) => s.startsWith("tag_assign"))).toEqual(["tag_assign o1 t1"]);
    /* Family is on the letter already: it never lights, and a release over it sends nothing. */
    mail.mutations.length = 0;
    await pointer("pointerdown", row(), 10, 10);
    hovering(railTag("Family 1"));
    await pointer("pointermove", window, 60, 60);
    expect(railTag("Family 1").getAttribute("data-drop")).toBeNull();
    await pointer("pointerup", window, 60, 60);
    await settle();
    expect(sent(mail).filter((s) => s.startsWith("tag_assign"))).toEqual([]);
  });
});
