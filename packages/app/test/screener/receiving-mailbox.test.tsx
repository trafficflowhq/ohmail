/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { BESIDE, modelOf, mountPlace, sender } from "./screener-world.js";

afterEach(cleanup);

it("shows the short receiving mailbox in the queue and the full mailbox in the opened sender", () => {
  const waiting = sender("first", "First sender", { mailboxId: "box" });
  mountPlace(modelOf({ flushes: 0 }, { waiting: [waiting], waitingCount: 1 }), {
    beside: { ...BESIDE, mailboxWord: (_id, form) => (form === "short" ? "Work" : "Work mail") },
  });
  const row = screen.getByRole("option", { name: /First sender/ });
  expect(within(row).getAllByText("Work", { exact: true })).toHaveLength(1);
  expect(row.getAttribute("aria-description")).toContain("Delivered to Work");
  expect(within(row).queryByText("Work mail")).toBeNull();
  expect(within(screen.getByRole("region", { name: "Reading" })).getByText(/Work mail/)).toBeTruthy();
});
