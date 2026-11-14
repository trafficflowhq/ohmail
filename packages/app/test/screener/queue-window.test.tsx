/** @vitest-environment jsdom */
import { ESTIMATED_ROW_PX } from "@ohmail/app-logic/lists";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { modelOf, mountPlace, sender } from "./screener-world.js";

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(cleanup);

const COUNT = 600;

function mountQueue(waitingCount: number) {
  const waiting = Array.from({ length: waitingCount }, (_, i) =>
    sender(`waiting-${i}`, `Waiting sender ${i + 1}`),
  );
  const decided = Array.from({ length: COUNT - waitingCount }, (_, i) => ({
    sender: sender(`decided-${i}`, `Pending sender ${i + 1}`),
    decision: {
      subject: "sender.example",
      scope: "sender" as const,
      decidedAt: "2026-11-10",
      holder: "Mac",
      state: "sent",
    },
  }));
  const asked = { flushes: 0 };
  mountPlace(
    modelOf(asked, {
      waiting,
      waitingCount,
      decided,
      role: { mode: "pending", name: "Mac", reason: null, oauthOnly: false },
    }),
  );
  const list = screen.getByRole("listbox", { name: "Screener" });
  const scroller = list.closest<HTMLElement>(".sc-scroll")!;
  return { list, scroller, asked };
}

async function scrollTo(scroller: HTMLElement, slot: number) {
  scroller.scrollTop = slot * ESTIMATED_ROW_PX;
  await act(async () => {
    fireEvent.scroll(scroller);
    await new Promise((resolve) => setTimeout(resolve, 24));
  });
}

it.each([COUNT, 100])("announces the full Screener set when %i senders are waiting", async (waitingCount) => {
  const { list, scroller, asked } = mountQueue(waitingCount);
  const pending = COUNT - waitingCount;
  const heard = new Map<string, number>();
  const read = () => {
    const options = within(list).getAllByRole("option");
    expect(options.length).toBeLessThan(COUNT);
    for (const option of options) {
      const name = option.getAttribute("aria-label")!;
      const match = /^(Waiting|Pending) sender (\d+):/.exec(name)!;
      const position = Number(match[2]) + (match[1] === "Pending" ? waitingCount : 0);
      expect(option.getAttribute("aria-setsize")).toBe(String(COUNT));
      expect(option.getAttribute("aria-posinset")).toBe(String(position));
      heard.set(name, position);
    }
  };
  read();
  for (let slot = 20; slot <= COUNT; slot += 20) {
    await scrollTo(scroller, slot);
    read();
  }
  expect(new Set(heard.values())).toEqual(new Set(Array.from({ length: COUNT }, (_, i) => i + 1)));
  expect(heard.size).toBe(COUNT);
  if (pending > 0) {
    await scrollTo(scroller, waitingCount - 4);
    const heading = within(list).getByRole("heading", { name: /Waiting for the organizer/ });
    expect(heading.closest('[role="option"]')).toBeNull();
    expect(screen.getAllByRole("listbox")).toEqual([list]);
    fireEvent.click(within(list).getByRole("option", { name: /^Pending sender 1:/ }));
    const panel = within(screen.getByRole("region", { name: "Reading" })).getByRole("toolbar", {
      name: "Actions",
    });
    expect(panel.textContent).toContain("Decided — Mac files it on its next pass.");
    expect(within(panel).queryAllByRole("button")).toEqual([]);
  }
  expect(asked).not.toHaveProperty("decided");
});

it("reveals the next sender when the keyboard moves a cursor outside the visible window", async () => {
  const { list, scroller } = mountQueue(COUNT);
  await scrollTo(scroller, 400);
  expect(within(list).queryByRole("option", { name: /^Waiting sender 1:/ })).toBeNull();
  fireEvent.keyDown(document.body, { key: "j" });
  await waitFor(() => {
    expect(
      within(list)
        .getByRole("option", { name: /^Waiting sender 2:/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
});
