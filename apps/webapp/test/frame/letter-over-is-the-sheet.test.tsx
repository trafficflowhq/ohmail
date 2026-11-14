/** @vitest-environment jsdom */
/**
 * AT ONE COLUMN THE LETTER OVER THE LIST IS THE ZONE WALK's SHEET (the switch's point 65, by RULING-JOIN J-1: today's
 * reader sheet was): while it stands, ↑ and ↓ scroll it from wherever the keyboard was left, and never move the list
 * hidden under it; a field under the letter does not silence it; a dialog over it owns its own arrows. Over the shell
 * the hosts mount (the tests' door), the letter opened by its address.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { READER_SCROLL_STEP } from "@ohmail/app-logic/keys";
import { act, message, mountShell, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

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

/** The open letter's region and its scroller, as a person meets them. */
const letter = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="region"][aria-label="Open message"]');
const scroller = (): HTMLElement | null => letter()?.querySelector<HTMLElement>("[data-reading-scroll]") ?? null;
const list = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="listbox"]');
const marked = (): string =>
  [...(list()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
    .map((r) => `${r.getAttribute("aria-selected")}|${r.hasAttribute("data-open")}|${r.hasAttribute("data-cursor")}`)
    .join(",");
const down = async (from: Element): Promise<void> => {
  await act(async () => {
    from.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
};

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  sized(390, 844);
});
afterEach(async () => {
  await unmountAll();
  document.querySelectorAll("[data-case-made]").forEach((n) => n.remove());
});

async function letterOver(): Promise<HTMLElement> {
  await mountShell("#/ohbox/m/m2", [message("m1"), message("m2"), message("m3")]);
  await waitFor(() => scroller() !== null, "the letter over the list");
  const el = scroller()!;
  el.scrollTop = 0;
  return el;
}

describe("the letter over the list at 390 wide is the sheet the keys scroll", () => {
  it("↓ with the keyboard on the page scrolls the letter and moves nothing in the list under it", async () => {
    const el = await letterOver();
    (document.activeElement as HTMLElement | null)?.blur();
    const before = marked();
    await down(document.body);
    expect(el.scrollTop, "the letter scrolled").toBe(READER_SCROLL_STEP);
    expect(marked(), "the list under it did not move").toBe(before);
    expect(window.location.hash).toBe("#/ohbox/m/m2");
  }, 30_000);

  it("a field under the letter does not silence it: ↓ there scrolls the letter", async () => {
    const el = await letterOver();
    const field = document.createElement("input");
    field.setAttribute("data-case-made", "");
    document.querySelector(".fr-list")!.prepend(field);
    field.focus();
    await down(field);
    expect(el.scrollTop).toBe(READER_SCROLL_STEP);
  }, 30_000);

  it("a dialog over the letter owns its own arrows: the letter does not scroll and the list does not move", async () => {
    const el = await letterOver();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-case-made", "");
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);
    button.focus();
    const before = marked();
    await down(button);
    expect(el.scrollTop).toBe(0);
    expect(marked()).toBe(before);
  }, 30_000);
});
