/** @vitest-environment jsdom */
/**
 * A NEW LETTER HOLDING ONLY A FILE IS OFFERED BACK AFTER ITS DISCARD, OVER THE NEW SHELL's DOOR (the switch's point 66,
 * PART B; by RULING-JOIN J-1 what the act does is today's). Today's composer asked before throwing away a letter that
 * held only a file ("the files are a loss the question must name"); Write's Discard asks nothing and offers Undo
 * instead (Write's own ruling), so a letter whose only content is a file is offered back like one with words, and Undo
 * puts the file back on it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { settleEditor, settleFirstPaint } from "../_first-paint.js";
import { act, message, mountShell, press, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

beforeEach(() => {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    /* storage blocked */
  }
  stubDom();
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
});
afterEach(async () => {
  await unmountAll();
});

const letter = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="region"][aria-label="New message"]');
const discard = (): HTMLButtonElement | null =>
  [...(letter()?.querySelectorAll<HTMLButtonElement>('[role="toolbar"][aria-label="Send or discard"] button') ?? [])].find(
    (b) => b.getAttribute("aria-label") === "Discard",
  ) ?? null;
/** The frame's report, and its Undo. */
const reportUndo = (): HTMLButtonElement | null =>
  [...document.querySelectorAll<HTMLButtonElement>(".fr-report button")].find(
    (b) => b.textContent?.trim() === en.ohbox.undo,
  ) ?? null;
const tile = (): HTMLButtonElement | null =>
  letter()?.querySelector<HTMLButtonElement>('button[aria-label="Remove notes.txt"]') ?? null;
const drain = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

async function newLetterWithOnlyAFile(): Promise<void> {
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
  });
  await settleEditor();
  await waitFor(() => letter() !== null, "the letter");
  const input = letter()!.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([new Uint8Array(2048)], "notes.txt", { type: "text/plain" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await drain(8);
  expect(tile(), "the file never attached").not.toBeNull();
}

describe("a new letter holding only a file, discarded", () => {
  it("is said discarded with Undo, and Undo puts the letter back with its file", async () => {
    await mountShell("#/ohbox", [message("m1")]);
    await newLetterWithOnlyAFile();
    await press(discard(), "Discard");
    await drain(6);
    const undo = reportUndo();
    expect(undo, "a letter holding only a file was thrown away with nothing offered back").not.toBeNull();
    expect(document.querySelector(".fr-report")?.textContent ?? "").toContain(en.compose.toastDiscard);
    await press(undo, "Undo");
    await settleFirstPaint();
    await drain(6);
    await waitFor(() => letter() !== null, "the letter back");
    expect(tile(), "Undo brought the letter back without its file").not.toBeNull();
  }, 60_000);

  it("CONTROL: an empty letter's discard offers nothing back", async () => {
    await mountShell("#/ohbox", [message("m1")]);
    await act(async () => {
      (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
    });
    await settleEditor();
    await waitFor(() => letter() !== null, "the letter");
    await press(discard(), "Discard");
    await drain(6);
    expect(reportUndo()).toBeNull();
  }, 60_000);
});
