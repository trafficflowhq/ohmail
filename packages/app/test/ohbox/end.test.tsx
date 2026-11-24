/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { at, msg, ohbox } from "./ohbox-world.js";
import { wideWindow } from "./setup.js";

beforeEach(wideWindow);
afterEach(cleanup);

describe("the end of the list, and the way back", () => {
  it("the list ends in one line that leads to History", () => {
    const world = ohbox({ previouslySeen: [msg({ id: "r", unread: false, date: at(6) })] });
    expect(screen.getByText(/Older mail/).textContent).toContain("Older mail");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(world.said.went).toEqual(["history"]);
  });

  it("the way back stands once the list is far from its top, and returns to it", () => {
    const { view } = ohbox({ newForYou: ["a", "b", "c"].map((id, i) => msg({ id, date: at(10 - i) })) });
    const back = () => screen.queryByRole("button", { name: "Back to top" });
    const scroller = view.container.querySelector<HTMLElement>("[data-window-top]")!.parentElement!;
    const shown = () =>
      back() !== null && !back()!.closest("[hidden]") && back()!.getAttribute("aria-hidden") !== "true";
    expect(shown()).toBe(false);
    Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    expect(shown()).toBe(true);
    fireEvent.click(back()!);
    expect(scroller.scrollTop).toBe(0);
  });
});
