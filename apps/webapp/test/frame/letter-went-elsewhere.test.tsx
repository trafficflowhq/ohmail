/** @vitest-environment jsdom */
/**
 * A LETTER OPEN HERE THAT ANOTHER DEVICE SENT OR CHANGED SAYS SO, OVER THE NEW SHELL's DOOR (the switch's point 72; by
 * RULING-JOIN J-1 what the act does is today's). The letter is written here and its pause saves it to the server; device
 * B then sends that row, or saves other words over it. The letter's note says what happened, in today's sentences;
 * Send sends nothing over a letter that already went: it is said as off, its hint the reason, its press says why, and
 * where today's offered it ("Send as a new letter": a changed letter, or words typed since), the offer's press is the
 * composition's own send, which sends the words on screen as a letter of their own and never the row that went.
 */
import type { EngineDraft, EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { AUTOSAVE_DELAY_MS } from "@ohmail/app-logic/writing/compose-autosave";
import { typeInto } from "../fixtures/rich-editor-driver";
import { settleEditor } from "../_first-paint.js";
import { act, DraftServer, message, mountShell, stubDom, unmountAll, waitFor, type DraftShell } from "../_draft-shell.js";

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

type Send = EngineMutation & { draftId?: string | null; subject?: string };
const sends = (s: DraftShell): Send[] => s.sent.filter((m) => m.kind === "mail_send") as Send[];
const pause = async (ms: number): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
};
const said = (): string[] =>
  [...document.querySelectorAll('[role="status"], [role="alert"]')].map((n) => (n.textContent ?? "").trim());
const saysAny = (sentence: string): boolean => said().some((line) => line.includes(sentence));
const sendVerb = (): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="toolbar"][aria-label="Send or discard"] button')].find(
    (b) => b.getAttribute("aria-label") === "Send",
  );
const offer = (): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim() === en.compose.sendAsNew);
const letterText = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="textbox"][aria-label="Message"]');
const subjectField = (): HTMLTextAreaElement | HTMLInputElement =>
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Subject"], input[aria-label="Subject"]')!;

async function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function key(k: string): Promise<void> {
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await settleEditor();
}

/** A writes a letter at the place that writes, and its pause saves it to the server: the row is returned. */
async function written(): Promise<{ s: DraftShell; server: DraftServer; row: EngineDraft }> {
  const server = new DraftServer();
  const s = await mountShell("#/ohbox", [message("m1")], [], { server });
  await key("c");
  await waitFor(() => letterText() != null, "the letter");
  await setInput(document.querySelector<HTMLInputElement>('[role="combobox"][aria-label="To"]')!, "lena@example.invalid, ");
  await setInput(subjectField(), "Plans for Friday");
  await act(async () => { typeInto(letterText()! as never, "Shall we meet at noon?"); });
  await settleEditor();
  await pause(AUTOSAVE_DELAY_MS + 400);
  await waitFor(() => server.rows.size === 1, "the letter saved to the server");
  return { s, server, row: [...server.rows.values()][0]! };
}

/** B, another device, acts on the row; A's next drain brings it. */
async function onB(s: DraftShell, server: DraftServer, m: EngineMutation): Promise<void> {
  const b = await server.device();
  const r = await b.mutate(m);
  expect(r.status, "premise: B's act went").toBe("confirmed");
  await act(async () => { await s.engine.syncOnce().catch(() => undefined); });
  await pause(300);
}
const sendOnB = (server: DraftServer, row: EngineDraft): EngineMutation => {
  const held = server.rows.get(row.id)!;
  return {
    kind: "mail_send", inReplyTo: null, draftId: row.id, mailboxId: "mb1", subject: held.subject, body: held.body ?? "",
    to: held.to, cc: [], bcc: [],
  } as EngineMutation;
};

/** Send over a letter that went: said as off with the reason, pressed it sends nothing and says why. */
async function sendRestsAndSays(s: DraftShell, row: EngineDraft, sentence: string): Promise<void> {
  const button = sendVerb()!;
  expect(
    { disabled: button.disabled, off: button.getAttribute("aria-disabled"), hint: button.getAttribute("title") },
    "Send over a letter that went elsewhere",
  ).toEqual({ disabled: false, off: "true", hint: sentence });
  const before = sends(s).length;
  await act(async () => { button.click(); });
  await pause(200);
  expect(sends(s).slice(before).filter((m) => m.draftId === row.id), "the row that went was sent again").toHaveLength(0);
  expect(sends(s).length - before, "a press over a letter that went reached the wire").toBe(0);
  expect(saysAny(sentence), "the press is told why").toBe(true);
}

describe("a letter open here that another device sent or changed", () => {
  it("sent on B, nothing typed since: the note says so, and Send says it already went and offers nothing", async () => {
    const { s, server, row } = await written();
    await onB(s, server, sendOnB(server, row));
    await waitFor(() => saysAny(en.compose.sentElsewhere), "the note");
    expect(saysAny(en.compose.draftNotSaved), "a save refusal said over a letter that went").toBe(false);
    await sendRestsAndSays(s, row, en.compose.sentElsewhereSend);
    expect(offer(), "an unchanged sent letter offered again").toBeUndefined();
  }, 60_000);

  it("sent on B, words typed after the note: Send says why and offers the words as a new letter, which sends them alone", async () => {
    const { s, server, row } = await written();
    await onB(s, server, sendOnB(server, row));
    await waitFor(() => saysAny(en.compose.sentElsewhere), "the note");
    await setInput(subjectField(), "Plans for Friday, and Saturday");
    await pause(100);
    await sendRestsAndSays(s, row, en.compose.sentElsewhereSend);
    expect(offer(), "no offer to send the words as a new letter").toBeDefined();
    await act(async () => { offer()!.click(); });
    await waitFor(() => sends(s).length > 0, "the new letter on the wire");
    const m = sends(s)[0]!;
    expect({ row: m.draftId === row.id ? "the row that went" : "a row of its own", subject: m.subject }).toEqual({
      row: "a row of its own",
      subject: "Plans for Friday, and Saturday",
    });
  }, 60_000);

  it("changed on B, then typed here: the note says the words here are kept as a new draft, and Send offers them as a new letter", async () => {
    const { s, server, row } = await written();
    await onB(s, server, {
      kind: "draft_save", draftId: row.id, mailboxId: "mb1", subject: "Plans for Friday", body: "Their words.", html: null,
      to: row.to, cc: [], bcc: [],
    } as EngineMutation);
    await act(async () => { typeInto(letterText()! as never, " And mine."); });
    await settleEditor();
    await pause(AUTOSAVE_DELAY_MS + 600);
    await waitFor(() => saysAny(en.compose.changedElsewhere) || saysAny(en.compose.changedElsewhereUnsaved), "the note");
    await sendRestsAndSays(s, row, en.compose.changedElsewhereSend);
    expect(offer(), "no offer to send the words as a new letter").toBeDefined();
    expect(server.rows.get(row.id)?.body, "B's words were overwritten").toBe("Their words.");
  }, 60_000);
});
