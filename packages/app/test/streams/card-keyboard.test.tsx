/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { issue, mountStreamFrame } from "./registered-world.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(["plain", "HTML"])("Enter on a fitting %s News row opens and focuses its actions", (format) => {
  for (const measurement of ["clientHeight", "scrollHeight"] as const) {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, measurement)!.get!;
    vi.spyOn(Element.prototype, measurement, "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("oh-message-clip") ? 200 : original.call(this);
    });
  }
  const text = "Short body";
  const letter = issue("first", 12, { body: format === "plain" ? text : undefined });
  const rows =
    format === "HTML"
      ? { "message_body:first": { state: "ready", text, html: `<p>${text}</p>` } }
      : undefined;
  const { address } = mountStreamFrame({ at: "#/reads", letters: [letter], rows });
  const reading = screen.getByRole("region", { name: "News stream" });
  reading.querySelector<HTMLElement>(".oh-sheet-scroll")!.scrollTo = vi.fn();
  expect(within(reading).queryByRole("button", { name: "Expand" })).toBeNull();
  const list = within(screen.getByRole("region", { name: "News" }));
  const row = list.getByRole("option", { name: /Issue 12/ });
  act(() => row.focus());
  fireEvent.keyDown(row, { key: "Enter" });
  expect(address.read()).toBe("#/reads/m/first");
  expect.soft(within(reading).queryByRole("button", { name: "Collapse" })).toBeTruthy();
  const actions = within(screen.getByRole("toolbar", { name: "Actions" }));
  expect(document.activeElement).toBe(actions.getByRole("button", { name: "Reply" }));
});
