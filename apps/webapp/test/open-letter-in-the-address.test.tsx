/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, message, mountShell, press, stubDom, unmountAll, waitFor } from "./_draft-shell.js";
import { ohboxRow, openSubject, readingColumn } from "./ohbox/_finders.js";

/**
 * A LETTER OPENED OUTSIDE THE OHBOX IS IN THE ADDRESS. History, Answer Later, Trash, folders and
 * tags read in a column of their own, whose pick the bar never saw: the address kept the view's
 * bare route, a reload opened the view's first letter, and Back left the view instead of the
 * letter. The column's pick is reported now, the bar claims it, and the claim restores it.
 * Mutation: the pick arm of the bar's `openOnScreen` removed → every case red on the address.
 */

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
});
afterEach(unmountAll);

const dated = (id: string, hour: number, over: Partial<EngineMessage> = {}): EngineMessage =>
  message(id, { date: `2026-09-27T0${hour}:00:00.000Z`, updatedAt: `2026-09-27T0${hour}:00:00.000Z`, ...over });
const THREE = [dated("m1", 8), dated("m2", 7), dated("m3", 6)];
const answerLater = (id: string, hour: number): EngineMessage => dated(id, hour, {
  triage: {
    state: "reply_later", bubbleUpAt: null,
    setAt: "2026-09-27T08:30:00.000Z", updatedAt: "2026-09-27T08:30:00.000Z",
  },
} as Partial<EngineMessage>);

async function openInColumn(el: HTMLElement, view: string, id: string): Promise<void> {
  await waitFor(() => ohboxRow(el, id) !== null, `${id} listed in ${view}`);
  await press(ohboxRow(el, id), `${id}'s row`);
}

describe("the letter a column view opens is the address's", () => {
  it("History: the open letter is named, a reload reopens it, and Back closes it", async () => {
    const s = await mountShell("#/history", THREE);
    await waitFor(() => openSubject(s.el) === "Subject m1", "the first letter shown");
    const firstAddress = window.location.hash;

    await openInColumn(s.el, "history", "m2");
    await waitFor(() => window.location.hash === "#/history/m/m2", "the address naming the letter");
    expect(openSubject(s.el)).toBe("Subject m2");

    await unmountAll();
    stubDom();
    const again = await mountShell(window.location.hash, THREE);
    await waitFor(() => openSubject(again.el) === "Subject m2", "the same letter after a reload");
    expect(window.location.hash).toBe("#/history/m/m2");
    expect(readingColumn(again.el)?.textContent).toContain("Subject m2");
    expect(again.el.querySelector('[role="dialog"][aria-label="Reading"]')).toBeNull();

    await act(async () => { window.history.back(); });
    await waitFor(() => openSubject(again.el) === "Subject m1", "Back restored the first letter");
    expect(window.location.hash).toBe(firstAddress);
  }, 30_000);

  it("Answer Later: the open letter is named, and a reload reopens it", async () => {
    const pile = [answerLater("a1", 8), answerLater("a2", 7)];
    const s = await mountShell("#/triage", pile);
    await openInColumn(s.el, "triage", "a2");
    await waitFor(() => window.location.hash === "#/triage/m/a2", "the address naming the letter");

    await unmountAll();
    stubDom();
    const again = await mountShell(window.location.hash, pile);
    await waitFor(() => openSubject(again.el) === "Subject a2", "the same letter after a reload");
    expect(window.location.hash).toBe("#/triage/m/a2");
  }, 30_000);
});
