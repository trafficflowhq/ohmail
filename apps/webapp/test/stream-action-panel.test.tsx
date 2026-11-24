/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { issue, mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";
import { stubDom } from "./_draft-shell.js";

beforeEach(() => stubDom());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mounted(place: "News" | "Receipts", unread = true) {
  const [route, make, subject] = place === "News" ? ["reads", issue, "Issue"] as const : ["receipts", receipt, "Order"] as const;
  const base = `#/${route}`;
  const { address, mail } = mountStreamFrame({
    at: base, withReply: true, letters: [make("a", 20, { unread }), make("b", 19, { unread })],
  });
  const region = within(screen.getByRole("region", { name: `${place} stream` }));
  const card = (day: number) => {
    const heading = region.getByRole("heading", { name: `${subject} ${day}` });
    return heading.closest<HTMLElement>("[data-stream-item]")!;
  };
  const toggle = async (day: number, name: "Expand" | "Collapse") => {
    await act(async () => { fireEvent.click(within(card(day)).getByRole("button", { name })); });
  };
  const panels = () => region.queryAllByRole("toolbar", { name: "Actions" });
  return { address, base, card, mail, panels, toggle };
}

describe("the action panel follows the open reading", () => {
  for (const place of ["News", "Receipts"] as const) {
    it(`${place}: the footer acts on the standing card before anything is opened`, () => {
      const { address, base, card, mail, panels } = mounted(place, false);
      expect(within(card(20)).getByRole("button", { name: "Expand" })).toBeTruthy();
      expect(panels()).toHaveLength(1);
      fireEvent.click(within(panels()[0]!).getByRole("button", { name: "Mark unread" }));
      expect(mail.mutations.filter((m) => m.kind === "mark_seen")).toEqual([
        expect.objectContaining({ messageIds: ["a"], unread: true }),
      ]);
      expect(address.read()).toBe(base);
    });

    it(`${place}: a folded card's menu acts on that card without opening it`, () => {
      const { address, base, card, mail } = mounted(place, false);
      fireEvent.click(within(card(19)).getByRole("button", { name: "Message" }));
      const menu = within(screen.getByRole("menu", { name: "Message" }));
      for (const name of ["Reply", "Forward", "Mark unread"])
        expect(menu.getByRole("menuitem", { name })).toBeTruthy();
      fireEvent.click(menu.getByRole("menuitem", { name: "Mark unread" }));
      expect(mail.mutations.filter((m) => m.kind === "mark_seen")).toEqual([
        expect.objectContaining({ messageIds: ["b"], unread: true }),
      ]);
      expect(address.read()).toBe(base);
      expect(within(card(19)).getByRole("button", { name: "Expand" })).toBeTruthy();
    });

    it(`${place}: opening another letter keeps only its action panel at rest`, async () => {
      const { address, base, card, panels, toggle } = mounted(place);
      await toggle(20, "Expand");
      expect(address.read()).toBe(`${base}/m/a`);
      expect(panels()).toHaveLength(1);
      vi.spyOn(card(20), "getBoundingClientRect").mockReturnValue({ top: -500, bottom: -100, height: 400 } as DOMRect);
      await toggle(19, "Expand");
      expect(address.read()).toBe(`${base}/m/b`);
      expect(panels()).toHaveLength(1);
      expect(within(panels()[0]!).getByRole("button", { name: "Reply" })).toBeTruthy();
    });

    it(`${place}: closing the addressed card folds the reading and keeps one footer`, async () => {
      const { address, base, card, panels, toggle } = mounted(place);
      await toggle(20, "Expand");
      await toggle(19, "Expand");
      expect(address.read()).toBe(`${base}/m/b`);
      await toggle(20, "Collapse");
      expect(address.read()).toBe(`${base}/m/b`);
      expect(panels()).toHaveLength(1);
      await toggle(19, "Collapse");
      expect(address.read()).toBe(base);
      expect(card(19).hasAttribute("data-expanded")).toBe(false);
      expect(panels()).toHaveLength(1);
      await toggle(19, "Expand");
      expect(address.read()).toBe(`${base}/m/b`);
      expect(panels()).toHaveLength(1);
    });
  }
});

it("both registered streams bind the action panel to their open reading", () => {
  for (const place of ["news", "receipts"]) {
    const seat = readFileSync(`packages/app/src/${place}/place.ts`, "utf8");
    expect(seat).toContain("Reading: StreamReading");
  }
  const reading = readFileSync("packages/app/src/stream/StreamReading.tsx", "utf8");
  expect(reading).toMatch(/<StreamColumn\b/);
  const column = readFileSync("packages/app/src/stream/StreamColumn.tsx", "utf8");
  expect(column).toMatch(/const\s+panelId\s*=\s*actionId\s*\?\?\s*fallback/);
  expect(column).toMatch(/<reader\.Actions\s+messageId=\{panelId\}/);
  const model = readFileSync("packages/app-logic/src/streams/use-stream.ts", "utf8");
  expect(model).toMatch(/actionId:\s*openId\s*\?\?\s*selected/);
  expect(column.match(/<reader\.Actions\b/g)).toHaveLength(1);
  expect(column).toContain("foot={panel}");
});
