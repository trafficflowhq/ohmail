/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OUTBOX_TYPE, type EngineDraft, type EngineMutation } from "@ohmail/client-engine";
import en from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import { readComposeRow } from "../app/shell/compose";
import {
  act, message, mountShell, press, replySurface, stubDom, unmountAll, waitFor, type DraftShell,
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
 * landed create made (`createdDraftOf`) → cases 6 to 8 red.
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
});
