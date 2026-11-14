/** @vitest-environment jsdom */
/**
 * A LETTER THAT COULD NOT BE SAVED SAYS SO, OVER THE NEW SHELL's DOOR (the switch's point 68; a person's unsent words;
 * by RULING-JOIN J-1 what the act does is today's). A letter past the save ceiling is in no Drafts: its note says so
 * while it is too long; Escape keeps it open (the composition refuses to close over words nothing holds) and the note
 * then says why it stayed; Discard still lets it go.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRAFT_BODY_MAX_BYTES } from "@trafficflow/core/outbound-text";
import en from "../../messages/en.json";
import { typeInto } from "../fixtures/rich-editor-driver";
import { settleEditor } from "../_first-paint.js";
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
afterEach(unmountAll);

const letter = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="region"][aria-label="New message"]');
const text = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="textbox"][aria-label="Message"]');
/** What the letter says under its text. */
const notes = (): string[] => [...(letter()?.querySelectorAll('[role="status"], [role="alert"]') ?? [])].map((n) => n.textContent ?? "");
const discard = (): HTMLButtonElement | null =>
  [...(letter()?.querySelectorAll<HTMLButtonElement>('[role="toolbar"][aria-label="Send or discard"] button') ?? [])].find(
    (b) => b.getAttribute("aria-label") === "Discard",
  ) ?? null;
const rounds = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
};

describe("a letter past the save ceiling", () => {
  it("says it is not saved; Escape keeps it open and says why; Discard lets it go", async () => {
    await mountShell("#/ohbox", [message("m1")]);
    await act(async () => {
      (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
    });
    await settleEditor();
    await waitFor(() => text() !== null, "the letter");
    await act(async () => { typeInto(text()! as never, "x".repeat(DRAFT_BODY_MAX_BYTES + 16)); });
    await rounds(4);
    expect(notes().some((n) => n.includes("Too long to save")), "the ceiling is not said").toBe(true);
    await act(async () => {
      text()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await rounds(8);
    expect(letter(), "the letter closed over words nothing holds").not.toBeNull();
    expect(notes(), "why it stayed open is not said").toContain(en.compose.closeNotSaved);
    await press(discard(), "Discard");
    await rounds(6);
    expect(letter(), "Discard did not let it go").toBeNull();
  }, 60_000);
});
