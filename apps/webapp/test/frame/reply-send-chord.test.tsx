/** @vitest-environment jsdom */
/**
 * THE SEND CHORD FROM A REPLY's OR A FORWARD's PEOPLE, OVER THE NEW SHELL's DOOR (the switch's point 68; by
 * RULING-JOIN J-1 what the act does is today's). Today's shell bound Mod+Enter to the composition's own `sendReply`
 * wherever the keys were while a reply stood: pressed in a forward's To line with nobody named, the composition said
 * why ("Add a recipient in To to forward this message.") and sent nothing; pressed in a reply's subject with a person
 * and words, it sent the reply once. The reply binds its keys as the letter does, while the reading column has them.
 */
import type { EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import en from "../../messages/en.json";
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

const sends = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "mail_send");
const openRegion = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="region"][aria-label="Open message"]');
const replyBody = (): HTMLElement | null =>
  openRegion()?.querySelector<HTMLElement>('[role="textbox"][aria-label="Reply body"]') ?? null;
const forwardText = (): HTMLElement | null =>
  openRegion()?.querySelector<HTMLElement>(`[role="textbox"][aria-label="${en.write.reply.forwardText}"]`) ?? null;
const subject = (): HTMLInputElement | null =>
  openRegion()?.querySelector<HTMLInputElement>('input[aria-label="Subject"]') ?? null;
const forwardTo = (): HTMLElement | null =>
  openRegion()?.querySelector<HTMLElement>('[role="combobox"][aria-label="To"]') ?? null;
const row = (el: HTMLElement, id: string): HTMLElement | null =>
  el.querySelector<HTMLElement>(`section[aria-label="Messages"] [role=option][data-id='${id}']`);
const rounds = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
};

async function onLetter(s: DraftShell, k: string, init: KeyboardEventInit = {}): Promise<void> {
  await waitFor(() => row(s.el, "m1") != null, "the row");
  await press(row(s.el, "m1"), "the row");
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settleEditor();
}

/** Mod+Enter pressed where the keys are (a key on the page itself reaches no field). */
async function chord(at: HTMLElement): Promise<void> {
  await act(async () => {
    at.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await settleEditor();
}

describe("the send chord from a reply's people", () => {
  it("a forward with nobody in To: Ctrl+Enter in To says why and sends nothing; the forward stays", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await onLetter(s, "F", { shiftKey: true });
    await waitFor(() => forwardText() != null, "the forward");
    await waitFor(() => forwardTo() != null, "the forward's To line");
    await act(async () => { typeInto(forwardText()!, "For your files"); });
    await rounds(4);
    const to = forwardTo()!;
    to.focus();
    await chord(to);
    await waitFor(
      () => (document.body.textContent ?? "").includes(en.compose.needRecipient),
      "Ctrl+Enter with nobody in To said nothing",
    );
    await rounds(8);
    expect(sends(s), "a forward to nobody reached the wire").toHaveLength(0);
    expect(forwardText(), "the refused chord closed the forward").not.toBeNull();
  }, 60_000);

  it("a reply with a person and words: Ctrl+Enter in its subject sends it once", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await onLetter(s, "r");
    await waitFor(() => replyBody() != null, "the reply editor");
    await act(async () => { typeInto(replyBody()!, "Thursday works"); });
    await rounds(4);
    await waitFor(() => subject() != null, "the reply's subject line");
    const field = subject()!;
    field.focus();
    await chord(field);
    await waitFor(() => sends(s).length > 0, "Ctrl+Enter in the subject sent nothing");
    await rounds(20);
    expect(sends(s)).toHaveLength(1);
  }, 60_000);
});
