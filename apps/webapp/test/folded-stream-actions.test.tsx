/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EngineMessage } from "@ohmail/wire";
import { issue, mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";
import { stubStreamDom } from "./stream-check-frame.js";

const one = issue("one", 20, { threadId: "thread-one" });
const two = issue("two", 19);
const read = () => screen.getByRole("region", { name: "News stream" });
const card = (day: number) => read().querySelector<HTMLElement>(
  `[data-stream-item="${day === 20 ? "one" : "two"}"]`,
)!;
const panel = () => within(read()).queryByRole("toolbar", { name: "Actions" });

beforeEach(stubStreamDom);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function seat(letters: EngineMessage[] = [one, two]) {
  return mountStreamFrame({ at: "#/reads", withReply: true, letters });
}


it("scrolling retargets the footer without unfolding the card", async () => {
  const { mail } = seat();
  const scroll = read().querySelector<HTMLElement>("[data-reading-scroll]")!;
  Object.defineProperty(scroll, "clientHeight", { value: 300 });
  Object.defineProperty(scroll, "scrollHeight", { value: 900 });
  scroll.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300 } as DOMRect);
  for (const [day, top] of [[20, 0], [19, 400]] as const) {
    card(day).getBoundingClientRect = () => ({
      top: top - scroll.scrollTop, bottom: top + 400 - scroll.scrollTop, height: 400,
    } as DOMRect);
  }
  expect(panel()).toBeTruthy();
  await act(async () => {
    fireEvent.wheel(scroll, { deltaY: 400 });
    scroll.scrollTop = 400;
    fireEvent.scroll(scroll);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(card(19).hasAttribute("data-open")).toBe(true);
  expect(within(card(19)).getByRole("button", { name: "Expand" })).toBeTruthy();
  fireEvent.click(within(panel()!).getByRole("button", { name: "Later" }));
  expect(mail.mutations.filter((write) => write.kind === "triage_set")).toEqual([
    expect.objectContaining({ messageId: "two", state: "reply_later" }),
  ]);
});
