/** @vitest-environment jsdom */
/**
 * SEND SAYS WHY IT SENDS NOTHING, AND SAYS IT IS AT WORK, OVER THE NEW SHELL's DOOR (the switch's point 66, PART B; by
 * RULING-JOIN J-1 what the act does is today's). With nothing written and nothing attached, Send stays a control a
 * person reaches: pressable, said as off (`aria-disabled`), its hint the reason; its press sends nothing and says the
 * reason under the editor, which goes the moment there is something to send. While the letter goes, Send says it is
 * busy. The reply in the reading column and the letter at the place that writes alike.
 */
import type { EngineDraft, EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncChange } from "@ohmail/client-engine";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";
import en from "../../messages/en.json";
import { typeInto } from "../fixtures/rich-editor-driver";
import { settleEditor } from "../_first-paint.js";
import { act, message, mountShell, press, storeWith, stubDom, unmountAll, waitFor, type DraftShell } from "../_draft-shell.js";

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
  resetStorageOwnerForTest();
});

const sends = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "mail_send");
const rounds = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
};
const verb = (bar: string, name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(`[role="toolbar"][aria-label="${bar}"]`)]
    .flatMap((t) => [...t.querySelectorAll<HTMLButtonElement>("button")])
    .find((b) => b.getAttribute("aria-label") === name);
const statuses = (): string[] => [...document.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? "");
const replyText = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="region"][aria-label="Open message"] [role="textbox"][aria-label="Reply body"]');
const letterText = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="textbox"][aria-label="Message"]');
async function key(k: string): Promise<void> {
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await settleEditor();
}
async function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function openReply(s: DraftShell): Promise<void> {
  const row = (): HTMLElement | null => s.el.querySelector<HTMLElement>(`section[aria-label="Messages"] [role=option][data-id='m1']`);
  await waitFor(() => row() != null, "the row");
  await press(row(), "the row");
  await key("r");
  await waitFor(() => replyText() != null, "the reply editor");
}
async function openLetter(): Promise<void> {
  await key("c");
  await waitFor(() => letterText() != null, "the letter");
  await setInput(document.querySelector<HTMLInputElement>('[role="combobox"][aria-label="To"]')!, "lena@example.invalid, ");
  await setInput(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Subject"]')!, "Nothing yet");
}

/** Send with nothing to send: reached, said off, its hint the reason; pressed, nothing goes and the reason is said. */
async function refusedForWantOfWords(s: DraftShell, send: () => HTMLButtonElement | undefined): Promise<void> {
  const button = send()!;
  expect(
    { disabled: button.disabled, off: button.getAttribute("aria-disabled"), hint: button.getAttribute("title") },
    "Send with nothing to send",
  ).toEqual({ disabled: false, off: "true", hint: en.compose.needContent });
  expect(statuses(), "the reason said before any press").not.toContain(en.compose.needContent);
  await act(async () => { button.click(); });
  await rounds(6);
  expect(sends(s), "a press with nothing to send reached the wire").toHaveLength(0);
  expect(statuses(), "the press is told why").toContain(en.compose.needContent);
}

describe("Send with nothing to send, and Send at work", () => {
  it("the reply: Send is pressable and says why it sends nothing; the reason goes once there are words", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await openReply(s);
    await rounds(4);
    await refusedForWantOfWords(s, () => verb("Actions", "Send"));
    await act(async () => { typeInto(replyText()!, "Now there are words"); });
    await rounds(4);
    expect(statuses()).not.toContain(en.compose.needContent);
    expect(verb("Actions", "Send")!.getAttribute("aria-disabled")).toBeNull();
  }, 60_000);

  it("the letter: Send is pressable and says why it sends nothing; the reason goes once there are words", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await openLetter();
    await rounds(4);
    await refusedForWantOfWords(s, () => verb("Send or discard", "Send"));
    await act(async () => { typeInto(letterText()! as never, "Now there are words"); });
    await settleEditor();
    await rounds(4);
    expect(statuses()).not.toContain(en.compose.needContent);
    expect(verb("Send or discard", "Send")!.getAttribute("aria-disabled")).toBeNull();
  }, 60_000);

  it("the reply: while it goes, Send is held and says it is busy", async () => {
    let release: () => void = () => {};
    const sendGate = { wait: new Promise<void>((r) => { release = r; }) as Promise<void> | null };
    const s = await mountShell("#/ohbox", [message("m1")], [], { sendGate });
    await openReply(s);
    await act(async () => { typeInto(replyText()!, "Going"); });
    await rounds(8);
    await act(async () => { verb("Actions", "Send")!.click(); });
    await waitFor(() => sends(s).length === 1, "the send on the wire");
    const button = verb("Actions", "Send");
    expect({ disabled: button?.disabled, busy: button?.getAttribute("aria-busy") }).toEqual({ disabled: true, busy: "true" });
    sendGate.wait = null;
    await act(async () => { release(); });
    await rounds(20);
  }, 60_000);

  it("the letter: while it goes, Send is held and says it is busy", async () => {
    let release: () => void = () => {};
    const sendGate = { wait: new Promise<void>((r) => { release = r; }) as Promise<void> | null };
    const s = await mountShell("#/ohbox", [message("m1")], [], { sendGate });
    await openLetter();
    await act(async () => { typeInto(letterText()! as never, "Going"); });
    await settleEditor();
    await rounds(8);
    await act(async () => { verb("Send or discard", "Send")!.click(); });
    await waitFor(() => sends(s).length === 1, "the send on the wire");
    const button = verb("Send or discard", "Send");
    expect({ disabled: button?.disabled, busy: button?.getAttribute("aria-busy") }).toEqual({ disabled: true, busy: "true" });
    sendGate.wait = null;
    await act(async () => { release(); });
    await rounds(20);
  }, 60_000);
});

describe("replying again to the same letter", () => {
  async function sendReply(s: DraftShell): Promise<void> {
    await openReply(s);
    await act(async () => { typeInto(replyText()!, "See you on Thursday"); });
    await act(async () => { verb("Actions", "Send")!.click(); });
    await waitFor(() => replyText() === null, "the reply handed off");
  }

  async function reopen(): Promise<void> {
    await key("r");
    await waitFor(() => replyText() !== null, "the next reply");
  }

  it("opens a fresh reply after confirmation and holds a later attempt on the same draft", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await sendReply(s);
    await waitFor(() => statuses().some((line) => line.includes(en.sendingLine.sent)), "confirmation");
    await reopen();
    expect(replyText()!.textContent).toBe("");
    expect(statuses().some((line) => line.includes(en.write.status.unverified))).toBe(false);
    await act(async () => { typeInto(replyText()!, "And Friday too"); });
    expect(verb("Actions", "Send")!.getAttribute("aria-disabled")).toBeNull();
    const row = s.store.list<EngineDraft>("draft").find((d) => d.status === "sending")!;
    // The server reports a later attempt, even when the draft id and its words are identical.
    await s.editElsewhere(row.id, { status: "sending" });
    await act(async () => { await s.engine.syncOnce(); });
    expect(statuses().some((line) => line.includes(en.write.status.unverified))).toBe(true);
    expect(sends(s)).toHaveLength(1);
  }, 60_000);

  it("keeps a reply held when the delivery answer is lost", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    s.loseSendAnswer.on = true;
    await sendReply(s);
    await waitFor(() => sends(s).length === 1, "the send reached the server");
    await reopen();
    await waitFor(() => statuses().some((line) => line === en.write.status.queued || line === en.write.status.unverified), "the unresolved send");
    expect(verb("Actions", "Send")?.disabled).toBe(true);
    expect(sends(s)).toHaveLength(1);
  }, 60_000);

  it("opens a fresh reply after the settled reservation answers a lost response", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    s.loseSendAnswer.on = true;
    s.syncHeld.on = true;
    await sendReply(s);
    await waitFor(() => s.engine.waitingSends().some((entry) => !entry.wire), "the unresolved send");
    s.loseSendAnswer.on = false;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => statuses().some((line) => line.includes(en.sendingLine.sent)), "confirmation from the original reservation");
    await reopen();
    expect(statuses().some((line) => line.includes(en.write.status.unverified))).toBe(false);
    expect(sends(s)).toHaveLength(2);
  }, 60_000);

  it("holds a different draft on the same letter and the same draft id in another account", async () => {
    setStorageOwner("account-one");
    const a = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await sendReply(a);
    await waitFor(() => statuses().some((line) => line.includes(en.sendingLine.sent)), "confirmation");
    const confirmed = a.store.entries<EngineDraft>("draft").find((d) => d.entity.status === "sending")!;
    // Both rows carry the same words, parent and change sequence as the confirmed one.
    const waiting = (id: string): SyncChange => ({
      type: "draft", op: "update", id, seq: confirmed.seq, updatedAt: confirmed.entity.updatedAt,
      entity: { ...confirmed.entity, id },
    } as SyncChange);
    await act(async () => {
      await a.store.applyChanges([waiting("other-draft")]);
      await a.engine.syncOnce();
    });
    await reopen();
    expect(statuses().some((line) => line.includes(en.write.status.unverified))).toBe(true);
    expect(sends(a)).toHaveLength(1);
    await unmountAll();

    setStorageOwner("account-two");
    const store = await storeWith([message("m1")], []);
    await store.applyChanges([waiting(confirmed.id)]);
    const b = await mountShell("#/ohbox", [], [], { store });
    await openReply(b);
    expect(statuses().some((line) => line.includes(en.write.status.unverified))).toBe(true);
    expect(sends(b)).toHaveLength(0);
  }, 60_000);
});
