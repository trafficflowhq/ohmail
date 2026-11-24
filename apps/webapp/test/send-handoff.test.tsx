/** @vitest-environment jsdom */
import type { EmailAddress, EngineDraft, EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftsList } from "@ohmail/client-engine";
import en from "../messages/en.json";
import { letter as editor, letterSubject } from "./_writing-shell.js";
import { composeSend, composerOn, footButton, footLine as readFootLine, noticeRows, slotNotices, toasts } from "./_handoff-steps.js";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import { AUTOSAVE_DELAY_MS } from "@ohmail/app-logic/writing/compose-autosave";
import { SENT_COPY_NOTES_PREFIX, SENT_LINE_MS } from "@ohmail/app-logic/writing/mail-send";
import {
  act, DraftServer, message, mountShell, NOW, press, stubDom, unmountAll, waitFor, type DraftShell,
} from "./_draft-shell.js";

/**
 * SEND LEAVES ITS EDITOR AT ONCE WHEN THE CONNECTION IS HEALTHY (owner, 2026-10-23: "move the
 * sending to the bottom left and complete the sending visually there"). The compose and the reply
 * dock close the moment the send is on disk; the sidebar's foot says "Sending to Mila…", then
 * "Sent", then nothing; no toast says it twice. A refusal stands there with Open, which brings
 * the words back. Unhealthy, the editor stays and says why, as before.
 */

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  setOnline(true);
});
afterEach(async () => {
  setOnline(true);
  await unmountAll();
});

function setOnline(on: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on });
}

const sends = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "mail_send");

/*
 * THE NEW SHELL's PARTS, by role and name. The sidebar's foot line is the frame's one notice slot (the rail's foot
 * from a desk's width, the bar over the list on a phone's), each line of a send one notice there, read with the
 * notices behind it ("N more"), its acts by name; a toast is the frame's report. The open letter is the region
 * "Open message": the reply's words the textbox "Reply body" (a forward's "Forward body"), its verbs the toolbar
 * "Actions", the line under the editor its status paragraph, the recipients the groups "To", "Cc" and "Bcc".
 * The letters are opened at the Ohbox: History is not mounted yet, and what these cases state is the send's.
 */
const footLine = (): string => readFootLine(false);
const footAct = (label: string): HTMLButtonElement | undefined => footButton(label) ?? undefined;
const openRegion = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="region"][aria-label="Open message"]');
const replySurface = (_el?: HTMLElement): HTMLElement | null =>
  openRegion()?.querySelector<HTMLElement>('[role="textbox"][aria-label="Reply body"], [role="textbox"][aria-label="Forward body"]') ?? null;
const actionNamed = (name: string): HTMLButtonElement | undefined =>
  [...(openRegion()?.querySelectorAll<HTMLButtonElement>('[role="toolbar"][aria-label="Actions"] button') ?? [])]
    .find((b) => b.getAttribute("aria-label") === name);
/** The line under the reply's editor. */
const lineUnder = (): HTMLElement | null => openRegion()?.querySelector<HTMLElement>('p[role="status"]') ?? null;
const row = (el: HTMLElement, id: string): HTMLElement | null =>
  el.querySelector<HTMLElement>(`section[aria-label="Messages"] [role=option][data-id='${id}']`);
const replySend = (_el?: HTMLElement): HTMLButtonElement | undefined => actionNamed("Send");
const gate = (s: DraftShell): (() => void) => {
  let release!: () => void;
  s.sendGate.wait = new Promise<void>((r) => { release = r; });
  return () => { s.sendGate.wait = null; release(); };
};
const navigate = async (hash: string): Promise<void> => {
  await act(async () => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent("hashchange")); });
};
/** The foot line's rows, top to bottom, and one row's Dismiss by whom its letter was for. */
async function readNote(name: string): Promise<string> {
  await waitFor(() => noticeRows().some(line => line.includes(name)), `the note for ${name}`);
  if (!footLine().includes(name)) {
    const more = document.querySelector<HTMLButtonElement>('.oh-noticeslot button[aria-haspopup="menu"]');
    await press(more, "More notices");
    const note = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')]
      .find(item => item.textContent?.includes(name));
    await press(note ?? null, `show the note for ${name}`);
    await waitFor(() => footLine().includes(name), `the front note for ${name}`);
  }
  return footLine();
}
const dismissFor = (name: string): HTMLButtonElement | undefined => {
  const at = slotNotices().find((r) => (r.textContent ?? "").includes(name));
  return [...(at?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === en.sendingLine.dismiss);
};
/** What this browser keeps of the notes, every owner's entry. */
const keptNotes = (): string => Object.keys(window.localStorage).filter((k) => k.startsWith(SENT_COPY_NOTES_PREFIX))
  .map((k) => window.localStorage.getItem(k) ?? "").join("\n");

async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settleEditor();
}
async function replyOpen(s: DraftShell, words: string): Promise<void> {
  await waitFor(() => row(s.el, "m1") != null, "the row");
  await press(row(s.el, "m1"), "the row");
  await key("r");
  await waitFor(() => replySurface(s.el) != null, "the reply editor");
  await act(async () => { typeInto(replySurface(s.el)!, words); });
}

const letter: EngineDraft = {
  id: "d-letter", mailboxId: "mb1", threadId: null, inReplyToMessageId: null,
  subject: "Plans for Friday", body: "Shall we meet at noon?",
  to: [{ name: "Mila", address: "mila@example.invalid" }], cc: [], bcc: [],
  rationale: null, status: "draft",
  createdAt: "2026-09-27T08:40:00.000Z", updatedAt: "2026-09-27T08:40:00.000Z",
} as unknown as EngineDraft;

const draftsOpen = (s: DraftShell): boolean =>
  s.el.querySelector('[data-rail-id="drafts"] [aria-current="page"]') !== null;

async function composerWith(s: DraftShell, id = "d-letter", subject = "Plans for Friday"): Promise<void> {
  await waitFor(() => draftsOpen(s), "the active Drafts destination");
  await composerOn(s, id, subject);
}

const letterTo = (id: string, name: string, subject: string): EngineDraft => ({
  ...letter, id, subject, body: `About ${subject}`, to: [{ name, address: `${name.toLowerCase()}@example.invalid` }],
}) as unknown as EngineDraft;
const letters = [letter, letterTo("d-jon", "Jon", "Budget review"), letterTo("d-ada", "Ada", "Train times"), letterTo("d-lin", "Lin", "Garden party")];
/** One letter from Drafts, its delivery answered with `copy` (nothing said of its copy when empty). */
async function sendLetter(s: DraftShell, id: string, subject: string, copy: DraftShell["sentCopy"] = {}): Promise<void> {
  await navigate("#/drafts");
  await composerWith(s, id, subject);
  for (const k of ["sentCopy", "sentCopyReason", "sentCopyUntil"] as const) delete s.sentCopy[k];
  Object.assign(s.sentCopy, copy);
  await waitFor(() => composeSend(s.el)?.disabled === false, "Send ready for this letter");
  await press(composeSend(s.el)!, "Send");
  await waitFor(() => editor(s.el) === null, `${id} handed off`);
}

describe("a healthy send leaves its editor and finishes in the sidebar's foot", () => {
  it("1 — the composer leaves before the answer; the foot says Sending to Mila…, then Sent, then nothing; no toast", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    await composerWith(s);
    s.sentCopy.sentCopy = "filed";
    const release = gate(s);
    await press(composeSend(s.el)!, "Send");
    await waitFor(() => editor(s.el) === null, "the composer gone before the answer");
    expect(sends(s), "the send is on the wire").toHaveLength(1);
    await waitFor(() => footLine().includes("Sending to Mila…"), "the foot line sending");
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.sendingLine.sent), "the foot line Sent");
    expect(toasts(), "a toast said the send twice").not.toContain(en.compose.toastSent);
    await waitFor(() => footLine() === "", "the foot line settles away", 200);
  }, 40_000);

  it("1c — delivered with no copy in Sent: the foot keeps Sent to Mila with why, past the line's time, until Dismiss", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    await composerWith(s);
    Object.assign(s.sentCopy, { sentCopy: "missing", sentCopyReason: "too_big" });
    await press(composeSend(s.el)!, "Send");
    await waitFor(() => footLine().includes(en.sentCopy.missingTooBig), "the foot says the copy is missing");
    expect(footLine()).toContain("Sent to Mila");
    await act(async () => { await new Promise((r) => setTimeout(r, SENT_LINE_MS + 300)); });
    expect(footLine(), "it settled away before the person read it").toContain(en.sentCopy.missingTooBig);
    expect(toasts()).not.toContain(en.sentCopy.missingTooBig);
    const dismiss = footAct(en.sendingLine.dismiss);
    await act(async () => { dismiss!.click(); });
    await waitFor(() => footLine() === "", "Dismiss ends it");
  }, 40_000);

  it("1d — a copy still owed for a reason the server gave says so", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    await composerWith(s);
    Object.assign(s.sentCopy, { sentCopy: "pending", sentCopyReason: "full" });
    await press(composeSend(s.el)!, "Send");
    await waitFor(() => footLine().includes(en.sentCopy.quotaWaiting), "the foot says the mailbox is full");
    expect(footLine()).toContain("is full");
    expect(footAct(en.sentCopy.notNow)).toBeTruthy();
  }, 40_000);

  it("1f — a copy kept without its files says until when ohmail tries again", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    await composerWith(s);
    Object.assign(s.sentCopy, { sentCopy: "pending", sentCopyUntil: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() });
    await press(composeSend(s.el)!, "Send");
    await waitFor(() => footLine().includes(en.sentCopy.waitingUntil.split("{time}")[0]!), "the foot says until when");
    expect(footLine()).not.toContain("{time}");
  }, 40_000);

  it("1g — each letter's note stands until its own Dismiss: a later letter with a note, or without one, replaces none", async () => {
    const s = await mountShell("#/drafts", [message("m1")], letters, { handOff: true });
    await sendLetter(s, "d-letter", "Plans for Friday", { sentCopy: "missing", sentCopyReason: "too_big" });
    await waitFor(() => footLine().includes(en.sentCopy.missingTooBig), "the first letter's note");
    await sendLetter(s, "d-jon", "Budget review", { sentCopy: "pending", sentCopyReason: "full" });
    await waitFor(() => readFootLine().includes("is full"), "the second letter's note");
    const order = noticeRows();
    expect(order.findIndex(r => r.includes("Mila")), "the older note above the newer")
      .toBeLessThan(order.findIndex(r => r.includes("is full")));
    expect(await readNote("is full")).toContain(en.sentCopy.quotaWaiting);
    expect(await readNote("Mila"), "the second letter replaced the first one's note").toContain(en.sentCopy.missingTooBig);
    await sendLetter(s, "d-ada", "Train times", { sentCopy: "filed" });
    await waitFor(() => readFootLine().includes("Sent to Ada"), "the third letter's Sent");
    await act(async () => { await new Promise((r) => setTimeout(r, SENT_LINE_MS + 300)); });
    expect(readFootLine(), "the third letter's Sent settles away").not.toContain("Ada");
    expect(await readNote("Mila"), "a later delivery took a note with it").toContain(en.sentCopy.missingTooBig);
    expect(await readNote("is full")).toContain(en.sentCopy.quotaWaiting);
    expect(toasts(), "a note said twice").not.toContain(en.sentCopy.quotaWaiting);
  }, 60_000);

  it("1h — a fourth note drops the oldest", async () => {
    const s = await mountShell("#/drafts", [message("m1")], letters, { handOff: true });
    const full = { sentCopy: "pending", sentCopyReason: "full" } as const;
    for (const [id, subject, name] of [
      ["d-letter", "Plans for Friday", "Mila"], ["d-jon", "Budget review", "Jon"],
      ["d-ada", "Train times", "Ada"], ["d-lin", "Garden party", "Lin"],
    ] as const) {
      await sendLetter(s, id, subject, full);
      await waitFor(() => keptNotes().includes(name), `the stored note for ${name}`);
    }
    const { notes } = JSON.parse(keptNotes()) as { notes: { to: string; note: unknown }[] };
    expect(notes.map((note) => note.to)).toEqual(["Lin", "Ada", "Jon"]);
    expect(notes.map((note) => note.note)).toEqual(Array(3).fill({ state: "pending", reason: "full" }));
    expect(noticeRows().filter((row) => row.includes("is full"))).toHaveLength(1);
    expect(keptNotes()).not.toContain("Mila");
  }, 60_000);

  it("1i — the notes outlive a reload; Dismiss takes one off the line and out of this browser, the other stays", async () => {
    const before = await mountShell("#/drafts", [message("m1")], letters, { handOff: true });
    await sendLetter(before, "d-letter", "Plans for Friday", { sentCopy: "missing", sentCopyReason: "too_big" });
    await sendLetter(before, "d-jon", "Budget review", { sentCopy: "pending", sentCopyReason: "full" });
    expect(await readNote("is full")).toContain(en.sentCopy.quotaWaiting);
    await unmountAll();
    stubDom();
    await mountShell("#/history", [message("m1")], [], { handOff: true, store: before.store });
    expect(await readNote("is full")).toContain(en.sentCopy.quotaWaiting);
    expect(await readNote("Mila")).toContain(en.sentCopy.missingTooBig);
    expect(footLine()).toContain("Sent to Mila");
    const dismissMila = dismissFor("Mila")!;
    await act(async () => { dismissMila.click(); });
    await waitFor(() => !footLine().includes("Mila"), "Dismiss ends Mila's note");
    expect(footLine(), "Dismiss took the other note too").toContain("is full");
    expect(keptNotes(), "the dismissed note is still kept in this browser").not.toContain("Mila");
    expect(keptNotes()).toContain("Jon");
    const dismissJon = footAct(en.sentCopy.notNow)!;
    await act(async () => { dismissJon.click(); });
    await waitFor(() => footLine() === "", "Dismiss ends the last note");
    expect(keptNotes()).toBe("");
  }, 60_000);

  it("1e — a copy still being filed, for no reason the server gave, says Sent and settles away", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    await composerWith(s);
    s.sentCopy.sentCopy = "pending";
    await press(composeSend(s.el)!, "Send");
    await waitFor(() => footLine().includes("Sent to Mila"), "Sent");
    expect(toasts(), "the send was also announced a second time").not.toContain(en.compose.toastSent);
    expect(footLine()).not.toMatch(/Sent folder/);
    await waitFor(() => footLine() === "", "the foot line settles away", 200);
  }, 40_000);

  it("1b — the answer lost after delivery, the retry answered from this press's own reservation: the foot says Sent to Mila", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    await composerWith(s);
    s.loseSendAnswer.on = true;
    await press(composeSend(s.el)!, "Send");
    await waitFor(() => editor(s.el) === null, "the composer gone");
    await waitFor(() => footLine().includes(en.compose.statusQueued), "not sent yet while the answer is missing");
    s.loseSendAnswer.on = false;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => footLine().includes("Sent to Mila"), "the foot finishes the send");
    expect(toasts(), "a single press told it had already been sent").not.toContain(en.compose.toastAlreadySent);
    expect(sends(s), "one key, asked twice").toHaveLength(2);
  }, 40_000);

  it("2 — the reply dock closes at once and the foot finishes it", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")], [], { handOff: true });
    await replyOpen(s, "See you on Thursday");
    const release = gate(s);
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => replySurface(s.el) == null, "the dock closed before the answer");
    await waitFor(() => /Sending to The colleague…/.test(footLine()), "the foot line names the recipient");
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.sendingLine.sent), "Sent");
    expect(sends(s)).toHaveLength(1);
    expect(toasts()).not.toContain(en.reply.toastSent);
  }, 40_000);

  it("2c — Send + Done with no copy in Sent: the toast says marked done with its Undo, the foot says why", async () => {
    const s = await mountShell("#/ohbox", [message("m1", { unread: true })], [], { handOff: true });
    Object.assign(s.sentCopy, { sentCopy: "missing", sentCopyReason: "too_big" });
    await replyOpen(s, "See you on Thursday");
    await press(actionNamed("Send + Done") ?? null, "Send + Done");
    await waitFor(() => toasts().includes(en.reply.toastSentAndDone), "Sent · marked done");
    await waitFor(() => footLine().includes(en.sentCopy.missingTooBig), "the foot says the copy is missing");
    expect(toasts()).toContain(en.ohbox.undo);
  }, 40_000);

  it("2d — a reply's note stands while its message's dock is open again", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")], [], { handOff: true });
    Object.assign(s.sentCopy, { sentCopy: "pending", sentCopyReason: "full" });
    await replyOpen(s, "See you on Thursday");
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => footLine().includes(en.sentCopy.quotaWaiting), "the reply's note");
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the dock open on the message again");
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(footLine(), "the open dock hid the note").toContain(en.sentCopy.quotaWaiting);
  }, 40_000);

  it("3 — a refusal after the hand-off stands in the foot with Open, no toast, and Open brings the words back", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await replyOpen(s, "Thursday works for me");
    const release = gate(s);
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => replySurface(s.el) == null, "the dock closed");
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.reply.statusUnreachable), "the refusal in the foot");
    expect(toasts(), "a toast said the refusal too").not.toContain(en.reply.statusUnreachable);
    s.refuseSend.on = false;
    const open = footAct(en.sendingLine.open);
    await press(open ?? null, "Open");
    await waitFor(() => (replySurface(s.el)?.textContent ?? "").includes("Thursday works for me"), "the words back");
    expect(footLine(), "the ending stayed after Open").toBe("");
  }, 40_000);

  it("4 — a confirmation after the person moved on leaves them where they are", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    await composerWith(s);
    const release = gate(s);
    await press(composeSend(s.el)!, "Send");
    await waitFor(() => editor(s.el) === null, "the composer gone");
    await navigate("#/drafts");
    await waitFor(() => draftsOpen(s), "Drafts");
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.sendingLine.sent), "Sent");
    // Past the sent beat (600 ms), where the settled compose is cleared.
    for (let i = 0; i < 48; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(window.location.hash, "a late confirmation moved the person").toBe("#/drafts");
  }, 40_000);

  it("7 — a send the last session left on its outbox: after the reload the foot says Sending to Mila…, then Sent", async () => {
    const before = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    await composerWith(before);
    gate(before);                                // never answered: the window closes with the send on its way
    await press(composeSend(before.el)!, "Send");
    await waitFor(() => editor(before.el) === null, "the composer gone");
    expect(before.engine.read().list("outbox_entry"), "the premise: the send is on the outbox").toHaveLength(1);
    await unmountAll();
    stubDom();
    const held: DraftShell["sendGate"] = { wait: null };
    let release!: () => void;
    held.wait = new Promise<void>((r) => { release = () => { held.wait = null; r(); }; });
    const after = await mountShell("#/history", [], [], { handOff: true, store: before.store, sendGate: held });
    await waitFor(() => footLine().includes("Sending to Mila…"), "the restored send in the foot");
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.sendingLine.sent), "the restored send finishes in the foot");
    expect(sends(after), "the replay went once").toHaveLength(1);
  }, 40_000);

  it("7b — a restored send whose Sent copy is missing: its note names the letter, and stands", async () => {
    const before = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    await composerWith(before);
    gate(before);
    await press(composeSend(before.el)!, "Send");
    await waitFor(() => editor(before.el) === null, "the composer gone");
    await unmountAll();
    stubDom();
    const held: DraftShell["sendGate"] = { wait: null };
    let release!: () => void;
    held.wait = new Promise<void>((r) => { release = () => { held.wait = null; r(); }; });
    const after = await mountShell("#/history", [], [], { handOff: true, store: before.store, sendGate: held });
    Object.assign(after.sentCopy, { sentCopy: "missing", sentCopyReason: "too_big" });
    await waitFor(() => footLine().includes("Sending to Mila…"), "the restored send in the foot");
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.sentCopy.missingTooBig), "the restored send's note");
    expect(footLine(), "the note does not say which letter").toContain("Sent to Mila");
    await act(async () => { await new Promise((r) => setTimeout(r, SENT_LINE_MS + 300)); });
    expect(footLine(), "the note settled away").toContain(en.sentCopy.missingTooBig);
  }, 40_000);
});

/** A control of the open letter by its name. */
const actionIn = (name: string): HTMLButtonElement | undefined =>
  [...(openRegion()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.getAttribute("aria-label") === name);
type Addressed = EngineMutation & { to?: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[] };
const audience = (m: EngineMutation | undefined): string => {
  const a = m as Addressed | undefined;
  const who = (xs: EmailAddress[] | undefined): string => (xs ?? []).map((x) => x.address).join(",");
  return a === undefined ? "(none)" : `to=${who(a.to)} cc=${who(a.cc)} bcc=${who(a.bcc)}`;
};
async function typeRecipient(_el: HTMLElement, label: string, text: string): Promise<void> {
  const input = openRegion()!.querySelector<HTMLInputElement>(`[role="group"][aria-label="${label}"] input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}
async function openOn(s: DraftShell, k: string, shiftKey = false): Promise<void> {
  await waitFor(() => row(s.el, "m1") != null, "the row");
  await press(row(s.el, "m1"), "the row");
  await key(k, shiftKey ? { shiftKey: true } : {});
  await waitFor(() => replySurface(s.el) != null, "the editor");
}
/** Refused after the hand-off, Open from the foot, Send again: both presses' audiences. */
async function refuseOpenResend(s: DraftShell, words: string): Promise<[string, string]> {
  await act(async () => { typeInto(replySurface(s.el)!, words); });
  const release = gate(s);
  Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
  await act(async () => { replySend(s.el)!.click(); });
  await waitFor(() => replySurface(s.el) == null, "the dock closed");
  await act(async () => { release(); });
  await waitFor(() => footLine().includes(en.reply.statusUnreachable), "the refusal in the foot");
  s.refuseSend.on = false;
  const open = footAct(en.sendingLine.open);
  await press(open ?? null, "Open");
  await waitFor(() => (replySurface(s.el)?.textContent ?? "").includes(words), "the words back");
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const again = replySend(s.el);
  expect(again?.disabled, "Send is ready again").toBe(false);
  await act(async () => { again!.click(); });
  await waitFor(() => sends(s).length >= 2, "the second press");
  return [audience(sends(s)[0]), audience(sends(s)[1])];
}

describe("Open after a handed-off refusal brings the audience back", () => {
  it("3b — a readdressed reply goes to whom the press named, not the computed sender", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await openOn(s, "r");
    await act(async () => { actionIn("Change recipients")!.click(); });
    await act(async () => { actionIn("Remove The colleague")!.click(); });
    await typeRecipient(s.el, "To", "teammate@example.invalid");
    const [first, second] = await refuseOpenResend(s, "Between us: I would not take this offer");
    expect(first).toBe("to=teammate@example.invalid cc= bcc=");
    expect(second).toBe(first);
  }, 60_000);

  it("3c — a reply-all keeps everyone it was sent to", async () => {
    const m1 = message("m1", {
      to: [{ address: "me@example.invalid", name: "Me" }, { address: "pat@example.invalid", name: "Pat" }],
      cc: [{ address: "kim@example.invalid", name: "Kim" }],
    } as never);
    const s = await mountShell("#/ohbox", [m1], [], { handOff: true });
    await openOn(s, "R", true);
    const [first, second] = await refuseOpenResend(s, "Agreed, let us go ahead");
    expect(first).toContain("kim@example.invalid");
    expect(second).toBe(first);
  }, 60_000);

  it("3d — a forward keeps its recipient", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await openOn(s, "F", true);
    await typeRecipient(s.el, "To", "friend@example.invalid");
    const [first, second] = await refuseOpenResend(s, "Have a look at this");
    expect(first).toBe("to=friend@example.invalid cc= bcc=");
    expect(second).toBe(first);
  }, 60_000);
});

describe("under 1024px the Reader sheet covers the foot's pill: the toast says it", () => {
  // The frame's plan reads the window's own width, as a phone hands it.
  beforeEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 }); });
  afterEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 }); });
  async function sheetReply(s: DraftShell, words: string): Promise<void> {
    await replyOpen(s, words);
    // The sheet: the letter stands over the list, on one column.
    expect(document.querySelector(".fr-frame[data-letter]") != null && openRegion() != null, "the reply is in the sheet").toBe(true);
  }
  /*
   * WHAT IS SAID OVER THE SHEET. Today's sheet covered the foot's pill, so its toast said what the pill would have. On a
   * phone's width the new frame draws its one notice in a bar at the frame's top, above the letter's column and never
   * under it, and its report at the foot over the letter's panel: both are read here, each a part of the frame itself.
   * A send's sentence is the frame's own (the foot's words: "Sent", the copy's why on the letter's own notice).
   */
  const overSheet = (): string =>
    [...document.querySelectorAll('.fr-frame[data-rail="dock"] > .fr-noticebar [role="status"], .fr-frame[data-rail="dock"] > .fr-report [role="status"]')]
      .map((n) => n.textContent ?? "").join(" | ");
  /** One notice or report over the sheet that says every one of `parts`. */
  const oneSays = (...parts: string[]): boolean => overSheet().split(" | ").some((one) => parts.every((p) => one.includes(p)));

  it("6a — a refusal after the hand-off is said over the sheet", async () => {
    stubDom({ narrow: true });
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await sheetReply(s, "Thursday works for me");
    const release = gate(s);
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => replySurface(s.el) == null, "the dock closed in the sheet");
    await act(async () => { release(); });
    await waitFor(() => overSheet().includes(en.reply.statusUnreachable), "the refusal said over the sheet");
  }, 40_000);

  it("6b — a delivery is said over the sheet", async () => {
    stubDom({ narrow: true });
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await sheetReply(s, "See you on Thursday");
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => overSheet().includes(en.sendingLine.sent), "Sent over the sheet");
  }, 40_000);

  it("6c — a delivery whose Sent copy is missing says why in the same toast", async () => {
    stubDom({ narrow: true });
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    Object.assign(s.sentCopy, { sentCopy: "missing", sentCopyReason: "full" });
    await sheetReply(s, "See you on Thursday");
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => oneSays(en.sendingLine.sent, en.sentCopy.missingFull), "the same notice says the copy is missing");
  }, 40_000);

  it("6d — Send + Done whose Sent copy is missing says both in one toast, with the Undo", async () => {
    stubDom({ narrow: true });
    const s = await mountShell("#/ohbox", [message("m1", { unread: true })], [], { handOff: true });
    Object.assign(s.sentCopy, { sentCopy: "missing", sentCopyReason: "too_big" });
    await sheetReply(s, "See you on Thursday");
    await press(actionNamed("Send + Done") ?? null, "Send + Done");
    // Marked done with its Undo in the report; why the copy is missing on the letter's notice beside it.
    await waitFor(() => oneSays(en.reply.toastSentAndDone, en.ohbox.undo) && overSheet().includes(en.sentCopy.missingTooBig), "both said over the sheet");
    expect(overSheet()).toContain(en.ohbox.undo);
  }, 40_000);

  it("6e — Send + Done whose copy is kept without its files says until when in the same toast, with the Undo", async () => {
    stubDom({ narrow: true });
    const s = await mountShell("#/ohbox", [message("m1", { unread: true })], [], { handOff: true });
    const until = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    Object.assign(s.sentCopy, { sentCopy: "pending", sentCopyReason: "unreachable", sentCopyUntil: until });
    await sheetReply(s, "See you on Thursday");
    await press(actionNamed("Send + Done") ?? null, "Send + Done");
    const waiting = en.sentCopy.waitingUnreachableUntil.split("{time}")[0]!;
    await waitFor(() => oneSays(en.reply.toastSentAndDone, en.ohbox.undo) && overSheet().includes(waiting), "marked done and until when said over the sheet");
    expect(overSheet()).not.toContain("{time}");
    expect(overSheet()).toContain(en.ohbox.undo);
  }, 40_000);
});

describe("CONTROLS: an unhealthy send keeps its editor and says why", () => {
  it("5a — a held outbox keeps the editor open, marks Send busy, and leaves the status line and foot empty", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await replyOpen(s, "Held words");
    const release = gate(s);
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => replySend(s.el)?.getAttribute("aria-busy") === "true", "the busy Send action");
    expect(replySurface(s.el), "the dock closed with the outbox held").not.toBeNull();
    expect(lineUnder()).toBeNull();
    expect(footLine()).toBe("");

    // Keep the wire held through the long-send threshold.
    await waitFor(() => lineUnder()?.textContent === en.write.status.sendingLong, "the reply's Still sending line", 240);
    expect(replySurface(s.el), "the dock closed during the long send").not.toBeNull();
    expect(footLine()).toBe("");

    await act(async () => { release(); });
    await waitFor(() => toasts().includes(en.reply.toastSent), "today's sent toast");
  }, 40_000);

  it("5 — offline: the dock stays and its own line says it", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await replyOpen(s, "Offline words");
    setOnline(false);
    await act(async () => { window.dispatchEvent(new Event("offline")); });
    s.offline.on = true;
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => lineUnder() != null, "the line under the editor");
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(replySurface(s.el), "the dock closed while offline").not.toBeNull();
    expect(footLine(), "the foot spoke for a send its editor shows").toBe("");
  }, 40_000);
});

/**
 * THE SENDING DEVICE SETTLES ITS ROW AT ONCE (a tester report: the sent letter stayed in Drafts with its
 * words and Discard for 43 s to 1.5 min, one press from a second send). A save of the row landed after
 * the send's 200 — the hand-off's close wrote it, or a send longer than the pause re-armed the timer —
 * and its shadow kept the row listed as a draft for three drains.
 */
describe("a sent letter leaves Drafts on the sending device at once", () => {
  const pause = async (ms: number): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
  const listed = (s: DraftShell): boolean => draftsList(s.engine.read(), NOW).some((d) => d.id === "d-letter");
  const savesAfterSend = (s: DraftShell): number => {
    const at = s.sent.findIndex((m) => m.kind === "mail_send");
    return s.sent.slice(at + 1).filter((m) => m.kind === "draft_save" && m.draftId === "d-letter").length;
  };
  async function setSubject(s: DraftShell, words: string): Promise<void> {
    const field = letterSubject(s.el)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, words);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function finished(handOff: boolean): Promise<DraftShell> {
    const s = await mountShell("#/drafts", [message("m1")], [], { handOff, server: new DraftServer([letter]) });
    await composerWith(s);
    await setSubject(s, "Plans for Friday, at noon");
    return s;
  }
  async function afterDrains(s: DraftShell): Promise<boolean[]> {
    const seen = [listed(s)];
    await pause(AUTOSAVE_DELAY_MS + 600);
    for (let i = 0; i < 3; i++) {
      await act(async () => { await s.engine.syncOnce().catch(() => undefined); });
      seen.push(listed(s));
    }
    return seen;
  }

  it("handed off: no save names the row after the send, and Drafts drops it at Sent and after three drains", async () => {
    const s = await finished(true);
    await press(composeSend(s.el)!, "Send");
    await waitFor(() => footLine().includes(en.sendingLine.sent), "the foot line Sent");
    expect({ listed: await afterDrains(s), saves: savesAfterSend(s) }).toEqual({ listed: [false, false, false, false], saves: 0 });
  }, 40_000);

  it("held in its editor past the pause: no save names the row after the send, and Drafts drops it at once", async () => {
    const s = await finished(false);
    const release = gate(s);
    await press(composeSend(s.el)!, "Send");
    await waitFor(() => sends(s).length === 1, "the send on the wire");
    await pause(AUTOSAVE_DELAY_MS + 600);
    await act(async () => { release(); });
    await waitFor(() => editor(s.el) === null || !listed(s), "the send settled");
    await pause(200);
    expect({ listed: await afterDrains(s), saves: savesAfterSend(s) }).toEqual({ listed: [false, false, false, false], saves: 0 });
  }, 40_000);

  it("control: a refused send gives the letter back, and its next words are saved to its row", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter]);
    await composerWith(s);
    s.refuseSend.on = true;
    await press(composeSend(s.el)!, "Send");
    await waitFor(() => (s.el.textContent ?? "").includes(en.compose.statusFailed), "the refusal said");
    s.refuseSend.on = false;
    const before = s.sent.length;
    await setSubject(s, "Plans for Friday, again");
    await pause(AUTOSAVE_DELAY_MS + 600);
    expect(s.sent.slice(before).filter((m) => m.kind === "draft_save").map((m) => (m as { draftId?: string | null }).draftId))
      .toEqual(["d-letter"]);
  }, 40_000);

  it("control: after a restart with a letter's send waiting offline, another draft's edits reach its own row", async () => {
    const server = new DraftServer([letter, { ...letter, id: "d-y", subject: "Letter Y" }, { ...letter, id: "d-z", subject: "Letter Z" }]);
    const s1 = await mountShell("#/drafts", [message("m1")], [], { server });
    await composerWith(s1);
    setOnline(false);
    await act(async () => { window.dispatchEvent(new Event("offline")); });
    s1.offline.on = true;
    await press(composeSend(s1.el)!, "Send");
    await waitFor(() => s1.engine.pendingMutations().some((p) => p.mutation.kind === "mail_send"), "the send waiting");
    await pause(300);
    await unmountAll();
    stubDom();
    const s2 = await mountShell("#/drafts", [message("m1")], [], { server, store: s1.store, startOffline: true });
    await composerWith(s2, "d-y", "Letter Y");
    await setSubject(s2, "Letter Y, edited");
    await pause(AUTOSAVE_DELAY_MS + 600);
    await navigate("#/drafts");
    await composerWith(s2, "d-z", "Letter Z");
    s2.offline.on = false;
    setOnline(true);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await act(async () => { await s2.engine.flushPending(); });
    await pause(500);
    expect({ y: server.rows.get("d-y")?.subject, letter: server.rows.get("d-letter")?.status })
      .toEqual({ y: "Letter Y, edited", letter: "sent" });
  }, 60_000);
});
