/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineDraft, EngineMutation } from "@ohmail/client-engine";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import {
  act, message, mountShell, press, replyDraft, replySurface, stubDom, unmountAll, waitFor,
  type DraftShell,
} from "./_draft-shell.js";

/**
 * A REPLY REFUSED FOR GOOD KEEPS ONE DRAFT. The send made a row and the refusal named it, and the
 * inline editor sent the next press without a row, so each press left another copy of one letter
 * in Drafts. The lane now takes the row and sends from it; a reply opened from a draft is sent as
 * that draft (the inline reply is a row since tester round 24).
 * Mutation: the lane's take (`takeLaneRow`) a no-op → the first case red on the second press's row.
 */

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
});
afterEach(unmountAll);

const sends = (s: DraftShell): Array<Extract<EngineMutation, { kind: "mail_send" }>> =>
  s.sent.filter((m): m is Extract<EngineMutation, { kind: "mail_send" }> => m.kind === "mail_send");
const repliesTo = (s: DraftShell, id: string): EngineDraft[] =>
  s.store.list<EngineDraft>("draft").filter((d) => d.inReplyToMessageId === id);
const sendButton = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button")]
    .find((b) => (b.textContent ?? "").startsWith("Send"));

async function key(k: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await settleEditor();
}

/** Press Send and wait for the refusal to be said in the editor. */
async function sendRefused(s: DraftShell, nth: number): Promise<void> {
  const button = sendButton(s.el);
  expect(button, "the reply editor offers no Send").toBeDefined();
  await act(async () => { button!.click(); });
  await waitFor(() => sends(s).length === nth, `send ${nth} on the wire`);
  await waitFor(
    () => sendButton(s.el)?.getAttribute("data-send") == null
      && s.el.querySelector(".reply .send-status.error") != null,
    `send ${nth} said as refused`,
  );
}

describe("a refused reply keeps one draft", () => {
  it("the second press sends the row the first refusal left, and makes no other", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await waitFor(() => s.el.querySelector(".view-ohbox :is(.row, [role=option])[data-id='m1']") != null, "the row");
    await press(s.el.querySelector(".view-ohbox :is(.row, [role=option])[data-id='m1']"), "the row");
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the reply editor");
    await act(async () => { typeInto(replySurface(s.el)!, "See you on Thursday"); });

    s.refuseSend.on = true;
    await sendRefused(s, 1);
    const left = repliesTo(s, "m1");
    expect(left.map((d) => d.id), "the refusal left one row").toHaveLength(1);
    expect(sends(s)[0]!.draftId ?? null, "the first press carried no row").toBeNull();

    await sendRefused(s, 2);
    expect(sends(s)[1]!.draftId, "the second press made a row of its own").toBe(left[0]!.id);
    expect(repliesTo(s, "m1").map((d) => d.id)).toEqual([left[0]!.id]);
    // The refusal is still said where the press was.
    expect(s.el.querySelector(".reply .send-status.error")).not.toBeNull();
  }, 20_000);

  it("a reply opened from a draft is sent as that draft: refused, it stays the one row", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [replyDraft("d1", "m1", "Thursday works")]);
    await waitFor(() => s.el.querySelector(".draft-row[data-id='d1'] .draft-open") != null, "the draft row");
    await press(s.el.querySelector(".draft-row[data-id='d1'] .draft-open"), "the draft's open button");
    await waitFor(() => replySurface(s.el) != null, "the reply editor, seeded");

    s.refuseSend.on = true;
    await sendRefused(s, 1);
    expect(sends(s)[0]!.draftId, "the send made a row beside the draft it was opened from").toBe("d1");
    expect(repliesTo(s, "m1").map((d) => d.id)).toEqual(["d1"]);

    await sendRefused(s, 2);
    expect(sends(s)[1]!.draftId).toBe("d1");
    expect(repliesTo(s, "m1").map((d) => d.id)).toEqual(["d1"]);
  }, 20_000);

  it("a send from that row whose fate is not known is never sent again", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await waitFor(() => s.el.querySelector(".view-ohbox :is(.row, [role=option])[data-id='m1']") != null, "the row");
    await press(s.el.querySelector(".view-ohbox :is(.row, [role=option])[data-id='m1']"), "the row");
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the reply editor");
    await act(async () => { typeInto(replySurface(s.el)!, "See you on Thursday"); });
    s.refuseSend.on = true;
    await sendRefused(s, 1);
    const row = repliesTo(s, "m1")[0]!.id;

    s.refuseSend.unverified = true;
    await act(async () => { sendButton(s.el)!.click(); });
    await waitFor(() => sends(s).length === 2, "the second send on the wire");
    expect(sends(s)[1]!.draftId).toBe(row);
    await waitFor(() => sendButton(s.el)?.getAttribute("data-send") == null, "the second send answered");

    await act(async () => { sendButton(s.el)?.click(); });
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(sends(s), "a send whose delivery is not known went out again").toHaveLength(2);
  }, 20_000);

  it("the row it was sent from is not discarded when that send goes through", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await waitFor(() => s.el.querySelector(".view-ohbox :is(.row, [role=option])[data-id='m1']") != null, "the row");
    await press(s.el.querySelector(".view-ohbox :is(.row, [role=option])[data-id='m1']"), "the row");
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the reply editor");
    await act(async () => { typeInto(replySurface(s.el)!, "See you on Thursday"); });
    s.refuseSend.on = true;
    await sendRefused(s, 1);
    const row = repliesTo(s, "m1")[0]!.id;

    // The row is reopened from Drafts, which seeds the editor from it, and sent for real.
    window.location.hash = "#/drafts";
    await waitFor(() => s.el.querySelector(`.draft-row[data-id='${row}'] .draft-open`) != null, "the row in Drafts");
    await press(s.el.querySelector(`.draft-row[data-id='${row}'] .draft-open`), "the row's open button");
    await waitFor(() => replySurface(s.el) != null, "the reply editor, seeded from the row");
    s.refuseSend.on = false;
    await act(async () => { sendButton(s.el)!.click(); });
    await waitFor(() => sends(s).length === 2, "the second send on the wire");
    await waitFor(() => replySurface(s.el) == null, "the editor closed on the confirmation");

    expect(sends(s)[1]!.draftId).toBe(row);
    expect(s.sent.filter((m) => m.kind === "draft_discard").map((m) => m.draftId)).not.toContain(row);
  }, 20_000);
});
