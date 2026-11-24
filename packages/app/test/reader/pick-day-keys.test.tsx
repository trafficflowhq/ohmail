/** @vitest-environment jsdom */
/**
 * RESURFACE's DAY PICKER BY THE KEYS (the switch's point 65; today's picker did each): as it opens the keys are on
 * the first day that can still be booked; the arrows move a day and a week, past the month's end into the next;
 * Enter books the day under the keys at the time named, and the picker closes as after any answer.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayAtIn, readerZone } from "@ohmail/app-logic/reader";
import { letter, mountReader } from "./support/mail.js";

/* Tuesday 10 November 2026, mid-afternoon wherever the suite runs: 09:00 today is past, so tomorrow is the floor. */
const NOW = new Date("2026-11-10T15:00:00.000Z");
beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const booked = (mail: { mutations: unknown[] }) =>
  (mail.mutations as { bubbleUpAt?: string }[]).map((m) => m.bubbleUpAt);
const keys = () => document.activeElement?.getAttribute("aria-label") ?? "";
const press = (...names: string[]) =>
  names.forEach((key) => fireEvent.keyDown(document.activeElement!, { key }));
function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: "Resurface" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Pick a date" }));
}

describe("Resurface's day picker, by the keys", () => {
  it("opens with the keys on the first day that can be booked, walks by the arrows, and Enter books that day", async () => {
    const { mail } = mountReader({ letters: [letter("m1")], open: "m1" });
    openPicker();
    expect(keys()).toMatch(/^Wed 11 Nov 2026/);
    /* The days before it are not offered: the keys do not go back onto them. */
    press("ArrowLeft", "ArrowUp");
    expect(keys()).toMatch(/^Wed 11 Nov 2026/);
    press("ArrowRight", "ArrowDown");
    expect(keys()).toMatch(/^Thu 19 Nov 2026/);
    await act(async () => press("Enter"));
    expect(booked(mail)).toEqual([dayAtIn("2026-11-19", "09:00", readerZone()).iso]);
    expect(screen.queryByRole("menu", { name: "Pick a date" })).toBeNull();
  });

  it("goes on past the month's last day into the next month, and Escape books nothing", () => {
    const { mail } = mountReader({ letters: [letter("m1")], open: "m1" });
    openPicker();
    press("ArrowDown", "ArrowDown", "ArrowDown");
    expect(keys()).toMatch(/^Wed 2 Dec 2026/);
    press("PageUp");
    expect(keys()).toMatch(/^Wed 11 Nov 2026/);
    press("Escape");
    expect(mail.mutations).toEqual([]);
  });
});
