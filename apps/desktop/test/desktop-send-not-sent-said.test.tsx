/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineMutation } from "@ohmail/client-engine";
import en from "../../webapp/messages/en.json";
import { typeInto } from "../../webapp/test/fixtures/rich-editor-driver";
import { settleEditor } from "../../webapp/test/_first-paint.js";
import {
  act, message, mountShell, press, replySurface, stubDom, unmountAll, waitFor, type DraftShell,
} from "../../webapp/test/_draft-shell.js";

/**
 * A REPLY THAT ENDS NOT SENT AFTER THE READER MOVED ON IS SAID. The desktop's mail
 * server was unreachable: the send was retried twice under its key, then refused for good, and the
 * reply became a draft with nothing on screen saying so. Now the ending is a toast with the way
 * back; nothing resends it on its own (a send needs a press).
 * Mutation: `onSendOutcome`'s unshown arm removed → the first case red on the toast.
 */

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
});
afterEach(unmountAll);

const sends = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "mail_send");
const sendButton = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button")]
    .find((b) => (b.textContent ?? "").startsWith("Send"));
const held = (): HTMLElement | null => document.querySelector<HTMLElement>(".toast-held");
const online = async (): Promise<void> => { await act(async () => { window.dispatchEvent(new Event("online")); }); };
const rounds = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
};

async function key(k: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await settleEditor();
}

async function replyWritten(s: DraftShell, words: string): Promise<void> {
  await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "the row");
  await press(s.el.querySelector(".view-ohbox .row[data-id='m1']"), "the row");
  await key("r");
  await waitFor(() => replySurface(s.el) != null, "the reply editor");
  await act(async () => { typeInto(replySurface(s.el)!, words); });
}

describe("desktop: a send that ends Not sent off screen", () => {
  it("is said with Open, Open brings the words back with Send live, and nothing resends it", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    await replyWritten(s, "See you on Thursday");
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424, retryableFirst: 2 });
    await act(async () => { sendButton(s.el)!.click(); });
    await waitFor(() => sends(s).length === 1, "the send on the wire");

    // The reader moves on, as a person does after pressing Send.
    await press(s.el.querySelector(".view-ohbox .row[data-id='m2']"), "the next row");
    await waitFor(() => replySurface(s.el) == null, "the reply editor off screen");
    await online();
    await waitFor(() => sends(s).length === 2, "the second try");
    await online();
    await waitFor(() => sends(s).length === 3, "the third try");

    await waitFor(() => (held()?.textContent ?? "").includes(en.reply.statusUnreachable), "the Not sent toast");
    const open = held()!.querySelector<HTMLButtonElement>(".toast-act");
    expect(open?.textContent, "the toast offers no way back").toBe(en.reply.notSentOpen);

    s.refuseSend.on = false;
    await press(open!, "Open");
    await waitFor(() => replySurface(s.el) != null, "the reply editor back on screen");
    expect(replySurface(s.el)!.textContent).toContain("See you on Thursday");
    expect(sendButton(s.el)?.disabled, "Send is not live").toBe(false);

    // The server answers again: nothing goes without a press.
    const before = sends(s).length;
    await online();
    await rounds(8);
    expect(sends(s).length, "a send went out with no press").toBe(before);
  }, 30_000);

  it("control: with the editor on screen the line is said in place, and no toast", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await replyWritten(s, "See you on Thursday");
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
    await act(async () => { sendButton(s.el)!.click(); });
    await waitFor(() => (s.el.querySelector(".reply .send-status.error")?.textContent ?? "") === en.reply.statusUnreachable,
      "the line under the editor");
    await rounds(4);
    expect(held(), "a toast stood beside the line").toBeNull();
  }, 30_000);
});
