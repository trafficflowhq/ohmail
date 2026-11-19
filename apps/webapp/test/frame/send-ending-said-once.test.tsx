/** @vitest-environment jsdom */
/**
 * A SEND THAT ENDS WHILE ITS LETTER IS ON SCREEN IS SAID ONCE, WHERE THE PERSON LOOKS, OVER THE NEW SHELL's DOOR (the
 * switch's point 66, PART B; by RULING-JOIN J-1 what the act does is today's). The one send machine says a send's
 * ending on the line of the letter that shows it, and in the frame's report only where no letter shows it; a letter
 * that shows its send registers its lane while it stands (today's line did: `MailSendApi.showing`). A reply whose
 * send ends Not sent with its editor on screen is said under the editor and NOT again in the frame's report; walked
 * away from, the ending is the report's.
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
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
});
afterEach(unmountAll);

const sends = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "mail_send");
const openRegion = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="region"][aria-label="Open message"]');
const replyBody = (): HTMLElement | null =>
  openRegion()?.querySelector<HTMLElement>('[role="textbox"][aria-label="Reply body"]') ?? null;
const sendButton = (): HTMLButtonElement | undefined =>
  [...(openRegion()?.querySelectorAll<HTMLButtonElement>('[role="toolbar"][aria-label="Actions"] button') ?? [])].find(
    (b) => b.getAttribute("aria-label") === "Send",
  );
/** The reply's own lines, under its editor. */
const replyLines = (): string[] =>
  [...(replyBody()?.closest<HTMLElement>("section[aria-label]")?.querySelectorAll<HTMLElement>('[role="status"]') ?? [])].map(
    (n) => n.textContent ?? "",
  );
/** What the frame says beside the places: its report and its notice slot. */
const frameSays = (): string =>
  [...document.querySelectorAll<HTMLElement>('.fr-report [role="status"], .fr-railnotice [role="status"], .fr-noticebar [role="status"]')]
    .map((n) => n.textContent ?? "")
    .join(" | ");
const row = (el: HTMLElement, id: string): HTMLElement | null =>
  el.querySelector<HTMLElement>(`section[aria-label="Messages"] [role=option][data-id='${id}']`);
const rounds = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
};

async function replyWritten(s: DraftShell, words: string): Promise<void> {
  await waitFor(() => row(s.el, "m1") != null, "the row");
  await press(row(s.el, "m1"), "the row");
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
  });
  await settleEditor();
  await waitFor(() => replyBody() != null, "the reply editor");
  await act(async () => { typeInto(replyBody()!, words); });
}

describe("a reply's send ending while the reply is on screen", () => {
  it("Not sent is said under the editor, and not again in the frame's report", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await replyWritten(s, "See you on Thursday");
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
    await act(async () => { sendButton()!.click(); });
    await waitFor(() => replyLines().includes(en.reply.statusUnreachable), "the line under the editor");
    await rounds(6);
    expect(frameSays(), "the ending said a second time beside the reply that says it").not.toContain(
      en.reply.statusUnreachable,
    );
    expect(sends(s)).toHaveLength(1);
  }, 30_000);
});
