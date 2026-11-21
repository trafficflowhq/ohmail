/** @vitest-environment jsdom */
/**
 * WHAT THE READING COLUMN SAYS OF A LETTER IT CANNOT SHOW, OVER THE NEW SHELL's DOOR (the switch's point 66, PART B; by
 * RULING-JOIN J-1 what the act does is today's). A letter another app took away is said gone; a letter THIS tab deleted
 * is the person's own act and is never blamed on another app (its address visited again rests blank); and a link to a
 * letter no store can show (another account's, or one the mirror never held where no store lookup stands) leaves the
 * address once the mail state has settled, replaced in place, so a reload and Back do not lead to it again.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import readerEn from "../../../../packages/app/messages/reader.en.json" with { type: "json" };
import { S, act, click, engineOver, msg, setup, shell, storeWith, teardown, tombstone, waitFor } from "../_view-shell";

beforeEach(setup);
afterEach(teardown);

const GONE = readerEn.reader.goneShort;
const row = (el: HTMLElement, id: string): HTMLElement | null => el.querySelector<HTMLElement>(`[role="option"][data-id="${id}"]`);
const column = (el: HTMLElement): string => el.querySelector('section[aria-label="Reading"]')?.textContent ?? "";
const settle = async (ms: number): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
};
async function visit(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settle(300);
}

describe("a letter the column cannot show", () => {
  it("one this tab deleted is not said gone when its address is visited again; another app's is", async () => {
    const s = await storeWith([msg("a1"), msg("a2", { date: "2026-09-16T08:00:00.000Z" })]);
    const el = await shell(s, engineOver(s), "#/ohbox");
    await waitFor(() => row(el, "a1") !== null && row(el, "a2") !== null, "the rows");
    await click(row(el, "a2"), "row a2");
    await waitFor(() => column(el).includes("Subject a2"), "a2 open");
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    });
    await settle(UNDO_MS + 1500);
    expect(S.engine!.messageIsGone("a2"), "the premise: the delete left a tombstone").toBe(true);
    await visit("#/ohbox/m/a2");
    expect(column(el), "this tab's own delete said as another app's").not.toContain(GONE);
    /* CONTROL: another app takes a1 away while it is open: said gone. */
    await visit("#/ohbox/m/a1");
    await waitFor(() => column(el).includes("Subject a1"), "a1 open");
    await tombstone("a1");
    expect(column(el)).toContain(GONE);
  }, 30_000);

  it("a link to a letter no store can show leaves the address once the mail state settles", async () => {
    const s = await storeWith([msg("b1")]);
    const el = await shell(s, engineOver(s), "#/ohbox/m/not-in-this-mirror");
    await waitFor(() => row(el, "b1") !== null, "the Ohbox's rows");
    await waitFor(() => window.location.hash === "#/ohbox", "the link left the address");
    expect(column(el)).not.toContain(GONE);
  }, 30_000);
});
