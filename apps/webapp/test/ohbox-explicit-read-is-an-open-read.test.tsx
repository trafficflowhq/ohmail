/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installShellEnv, teardownShellEnv } from "./fixtures/live-walk-shell.js";
import { click, key, mountThread, msg, patches, readSlot, settle, toastText, undoPress } from "./fixtures/thread-read-shell.js";
import { cursorRow, readingColumn, seatedList } from "./ohbox/_finders.js";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";

/**
 * AN EXPLICIT MARK READ ON THE MESSAGE ON SCREEN IS A READ IN OHMAIL (owner 2026-10-21, after
 * 2026-10-07): the Mark read button or ⇧I on the shown message files it at the top of Earlier
 * once the reader moves on, exactly like opening it — a message shown in a preview (a URL landing,
 * j, the after-verb advance, after `u`) included. A conversation's Mark read is ONE request.
 * Through the shipped shell and the real engine, its reader laid out (`fixtures/thread-layout.ts`).
 * Mark all read and multi-select keep arrival.
 */

const deliberate = () => patches.filter((p) => p.via === undefined);
const openReads = () => patches.filter((p) => (p as { openRead?: boolean }).openRead === true);
/** The reading column beside the list (today's `.read-col`). */
const col = (): HTMLElement => readingColumn(document)!;
const ids = (label: string): string[] =>
  [...document.querySelectorAll(`[role="listbox"][aria-label="${label}"] :is(.row, [role=option])[data-id]`)]
    .map((e) => (e as HTMLElement).dataset.id!);
const rowOf = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`:is(.row, [role=option])[data-id="${id}"]`);
/** The row the keys are on (today's `.row.sel`): the seated list's cursor row, or its open row. */
const selected = (): string | null => cursorRow(document)?.getAttribute("data-id") ?? null;
/**
 * The read slot by its place on the open letter's panel (the kit's verb `read`), not by its name: over a conversation
 * of two unread letters its name is the sentence the case reads ("Mark 2 unread messages as read"), its word "Mark read".
 */
const conversationReadSlot = (): HTMLElement | null =>
  col().querySelector<HTMLElement>('[role="toolbar"][aria-label="Actions"] button[data-id="read"]');
/** "old" unread (08:00) under "newer" read (08:30): New ["old"], Earlier ["newer"]. */
const two = () => [msg("old", 0, { threadId: "t-old" }), msg("newer", 30, { threadId: "t-newer", unread: false })];
/** Three seconds of nothing. */
const idle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await key("Shift"); };
const OPEN_READ = { ids: ["old"], unread: false, openRead: true };

beforeAll(async () => {
  await import("./_mail-shell.js");
  await import("@ohmail/ui");
}, 120_000);
let layout: ThreadLayout;
beforeEach(() => {
  installShellEnv();
  layout = stubThreadLayout();
  window.location.hash = "#/ohbox";
});
afterEach(async () => {
  layout.restore();
  await teardownShellEnv();
});

describe("an explicit Mark read on the shown message files it at the top of Earlier", () => {
  it("after a verb's advance (a preview), ⇧I: held while shown, top of Earlier once left", async () => {
    await mountThread([msg("first", 20, { threadId: "t-first" }), ...two()]);
    await key("j");
    expect(selected()).toBe("first");
    await key("Backspace");
    expect(selected(), "the verb advanced to the next row").toBe("old");
    await key("I", { shiftKey: true });
    expect(deliberate()).toEqual([OPEN_READ]);
    await idle();
    expect(patches, "the advance adds nothing").toEqual([OPEN_READ]);
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

  it("Mark read on a j preview: one PATCH, an open read", async () => {
    await mountThread(two());
    await key("j");
    await click(readSlot(col()), "Mark read");
    await idle();
    expect(patches, "the preview adds nothing").toEqual([OPEN_READ]);
    expect(ids("New")).toEqual(["old"]);
    await click(rowOf("newer"), "move on");
    expect(ids("Earlier")).toEqual(["old", "newer"]);
  }, 30_000);

  it("opened, u, then ⇧I: the read again counts as an open read", async () => {
    await mountThread(two());
    await click(rowOf("old"), "open old");
    await key("u");
    expect(ids("New")).toEqual(["old"]);
    await key("I", { shiftKey: true });
    expect(deliberate().at(-1)).toEqual(OPEN_READ);
    expect(ids("New")).toEqual(["old"]);
    await click(rowOf("newer"), "move on");
    expect(ids("Earlier")).toEqual(["old", "newer"]);
  }, 30_000);

  it("two unread in the conversation, landed on x2: one open read for both, and one Undo for both", async () => {
    window.location.hash = "#/ohbox/m/x2";
    await mountThread([
      msg("a1", 0, { threadId: "t-old" }), msg("x2", 10, { threadId: "t-old" }),
      msg("newer", 30, { threadId: "t-newer", unread: false }),
    ]);
    expect(conversationReadSlot()?.getAttribute("aria-label")).toBe("Mark 2 unread messages as read");
    await click(conversationReadSlot(), "Mark read");
    expect(deliberate(), "one request for the conversation").toEqual([{ ids: ["a1", "x2"], unread: false, openRead: true }]);
    expect(toastText()).toContain("2 · Read");
    await click(undoPress(), "Undo");
    expect(deliberate().at(-1), "Undo takes back what the press wrote").toEqual({ ids: ["a1", "x2"], unread: true });
    expect(conversationReadSlot()?.getAttribute("aria-label")).toBe("Mark 2 unread messages as read");
  }, 30_000);
});

describe("CONTROLS: what keeps its arrival slot, and the open", () => {
  it("an open saves a glance that is an open read", async () => {
    await mountThread(two());
    await click(rowOf("old"), "open old");
    await layout.passDwell(); // its top on screen for the dwell: read
    await settle();
    expect(patches).toEqual([{ ids: ["old"], unread: false, via: "glance", openRead: true }]);
  }, 30_000);

  it("⇧U over two picks of two conversations: no open read, arrival order", async () => {
    await mountThread([msg("p1", 0, { threadId: "t-old" }), msg("p2", 10, { threadId: "t-newer" })]);
    await key("j");
    await key("x");
    await key("j");
    await key("x");
    await key("U", { shiftKey: true });
    expect(patches.length).toBeGreaterThan(0);
    expect(openReads()).toEqual([]);
    expect(ids("Earlier")).toEqual(["p2", "p1"]);
  }, 30_000);

  it("Mark all read with a row selected: no open read, arrival order", async () => {
    await mountThread([msg("p1", 0, { threadId: "t-old" }), msg("p2", 10, { threadId: "t-newer" })]);
    await key("j");
    await key("j");
    expect(selected()).toBe("p1");
    await click([...(seatedList(document)?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => /^Mark (all \d+ unread messages|the 1 unread message) read$/.test(b.getAttribute("aria-label") ?? "")) ?? null, "Mark all read");
    expect(patches.length).toBeGreaterThan(0);
    expect(openReads()).toEqual([]);
    await click(rowOf("p2"), "move on");
    expect(ids("Earlier")).toEqual(["p2", "p1"]);
  }, 30_000);
});
