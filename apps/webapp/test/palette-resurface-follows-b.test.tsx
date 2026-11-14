/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncChange } from "@ohmail/client-engine";
import { NOW, act, click, engineOver, msg, setup, shell, storeWith, teardown, waitFor } from "./_view-shell";

/**
 * PALETTE-RESURFACE-GREYED-WHERE-B-ACTS. The palette's "Resurface selection" is the `b` key's row:
 * live wherever `b` is live and acting as `b` does, as "Move" is `m`'s. It read the Ohbox's own
 * selection only, so in a tag or History with a row picked — `b` live there — it was greyed.
 */
beforeEach(setup);
afterEach(teardown);

const TAG = { type: "tag", op: "create", id: "tg1", seq: 900, updatedAt: NOW.toISOString(),
  entity: { id: "tg1", name: "Invoices", hue: "moss", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } } as unknown as SyncChange;

async function paletteRow(el: HTMLElement, label: string): Promise<HTMLElement | null> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await waitFor(() => el.ownerDocument.querySelector(".palette") !== null, "the palette open");
  return [...el.ownerDocument.querySelectorAll<HTMLElement>(".palette li[role=option]")]
    .find((li) => (li.textContent ?? "").includes(label)) ?? null;
}

const rows = () => [msg("m1", { labels: ["tg1"] }), msg("m2", { labels: ["tg1"], date: "2026-09-16T08:00:00.000Z" })];

describe("the palette's Resurface row follows the live `b`", () => {
  for (const [hash, view] of [["#/tag/tg1", "tag"], ["#/history", "history"]] as const) {
    it(`in ${view}, with a row picked, the row is live`, async () => {
      const s = await storeWith(rows(), [TAG]);
      const el = await shell(s, engineOver(s), hash);
      await waitFor(() => el.querySelector(`.view-${view} :is(.row, [role=option])[data-id="m1"]`) !== null, `${view} rows`);
      await click(el.querySelector(`.view-${view} :is(.row, [role=option])[data-id="m1"]`), "row m1");
      const row = await paletteRow(el, "Resurface selection");
      expect(row, "the row is listed").not.toBeNull();
      expect(row!.getAttribute("aria-disabled"), "greyed where b acts").toBeNull();
    });
  }

  it("control: in the Ohbox with nothing open, `b` is not live and neither is the row", async () => {
    const s = await storeWith(rows(), [TAG]);
    const el = await shell(s, engineOver(s), "#/ohbox");
    await waitFor(() => el.querySelector('.view-ohbox :is(.row, [role=option])[data-id="m1"]') !== null, "ohbox rows");
    const row = await paletteRow(el, "Resurface selection");
    expect(row, "the row is listed").not.toBeNull();
    expect(row!.getAttribute("aria-disabled")).toBe("true");
  });
});
