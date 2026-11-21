/** @vitest-environment jsdom */
/**
 * THE CHANGES THAT HAVE NOT GONE THROUGH, OVER THE NEW SHELL's DOOR (the switch's point 66). A change made
 * while the account cannot be reached waits on the queue; the frame's notice says how many with "Show them", which
 * opens their list over the app: each row says what it was and why it waits, with Try again and Discard. Discard
 * withdraws it, so it is never sent, and the notice leaves with the last row; Try again once the account answers
 * sends it, once.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { act, message, mountShell, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

const S = en.sync;
const button = (name: string, within: ParentNode = document): HTMLButtonElement | null =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name) ?? null;
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');
const rows = (): HTMLElement[] => [...(dialog()?.querySelectorAll<HTMLElement>('[role="listitem"]') ?? [])];
const said = (text: string): boolean => (document.body.textContent ?? "").includes(text);
const settle = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
});
afterEach(async () => {
  await unmountAll();
});

/** The door with one letter, a mark read made while the account cannot be reached, waiting on the queue. */
async function waitingChange() {
  const s = await mountShell("#/ohbox", [message("m1", { seen: false } as never)], []);
  s.offline.on = true;
  await act(async () => {
    await (s.engine as unknown as { mutate(m: unknown): Promise<unknown> })
      .mutate({ kind: "mark_seen", messageIds: ["m1"], unread: false });
  });
  await waitFor(() => said("1 change has not gone through yet"), "the unsaved notice");
  return s;
}

describe("the changes that have not gone through, in the new shell", () => {
  it("the notice offers Show them, which lists the change with what it was, why it waits, Try again and Discard", async () => {
    await waitingChange();
    expect(button(S.unsavedShow), "Show them").not.toBeNull();
    expect(dialog()).toBeNull();
    await act(async () => { button(S.unsavedShow)!.click(); });
    await waitFor(() => rows().length === 1, "the list over the app");
    const row = rows()[0]!;
    expect(row.textContent).toContain(S.unsavedKindRead);
    expect(row.textContent).toContain(S.unsavedQueuedWhy);
    expect(button(S.unsavedRetry, row)).not.toBeNull();
    expect(button(S.unsavedDiscard, row)).not.toBeNull();
  }, 30_000);

  it("Discard withdraws the change, so it is never sent, and the notice leaves with it", async () => {
    const s = await waitingChange();
    await act(async () => { button(S.unsavedShow)!.click(); });
    await waitFor(() => rows().length === 1, "the list");
    await act(async () => { button(S.unsavedDiscard, rows()[0]!)!.click(); });
    await settle();
    expect(dialog()).toBeNull();
    expect(said("has not gone through")).toBe(false);
    s.offline.on = false;
    await settle(20);
    expect(s.sent.filter((m) => m.kind === "mark_seen")).toEqual([]);
  }, 30_000);

  it("Try again once the account answers sends the change once, and the list empties", async () => {
    const s = await waitingChange();
    await act(async () => { button(S.unsavedShow)!.click(); });
    await waitFor(() => rows().length === 1, "the list");
    s.offline.on = false;
    await act(async () => { button(S.unsavedRetry, rows()[0]!)!.click(); });
    await waitFor(() => !said("has not gone through"), "the change went through");
    expect(s.sent.filter((m) => m.kind === "mark_seen")).toHaveLength(1);
    expect(dialog()).toBeNull();
  }, 30_000);
});
