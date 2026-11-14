/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ISO, installShellEnv, teardownShellEnv } from "./fixtures/live-walk-shell.js";
import { LENA, click, mountThread, msg, patches, readSlot } from "./fixtures/thread-read-shell.js";

/**
 * OFF THE OHBOX THE READ SLOT IS THE OPENED MESSAGE'S OWN, and its press flips in the direction its
 * face shows. The thread a1 (opened, READ) + x2 (unread), opened in the Tag view and the sender's
 * view: the slot says "Mark unread" and the press writes a1 unread — never a write over x2.
 * Mutation: the pane deriving the conversation's face itself when no `readSet` is handed in — the
 * slot then says "Mark read" and the same press marks the opened message UNREAD (red here).
 */

const tag = { type: "tag", op: "create", id: "tg1", seq: 900, updatedAt: ISO, entity: { id: "tg1", name: "Plans", hue: "blue", createdAt: ISO, updatedAt: ISO } };
const views = [
  ["the Tag view", "#/tag/tg1/m/a1"],
  ["the sender's view", `#/address/${encodeURIComponent(LENA.address)}/m/a1`],
] as const;

beforeAll(async () => {
  await import("./_mail-shell.js");
  await import("@ohmail/ui");
}, 120_000);
beforeEach(() => { installShellEnv(); });
afterEach(async () => { await teardownShellEnv(); });

describe("the read slot off the Ohbox", () => {
  for (const [label, hash] of views) {
    it(`in ${label}, a read message beside an unread sibling says Mark unread and flips itself`, async () => {
      window.location.hash = hash;
      await mountThread([msg("a1", 0, { unread: false, labels: ["tg1"] }), msg("x2", 60, { labels: ["tg1"] }), tag]);
      const pane = document.querySelector<HTMLElement>('[data-conv-id="a1"][aria-current="true"]')?.closest<HTMLElement>(".conv");
      expect(pane, `the premise: ${label} opens a1 in its conversation`).toBeTruthy();
      expect(pane!.querySelector('article.pm[data-conv-id="x2"][data-unseen]'), "x2 is an unread panel").toBeTruthy();
      expect(readSlot(pane!)?.getAttribute("aria-label")).toBe("Mark unread");
      await click(readSlot(pane!), "the read slot");
      expect(patches, "the flip of the opened message, in the face's direction").toEqual([{ ids: ["a1"], unread: true }]);
    }, 30_000);
  }
});
