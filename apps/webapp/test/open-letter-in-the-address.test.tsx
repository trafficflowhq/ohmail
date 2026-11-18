/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, message, mountShell, press, stubDom, unmountAll, waitFor } from "./_draft-shell.js";

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

const columnSubject = (el: HTMLElement, view: string): string =>
  el.querySelector(`.view-${view} .read-col .msg .msg-subject`)?.textContent ?? "";

async function openInColumn(el: HTMLElement, view: string, id: string): Promise<void> {
  await waitFor(() => el.querySelector(`.view-${view} .row[data-id='${id}']`) != null, `${id} listed in ${view}`);
  await press(el.querySelector(`.view-${view} .row[data-id='${id}']`), `${id}'s row`);
}

describe("the letter a column view opens is the address's", () => {
  it("History: the open letter is named, a reload reopens it, and Back closes it", async () => {
    const s = await mountShell("#/history", THREE);
    await waitFor(() => columnSubject(s.el, "history") === "Subject m1", "the first letter shown");

    await openInColumn(s.el, "history", "m2");
    await waitFor(() => window.location.hash === "#/history/m/m2", "the address naming the letter");
    expect(columnSubject(s.el, "history")).toBe("Subject m2");

    await unmountAll();
    stubDom();
    const again = await mountShell(window.location.hash, THREE);
    await waitFor(() => columnSubject(again.el, "history") === "Subject m2", "the same letter after a reload");
    expect(window.location.hash).toBe("#/history/m/m2");
    expect(again.el.querySelector(".reader .msg"), "reopened in the reader over the column").toBeNull();

    // Back: the claim dropped in place closes the letter.
    await act(async () => { window.location.hash = "#/history"; });
    await waitFor(() => columnSubject(again.el, "history") === "Subject m1", "the letter closed");
    expect(window.location.hash).toBe("#/history");
  }, 30_000);

  it("Answer Later: the open letter is named, and a reload reopens it", async () => {
    const pile = [answerLater("a1", 8), answerLater("a2", 7)];
    const s = await mountShell("#/triage", pile);
    await openInColumn(s.el, "triage", "a2");
    await waitFor(() => window.location.hash === "#/triage/m/a2", "the address naming the letter");

    await unmountAll();
    stubDom();
    const again = await mountShell(window.location.hash, pile);
    await waitFor(() => columnSubject(again.el, "triage") === "Subject a2", "the same letter after a reload");
    expect(window.location.hash).toBe("#/triage/m/a2");
  }, 30_000);
});
