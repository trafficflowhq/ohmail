/** @vitest-environment jsdom */
/**
 * ESCAPE IN THE REPLY's SUBJECT GOES BACK TO ITS TEXT, OVER THE NEW SHELL's DOOR (the switch's point 66, PART B; by
 * RULING-JOIN J-1 what the act does is today's): writing a reply, a person changes its subject and presses Escape to
 * go back to the words: the keys go to the reply's text, and the reply stays open with its subject as changed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { typeInto } from "../fixtures/rich-editor-driver";
import { settleEditor } from "../_first-paint.js";
import { act, message, mountShell, press, stubDom, unmountAll, waitFor, type DraftShell } from "../_draft-shell.js";

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* storage blocked */
  }
  stubDom();
});
afterEach(unmountAll);

const openRegion = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="region"][aria-label="Open message"]');
const replyBody = (): HTMLElement | null =>
  openRegion()?.querySelector<HTMLElement>('[role="textbox"][aria-label="Reply body"]') ?? null;
const subject = (): HTMLInputElement | null =>
  openRegion()?.querySelector<HTMLInputElement>('input[aria-label="Subject"]') ?? null;
const row = (el: HTMLElement, id: string): HTMLElement | null =>
  el.querySelector<HTMLElement>(`section[aria-label="Messages"] [role=option][data-id='${id}']`);

async function replyOpen(s: DraftShell): Promise<void> {
  await waitFor(() => row(s.el, "m1") != null, "the row");
  await press(row(s.el, "m1"), "the row");
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
  });
  await settleEditor();
  await waitFor(() => replyBody() != null, "the reply editor");
  await act(async () => { typeInto(replyBody()!, "Thursday works"); });
}

describe("Escape in the reply's subject", () => {
  it("hands the keys to the reply's text; the reply stays open with its subject as changed", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await replyOpen(s);
    await waitFor(() => subject() != null, "the reply's subject line");
    const field = subject()!;
    await act(async () => {
      field.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, "Re: Thursday instead");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settleEditor();
    /* The editor takes the keys at its next frame, as it does at every focus. */
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(replyBody(), "Escape in the subject closed the reply").not.toBeNull();
    expect(document.activeElement, "the keys stayed in the subject").toBe(replyBody());
    expect(subject()!.value).toBe("Re: Thursday instead");
  }, 30_000);
});
