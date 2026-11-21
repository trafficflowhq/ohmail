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

function mounted(place: "News" | "Receipts") {
  const [route, make, subject] = place === "News" ? ["reads", issue, "Issue"] as const : ["receipts", receipt, "Order"] as const;
  const base = `#/${route}`;
  const { address } = mountStreamFrame({ at: base, withReply: true, letters: [make("a", 20), make("b", 19)] });
  const region = within(screen.getByRole("region", { name: `${place} stream` }));
  const card = (day: number) => {
    const heading = region.getByRole("heading", { name: `${subject} ${day}` });
    return heading.closest<HTMLElement>("[data-stream-item]")!;
  };
  const toggle = async (day: number, name: "Expand" | "Collapse") => {
    await act(async () => { fireEvent.click(within(card(day)).getByRole("button", { name })); });
  };
  const panels = () => region.queryAllByRole("toolbar", { name: "Actions" });
  return { address, base, card, panels, toggle };
}

describe("the action panel follows the open reading", () => {
  for (const place of ["News", "Receipts"] as const) {
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

    it(`${place}: closing the addressed card clears the reading and its actions`, async () => {
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
      expect(panels()).toHaveLength(0);
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
