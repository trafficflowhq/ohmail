/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installShellEnv, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
import { click, key, mountThread, msg, patches, settle, toastText } from "./fixtures/thread-read-shell.js";
import { AFTER_VERB_STORAGE_KEY } from "../app/shell/after-verb.js";

/**
 * THE AFTER-VERB ADVANCE ARMS THE 2 S DWELL (owner 2026-10-21: "should be at the top when it was my
 * last action"). The message a verb's advance shows is a cursor landing like j: stop on it for two
 * seconds and it is read in ohmail, held in New while shown and at the top of Earlier once left.
 * Before, the advance armed nothing, so the message read there and left stayed unread. An Undo
 * inside the dwell cancels it, and the dwell's timer reads only the row the cursor is on.
 */

const openReads = () => patches.filter((p) => (p as { openRead?: boolean }).openRead === true);
const ids = (label: string): string[] =>
  [...document.querySelectorAll(`[role="listbox"][aria-label="${label}"] .row[data-id]`)]
    .map((e) => (e as HTMLElement).dataset.id!);
const rowOf = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`.row[data-id="${id}"]`);
const selected = (): string | null => document.querySelector(".view .row.sel")?.getAttribute("data-id") ?? null;
const naming = (id: string) => patches.filter((p) => p.ids.includes(id));
/** "first" (08:20) and "old" (08:00) unread over "newer" read (08:30): New ["first", "old"], Earlier ["newer"]. */
const three = () => [
  msg("first", 20, { threadId: "t-first" }), msg("old", 0, { threadId: "t-old" }),
  msg("newer", 30, { threadId: "t-newer", unread: false }),
];
/** Three seconds of nothing: longer than the 2 s dwell. */
const idle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await key("Shift"); };
const GLANCE = { ids: ["old"], unread: false, via: "glance", openRead: true };
const undo = () => click(document.querySelector(".toast .toast-act"), "Undo");

beforeAll(async () => {
  await import("../app/shell/AppShell.js");
  await import("@ohmail/ui");
}, 120_000);
beforeEach(() => {
  installShellEnv();
  window.location.hash = "#/ohbox";
});
afterEach(async () => { await teardownShellEnv(); });

/** j onto "first", then Delete: the advance lands on "old". */
async function deleteFirst(): Promise<void> {
  await mountThread(three());
  await key("j");
  expect(selected()).toBe("first");
  await key("Backspace");
  expect(selected(), "the verb advanced to the next row").toBe("old");
}

describe("the advance's landing is read after the dwell", () => {
  it("a verb, then two seconds on the next message: an open read, held in New, top of Earlier once left", async () => {
    await deleteFirst();
    await idle();
    expect(patches).toEqual([GLANCE]);
    expect(ids("New"), "it keeps its place while on screen").toEqual(["old"]);
    await click(rowOf("newer"), "move on");
    expect(ids("Earlier"), "left, it takes the top of Earlier").toEqual(["old", "newer"]);
  }, 30_000);

  it("the dwell's read starts no further advance: one PATCH after five seconds more", async () => {
    await deleteFirst();
    await idle();
    await idle();
    expect(patches).toEqual([GLANCE]);
    expect(selected()).toBe("old");
  }, 30_000);
});

describe("CONTROLS: what the advance's dwell must not read", () => {
  it("a second verb inside the dwell reads nothing", async () => {
    await deleteFirst();
    await key("Backspace");
    await idle();
    expect(naming("old")).toEqual([]);
  }, 30_000);

  for (const choice of ["stay", "close"] as const) {
    it(`the after-verb choice "${choice}" arms nothing`, async () => {
      window.localStorage.setItem(AFTER_VERB_STORAGE_KEY, choice);
      try {
        await mountThread(three());
        await key("j");
        await key("Backspace");
        expect(selected()).not.toBe("old");
        await idle();
        expect(patches).toEqual([]);
      } finally {
        window.localStorage.removeItem(AFTER_VERB_STORAGE_KEY);
      }
    }, 30_000);
  }

  it("open, verb, Undo at once: the row is back as it stood and the advance's landing is not read", async () => {
    await mountThread(three());
    await click(rowOf("first"), "select first");
    await click(rowOf("first"), "open first");
    expect(patches).toEqual([{ ids: ["first"], unread: false, via: "glance", openRead: true }]);
    await key("Backspace");
    expect(selected()).toBe("old");
    await undo();
    expect(selected()).toBe("first");
    await idle();
    expect(naming("old"), "old was read while the cursor was on first").toEqual([]);
    expect(ids("New"), "first keeps its place in New").toEqual(["first", "old"]);
    // The advance's dwell ended at the Undo, so j onto old starts a fresh one.
    await key("j");
    expect(selected()).toBe("old");
    await idle();
    expect(naming("old")).toEqual([GLANCE]);
  }, 30_000);

  it("Undo after the dwell: the moved-on Undo, the landing's read stands", async () => {
    await deleteFirst();
    await idle();
    expect(patches).toEqual([GLANCE]);
    await undo();
    expect(toastText()).toContain("Not deleted.");
    expect(selected()).toBe("old");
    expect(patches).toEqual([GLANCE]);
  }, 30_000);

  it("a URL landing inside a dwell: the dwelt row is not read under another cursor", async () => {
    await mountThread([
      msg("a", 20, { threadId: "t-a" }), msg("c", 0, { threadId: "t-c" }),
      msg("newer", 30, { threadId: "t-newer", unread: false }),
    ]);
    await key("j");
    expect(selected()).toBe("a");
    window.location.hash = "#/ohbox/m/c";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await settle();
    expect(selected()).toBe("c");
    await idle();
    expect(naming("a"), "a was read while the cursor was on c").toEqual([]);
    expect(openReads().flatMap((p) => p.ids)).not.toContain("a");
  }, 30_000);

  it("j/k inside two seconds reads nothing", async () => {
    await mountThread(three());
    await key("j");
    await key("j");
    await key("k");
    await tick(1500);
    await key("j");
    await tick(1500);
    expect(patches).toEqual([]);
  }, 30_000);
});
