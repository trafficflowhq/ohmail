/** @vitest-environment jsdom */
/**
 * AT A PHONE's WIDTH, WITH NO LETTER OPEN, THE CURSOR ROW's `d` ASKS FIRST AND `m` ASKS WHERE TO (the switch's point
 * 62, by RULING-JOIN J-1: today's shell bound both on the cursor row there), over the shell the hosts mount (the
 * tests' door). Nothing leaves at the press of `d`; only the ask's own Delete deletes, held for the Undo window; Move
 * files the letter once, to the place chosen.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, message, mountShell, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

/** The window at a phone's width, as the frame's plan reads it. */
function sized(w: number, hgt: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: w });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: hgt });
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => {
      const max = /max-width:\s*([\d.]+)px/.exec(query);
      const min = /min-width:\s*([\d.]+)px/.exec(query);
      const matches = (max === null || w <= Number(max[1])) && (min === null || w >= Number(min[1])) && (max !== null || min !== null);
      return {
        matches, media: query, onchange: null, addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
      };
    },
  });
}

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
const key = async (k: string): Promise<void> => {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
};
const question = (name: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${name}"], [role="menu"][aria-label="${name}"]`);
const item = (within: HTMLElement, name: RegExp): HTMLElement | null =>
  [...within.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((b) => name.test(b.textContent ?? "")) ?? null;
const settle = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  sized(390, 844);
});
afterEach(async () => {
  await unmountAll();
});

describe("the cursor row at 390 wide, no letter open", () => {
  it("d asks first: nothing leaves at the press or on Cancel; the ask's Delete takes the row and holds the delete", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2"), message("m3")]);
    await waitFor(() => rows().length === 3, "the seated list");
    await key("j");
    await key("d");
    await waitFor(() => question("Move to Trash.") !== null, "the delete's ask");
    expect(s.sent.filter((m) => m.kind === "message_delete")).toEqual([]);
    await act(async () => { item(question("Move to Trash.")!, /^Cancel/)!.click(); });
    await settle();
    expect(rows().length).toBe(3);
    await key("d");
    await waitFor(() => question("Move to Trash.") !== null, "the delete's ask again");
    await act(async () => { item(question("Move to Trash.")!, /^Move/)!.click(); });
    await waitFor(() => rows().length === 2, "the row taken out of the list");
    expect(s.sent.filter((m) => m.kind === "message_delete"), "held for the Undo window").toEqual([]);
  }, 30_000);

  it("m asks where to, and the place chosen files the cursor row's letter once", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2"), message("m3")]);
    await waitFor(() => rows().length === 3, "the seated list");
    await key("j");
    const before = s.sent.length;
    await key("m");
    await waitFor(() => question("Move") !== null, "the places to move to");
    expect(s.sent.length).toBe(before);
    const places = [...question("Move")!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    await act(async () => { places[1]!.click(); });
    await waitFor(() => s.sent.length === before + 1, "the move on the wire");
    await settle();
    expect(s.sent.length).toBe(before + 1);
  }, 30_000);
});
