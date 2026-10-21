/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ISO, installShellEnv, teardownShellEnv } from "./fixtures/live-walk-shell.js";
import { LENA, click, mountThread, msg, patches, settle } from "./fixtures/thread-read-shell.js";

/**
 * AN OHBOX MESSAGE READ IN THE READER OVER ANOTHER VIEW IS A READ IN OHMAIL (owner 2026-10-21:
 * "should be at the top when it was my last action"). The reader's Mark read over the Tag view, the
 * sender's view or History names the message as the row read (`readRow`), so the engine sends an
 * open read and the Ohbox files it at the top of Earlier. Before, only OhboxView held the row, so
 * the read kept its arrival slot. Nothing holds it off the Ohbox: no view there keeps the row.
 */

const tag = { type: "tag", op: "create", id: "tg1", seq: 900, updatedAt: ISO, entity: { id: "tg1", name: "Plans", hue: "blue", createdAt: ISO, updatedAt: ISO } };
/** "old" unread (08:00) under "newer" read (08:30), both tagged: New ["old"], Earlier ["newer"]. */
const two = (over: Record<string, unknown> = {}) => [
  msg("old", 0, { threadId: "t-old", labels: ["tg1"], ...over }),
  msg("newer", 30, { threadId: "t-newer", unread: false, labels: ["tg1"] }),
  tag,
];
const views = [
  ["the Tag view", "#/tag/tg1/m/old"],
  ["the sender's view", `#/address/${encodeURIComponent(LENA.address)}/m/old`],
  ["History", "#/history/m/old"],
] as const;
const ids = (label: string): string[] =>
  [...document.querySelectorAll(`[role="listbox"][aria-label="${label}"] .row[data-id]`)]
    .map((e) => (e as HTMLElement).dataset.id!);
/** The one reader on screen: the column, the sender's pane or the sheet. */
const slot = (): HTMLElement | null => {
  const all = document.querySelectorAll<HTMLElement>(".abar .abar-read");
  return all.length === 1 ? all[0]! : null;
};
const openReads = () => patches.filter((p) => (p as { openRead?: boolean }).openRead === true);
async function goOhbox(): Promise<void> {
  window.location.hash = "#/ohbox";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await settle();
}

beforeAll(async () => {
  await import("../app/shell/AppShell.js");
  await import("@ohmail/ui");
}, 120_000);
beforeEach(() => { installShellEnv(); });
afterEach(async () => { await teardownShellEnv(); });

describe("the reader's Mark read off the Ohbox is an open read", () => {
  for (const [label, hash] of views) {
    it(`in ${label}: an open read, and the Ohbox files it at the top of Earlier`, async () => {
      window.location.hash = hash;
      await mountThread(two());
      expect(slot()?.getAttribute("aria-label"), `the premise: ${label} shows old`).toBe("Mark read");
      await click(slot(), "Mark read");
      expect(patches.at(-1)).toEqual({ ids: ["old"], unread: false, openRead: true });
      await goOhbox();
      expect(ids("Earlier")).toEqual(["old", "newer"]);
      expect(ids("New"), "no hold is left behind").toEqual([]);
    }, 30_000);
  }

  it("the narrow sheet over the Tag view: an open read", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (query: string) => ({
        matches: /max-width/.test(query), media: query, addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
      }),
    });
    window.location.hash = "#/tag/tg1/m/old";
    await mountThread(two());
    const sheet = document.querySelector<HTMLElement>(".reader .abar .abar-read");
    expect(sheet?.getAttribute("aria-label"), "the premise: the sheet shows old").toBe("Mark read");
    await click(sheet, "Mark read");
    expect(patches.at(-1)).toEqual({ ids: ["old"], unread: false, openRead: true });
  }, 30_000);
});

describe("CONTROLS off the Ohbox", () => {
  it("Mark unread on a read message: no open read", async () => {
    window.location.hash = "#/tag/tg1/m/newer";
    await mountThread(two());
    expect(slot()?.getAttribute("aria-label")).toBe("Mark unread");
    await click(slot(), "Mark unread");
    expect(patches).toEqual([{ ids: ["newer"], unread: true }]);
  }, 30_000);

  it("a tagged News message: no open read", async () => {
    window.location.hash = "#/tag/tg1/m/old";
    await mountThread(two({ folder: "ohmail/News" }));
    expect(slot()?.getAttribute("aria-label")).toBe("Mark read");
    await click(slot(), "Mark read");
    expect(patches.at(-1)).toEqual({ ids: ["old"], unread: false });
    expect(openReads()).toEqual([]);
  }, 30_000);
});
