/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRAFT_BODY_MAX_BYTES } from "@trafficflow/core/outbound-text";
import { OUTBOX_TYPE, type EngineDraft, type EngineMutation } from "@ohmail/client-engine";
import en from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import { readComposeRow, resetComposerForTest } from "../app/shell/compose";
import {
  act, message, mountShell, NOW, press, replyDraft, replySurface, stubDom, unmountAll, waitFor, type DraftShell,
} from "./_draft-shell.js";

/**
 * A MESSAGE SENT WHILE OFFLINE LEAVES DRAFTS AS AN ONLINE ONE DOES (a tester report).
 *
 * Measured on Cloud web: the reply's pause wrote its row while the tab was offline, so the create
 * waited on the outbox and no row was ever taken. Send then went without a row, the reconnect
 * delivered it once under a row of its own, and the pause's create landed beside it: the sent reply
 * sat in Drafts under "haven't sent" on the web and on the paired desktop, one press from a second
 * copy. The composer did the same with a letter. The press now takes the waiting creates back (the
 * outbox row is marked, so a later boot does not replay them either), and the send is the one row.
 * A Cancel of that send gives the words back to a draft. The send itself is untouched: one key, one
 * request, and the server's one-per-key reservation behind it.
 * Mutations: `sending` in the reply autosave not called → cases 1 and 2 red; in the compose
 * autosave → case 5 red; `cancelled` not called → case 3 red; the editors not taking the row a
 * landed create made (`createdDraftOf`) → cases 6 to 8 red; a later create of the same reply
 * deleted without its words reaching the held row → cases 9 and 10 red; a create from before another
 * door bound the reply deleted → case 11 red; a refused press counted as a Send → case 12 red; a
 * Send taking back creates of another binding → cases 13 and 14 red; a door binding the reply to
 * its own waiting create's local id → cases 15, 16 and 18 red; a door's waiting create kept as
 * the seed of another row → case 17 red; a door binding a waiting create while the reply's meta
 * still names the row held before → cases 19 and 20 red. A first save waiting its turn at the gate or
 * behind a hold is named by its key on the row it paints (`EngineDraft.pendingCreate`): that key off
 * the paint → cases 21 to 28 red; the Drafts door's letter arm binding the local id → cases 29 and 30
 * red; a door reseeding a reply the lane holds → case 31 red; the stored claims off → cases 33 and 34
 * red. Cases 21 to 34 are all red on the previous design (`pendingCreateOf` over the queue alone).
 * A Cancel withdrawing a Send that held a create on the wire: the reply's close creating beside it, or
 * the withdraw leaving the create held → case 35 red; an ended message's create waiting on its held
 * Send (the table's order and the Discard's release both off) → case 37 red, and with the dock's
 * release off too, case 36. A reload's restored create judged with no row, the reply's stored row
 * passed over for the copy or rebound, or the copy kept though the row's server copy holds its words
 * → case 38 red.
 */

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
});
afterEach(unmountAll);

type Entry = { mutation: EngineMutation; withdrawn?: boolean };
const sends = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "mail_send");
/** What Drafts lists as not sent: the account's rows still a draft. */
const unsent = (s: DraftShell): EngineDraft[] => s.store.list<EngineDraft>("draft").filter((d) => d.status === "draft");
const waitingSaves = (s: DraftShell): number =>
  s.engine.pendingMutations().filter((p) => p.mutation.kind === "draft_save").length;
/** The creates a later boot would replay: on disk and not marked withdrawn. */
const replayableCreates = (s: DraftShell): Entry[] => s.store.list<Entry>(OUTBOX_TYPE)
  .filter((e) => e.mutation.kind === "draft_save" && e.mutation.draftId === null && e.withdrawn !== true);
const replySend = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button")]
    .find((b) => (b.textContent ?? "").startsWith("Send"));
const replyCancel = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button")]
    .find((b) => (b.textContent ?? "").trim() === "Cancel");
const composeSend = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll<HTMLButtonElement>(".view-compose .send-row button")]
    .find((b) => (b.textContent ?? "").trim().startsWith("Send") && !/later/i.test(b.textContent ?? ""));
const toasts = (): string => [...document.querySelectorAll(".toast, .toast-held")].map((n) => n.textContent ?? "").join(" | ");
const online = async (): Promise<void> => { await act(async () => { window.dispatchEvent(new Event("online")); }); };
const rounds = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
};
/** Past the two-second pause, in real time: this harness runs real timers. */
const PAUSE_ROUNDS = 200;

async function key(k: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await settleEditor();
}
async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function replyOn(s: DraftShell, id: string, words: string): Promise<void> {
  await waitFor(() => s.el.querySelector(`.view-ohbox .row[data-id='${id}']`) != null, "the row");
  await press(s.el.querySelector(`.view-ohbox .row[data-id='${id}']`), "the row");
  await key("r");
  await waitFor(() => replySurface(s.el) != null, "the reply editor");
  await act(async () => { typeInto(replySurface(s.el)!, words); });
}

/** Offline: the reply as it stands after each of `pauses`, each left to its pause, then Send. */
async function offlineReplySent(s: DraftShell, pauses: string[]): Promise<void> {
  s.offline.on = true;
  await replyOn(s, "m1", pauses[0]!);
  await waitFor(() => waitingSaves(s) === 1, "the pause's row waiting on the outbox", PAUSE_ROUNDS);
  for (const [i, words] of pauses.slice(1).entries()) {
    await act(async () => { typeInto(replySurface(s.el)!, words); });
    await waitFor(() => waitingSaves(s) === i + 2, `pause ${i + 2} waiting on the outbox`, PAUSE_ROUNDS);
  }
  await act(async () => { replySend(s.el)!.click(); });
  await waitFor(() => (s.el.querySelector(".reply .send-status")?.textContent ?? "").includes(en.reply.statusQueued), "Not sent yet");
}

describe("a reply sent while offline", () => {
  it("1 — goes once on reconnect, and Drafts is back to its count", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    s.spendSentRow.on = true;
    const before = unsent(s).length;
    await offlineReplySent(s, ["Sent while offline"]);
    expect(replayableCreates(s), "a later boot would still write the reply's row").toHaveLength(0);

    s.offline.on = false;
    await online();
    await waitFor(() => toasts().includes(en.reply.toastSent), "Reply sent.");
    await rounds(12);
    expect(sends(s), "the reply went more than once, or not at all").toHaveLength(1);
    expect((sends(s)[0] as { body?: string }).body).toBe("Sent while offline");
    expect(unsent(s).map((d) => d.body), "the sent reply is still listed as not sent").toHaveLength(before);
    expect(waitingSaves(s), "a create still waits to write the sent reply back").toBe(0);

    // Nothing is left to go: another reconnect and a flush send nothing and write no row.
    await online();
    await act(async () => { await s.engine.flushPending(); });
    await rounds(12);
    expect(sends(s)).toHaveLength(1);
    expect(unsent(s)).toHaveLength(before);
  }, 30_000);

  it("2 — two pauses offline, then Send: neither pause's row is left behind", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    s.spendSentRow.on = true;
    await offlineReplySent(s, ["First words", "First words and more words"]);
    s.offline.on = false;
    await online();
    await waitFor(() => toasts().includes(en.reply.toastSent), "Reply sent.");
    await rounds(12);
    expect(sends(s)).toHaveLength(1);
    expect((sends(s)[0] as { body?: string }).body).toBe("First words and more words");
    expect(unsent(s)).toHaveLength(0);
  }, 40_000);

  it("3 — Cancel on the waiting send: nothing goes, and the words are one draft again", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    await offlineReplySent(s, ["Kept, not sent"]);
    // Offline, the server cannot be asked: the Cancel is owed, and the dock holds until it is answered.
    await act(async () => { replyCancel(s.el)!.click(); });
    await waitFor(() => toasts().includes(en.compose.cancelUnreachable), "the owed Cancel said");

    s.withdrawAnswer.outcome = "withdrawn";
    s.offline.on = false;
    await online();
    await waitFor(() => replySurface(s.el) == null, "the dock closed once the Cancel was answered");
    await waitFor(() => unsent(s).some((d) => d.inReplyToMessageId === "m1"), "the words a draft on the account again", PAUSE_ROUNDS);
    await rounds(12);
    expect(sends(s), "a cancelled send went").toHaveLength(0);
    expect(unsent(s).filter((d) => d.inReplyToMessageId === "m1").map((d) => d.body)).toEqual(["Kept, not sent"]);
  }, 30_000);

  it("4 — control: a reply sent online is sent from its row, and leaves no draft", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    s.spendSentRow.on = true;
    const before = unsent(s).length;
    await replyOn(s, "m1", "Sent while online");
    await waitFor(() => unsent(s).length === before + 1, "the pause's row on the account", PAUSE_ROUNDS);
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => toasts().includes(en.reply.toastSent), "Reply sent.");
    await rounds(12);
    expect(sends(s)).toHaveLength(1);
    expect(unsent(s)).toHaveLength(before);
  }, 30_000);
});

describe("a letter sent while offline", () => {
  it("5 — goes once on reconnect, and Drafts is back to its count", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    s.spendSentRow.on = true;
    const before = unsent(s).length;
    s.offline.on = true;
    await key("c");
    await waitFor(() => s.el.querySelector(".view-compose .rte-surface") != null, "the composer");
    await setInput(s.el.querySelector<HTMLInputElement>("#compose-to")!, "lena@example.invalid, ");
    await setInput(s.el.querySelector<HTMLInputElement>("#compose-subject")!, "Written offline");
    await act(async () => { typeInto(s.el.querySelector<HTMLElement>(".view-compose .rte-surface")! as never, "A letter written offline"); });
    await settleEditor();
    await waitFor(() => waitingSaves(s) === 1, "the pause's row waiting on the outbox", PAUSE_ROUNDS);
    await act(async () => { composeSend(s.el)!.click(); });
    await waitFor(() => (s.el.textContent ?? "").includes(en.compose.statusQueued), "Not sent yet");
    expect(replayableCreates(s), "a later boot would still write the letter's row").toHaveLength(0);

    s.offline.on = false;
    await online();
    await waitFor(() => toasts().includes(en.compose.toastSent), "Message sent.");
    await rounds(12);
    expect(sends(s)).toHaveLength(1);
    expect(unsent(s), "the sent letter is still listed as not sent").toHaveLength(before);
    await online();
    await act(async () => { await s.engine.flushPending(); });
    await rounds(12);
    expect(sends(s)).toHaveLength(1);
  }, 30_000);
});

describe("a create that waited offline lands on the reconnect", () => {
  const createsOf = (s: DraftShell, parent: string | null) => s.engine.pendingMutations()
    .filter((p) => p.mutation.kind === "draft_save" && p.mutation.draftId === null
      && ((p.mutation as { inReplyToMessageId?: string | null }).inReplyToMessageId ?? null) === parent);

  it("6 — two replies offline: the second reply takes the row its create made, and its Send goes from it", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    s.spendSentRow.on = true;
    s.offline.on = true;
    await replyOn(s, "m1", "First reply");
    await waitFor(() => createsOf(s, "m1").length === 1, "the first reply's create waiting", PAUSE_ROUNDS);
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => (s.el.querySelector(".reply .send-status")?.textContent ?? "").includes(en.reply.statusQueued), "Not sent yet");
    await replyOn(s, "m2", "Second reply");
    await waitFor(() => createsOf(s, "m2").length === 1, "the second reply's create waiting", PAUSE_ROUNDS);
    s.offline.on = false;
    await online();
    await waitFor(() => toasts().includes(en.reply.toastSent), "Reply sent.");
    await waitFor(() => unsent(s).some((d) => d.inReplyToMessageId === "m2"), "the second reply's row landed");
    const row = unsent(s).find((d) => d.inReplyToMessageId === "m2")!.id;
    await rounds(12);
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => sends(s).length === 2, "the second reply sent");
    await rounds(20);
    expect({ from: (sends(s)[1] as { draftId?: string | null }).draftId ?? null, left: unsent(s).filter((d) => d.inReplyToMessageId === "m2").length },
      "the second reply went without its row, and the row stayed in Drafts").toEqual({ from: row, left: 0 });
  }, 60_000);

  it("7 — a letter paused offline beside a reply sent offline: the composer takes its row, one row in Drafts", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    s.spendSentRow.on = true;
    s.offline.on = true;
    await key("c");
    await waitFor(() => s.el.querySelector(".view-compose .rte-surface") != null, "the composer");
    await setInput(s.el.querySelector<HTMLInputElement>("#compose-to")!, "lena@example.invalid, ");
    await setInput(s.el.querySelector<HTMLInputElement>("#compose-subject")!, "Written offline");
    await act(async () => { typeInto(s.el.querySelector<HTMLElement>(".view-compose .rte-surface")! as never, "A letter written offline"); });
    await settleEditor();
    await waitFor(() => createsOf(s, null).length >= 1, "the letter's create waiting", PAUSE_ROUNDS);
    await act(async () => { window.location.hash = "#/ohbox"; });
    await replyOn(s, "m1", "A reply sent offline");
    await waitFor(() => createsOf(s, "m1").length === 1, "the reply's create waiting", PAUSE_ROUNDS);
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => (s.el.querySelector(".reply .send-status")?.textContent ?? "").includes(en.reply.statusQueued), "Not sent yet");
    s.offline.on = false;
    await online();
    await waitFor(() => toasts().includes(en.reply.toastSent), "Reply sent.");
    await rounds(40);
    const letters = unsent(s).filter((d) => d.subject === "Written offline");
    expect({ letters: letters.length, held: readComposeRow() === (letters[0]?.id ?? "none") },
      "the letter's row was left beside the composer, or written twice").toEqual({ letters: 1, held: true });
  }, 60_000);

  it("8 — a create taken back while already on the wire is deleted once the send goes from its own row", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    s.spendSentRow.on = true;
    const before = unsent(s).length;
    s.offline.on = true;
    await replyOn(s, "m1", "Sent while its create was on the wire");
    await waitFor(() => createsOf(s, "m1").length === 1, "the create waiting", PAUSE_ROUNDS);
    let land: () => void = () => {};
    s.saveGate.wait = new Promise<void>((r) => { land = r; });
    s.offline.on = false;
    let flushed: Promise<unknown> = Promise.resolve();
    await act(async () => { flushed = s.engine.flushPending(); });
    await waitFor(() => s.sent.some((m) => m.kind === "draft_save"), "the create on the wire");
    await act(async () => { replySend(s.el)!.click(); });
    await rounds(4);
    s.saveGate.wait = null;
    await act(async () => { land(); await flushed; });
    await online();
    await waitFor(() => toasts().includes(en.reply.toastSent), "Reply sent.");
    await rounds(40);
    expect({ sends: sends(s).length, left: unsent(s).length - before }, "the create that landed beside the send stayed in Drafts")
      .toEqual({ sends: 1, left: 0 });
  }, 60_000);

  const rowsOf = (s: DraftShell, parent: string): string[] => unsent(s)
    .filter((d) => d.inReplyToMessageId === parent).map((d) => d.body ?? "");
  const reconnect = async (s: DraftShell): Promise<void> => {
    s.offline.on = false;
    await online();
    await rounds(20);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(40);
  };

  it("9 — two pauses offline, then a reply to the next message: the first reply's row holds its newest words", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    s.offline.on = true;
    await replyOn(s, "m1", "Dear Ann, yes");
    await waitFor(() => createsOf(s, "m1").length === 1, "pause 1 waiting", PAUSE_ROUNDS);
    await act(async () => { typeInto(replySurface(s.el)!, "Dear Ann, yes, Thursday at ten works"); });
    await waitFor(() => createsOf(s, "m1").length === 2, "pause 2 waiting", PAUSE_ROUNDS);
    await replyOn(s, "m2", "Thanks Bo");
    await waitFor(() => createsOf(s, "m2").length === 1, "the next reply's create waiting", PAUSE_ROUNDS);
    await reconnect(s);
    expect(rowsOf(s, "m1"), "the account kept the first pause's words").toEqual(["Dear Ann, yes, Thursday at ten works"]);
    expect(rowsOf(s, "m2")).toEqual(["Thanks Bo"]);
  }, 90_000);

  it("10 — two pauses offline, the editor open at the reconnect: one row, the newest words", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    s.offline.on = true;
    await replyOn(s, "m1", "Dear Ann, yes");
    await waitFor(() => createsOf(s, "m1").length === 1, "pause 1 waiting", PAUSE_ROUNDS);
    await act(async () => { typeInto(replySurface(s.el)!, "Dear Ann, yes, Thursday works"); });
    await waitFor(() => createsOf(s, "m1").length === 2, "pause 2 waiting", PAUSE_ROUNDS);
    await reconnect(s);
    await rounds(80);
    expect(rowsOf(s, "m1")).toEqual(["Dear Ann, yes, Thursday works"]);
  }, 90_000);

  it("11 — a reply typed offline, then another device's draft of it opened from Drafts: both rows stay", async () => {
    window.localStorage.setItem("ohmail.ui.reply:m1", "Laptop words");
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")], [replyDraft("d-phone", "m1", "Words from the phone")]);
    s.offline.on = true;
    await replyOn(s, "m1", "Laptop words, written offline");
    await waitFor(() => createsOf(s, "m1").length === 1, "the laptop reply's create waiting", PAUSE_ROUNDS);
    await act(async () => { window.location.hash = "#/drafts"; });
    await waitFor(() => s.el.querySelector(".draft-row[data-id='d-phone'] .draft-open") != null, "the phone's draft row");
    await press(s.el.querySelector(".draft-row[data-id='d-phone'] .draft-open"), "the phone draft's open button");
    await waitFor(() => (replySurface(s.el)?.textContent ?? "").includes("phone"), "the phone's draft in the editor");
    await reconnect(s);
    expect(rowsOf(s, "m1").sort(), "the reply typed offline was deleted")
      .toEqual(["Laptop words, written offline", "Words from the phone"]);
  }, 90_000);

  it("12 — a press refused at the door is no Send: the reply's waiting row survives the reconnect", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    s.offline.on = true;
    await replyOn(s, "m1", "Kept words");
    await waitFor(() => createsOf(s, "m1").length === 1, "the pause's create waiting", PAUSE_ROUNDS);
    await act(async () => { typeInto(replySurface(s.el)!, "x".repeat(DRAFT_BODY_MAX_BYTES + 100)); });
    await rounds(4);
    const editor = replySurface(s.el)!;
    editor.focus();
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    });
    await settleEditor();
    await rounds(6);
    await act(async () => { typeInto(replySurface(s.el)!, "Kept words"); });
    await rounds(120);
    await reconnect(s);
    expect(sends(s), "the refused press went").toHaveLength(0);
    expect(rowsOf(s, "m1"), "an unsent reply's row was deleted").toEqual(["Kept words"]);
  }, 90_000);

  const openPhoneDraft = async (s: DraftShell): Promise<void> => {
    await act(async () => { window.location.hash = "#/drafts"; });
    await waitFor(() => s.el.querySelector(".draft-row[data-id='d-phone'] .draft-open") != null, "the phone's draft row");
    await press(s.el.querySelector(".draft-row[data-id='d-phone'] .draft-open"), "the phone draft's open button");
    await waitFor(() => (replySurface(s.el)?.textContent ?? "").includes("phone"), "the phone's draft in the editor");
    await rounds(10);
  };

  it("13 — a reply typed offline, then another device's draft of it sent offline: the typed words stay a draft", async () => {
    window.localStorage.setItem("ohmail.ui.reply:m1", "Laptop words");
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")], [replyDraft("d-phone", "m1", "Words from the phone")]);
    s.spendSentRow.on = true;
    s.offline.on = true;
    await replyOn(s, "m1", "Laptop words, written offline");
    await waitFor(() => createsOf(s, "m1").length === 1, "the laptop reply's create waiting", PAUSE_ROUNDS);
    await openPhoneDraft(s);
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => (s.el.querySelector(".reply .send-status")?.textContent ?? "").includes(en.reply.statusQueued), "Not sent yet");
    await reconnect(s);
    await waitFor(() => toasts().includes(en.reply.toastSent), "Reply sent.");
    await rounds(40);
    expect(sends(s).map((m) => (m as { draftId?: string | null }).draftId ?? null)).toEqual(["d-phone"]);
    expect(rowsOf(s, "m1"), "the reply typed offline was lost").toEqual(["Laptop words, written offline"]);
  }, 90_000);

  it("14 — the same with the typed reply's create on the wire at the press: it stays a draft", async () => {
    window.localStorage.setItem("ohmail.ui.reply:m1", "Laptop words");
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")], [replyDraft("d-phone", "m1", "Words from the phone")]);
    s.spendSentRow.on = true;
    s.offline.on = true;
    await replyOn(s, "m1", "Laptop words, written offline");
    await waitFor(() => createsOf(s, "m1").length === 1, "the laptop reply's create waiting", PAUSE_ROUNDS);
    await openPhoneDraft(s);
    let land: () => void = () => {};
    s.saveGate.wait = new Promise<void>((r) => { land = r; });
    s.offline.on = false;
    let flushed: Promise<unknown> = Promise.resolve();
    await act(async () => { flushed = s.engine.flushPending(); });
    await waitFor(() => s.sent.some((m) => m.kind === "draft_save"), "the create on the wire");
    await act(async () => { replySend(s.el)!.click(); });
    await rounds(4);
    s.saveGate.wait = null;
    await act(async () => { land(); await flushed; });
    await online();
    await waitFor(() => toasts().includes(en.reply.toastSent), "Reply sent.");
    await rounds(40);
    expect(sends(s).map((m) => (m as { draftId?: string | null }).draftId ?? null)).toEqual(["d-phone"]);
    expect(rowsOf(s, "m1"), "the reply typed offline was deleted").toEqual(["Laptop words, written offline"]);
  }, 90_000);

  /** Offline: the reply typed and paused, its editor closed; `reopen` opens it again, then Send. */
  const reopenedAndSent = async (s: DraftShell, words: string, reopen: () => Promise<void>): Promise<void> => {
    s.spendSentRow.on = true;
    s.offline.on = true;
    await replyOn(s, "m1", words);
    await waitFor(() => createsOf(s, "m1").length === 1, "the create waiting", PAUSE_ROUNDS);
    await key("Escape");
    await waitFor(() => replySurface(s.el) == null, "the editor closed");
    await rounds(10);
    await reopen();
    await waitFor(() => (replySurface(s.el)?.textContent ?? "").includes(words), "the reply in the editor again");
    await rounds(20);
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => (s.el.querySelector(".reply .send-status")?.textContent ?? "").includes(en.reply.statusQueued), "Not sent yet");
    await reconnect(s);
    await waitFor(() => toasts().includes(en.reply.toastSent), "Reply sent.");
    await rounds(40);
  };
  const openListed = async (s: DraftShell, words: string): Promise<void> => {
    await act(async () => { window.location.hash = "#/drafts"; });
    const row = (): Element | undefined => [...s.el.querySelectorAll(".draft-row")].find((r) => (r.textContent ?? "").includes(words));
    await waitFor(() => row()?.querySelector(".draft-open") != null, "the waiting reply listed in Drafts");
    await press(row()!.querySelector(".draft-open"), "its open button");
  };
  const sentFrom = (s: DraftShell): (string | null)[] => sends(s).map((m) => (m as { draftId?: string | null }).draftId ?? null);

  it("15 — reopened with Reply onto its own waiting create: one send, from no unconfirmed id, and no draft left", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    await reopenedAndSent(s, "Typed offline, sent after a reopen", () => key("r"));
    expect({ from: sentFrom(s), left: rowsOf(s, "m1") }).toEqual({ from: [null], left: [] });
  }, 90_000);

  it("16 — reopened from Drafts onto its own waiting create: one send, from no unconfirmed id, and no draft left", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    await reopenedAndSent(s, "Typed offline, opened from Drafts", () => openListed(s, "opened from Drafts"));
    expect({ from: sentFrom(s), left: rowsOf(s, "m1") }).toEqual({ from: [null], left: [] });
  }, 90_000);

  it("17 — another device's draft opened, then the reply's own waiting create from Drafts and sent: the phone's draft stays", async () => {
    window.localStorage.setItem("ohmail.ui.reply:m1", "Laptop words");
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")], [replyDraft("d-phone", "m1", "Words from the phone")]);
    await reopenedAndSent(s, "Laptop words, written offline", async () => {
      await openPhoneDraft(s);
      await openListed(s, "written offline");
    });
    expect({ from: sentFrom(s), left: rowsOf(s, "m1") }).toEqual({ from: [null], left: ["Words from the phone"] });
  }, 90_000);

  /** Offline: the reply typed, the phone's draft opened and edited, the reply's own create opened from Drafts, closed, Reply. */
  const staleReopen = async (s: DraftShell): Promise<void> => {
    const edits = (): number => s.engine.pendingMutations()
      .filter((p) => p.mutation.kind === "draft_save" && p.mutation.draftId === "zz-phone").length;
    const shown = (words: string) => waitFor(() => (replySurface(s.el)?.textContent ?? "").includes(words), `"${words}" in the editor`);
    s.offline.on = true;
    await replyOn(s, "m1", "Laptop words, written offline");
    await waitFor(() => createsOf(s, "m1").length === 1, "the laptop reply's create waiting", PAUSE_ROUNDS);
    await openListed(s, "Words from the phone");
    await shown("Words from the phone");
    await rounds(10);
    await act(async () => { typeInto(replySurface(s.el)!, "Words from the phone, edited offline"); });
    await waitFor(() => edits() >= 1, "the phone draft's edit waiting", PAUSE_ROUNDS);
    await openListed(s, "written offline");
    await shown("written offline");
    await rounds(10);
    await key("Escape");
    await waitFor(() => replySurface(s.el) == null, "the editor closed");
    await rounds(10);
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the reply editor again");
    await rounds(10);
  };
  const phoneEdited = (): Promise<DraftShell> =>
    mountShell("#/ohbox", [message("m1"), message("m2")], [replyDraft("zz-phone", "m1", "Words from the phone")]);

  it("19 — the phone's draft edited, then the reply's own waiting create, then Reply and typed on: the phone's words stay its own", async () => {
    window.localStorage.setItem("ohmail.ui.reply:m1", "Laptop words");
    const s = await phoneEdited();
    await staleReopen(s);
    await act(async () => { typeInto(replySurface(s.el)!, "Laptop words, written offline, and one more line"); });
    await rounds(PAUSE_ROUNDS);
    await reconnect(s);
    await rounds(60);
    expect(rowsOf(s, "m1"), "the phone's draft was written over").toContain("Words from the phone, edited offline");
  }, 120_000);

  it("20 — the same, then Send: the phone's draft is not spent, and no copy of the sent words stays", async () => {
    window.localStorage.setItem("ohmail.ui.reply:m1", "Laptop words");
    const s = await phoneEdited();
    s.spendSentRow.on = true;
    await staleReopen(s);
    await act(async () => { replySend(s.el)!.click(); });
    await rounds(20);
    await reconnect(s);
    await rounds(60);
    expect({ from: sentFrom(s), left: rowsOf(s, "m1") }).toEqual({ from: [null], left: ["Words from the phone, edited offline"] });
  }, 120_000);
});

describe("a reply reopened while its first save is in the air", () => {
  type Save = Extract<EngineMutation, { kind: "draft_save" }>;
  const saves = (s: DraftShell): Save[] => s.sent.filter((m): m is Save => m.kind === "draft_save");

  it("18 — online, typed on after the reopen: the reply keeps one row, written by the next save", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    let release: () => void = () => {};
    s.saveGate.wait = new Promise<void>((r) => { release = r; });
    await replyOn(s, "m1", "On my way");
    await waitFor(() => saves(s).length >= 1, "the first save on the wire", PAUSE_ROUNDS);
    await key("Escape");
    await waitFor(() => replySurface(s.el) == null, "closed");
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "opened again");
    await rounds(10);
    s.saveGate.wait = null;
    await act(async () => { release(); });
    await rounds(20);
    await act(async () => { typeInto(replySurface(s.el)!, "On my way, ten minutes at most"); });
    await waitFor(() => saves(s).length >= 2, "the next save", PAUSE_ROUNDS);
    await rounds(40);
    const rows = unsent(s).filter((d) => d.inReplyToMessageId === "m1");
    expect({ rows: rows.map((d) => d.body), next: saves(s)[1]?.draftId }, "the reply has two rows on the account")
      .toEqual({ rows: ["On my way, ten minutes at most"], next: rows[0]?.id });
  }, 60_000);
});

describe("a first save named by its key while it waits — at the gate, behind a hold, across a reload", () => {
  type Save = Extract<EngineMutation, { kind: "draft_save" }>;
  const saves = (s: DraftShell): Save[] => s.sent.filter((m): m is Save => m.kind === "draft_save");
  /** What the engine shows (store plus overlays): a waiting create's local row is here only. */
  const shown = (s: DraftShell): EngineDraft[] => s.engine.read().list<EngineDraft>("draft").filter((d) => d.status === "draft");
  const rowsOf = (s: DraftShell, parent: string): string[] => unsent(s)
    .filter((d) => d.inReplyToMessageId === parent).map((d) => d.body ?? "");
  const createsOf = (s: DraftShell, parent: string | null) => s.engine.pendingMutations()
    .filter((p) => p.mutation.kind === "draft_save" && p.mutation.draftId === null
      && ((p.mutation as { inReplyToMessageId?: string | null }).inReplyToMessageId ?? null) === parent);
  const sendsOf = (s: DraftShell) => sends(s)
    .map((m) => ({ draftId: (m as { draftId?: string | null }).draftId ?? null, body: (m as { body?: string }).body }));
  const reconnect = async (s: DraftShell): Promise<void> => {
    s.offline.on = false;
    await online();
    await rounds(20);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(60);
  };
  const openListed = async (s: DraftShell, words: string, surface: () => boolean = () => replySurface(s.el) != null): Promise<void> => {
    await act(async () => { window.location.hash = "#/drafts"; });
    const row = (): Element | undefined => [...s.el.querySelectorAll(".draft-row")].find((r) => (r.textContent ?? "").includes(words));
    await waitFor(() => row()?.querySelector(".draft-open") != null, `"${words}" listed in Drafts`);
    await press(row()!.querySelector(".draft-open"), "its open button");
    await waitFor(surface, "the editor open again");
    await rounds(10);
  };
  const discardListed = async (s: DraftShell, words: string): Promise<void> => {
    await act(async () => { window.location.hash = "#/drafts"; });
    const row = (): Element | undefined => [...s.el.querySelectorAll(".draft-row")].find((r) => (r.textContent ?? "").includes(words));
    await waitFor(() => row()?.querySelector(".draft-discard") != null, `"${words}" listed in Drafts`);
    await press(row()!.querySelector(".draft-discard"), "Delete");
    const confirm = [...s.el.querySelectorAll<HTMLButtonElement>(".draft-confirm button")]
      .find((b) => (b.textContent ?? "").trim() === en.drafts.discardConfirm) ?? null;
    await press(confirm, "confirm the delete");
    await rounds(10);
  };
  const reload = async (s: DraftShell, hash: string): Promise<DraftShell> => {
    await unmountAll();
    resetComposerForTest();
    stubDom();
    return mountShell(hash, [message("m1"), message("m2")], [], { store: s.store });
  };

  /**
   * Online, another save on the wire (m2's first save held at the server, or past a short deadline
   * the hold it armed): m1's first save waits its turn painted, in neither the queue nor the wire.
   * The reply is closed and opened again in that window.
   */
  async function gateWaitSetup(s: DraftShell, reopen: "reply" | "drafts"): Promise<{ release: () => void; local: string }> {
    let release: () => void = () => {};
    s.saveGate.wait = new Promise<void>((r) => { release = r; });
    await replyOn(s, "m2", "Answer to the second");
    await waitFor(() => saves(s).length >= 1, "m2's save on the wire", PAUSE_ROUNDS);
    await key("Escape");
    await waitFor(() => replySurface(s.el) == null, "closed");
    await replyOn(s, "m1", "On my way");
    await waitFor(() => shown(s).some((d) => d.inReplyToMessageId === "m1"), "m1's row painted", PAUSE_ROUNDS);
    await rounds(10);
    const local = shown(s).find((d) => d.inReplyToMessageId === "m1")!.id;
    await key("Escape");
    await waitFor(() => replySurface(s.el) == null, "closed");
    await rounds(10);
    if (reopen === "reply") {
      await key("r");
      await waitFor(() => replySurface(s.el) != null, "opened again");
    } else {
      await openListed(s, "On my way");
    }
    await rounds(10);
    return { release, local };
  }
  const opened = (deadline: boolean): Promise<DraftShell> =>
    mountShell("#/ohbox", [message("m1"), message("m2")], [], deadline ? { outboxReplayDeadlineMs: 50 } : {});

  async function typedOnAfterTheGate(deadline: boolean, twice: boolean): Promise<DraftShell> {
    const s = await opened(deadline);
    const { release } = await gateWaitSetup(s, "reply");
    s.saveGate.wait = null;
    await act(async () => { release(); });
    await rounds(40);
    if (twice) {
      await act(async () => { typeInto(replySurface(s.el)!, "On my way, ten minutes"); });
      await rounds(PAUSE_ROUNDS);
    }
    await act(async () => { typeInto(replySurface(s.el)!, "On my way, ten minutes at most"); });
    await rounds(PAUSE_ROUNDS);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(40);
    return s;
  }
  async function sentBeforeTheGate(deadline: boolean): Promise<{ s: DraftShell; local: string }> {
    const s = await opened(deadline);
    s.spendSentRow.on = true;
    const { release, local } = await gateWaitSetup(s, "reply");
    await act(async () => { replySend(s.el)!.click(); });
    await rounds(10);
    s.saveGate.wait = null;
    await act(async () => { release(); });
    await rounds(80);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(40);
    return { s, local };
  }

  it("21 — m1's first save waiting behind another save, reopened with Reply, typed on: one row, the newest words", async () => {
    const s = await typedOnAfterTheGate(false, false);
    expect(rowsOf(s, "m1")).toEqual(["On my way, ten minutes at most"]);
  }, 120_000);

  it("22 — the same, typed on twice: one row on the account, the newest words", async () => {
    const s = await typedOnAfterTheGate(false, true);
    expect(rowsOf(s, "m1")).toEqual(["On my way, ten minutes at most"]);
  }, 120_000);

  it("23 — the same, then Send before the save lands: one send from no unconfirmed id, and no draft of it left", async () => {
    const { s, local } = await sentBeforeTheGate(false);
    expect({ sends: sendsOf(s).length, left: rowsOf(s, "m1") }).toEqual({ sends: 1, left: [] });
    expect(sendsOf(s)[0]?.draftId, "the send named the unconfirmed local id").not.toBe(local);
  }, 120_000);

  it("24 — the same against the server's answer for an unknown row, then Send again: the reply goes once, no copy left", async () => {
    const s = await opened(false);
    s.spendSentRow.on = true;
    const { release, local } = await gateWaitSetup(s, "reply");
    s.refuseSend.on = true;
    s.refuseSend.code = "not_found";
    s.refuseSend.status = 404;
    await act(async () => { replySend(s.el)!.click(); });
    await rounds(10);
    s.saveGate.wait = null;
    await act(async () => { release(); });
    await waitFor(() => sendsOf(s).length >= 1, "the first press on the wire", PAUSE_ROUNDS);
    await rounds(60);
    s.refuseSend.on = false;
    s.serverGone.add(local);
    for (let i = 0; i < 2; i++) {
      const btn = replySend(s.el);
      if (!btn) break;
      await act(async () => { btn.click(); });
      await rounds(40);
      await act(async () => { await s.engine.flushPending(); });
      await rounds(40);
    }
    expect(sendsOf(s).map((x) => x.draftId), "a press named the unconfirmed local id").not.toContain(local);
    expect(rowsOf(s, "m1"), "a copy of the reply stayed in Drafts").toEqual([]);
  }, 120_000);

  it("25 — the same reopened from Drafts, typed on: one row, the newest words", async () => {
    const s = await opened(false);
    const { release } = await gateWaitSetup(s, "drafts");
    s.saveGate.wait = null;
    await act(async () => { release(); });
    await rounds(40);
    await act(async () => { typeInto(replySurface(s.el)!, "On my way, ten minutes at most"); });
    await rounds(PAUSE_ROUNDS);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(40);
    expect(rowsOf(s, "m1")).toEqual(["On my way, ten minutes at most"]);
  }, 120_000);

  it("26 — the previous reply's send still on the wire: m1's first save waits behind it, reopened, typed on twice: one row", async () => {
    const s = await opened(false);
    let release: () => void = () => {};
    s.sendGate.wait = new Promise<void>((r) => { release = r; });
    await replyOn(s, "m2", "Answer to the second");
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => sends(s).length >= 1, "m2's send on the wire", PAUSE_ROUNDS);
    await replyOn(s, "m1", "On my way");
    await waitFor(() => shown(s).some((d) => d.inReplyToMessageId === "m1"), "m1's row painted", PAUSE_ROUNDS);
    await rounds(10);
    await key("Escape");
    await waitFor(() => replySurface(s.el) == null, "closed");
    await rounds(10);
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "opened again");
    await rounds(10);
    s.sendGate.wait = null;
    await act(async () => { release(); });
    await rounds(60);
    await act(async () => { typeInto(replySurface(s.el)!, "On my way, ten minutes"); });
    await rounds(PAUSE_ROUNDS);
    await act(async () => { typeInto(replySurface(s.el)!, "On my way, ten minutes at most"); });
    await rounds(PAUSE_ROUNDS);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(40);
    expect(rowsOf(s, "m1")).toEqual(["On my way, ten minutes at most"]);
  }, 120_000);

  it("27 — 21 behind a deadline hold: one row, the newest words", async () => {
    const s = await typedOnAfterTheGate(true, false);
    expect(rowsOf(s, "m1")).toEqual(["On my way, ten minutes at most"]);
  }, 120_000);

  it("28 — 23 behind a deadline hold: one send from no unconfirmed id, and no draft of it left", async () => {
    const { s, local } = await sentBeforeTheGate(true);
    expect({ sends: sendsOf(s).length, left: rowsOf(s, "m1") }).toEqual({ sends: 1, left: [] });
    expect(sendsOf(s)[0]?.draftId, "the send named the unconfirmed local id").not.toBe(local);
  }, 120_000);

  /** Offline: a letter paused, opened again from Drafts while its create waits, typed on. */
  async function letterReopened(s: DraftShell): Promise<string> {
    s.offline.on = true;
    await key("c");
    await waitFor(() => s.el.querySelector(".view-compose .rte-surface") != null, "the composer");
    await setInput(s.el.querySelector<HTMLInputElement>("#compose-to")!, "lena@example.invalid, ");
    await setInput(s.el.querySelector<HTMLInputElement>("#compose-subject")!, "Written offline");
    await act(async () => { typeInto(s.el.querySelector<HTMLElement>(".view-compose .rte-surface")! as never, "A letter"); });
    await settleEditor();
    await waitFor(() => createsOf(s, null).length >= 1, "the letter's create waiting", PAUSE_ROUNDS);
    const local = shown(s).find((d) => d.subject === "Written offline")!.id;
    await openListed(s, "Written offline", () => s.el.querySelector(".view-compose .rte-surface") != null);
    await act(async () => { typeInto(s.el.querySelector<HTMLElement>(".view-compose .rte-surface")! as never, "A letter, now longer"); });
    await settleEditor();
    await rounds(PAUSE_ROUNDS);
    return local;
  }
  const letters = (s: DraftShell): string[] => unsent(s).filter((d) => d.subject === "Written offline").map((d) => d.body ?? "");

  it("29 — a letter paused offline, opened again from Drafts, typed on: one row, the newest words, no write names the local id", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    const local = await letterReopened(s);
    await reconnect(s);
    expect(saves(s).map((m) => m.draftId), "a save named the unconfirmed local id").not.toContain(local);
    expect(letters(s)).toEqual(["A letter, now longer"]);
  }, 120_000);

  it("30 — the same, then Send: it goes once with the newest words, and no draft of it is left", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    s.spendSentRow.on = true;
    const local = await letterReopened(s);
    await act(async () => { composeSend(s.el)!.click(); });
    await rounds(20);
    await reconnect(s);
    expect(sendsOf(s).map((x) => [x.draftId === local, x.body])).toEqual([[false, "A letter, now longer"]]);
    expect(letters(s), "a draft of the sent letter stayed").toEqual([]);
  }, 120_000);

  it("31 — two pauses offline, closed, the older row opened from Drafts, reconnect: one row, the newest words", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    s.offline.on = true;
    await replyOn(s, "m1", "Dear Ann, yes");
    await waitFor(() => createsOf(s, "m1").length === 1, "pause 1 waiting", PAUSE_ROUNDS);
    await act(async () => { typeInto(replySurface(s.el)!, "Dear Ann, yes, Thursday at ten works"); });
    await waitFor(() => createsOf(s, "m1").length === 2, "pause 2 waiting", PAUSE_ROUNDS);
    await key("Escape");
    await waitFor(() => replySurface(s.el) == null, "closed");
    await act(async () => { window.location.hash = "#/drafts"; });
    const older = (): Element | undefined => [...s.el.querySelectorAll(".draft-row")]
      .find((r) => (r.textContent ?? "").includes("Dear Ann, yes") && !(r.textContent ?? "").includes("Thursday"));
    await waitFor(() => older()?.querySelector(".draft-open") != null, "the older row listed");
    await press(older()!.querySelector(".draft-open"), "its open button");
    await waitFor(() => replySurface(s.el) != null, "the reply editor again");
    await rounds(10);
    expect(replySurface(s.el)?.textContent ?? "", "the open wrote the older words over the newer").toContain("Thursday");
    await reconnect(s);
    expect(rowsOf(s, "m1")).toEqual(["Dear Ann, yes, Thursday at ten works"]);
  }, 120_000);

  it("32 — Discard in Drafts of a reply whose first save waits, then of one on the wire: nothing of either is left", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    s.offline.on = true;
    await replyOn(s, "m1", "Never mind this one");
    await waitFor(() => createsOf(s, "m1").length === 1, "the create waiting", PAUSE_ROUNDS);
    await key("Escape");
    await discardListed(s, "Never mind this one");
    await reconnect(s);
    expect({ rows: rowsOf(s, "m1"), creates: saves(s).filter((m) => m.inReplyToMessageId === "m1").length })
      .toEqual({ rows: [], creates: 0 });
    expect(replayableCreates(s), "a later boot would write the discarded reply").toHaveLength(0);

    let release: () => void = () => {};
    s.saveGate.wait = new Promise<void>((r) => { release = r; });
    await act(async () => { window.location.hash = "#/ohbox"; });
    await replyOn(s, "m2", "Nor this one");
    await waitFor(() => saves(s).some((m) => m.inReplyToMessageId === "m2"), "m2's create on the wire", PAUSE_ROUNDS);
    await key("Escape");
    await discardListed(s, "Nor this one");
    s.saveGate.wait = null;
    await act(async () => { release(); });
    await rounds(60);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(40);
    expect(rowsOf(s, "m2"), "the create on the wire stayed as a draft after its Discard").toEqual([]);
  }, 120_000);

  it("33 — a reply paused twice offline, the page reloaded online: one row, the newest words", async () => {
    const first = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    first.offline.on = true;
    await replyOn(first, "m1", "Before the reload");
    await waitFor(() => createsOf(first, "m1").length === 1, "pause 1 waiting", PAUSE_ROUNDS);
    await act(async () => { typeInto(replySurface(first.el)!, "Before the reload, and after a second pause"); });
    await waitFor(() => createsOf(first, "m1").length === 2, "pause 2 waiting", PAUSE_ROUNDS);
    const s = await reload(first, "#/ohbox");
    await rounds(40);
    await replyOn(s, "m1", "Before the reload, and after a second pause");
    await rounds(PAUSE_ROUNDS);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(40);
    expect(rowsOf(s, "m1")).toEqual(["Before the reload, and after a second pause"]);
  }, 120_000);

  it("34 — a letter paused twice offline, the page reloaded online: one row, the newest words", async () => {
    const first = await mountShell("#/ohbox", [message("m1")]);
    first.offline.on = true;
    await key("c");
    await waitFor(() => first.el.querySelector(".view-compose .rte-surface") != null, "the composer");
    await setInput(first.el.querySelector<HTMLInputElement>("#compose-to")!, "lena@example.invalid, ");
    await setInput(first.el.querySelector<HTMLInputElement>("#compose-subject")!, "Written offline");
    await act(async () => { typeInto(first.el.querySelector<HTMLElement>(".view-compose .rte-surface")! as never, "A letter"); });
    await settleEditor();
    await waitFor(() => createsOf(first, null).length === 1, "pause 1 waiting", PAUSE_ROUNDS);
    await act(async () => { typeInto(first.el.querySelector<HTMLElement>(".view-compose .rte-surface")! as never, "A letter, longer"); });
    await settleEditor();
    await waitFor(() => createsOf(first, null).length === 2, "pause 2 waiting", PAUSE_ROUNDS);
    const s = await reload(first, "#/compose");
    await waitFor(() => s.el.querySelector(".view-compose .rte-surface") != null, "the composer again");
    await rounds(PAUSE_ROUNDS);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(40);
    expect(letters(s)).toEqual(["A letter, longer"]);
  }, 120_000);

  /** Online, the first save hangs past a short deadline (the hold armed); Send waits; the Cancel is withdrawn. */
  async function hungThenCancelled(s: DraftShell, open: () => Promise<void>, send: () => HTMLButtonElement | undefined,
    queued: string, cancel: () => Promise<void>): Promise<() => Promise<void>> {
    let release: () => void = () => {};
    s.saveGate.wait = new Promise<void>((r) => { release = r; });
    await open();
    await waitFor(() => saves(s).some((m) => m.draftId === null), "the create on the wire", PAUSE_ROUNDS);
    await rounds(8);
    await act(async () => { send()!.click(); });
    await waitFor(() => (s.el.textContent ?? "").includes(queued), "Not sent yet");
    s.withdrawAnswer.outcome = "withdrawn";
    await cancel();
    await rounds(20);
    return async () => {
      s.saveGate.wait = null;
      await act(async () => { release(); });
      await rounds(80);
      await act(async () => { await s.engine.flushPending(); });
      await rounds(60);
    };
  }
  const hungReply = async (s: DraftShell): Promise<() => Promise<void>> => hungThenCancelled(s,
    () => replyOn(s, "m1", "Hung words"), () => replySend(s.el), en.reply.statusQueued, async () => {
      await act(async () => { replyCancel(s.el)!.click(); });
      await waitFor(() => replySurface(s.el) == null, "the dock closed");
    });

  it("35 — a reply's first save hung behind a hold, Send, then the dock's Cancel: nothing goes, and the words are one row", async () => {
    const s = await opened(true);
    const landed = await hungReply(s);
    await landed();
    expect({ sends: sendsOf(s).length, rows: rowsOf(s, "m1") }).toEqual({ sends: 0, rows: ["Hung words"] });
    // The landed create is the reply's row: Reply again writes it, never a second one.
    await replyOn(s, "m1", "Hung words, and more");
    await rounds(PAUSE_ROUNDS);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(20);
    expect(rowsOf(s, "m1")).toEqual(["Hung words, and more"]);
  }, 120_000);

  it("36 — the same, then Discard in Drafts before it lands: nothing of the reply is left", async () => {
    const s = await opened(true);
    const landed = await hungReply(s);
    await discardListed(s, "Hung words");
    await landed();
    expect({ sends: sendsOf(s).length, rows: rowsOf(s, "m1") }).toEqual({ sends: 0, rows: [] });
  }, 120_000);

  it("37 — a letter's first save hung behind a hold, Send, then Cancel and Discard message: nothing of it is left", async () => {
    const s = await opened(true);
    const landed = await hungThenCancelled(s, async () => {
      await key("c");
      await waitFor(() => s.el.querySelector(".view-compose .rte-surface") != null, "the composer");
      await setInput(s.el.querySelector<HTMLInputElement>("#compose-to")!, "lena@example.invalid, ");
      await setInput(s.el.querySelector<HTMLInputElement>("#compose-subject")!, "Written offline");
      await act(async () => { typeInto(s.el.querySelector<HTMLElement>(".view-compose .rte-surface")! as never, "A letter"); });
      await settleEditor();
    }, () => composeSend(s.el), en.compose.statusQueued, async () => {
      await press(s.el.querySelector(".compose-cancel"), "Cancel");
      await waitFor(() => s.el.querySelector(".compose-confirm") != null, "the discard question");
      await press([...s.el.querySelectorAll<HTMLButtonElement>(".compose-confirm button")]
        .find((b) => (b.textContent ?? "").trim() === en.compose.cancelConfirm) ?? null, "Discard message");
    });
    await landed();
    expect({ sends: sendsOf(s).length, letters: letters(s) }).toEqual({ sends: 0, letters: [] });
  }, 120_000);

  it("38 — paused twice offline, the first create taken on the reconnect, the page reloaded before the second lands, Reply, Send: no draft left", async () => {
    const first = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    first.offline.on = true;
    await replyOn(first, "m1", "Dear Ann, yes");
    await waitFor(() => createsOf(first, "m1").length === 1, "pause 1 waiting", PAUSE_ROUNDS);
    await act(async () => { typeInto(replySurface(first.el)!, "Dear Ann, yes, Thursday at ten works"); });
    await waitFor(() => createsOf(first, "m1").length === 2, "pause 2 waiting", PAUSE_ROUNDS);
    // The reconnect lands the first create; the signal goes again before the second leaves.
    let release: () => void = () => {};
    first.saveGate.wait = new Promise<void>((r) => { release = r; });
    first.offline.on = false;
    await online();
    await act(async () => { void first.engine.flushPending(); });
    await waitFor(() => saves(first).length >= 1, "the first create on the wire", PAUSE_ROUNDS);
    first.offline.on = true;
    first.saveGate.wait = null;
    await act(async () => { release(); });
    await rounds(40);
    expect({ rows: rowsOf(first, "m1").length, waiting: createsOf(first, "m1").length }).toEqual({ rows: 1, waiting: 1 });

    const s = await reload(first, "#/ohbox");
    s.spendSentRow.on = true;
    await rounds(40);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(20);
    await replyOn(s, "m1", "Dear Ann, yes, Thursday at ten works");
    await rounds(PAUSE_ROUNDS);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(20);
    expect(rowsOf(s, "m1"), "the reply's row and the second create's copy both stand").toEqual(["Dear Ann, yes, Thursday at ten works"]);
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => toasts().includes(en.reply.toastSent), "Reply sent.");
    await rounds(20);
    expect({ sends: sendsOf(s).map((x) => x.body), rows: rowsOf(s, "m1") })
      .toEqual({ sends: ["Dear Ann, yes, Thursday at ten works"], rows: [] });
  }, 120_000);
});

describe("a reply's creates replayed by a reload are judged from the boot, before Reply", () => {
  type Save = Extract<EngineMutation, { kind: "draft_save" }>;
  const saves = (s: DraftShell): Save[] => s.sent.filter((m): m is Save => m.kind === "draft_save");
  const rowsOf = (s: DraftShell, parent: string): Array<[string, string]> => unsent(s)
    .filter((d) => d.inReplyToMessageId === parent).map((d) => [d.id, d.body ?? ""]);
  const createsOf = (s: DraftShell, parent: string) => s.engine.pendingMutations()
    .filter((p) => p.mutation.kind === "draft_save" && p.mutation.draftId === null
      && ((p.mutation as { inReplyToMessageId?: string | null }).inReplyToMessageId ?? null) === parent);
  const sendsOf = (s: DraftShell) => sends(s)
    .map((m) => ({ draftId: (m as { draftId?: string | null }).draftId ?? null, body: (m as { body?: string }).body }));
  const reload = async (s: DraftShell): Promise<DraftShell> => {
    await unmountAll();
    resetComposerForTest();
    stubDom();
    const next = await mountShell("#/ohbox", [message("m1"), message("m2")], [], { store: s.store });
    next.spendSentRow.on = true;
    await rounds(40);
    await act(async () => { await next.engine.flushPending(); });
    await rounds(40);
    return next;
  };
  const NEWEST = "Dear Ann, yes, Thursday at ten works";
  const twoPausesOffline = async (s: DraftShell): Promise<void> => {
    s.offline.on = true;
    await replyOn(s, "m1", "Dear Ann, yes");
    await waitFor(() => createsOf(s, "m1").length === 1, "pause 1 waiting", PAUSE_ROUNDS);
    await act(async () => { typeInto(replySurface(s.el)!, NEWEST); });
    await waitFor(() => createsOf(s, "m1").length === 2, "pause 2 waiting", PAUSE_ROUNDS);
  };
  /** Case 38's first half: the first create taken on the reconnect, the second lands at the next boot. */
  async function landedAtBoot(): Promise<{ s: DraftShell; stored: string }> {
    const first = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    await twoPausesOffline(first);
    let release: () => void = () => {};
    first.saveGate.wait = new Promise<void>((r) => { release = r; });
    first.offline.on = false;
    await online();
    await act(async () => { void first.engine.flushPending(); });
    await waitFor(() => saves(first).length >= 1, "the first create on the wire", PAUSE_ROUNDS);
    first.offline.on = true;
    first.saveGate.wait = null;
    await act(async () => { release(); });
    await rounds(40);
    const stored = rowsOf(first, "m1")[0]![0];
    return { s: await reload(first), stored };
  }
  /** Both creates land at the boot: the older words take the reply's row, the newer stand beside it. */
  async function bothLandedAtBoot(): Promise<{ s: DraftShell; older: string; copy: string }> {
    const first = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    await twoPausesOffline(first);
    const s = await reload(first);
    const id = (words: string): string => rowsOf(s, "m1").find(([, b]) => b === words)?.[0] ?? "";
    return { s, older: id("Dear Ann, yes"), copy: id(NEWEST) };
  }
  async function openFromDrafts(s: DraftShell, id: string): Promise<void> {
    await act(async () => { window.location.hash = "#/drafts"; });
    const row = (): Element | null => s.el.querySelector(`.draft-row[data-id="${id}"]`);
    await waitFor(() => row()?.querySelector(".draft-open") != null, `${id} listed in Drafts`);
    await press(row()!.querySelector(".draft-open"), "its open button");
    await waitFor(() => replySurface(s.el) != null, "the reply editor");
    await rounds(10);
  }
  async function sendAndSettle(s: DraftShell): Promise<void> {
    await rounds(PAUSE_ROUNDS);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(20);
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => toasts().includes(en.reply.toastSent), "Reply sent.", 200);
    await rounds(40);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(40);
  }

  it("39 — the second create lands at the boot beside a row holding its words: one row before Reply, the newest words", async () => {
    const { s } = await landedAtBoot();
    await rounds(40);
    expect(rowsOf(s, "m1").map(([, b]) => b)).toEqual([NEWEST]);
  }, 120_000);

  it("40 — the same, reloaded once more, then Reply and Send: one send, no draft left", async () => {
    const { s } = await landedAtBoot();
    const again = await reload(s);
    await replyOn(again, "m1", NEWEST);
    await sendAndSettle(again);
    expect({ sends: sendsOf(again).length, left: rowsOf(again, "m1") }).toEqual({ sends: 1, left: [] });
  }, 120_000);

  it("41 — both creates land at the boot; the newer copy opened from Drafts and sent: one send from it, no draft left", async () => {
    const { s, older, copy } = await bothLandedAtBoot();
    expect([older, copy].every((x) => x !== "")).toBe(true);
    await openFromDrafts(s, copy);
    await sendAndSettle(s);
    expect({ sends: sendsOf(s), left: rowsOf(s, "m1") }).toEqual({ sends: [{ draftId: copy, body: NEWEST }], left: [] });
  }, 120_000);

  it("42 — the copy bound by Drafts while its claim waits for the reply's words: typed on, the row survives and the send goes from it", async () => {
    const { s, copy } = await bothLandedAtBoot();
    await openFromDrafts(s, copy);
    await act(async () => { typeInto(replySurface(s.el)!, `${NEWEST}, and Friday too`); });
    await rounds(PAUSE_ROUNDS);
    await act(async () => { await s.engine.flushPending(); });
    await rounds(40);
    expect(rowsOf(s, "m1"), "the bound row was deleted as its own copy").toContainEqual([copy, `${NEWEST}, and Friday too`]);
    await sendAndSettle(s);
    expect(sendsOf(s)).toEqual([{ draftId: copy, body: `${NEWEST}, and Friday too` }]);
  }, 120_000);

  it("43 — control: the reply's stored row opened from Drafts and sent: no draft left", async () => {
    const { s, stored } = await landedAtBoot();
    await openFromDrafts(s, stored);
    await sendAndSettle(s);
    expect({ sends: sendsOf(s).map((x) => x.draftId), left: rowsOf(s, "m1") }).toEqual({ sends: [stored], left: [] });
  }, 120_000);

  it("44 — control: a reply row written on another device, and the older row changed there since, both stay", async () => {
    const { s, older, copy } = await bothLandedAtBoot();
    const held = s.store.get<EngineDraft>("draft", older)!;
    s.remote.push(
      { type: "draft", op: "create", id: "d-phone", seq: 0, updatedAt: NOW.toISOString(), entity: replyDraft("d-phone", "m1", "Words from the phone") } as never,
      { type: "draft", op: "update", id: older, seq: 0, updatedAt: NOW.toISOString(), entity: { ...held, body: "Dear Ann, changed on the phone" } } as never,
    );
    await act(async () => { await s.engine.syncOnce().catch(() => undefined); });
    await rounds(20);
    await openFromDrafts(s, copy);
    await sendAndSettle(s);
    expect({ sends: sendsOf(s).map((x) => x.draftId), left: rowsOf(s, "m1").map(([, b]) => b).sort() })
      .toEqual({ sends: [copy], left: ["Dear Ann, changed on the phone", "Words from the phone"] });
  }, 120_000);
});
