/** @vitest-environment jsdom */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, message, mountShell, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

beforeEach(() => {
  stubDom();
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
});

it("an older Screener hit opens that held letter in the selected sender", async () => {
  const common = {folder:"ohmail/Screener", unread:true} as const;
  const before = message("found-earlier", {...common, subject:"Unique ceramic invoice", date:"2026-09-25T08:00:00Z"});
  const after = message("newest", {...common,subject:"A different newer subject", date:"2026-09-27T08:00:00Z"});
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const r = real.call(this);
    const offset = this.id === "sc-held-found-earlier" ? 160 : this.id === "sc-held-newest" ? 900 : 0;
    if (!offset) return r;
    const scroll = this.closest(".oh-sheet-scroll")?.scrollTop ?? 0;
    return {...r, top: offset-scroll, bottom: offset-scroll+120, height:120} as DOMRect;
  });
  await mountShell("#/search",[before,after]);
  const field = await screen.findByRole("textbox", { name: "Search" });
  await act(async () => { fireEvent.change(field, {target: {value:"ceramic"}}); });
  const row = () => document.querySelector<HTMLElement>('[data-hit="found-earlier"]');
  await waitFor(() => row() !== null, "the older held letter in Search");
  await act(async () => { within(row()!).getAllByRole("button")[0]!.click(); });
  await waitFor(()=>window.location.hash.startsWith("#/screener"), "sender card from Search");
  const target = document.getElementById("sc-held-found-earlier");
  expect(target?.textContent).toContain("Unique ceramic invoice");
  const scroll = target?.closest(".oh-sheet-scroll")?.scrollTop ?? 0;
  expect(scroll).toBeGreaterThan(100);
  expect(scroll).toBeLessThan(170);
}, 60_000);
