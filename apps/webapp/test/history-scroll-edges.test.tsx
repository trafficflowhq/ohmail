/** @vitest-environment jsdom */
import { act, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, onTestFinished } from "vitest";
import { message, mountMailFrame, unmountAll } from "./_registered-mail-frame.js";

describe("ListPane says its scroller's edges on the column", () => {
  it("data-scrolled once rows went up, data-more-below while rows continue", async () => {
    localStorage.clear();
    onTestFinished(unmountAll);
    const { el } = await mountMailFrame("#/history", [message("older")]);
    const list = within(el).getByRole("listbox", { name: "History" });
    const scroller = list.closest<HTMLElement>(".pl-scroll")!;
    const column = scroller.parentElement!;
    Object.defineProperty(scroller, "clientHeight", { value: 400 });
    Object.defineProperty(scroller, "scrollHeight", { value: 1200 });
    const at = async (top: number) => {
      await act(async () => {
        scroller.scrollTop = top;
        fireEvent.scroll(scroller);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
    };
    await at(0);
    expect.soft(column.hasAttribute("data-scrolled")).toBe(false);
    expect.soft(column.hasAttribute("data-more-below")).toBe(true);
    await at(800);
    expect.soft(column.hasAttribute("data-scrolled")).toBe(true);
    expect.soft(column.hasAttribute("data-more-below")).toBe(false);
  });
});
