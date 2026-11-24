/** @vitest-environment jsdom */
/**
 * A LETTER OR A REPLY WHOSE SEND WAITS CAN BE TAKEN BACK, OVER THE NEW SHELL's DOOR (the switch's point 66, PART B; by
 * RULING-JOIN J-1 what the act does is today's). A send pressed while the letter's first save hangs waits ("Not sent
 * yet."): it is queued, not on the wire. Today's composer kept its Cancel live and withdrew the queued send before
 * anything else; today's reply dock's Cancel did the same and kept the words as one draft. Write's Discard is that
 * press while the send waits: pressable, and its press is the composition's own (the letter's discard, the reply's
 * close), each of which asks the send machine's withdraw first. Nothing of the machine is under test here: what it
 * answers is what the person is told. While the send is on the wire, Discard stays held, as before.
 */
import type { EngineDraft, EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";
import en from "../../messages/en.json";
import { typeInto } from "../fixtures/rich-editor-driver";
import { settleEditor } from "../_first-paint.js";
import { act, message, mountShell, press, stubDom, unmountAll, waitFor, type DraftShell } from "../_draft-shell.js";

const OWNER = "acc-send-waits-discard";

beforeEach(() => {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    /* storage blocked */
  }
  setStorageOwner(OWNER);
  stubDom();
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
});
afterEach(async () => {
  await unmountAll();
  resetStorageOwnerForTest();
});

const sends = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "mail_send");
const saves = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "draft_save");
const unsent = (s: DraftShell): EngineDraft[] =>
  s.store.list<EngineDraft>("draft").filter((d) => d.status === "draft");
const rounds = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
};
/** A verb of a bar, by the bar's name and the verb's. */
const verb = (bar: string, name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(`[role="toolbar"][aria-label="${bar}"]`)]
    .flatMap((t) => [...t.querySelectorAll<HTMLButtonElement>("button")])
    .find((b) => b.getAttribute("aria-label") === name);
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

/**
 * The first save hung at the gate, Send pressed: the send waits behind it ("Not sent yet."), queued and not on the
 * wire. The withdraw will be answered `withdrawn`. Returns the release of the hung save.
 */
async function sendWaits(s: DraftShell, open: () => Promise<void>, send: () => HTMLButtonElement | undefined, queued: string): Promise<() => Promise<void>> {
  let release: () => void = () => {};
  s.saveGate.wait = new Promise<void>((r) => { release = r; });
  await open();
  await waitFor(() => saves(s).length > 0, "the first save on the wire", 200);
  await rounds(8);
  await act(async () => { send()!.click(); });
  await waitFor(() => (document.body.textContent ?? "").includes(queued), "Not sent yet");
  s.withdrawAnswer.outcome = "withdrawn";
  return async () => {
    s.saveGate.wait = null;
    await act(async () => { release(); });
    await rounds(80);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(60);
  };
}

describe("a send that waits can be taken back by Discard", () => {
  it("a letter: Discard is pressable while its send waits, and its press withdraws the send first: nothing goes, nothing is left", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { outboxReplayDeadlineMs: 50 });
    const landed = await sendWaits(s, async () => {
      await key("c");
      await waitFor(() => letterText() != null, "the letter");
      await setInput(document.querySelector<HTMLInputElement>('[role="combobox"][aria-label="To"]')!, "lena@example.invalid, ");
      await setInput(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Subject"]')!, "Waiting letter");
      await act(async () => { typeInto(letterText()! as never, "A letter that waits"); });
      await settleEditor();
    }, () => verb("Send or discard", "Send"), en.compose.statusQueued);
    const discard = verb("Send or discard", "Discard")!;
    expect(discard.disabled, "Discard is held while the send only waits").toBe(false);
    expect(verb("Send or discard", "Send")!.disabled, "Send stays held while its send waits").toBe(true);
    await press(discard, "Discard");
    await rounds(20);
    await landed();
    expect({
      sends: sends(s).length,
      letters: unsent(s).filter((d) => d.subject === "Waiting letter").map((d) => d.body ?? ""),
    }).toEqual({ sends: 0, letters: [] });
  }, 120_000);

  it("a reply, by pointer: Discard is pressable while its send waits, and its press withdraws the send: nothing goes, the words are one draft", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")], [], { outboxReplayDeadlineMs: 50 });
    const row = (): HTMLElement | null => s.el.querySelector<HTMLElement>(`section[aria-label="Messages"] [role=option][data-id='m1']`);
    const landed = await sendWaits(s, async () => {
      await waitFor(() => row() != null, "the row");
      await press(row(), "the row");
      await key("r");
      await waitFor(() => replyText() != null, "the reply editor");
      await act(async () => { typeInto(replyText()!, "Words that wait"); });
    }, () => verb("Actions", "Send"), en.reply.statusQueued);
    const discard = verb("Actions", "Discard")!;
    expect(discard.disabled, "Discard is held while the send only waits").toBe(false);
    await press(discard, "Discard");
    await waitFor(() => replyText() == null, "the reply closed once its send was withdrawn");
    await landed();
    expect({
      sends: sends(s).length,
      rows: unsent(s).filter((d) => d.inReplyToMessageId === "m1").map((d) => d.body ?? ""),
    }).toEqual({ sends: 0, rows: ["Words that wait"] });
  }, 120_000);

  it("CONTROL: while a send is on the wire, Discard stays held", async () => {
    let release: () => void = () => {};
    const sendGate = { wait: new Promise<void>((r) => { release = r; }) as Promise<void> | null };
    const s = await mountShell("#/ohbox", [message("m1")], [], { sendGate });
    await key("c");
    await waitFor(() => letterText() != null, "the letter");
    await setInput(document.querySelector<HTMLInputElement>('[role="combobox"][aria-label="To"]')!, "lena@example.invalid, ");
    await setInput(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Subject"]')!, "On the wire");
    await act(async () => { typeInto(letterText()! as never, "Going now"); });
    await settleEditor();
    await rounds(8);
    await act(async () => { verb("Send or discard", "Send")!.click(); });
    await waitFor(() => sends(s).length === 1, "the send on the wire");
    expect(verb("Send or discard", "Discard")?.disabled ?? true, "Discard pressable while the letter is on the wire").toBe(true);
    sendGate.wait = null;
    await act(async () => { release(); });
    await rounds(20);
  }, 60_000);
});
