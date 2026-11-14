/** @vitest-environment jsdom */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FEED_SINCE_ID, waterlineIdOf } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";
import { message, mountShell, storeWith, stubDom, unmountAll, waitFor } from "./_draft-shell.js";

const date = (i: number) => new Date(Date.UTC(2026, 7, 10 - i, 9)).toISOString();

function mail(id: string, at: number, unread: boolean, folder: EngineMessage["folder"] = "ohmail/News"): EngineMessage {
  const stamp = date(at);
  return message(id, { date: stamp, arrivedAt: stamp, updatedAt: stamp, unread, folder });
}

const warm = [
  mail("new1", 0, true),
  mail("read1", 1, false),
  mail("skip1", 2, true),
  mail("read2", 3, false),
];

async function arrive(
  view: "reads" | "receipts",
  letters: EngineMessage[],
  opts: { firstSync?: string; line?: string } = {},
) {
  const store = await storeWith(letters, []);
  if (opts.firstSync) await store.putLocal("view_meta", FEED_SINCE_ID, { at: opts.firstSync });
  if (opts.line) await store.putLocal("view_meta", waterlineIdOf(view), { newestSeenId: opts.line, at: date(2) });
  const shell = await mountShell(`#/${view}`, letters, [], { store });
  const column = within(shell.el).getByRole("region", { name: view === "reads" ? "News" : "Receipts" });
  const list = within(column);
  const header = within(list.getByRole("banner"));
  const rows = () => list.getAllByRole("option");
  const row = (id: string) => list.getByRole("option", { name: new RegExp(`Subject ${id}$`) });
  const markAll = () => screen.queryByRole("menuitem", { name: /Mark all read|Mark all \d+|Mark the 1 message new since you were here as read/ });
  const openMenu = () => {
    const menu = header.queryByRole("button", { name: "List" });
    if (menu) fireEvent.click(menu);
  };
  async function mark() {
    const control = markAll();
    expect(control).not.toBeNull();
    await act(async () => { fireEvent.click(control!); });
    await waitFor(() => shell.sent.some((m) => m.kind === "feed_mark_seen"), "the stream line commits");
  }
  return { ...shell, list, header, rows, row, openMenu, markAll, mark };
}

beforeEach(() => {
  localStorage.clear();
  stubDom();
});
afterEach(unmountAll);

describe("first paint over a warm import is truthful (Reads)", () => {
  it("an already-\\Seen message renders READ — quiet ink, no data-unseen — and is not counted new", async () => {
    const { header, row, rows } = await arrive("reads", warm, { firstSync: date(-1) });
    expect(header.getByText("2 new since you were here")).toBeTruthy();
    expect(row("read1").hasAttribute("data-unread")).toBe(false);
    expect(row("read2").hasAttribute("data-unread")).toBe(false);
    expect(row("new1").hasAttribute("data-unread")).toBe(true);
    expect(row("skip1").hasAttribute("data-unread")).toBe(true);
    expect(rows().flatMap((option) => [...option.querySelectorAll(".oh-avatar .oh-dot")])).toEqual([]);
  });

  it("no visit yet: unread mail counts on either side of the first sync, and no line is drawn", async () => {
    const { header, list, rows } = await arrive("reads", warm, { firstSync: date(1) });
    expect(header.getByText("2 new since you were here")).toBeTruthy();
    expect(rows().map((option) => option.dataset.id)).toEqual(["new1", "read1", "skip1", "read2"]);
    expect(list.getAllByRole("listbox")).toHaveLength(1);
    expect(list.queryByText("Seen up to here")).toBeNull();
  });
});

describe("Mark all read clears WHAT THE VIEW SHOWS, not just its own button", () => {
  it("after the flips land, nothing renders unread and the button's absence is true", async () => {
    const { header, rows, openMenu, markAll, mark } = await arrive("reads", warm);
    openMenu();
    await mark();
    await waitFor(() => header.queryByText("Nothing new since you were here") !== null, "nothing remains new");
    expect(rows().map((option) => option.hasAttribute("data-unread"))).toEqual([false, false, false, false]);
    openMenu();
    expect(markAll()).toBeNull();
  });

  it("mail read in ANOTHER client: zero unread, a stale line — the headline says nothing is new, the control still clears the line", async () => {
    const pile = [mail("r0", 0, false), mail("r1", 1, false), mail("r2", 2, false)];
    const { header, openMenu, markAll, mark, sent } = await arrive("reads", pile, { line: "r2" });
    expect(header.getByText("Nothing new since you were here")).toBeTruthy();
    openMenu();
    expect.soft(markAll()?.getAttribute("aria-label")).toBe("Mark all 2 messages new since you were here as read");
    await mark();
    expect(sent).toEqual([{ kind: "feed_mark_seen", view: "reads", upToId: "r0", messageIds: [] }]);
  });
});

describe("Receipts — the same contract through its own props", () => {
  it("read receipts render read; the press flips the unread ids and commits ITS line", async () => {
    const pile = [
      mail("t0", 0, true, "ohmail/Receipts"),
      mail("t1", 1, false, "ohmail/Receipts"),
      mail("t2", 2, true, "ohmail/Receipts"),
    ];
    const { header, row, openMenu, mark, sent } = await arrive("receipts", pile, { firstSync: date(1) });
    expect(header.getByText("2 new since you were here")).toBeTruthy();
    expect(row("t1").hasAttribute("data-unread")).toBe(false);
    expect(row("t0").hasAttribute("data-unread")).toBe(true);
    openMenu();
    await mark();
    expect(sent).toEqual([
      expect.objectContaining({ kind: "mark_seen", messageIds: ["t0", "t2"], unread: false }),
      { kind: "feed_mark_seen", view: "receipts", upToId: "t0", messageIds: [] },
    ]);
  });

  it("fresh-only receipts still get the control", async () => {
    const pile = [mail("t0", 0, false, "ohmail/Receipts"), mail("t1", 1, false, "ohmail/Receipts")];
    const { header, openMenu, mark, sent } = await arrive("receipts", pile, { line: "t1" });
    expect(header.getByText("Nothing new since you were here")).toBeTruthy();
    openMenu();
    await mark();
    expect(sent).toEqual([{ kind: "feed_mark_seen", view: "receipts", upToId: "t0", messageIds: [] }]);
  });
});
