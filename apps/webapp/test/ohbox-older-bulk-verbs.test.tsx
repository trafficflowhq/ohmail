/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import en from "../messages/en.json";
import { UNDO_MS } from "@ohmail/app-logic/screener/screener-state";
import { act, teardownShellEnv, tick } from "./fixtures/live-walk-shell";
import {
  OLDER, installOlderStore, mountSettled, olderRows, pressLoadOlder, store,
} from "./fixtures/older-store-shell";

/**
 * A SELECTION HOLDING AN OLDER ROW — the bulk verbs resolve it through the Ohbox surface.
 *
 * The selection's verbs resolved each id through the verb reader alone, which answered `undefined`
 * for an Older row: Delete and Move refused the whole press over mailbox `""`, Tag dropped the row,
 * Screen planned nothing, Undo on Read had no inverse. A single row's press is handed its row.
 * One case per arm, through the real shell and engine, over a row only the store holds; `later`
 * resolves nothing and is the control that the ordinary dispatch holds.
 */

const OLD = OLDER[0]!.id; // unread, from a decided sender

beforeEach(installOlderStore);
afterEach(teardownShellEnv);

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await tick(0);
};
const click = async (el: Element | null | undefined, what: string): Promise<void> => {
  expect(el, `nothing to click: ${what}`).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  for (let i = 0; i < 4; i += 1) await tick(0);
};
const buttonStarting = (root: ParentNode, label: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
const writesFor = (id: string) => store.writes.filter((w) => w.url.includes(id) || JSON.stringify(w.body ?? "").includes(id));

/** Mount, reach past the window, and pick the Older row by itself. */
async function pickOlderRow(): Promise<HTMLElement> {
  store.rows = OLDER;
  const el = await mountSettled();
  await pressLoadOlder(el);
  expect(olderRows(el), "the fixture's Older row is not on screen").toContain(OLD);
  await click(el.querySelector(`.row[data-id="${OLD}"]`), "the Older row");
  await key("x");
  const picked = [...el.querySelectorAll<HTMLElement>(".view-ohbox .row.picked[data-id]")].map((r) => r.dataset.id);
  expect(picked).toEqual([OLD]);
  store.writes = [];
  return el;
}

describe("a selection holding an Older row reaches it with every verb", () => {
  it("delete: the press is not refused, and the delete reaches the wire when the window closes", async () => {
    await pickOlderRow();
    await key("Backspace");
    await tick(UNDO_MS * 2);
    expect(writesFor(OLD).some((w) => w.method === "DELETE"), "the Older row's delete never left").toBe(true);
  }, 30_000);

  it("move: files the row, where the press was refused as an unknown mailbox", async () => {
    const el = await pickOlderRow();
    await click(buttonStarting(el, en.ohbox.moveLabel) ?? buttonStarting(el, "Move"), "the Move control");
    await click(buttonStarting(el, "→ News"), "→ News");
    expect(writesFor(OLD).some((w) => w.method === "POST" && w.url.includes("/move")),
      "the Older row was not moved").toBe(true);
  }, 30_000);

  it("tag: the row is tagged, not filtered out of its own set", async () => {
    const el = await pickOlderRow();
    await key("t");
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((o) => (o.textContent ?? "").includes("Keep"));
    await click(option, "the Keep tag");
    expect(writesFor(OLD).some((w) => w.url.includes("/tags")), "the Older row was not tagged").toBe(true);
    void el;
  }, 30_000);

  it("screen: the plan names the row's sender, and the commit files", async () => {
    const el = await pickOlderRow();
    await key("s");
    await click(buttonStarting(el, "→ News"), "→ News");
    const commit = buttonStarting(el, en.screening.bulkCommit);
    expect(commit?.disabled, "the plan found no sender for the Older row").toBe(false);
    await click(commit, "the commit");
    expect(store.writes.length, "the screening wrote nothing").toBeGreaterThan(0);
  }, 30_000);

  it("read: Undo carries the Older row back to unread", async () => {
    await pickOlderRow();
    await key("U", { shiftKey: true });
    expect(writesFor(OLD).length, "the read never left").toBeGreaterThan(0);
    store.writes = [];
    const undo = [...document.querySelectorAll<HTMLButtonElement>('[role="status"] button')]
      .find((b) => (b.textContent ?? "").trim() === en.screener.toastUndo);
    await click(undo, "the toast's Undo");
    expect(writesFor(OLD).length, "Undo left the Older row read").toBeGreaterThan(0);
  }, 30_000);

  it("later (the control): a verb that resolves nothing reaches the wire as before", async () => {
    await pickOlderRow();
    await key("a");
    expect(writesFor(OLD).some((w) => w.url.includes("/triage")), "the park never left").toBe(true);
  }, 30_000);
});
