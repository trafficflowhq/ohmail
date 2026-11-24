/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ScreenerSenderDTO } from "@ohmail/wire";
import { modelOf, mountPlace, sender } from "./screener-world.js";

afterEach(cleanup);

it("keeps background keys blocked and only removes rows from the open Spam question", () => {
  const a = sender("a", "First sender");
  const b = sender("b", "Second sender");
  const aNew = sender("a-new", "First sender", { from: (a as ScreenerSenderDTO).from });
  const c = sender("c", "New sender");
  const asked = { flushes: 0, decided: [] };
  const file = vi.fn();
  const model = (waiting: ScreenerSenderDTO[]) =>
    modelOf(asked, {
      waiting,
      waitingCount: waiting.length,
      markAllSpam: (_scope, only) => file(waiting.filter((row) => only?.(row)).map((row) => row.id)),
    });
  const view = mountPlace(model([a, b]));
  fireEvent.click(screen.getByRole("button", { name: "List" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Mark all spam" }));
  const question = () => screen.getByRole("dialog", { name: /Mark \d+ as spam/ });
  expect(question().textContent).toContain("Mark 2 as spam");
  (document.activeElement as HTMLElement).blur();
  fireEvent.keyDown(document.body, { key: "o" });
  expect(asked.decided).toEqual([]);
  expect(question().textContent).toContain("Mark 2 as spam");
  view.again(model([b, aNew, c]));
  expect(question().textContent).toContain("Mark 1 as spam");
  fireEvent.click(within(question()).getByRole("button", { name: "Cancel" }));
  expect(file).not.toHaveBeenCalled();
});
