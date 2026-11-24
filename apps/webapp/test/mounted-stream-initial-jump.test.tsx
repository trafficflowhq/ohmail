/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hitAt, issue, mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";
import { stubDom } from "./_draft-shell.js";

beforeEach(() => stubDom());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  { name: "News", place: "news", seed: issue },
  { name: "Receipts", place: "receipts", seed: receipt },
] as const)("$name opens an initial search jump", ({ name, place, seed }) => {
  it("waits for the target card and then scrolls to it", async () => {
    const target = "m30";
    const selector = `[data-stream-item="${target}"]`;
    const letters = Array.from({ length: 40 }, (_, i) => seed(`m${i}`, 50 - i));
    const height = 240;
    let position = 0;
    const ports = () => screen.queryByRole("region", { name: `${name} stream` });
    const targetMountedAtScroll: boolean[] = [];
    const isPort = (element: HTMLElement) => element.hasAttribute("data-reading-scroll") && ports()?.contains(element);
    const restoreHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return isPort(this) ? 600 : restoreHeight?.get?.call(this) ?? 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return isPort(this) ? letters.length * height : 0;
    });
    const rect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (isPort(this)) return new DOMRect(0, 0, 500, 600);
      const item = this.dataset.streamItem;
      if (item) return new DOMRect(0, Number(item.slice(1)) * height - position, 500, height);
      return rect.call(this);
    });
    vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(() => position);
    vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
      if (!isPort(this)) return;
      targetMountedAtScroll.push(ports()?.querySelector(selector) !== null);
      position = (typeof options === "number" ? y : options?.top) ?? position;
    });
    mountStreamFrame({ at: "#/search", letters, hit: hitAt(place, target) });
    expect(document.querySelector(selector)).toBeNull();
    expect(targetMountedAtScroll).toEqual([]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open the hit" })); });
    const stream = screen.getByRole("region", { name: `${name} stream` });
    expect(stream.querySelector(selector)).not.toBeNull();
    for (let frame = 0; frame < 6; frame += 1) {
      await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    }
    expect(targetMountedAtScroll.length).toBeGreaterThan(0);
    expect(targetMountedAtScroll).not.toContain(false);
    expect(position).toBeGreaterThan(0);
    expect(within(stream).getByRole("button", { name: "Collapse" }).closest(selector)).not.toBeNull();
  });
});
