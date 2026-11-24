/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncChange } from "@ohmail/client-engine";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import readerEn from "../../../../packages/app/messages/reader.en.json" with { type: "json" };
import { NOW, S, act, click, engineOver, msg, setup, shell, storeWith, teardown, tombstone, waitFor } from "../_view-shell";

/**
 * GONE AT THE OHBOX. A picked message another mail client took away is SAID in the Ohbox's reading column, never
 * swapped for another row; a tombstone this tab's own verb wrote is not "gone": nobody lost that message.
 *
 * MOVED (share ohbox-2, the switch's older tests) from `list-view-says-gone.test.tsx`, whose other cases still stand
 * over the views of places not mounted yet, and RE-POINTED over the new shell's door (`_view-shell`'s `shell` mounts
 * the frame over the mail ground): the row and the column by role and name (today's `.view-ohbox`, `.read-col` are
 * drawn by no part of the new shell). The column says the reader's own words for it (`reader.goneShort`: the seated
 * part's catalogue, as the lists' seats read it). The shell half's case read today's `listGoneFacts`, the function
 * AppShell fed with this tab's own verbs; here it reads what a person meets in the column: a foreign tombstone is
 * said, an own one and a letter the mirror never held are not.
 */
beforeEach(setup);
afterEach(teardown);

const GONE = readerEn.reader.goneShort;
const TAG = { type: "tag", op: "create", id: "tg1", seq: 900, updatedAt: NOW.toISOString(),
  entity: { id: "tg1", name: "Invoices", hue: "moss", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } } as unknown as SyncChange;
const tagged = () => [msg("m1", { labels: ["tg1"] }), msg("m2", { labels: ["tg1"], date: "2026-09-16T08:00:00.000Z" })];
/** A row of the Ohbox's list by its letter, and the frame's reading column. */
const row = (el: HTMLElement, id: string): HTMLElement | null => el.querySelector<HTMLElement>(`[role="option"][data-id="${id}"]`);
const column = (el: HTMLElement): string => el.querySelector('section[aria-label="Reading"]')?.textContent ?? "";
/** The address a link or Back names: the frame follows it. */
async function visit(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
}

describe("the shell's list views say a picked message is gone", () => {
  it("control: the Ohbox column says it", async () => {
    const s = await storeWith(tagged(), [TAG]);
    const el = await shell(s, engineOver(s), "#/ohbox");
    await waitFor(() => row(el, "m1") !== null, "ohbox rows");
    await click(row(el, "m1"), "ohbox row m1");
    await tombstone("m1");
    expect(column(el)).toContain(GONE);
  });
});

describe("the shell half: a tombstone this tab's own verb wrote is not 'gone'", () => {
  it("reads a foreign tombstone as gone, and neither an own one nor an absent row", async () => {
    const s = await storeWith([msg("t1"), msg("t2", { date: "2026-09-16T08:00:00.000Z" })]);
    const el = await shell(s, engineOver(s), "#/ohbox");
    await waitFor(() => row(el, "t1") !== null && row(el, "t2") !== null, "ohbox rows");
    /* t1: another mail app took it away while it was open. */
    await click(row(el, "t1"), "ohbox row t1");
    await waitFor(() => column(el).includes("Subject t1"), "t1 open");
    await tombstone("t1");
    expect(column(el)).toContain(GONE);
    /* t2: this tab deleted it (⌫ on its row, the Undo window let pass); a way back to its address finds it. */
    await click(row(el, "t2"), "ohbox row t2");
    await waitFor(() => column(el).includes("Subject t2"), "t2 open");
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, UNDO_MS + 1500)); });
    expect(S.engine!.messageIsGone("t2"), "the premise: this tab's delete left a tombstone").toBe(true);
    await visit("#/ohbox/m/t2");
    expect(column(el), "this tab's own delete read as another app's").not.toContain(GONE);
    /* absent: a letter this mirror never held. */
    await visit("#/ohbox/m/absent");
    expect(column(el)).not.toContain(GONE);
  }, 30_000);
});
