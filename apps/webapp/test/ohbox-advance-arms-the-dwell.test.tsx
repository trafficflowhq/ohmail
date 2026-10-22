/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installShellEnv, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
import { click, key, mountThread, msg, patches, settle, toastText } from "./fixtures/thread-read-shell.js";
import { AFTER_VERB_STORAGE_KEY } from "../app/shell/after-verb.js";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";

/**
 * THE AFTER-VERB ADVANCE IS A PREVIEW. The message a verb's advance shows is a cursor landing like
 * j: it reads nothing however long it rests. Entering it (↵, a click, a wheel in the column) reads
 * what is on screen, as an open read: held in New while shown and at the top of Earlier once left
 * (owner 2026-10-21: "should be at the top when it was my last action"). An Undo restores the row
 * as it stood and reads nothing either. The reader is laid out (`fixtures/thread-layout.ts`).
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
/** Three seconds of nothing: longer than the dwell that used to read. */
const idle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await key("Shift"); };
const GLANCE = { ids: ["old"], unread: false, via: "glance", openRead: true };
const undo = () => click(document.querySelector(".toast .toast-act"), "Undo");

beforeAll(async () => {
  await import("../app/shell/AppShell.js");
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

/** j onto "first", then Delete: the advance lands on "old". */
async function deleteFirst(): Promise<void> {
  await mountThread(three());
  await key("j");
  expect(selected()).toBe("first");
  await key("Backspace");
  expect(selected(), "the verb advanced to the next row").toBe("old");
}

describe("the advance's landing is a preview; entering it reads", () => {
  it("a verb, then rest on the next message: nothing is read; ↵ reads it as an open read, top of Earlier once left", async () => {
    await deleteFirst();
    await idle();
    expect(patches, "base: the dwell read it").toEqual([]);
    await key("Enter");
    await layout.passDwell(); // its top on screen for the dwell
    await settle();
    expect(patches).toEqual([GLANCE]);
    expect(ids("New"), "it keeps its place while on screen").toEqual(["old"]);
    await click(rowOf("newer"), "move on");
    expect(ids("Earlier"), "left, it takes the top of Earlier").toEqual(["old", "newer"]);
  }, 30_000);

  it("the advance starts no further advance and reads nothing, however long it rests", async () => {
    await deleteFirst();
    await idle();
    await idle();
    expect(patches).toEqual([]);
    expect(selected()).toBe("old");
  }, 30_000);
});

describe("CONTROLS: what the advance must not read", () => {
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
    await click(rowOf("first"), "open first");
    await layout.passDwell();
    await settle();
    expect(patches).toEqual([{ ids: ["first"], unread: false, via: "glance", openRead: true }]);
    await key("Backspace");
    expect(selected()).toBe("old");
    await undo();
    expect(selected()).toBe("first");
    await idle();
    expect(naming("old"), "old was read while the cursor was on first").toEqual([]);
    expect(ids("New"), "first keeps its place in New").toEqual(["first", "old"]);
    // j onto old is a preview; ↵ enters it and reads it.
    await key("j");
    expect(selected()).toBe("old");
    await idle();
    expect(naming("old")).toEqual([]);
    await key("Enter");
    await layout.passDwell();
    await settle();
    expect(naming("old")).toEqual([GLANCE]);
  }, 30_000);

  it("Undo after entering the landing: the moved-on Undo, the landing's read stands", async () => {
    await deleteFirst();
    await idle();
    await key("Enter");
    await layout.passDwell();
    await settle();
    expect(patches).toEqual([GLANCE]);
    await undo();
    expect(toastText()).toContain("Not deleted.");
    expect(selected()).toBe("old");
    expect(patches).toEqual([GLANCE]);
  }, 30_000);

  it("a URL landing after a preview: neither row is read", async () => {
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
    expect(naming("c"), "a URL landing is a preview").toEqual([]);
    expect(openReads().flatMap((p) => p.ids)).not.toContain("a");
  }, 30_000);

  it("j/k, resting or not, reads nothing", async () => {
    await mountThread(three());
    await key("j");
    await key("j");
    await key("k");
    await tick(1500);
    await key("j");
    await tick(5000);
    expect(patches).toEqual([]);
  }, 30_000);
});
