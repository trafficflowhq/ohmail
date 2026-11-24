/** @vitest-environment jsdom */
import { cleanup, screen } from "@testing-library/react";
import type { ScreenerSenderDTO } from "@ohmail/wire";
import { afterEach, expect, it } from "vitest";
import { modelOf, mountPlace, sender } from "./screener-world.js";

afterEach(cleanup);

it("announces the visual read state of each held sender", () => {
  const waiting = [true, false].map((unread) => {
    const id = unread ? "unread" : "read";
    const name = unread ? "First correspondent" : "Second correspondent";
    return sender(id, name, {
      held: [{ id, time: "09:00", subject: "Held letter", snippet: "", unread }],
    }) as ScreenerSenderDTO;
  });
  mountPlace(modelOf({ flushes: 0 }, { waiting, waitingCount: 2 }));
  const unread = screen.getByRole("option", { name: /^First correspondent/ });
  const read = screen.getByRole("option", { name: /^Second correspondent/ });
  expect(unread.hasAttribute("data-unread")).toBe(true);
  expect(read.hasAttribute("data-unread")).toBe(false);
  expect(unread.getAttribute("aria-description")).toBe("Unread");
  expect(read.getAttribute("aria-description")).toBe("Read");
});

for (const segment of ["screened", "spam"] as const) {
  it(`shows previously decided senders as read in ${segment}`, () => {
    const row = sender("decided", "Decided correspondent", {
      segment,
      held: [{ id: "held", time: "09:00", subject: "Previously decided", snippet: "", unread: true }],
    }) as ScreenerSenderDTO;
    mountPlace(
      modelOf(
        { flushes: 0 },
        {
          ...(segment === "screened" ? { screenedOut: [row] } : { spam: [row] }),
        },
      ),
      { at: `#/screener/${segment}` },
    );
    const shown = screen.getByRole("option", { name: /^Decided correspondent/ });
    expect(shown.getAttribute("aria-description")).toBe("Read");
    expect(shown.hasAttribute("data-unread")).toBe(false);
  });
}
