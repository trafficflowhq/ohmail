/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installShellEnv, teardownShellEnv } from "./fixtures/live-walk-shell.js";
import { click, key, mountThread, msg, patches, readSlot, toastText } from "./fixtures/thread-read-shell.js";

/**
 * AN EXPLICIT MARK READ ON THE MESSAGE ON SCREEN IS A READ IN OHMAIL (owner 2026-10-21, after
 * 2026-10-07): the Mark read button or ⇧I on the shown message files it at the top of Earlier
 * once the reader moves on, exactly like opening it. Before, only an armed read (dwell, open, →)
 * took the engine's hold, so a message shown without one (a URL landing, a press inside the dwell,
 * after `u`) left New at the press and filed at its arrival slot.
 * Through the shipped shell and the real engine. Mark all read and multi-select keep arrival.
 */

const deliberate = () => patches.filter((p) => p.via === undefined);
const openReads = () => patches.filter((p) => (p as { openRead?: boolean }).openRead === true);
const col = (): HTMLElement => document.querySelector<HTMLElement>(".read-col")!;
const ids = (label: string): string[] =>
  [...document.querySelectorAll(`[role="listbox"][aria-label="${label}"] .row[data-id]`)]
    .map((e) => (e as HTMLElement).dataset.id!);
const rowOf = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`.row[data-id="${id}"]`);
const selected = (): string | null => document.querySelector(".view .row.sel")?.getAttribute("data-id") ?? null;
/** "old" unread (08:00) under "newer" read (08:30): New ["old"], Earlier ["newer"]. */
const two = () => [msg("old", 0, { threadId: "t-old" }), msg("newer", 30, { threadId: "t-newer", unread: false })];
/** Three seconds of nothing: longer than the 2 s dwell. */
const idle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await key("Shift"); };
const OPEN_READ = { ids: ["old"], unread: false, openRead: true };

beforeAll(async () => {
  await import("../app/shell/AppShell.js");
  await import("@ohmail/ui");
}, 120_000);
beforeEach(() => {
  installShellEnv();
  window.location.hash = "#/ohbox";
});
afterEach(async () => { await teardownShellEnv(); });

describe("an explicit Mark read on the shown message files it at the top of Earlier", () => {
  it("after a verb's advance, ⇧I inside its dwell: held while shown, top of Earlier once left", async () => {
    await mountThread([msg("first", 20, { threadId: "t-first" }), ...two()]);
    await key("j");
    expect(selected()).toBe("first");
    await key("Backspace");
    expect(selected(), "the verb advanced to the next row").toBe("old");
    await key("I", { shiftKey: true });
    expect(deliberate()).toEqual([OPEN_READ]);
    await idle();
    expect(patches, "the advance's dwell adds nothing").toEqual([OPEN_READ]);
    expect(ids("New"), "it keeps its place while on screen").toEqual(["old"]);
    await click(rowOf("newer"), "move on");
    expect(ids("Earlier"), "left, it takes the top of Earlier").toEqual(["old", "newer"]);
  }, 30_000);

  it("a URL landing, then the Mark read button", async () => {
    window.location.hash = "#/ohbox/m/old";
    await mountThread(two());
    expect(patches).toEqual([]);
    await click(readSlot(col()), "Mark read");
    expect(deliberate()).toEqual([OPEN_READ]);
    expect(ids("New")).toEqual(["old"]);
    await click(rowOf("newer"), "move on");
    expect(ids("Earlier")).toEqual(["old", "newer"]);
  }, 30_000);

  it("Mark read inside the dwell: one PATCH, an open read", async () => {
    await mountThread(two());
    await click(rowOf("old"), "select old");
    await click(readSlot(col()), "Mark read");
    await idle();
    expect(patches, "the dwell adds nothing").toEqual([OPEN_READ]);
    expect(ids("New")).toEqual(["old"]);
    await click(rowOf("newer"), "move on");
    expect(ids("Earlier")).toEqual(["old", "newer"]);
  }, 30_000);

  it("opened, u, then ⇧I: the read again counts as an open read", async () => {
    await mountThread(two());
    await click(rowOf("old"), "select old");
    await click(rowOf("old"), "open old");
    await key("u");
    expect(ids("New")).toEqual(["old"]);
    await key("I", { shiftKey: true });
    expect(deliberate().at(-1)).toEqual(OPEN_READ);
    expect(ids("New")).toEqual(["old"]);
    await click(rowOf("newer"), "move on");
    expect(ids("Earlier")).toEqual(["old", "newer"]);
  }, 30_000);

  it("two unread in the conversation, landed on x2: both open reads, the Undo restores a1 alone", async () => {
    window.location.hash = "#/ohbox/m/x2";
    await mountThread([
      msg("a1", 0, { threadId: "t-old" }), msg("x2", 10, { threadId: "t-old" }),
      msg("newer", 30, { threadId: "t-newer", unread: false }),
    ]);
    expect(readSlot(col())?.getAttribute("aria-label")).toBe("Mark 2 unread messages as read");
    await click(readSlot(col()), "Mark read");
    expect(deliberate()).toEqual([
      { ids: ["x2"], unread: false, openRead: true },
      { ids: ["a1", "x2"], unread: false, openRead: true },
    ]);
    expect(toastText()).toContain("2 messages marked read.");
    await click(document.querySelector(".toast .toast-act"), "Undo");
    expect(deliberate().at(-1), "Undo takes back the other message only").toEqual({ ids: ["a1"], unread: true });
    expect(readSlot(col())?.getAttribute("aria-label")).toBe("Mark 1 unread message as read");
  }, 30_000);
});

describe("CONTROLS: what keeps its arrival slot, and the open", () => {
  it("an open saves a glance that is an open read", async () => {
    await mountThread(two());
    await click(rowOf("old"), "select old");
    await click(rowOf("old"), "open old");
    expect(patches).toEqual([{ ids: ["old"], unread: false, via: "glance", openRead: true }]);
  }, 30_000);

  it("⇧U over two picks of two conversations: no open read, arrival order", async () => {
    await mountThread([msg("p1", 0, { threadId: "t-old" }), msg("p2", 10, { threadId: "t-newer" })]);
    await click(rowOf("p1"), "select p1");
    await key("x");
    await click(rowOf("p2"), "select p2");
    await key("x");
    await key("U", { shiftKey: true });
    expect(patches.length).toBeGreaterThan(0);
    expect(openReads()).toEqual([]);
    expect(ids("Earlier")).toEqual(["p2", "p1"]);
  }, 30_000);

  it("Mark all read with a row selected: no open read, arrival order", async () => {
    await mountThread([msg("p1", 0, { threadId: "t-old" }), msg("p2", 10, { threadId: "t-newer" })]);
    await click(rowOf("p1"), "select p1");
    await click(document.querySelector(".mark-all-read"), "Mark all read");
    expect(patches.length).toBeGreaterThan(0);
    expect(openReads()).toEqual([]);
    await click(rowOf("p2"), "move on");
    expect(ids("Earlier")).toEqual(["p2", "p1"]);
  }, 30_000);
});
