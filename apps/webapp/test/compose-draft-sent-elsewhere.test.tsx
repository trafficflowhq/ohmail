/** @vitest-environment jsdom */
/**
 * A DRAFT SENT FROM ANOTHER DEVICE WHILE IT IS OPEN HERE SAYS SO. The shipped shell over
 * an engine whose next `/sync` carries the server's own delta for that send: the row comes back
 * `status: "sent"` with its text withheld (`draftRowToSnapshotDTO`). The editor then said nothing, kept
 * "Saved to your drafts after a moment" while saving nothing, Send did nothing in silence, and Cancel
 * said the letter stays in Drafts. Every word typed after the send was lost on reload.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineDraft, EngineMutation, SyncChange } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { AUTOSAVE_DELAY_MS } from "../app/shell/compose-autosave";
import { draftsList } from "@ohmail/client-engine";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import {
  act, DraftServer, message, mountShell, NOW, press, replySurface, stubDom, unmountAll, waitFor, type DraftShell,
} from "./_draft-shell.js";

const compose = messages.compose as unknown as Record<string, string>;
const D = "d-elsewhere";

const letter = (over: Partial<EngineDraft> = {}): EngineDraft => ({
  id: D, mailboxId: "mb1", threadId: null, inReplyToMessageId: null,
  subject: "Plans for Friday", body: "Written in this tab.",
  to: [{ name: null, address: "lena@example.invalid" }], cc: [], bcc: [],
  rationale: null, status: "draft",
  createdAt: "2026-09-27T08:40:00.000Z", updatedAt: "2026-09-27T08:40:00.000Z",
  ...over,
} as unknown as EngineDraft);

/** The server's delta for a send another device made of this row — the row, not a delete. */
const sentElsewhere = (): SyncChange => ({
  type: "draft", op: "update", id: D, seq: 0, updatedAt: NOW.toISOString(),
  entity: { ...letter(), status: "sent", body: null, html: null, bodyOmitted: "sent" },
} as unknown as SyncChange);

let shell: DraftShell;
const q = <T extends Element>(sel: string): T | null => shell.el.querySelector<T>(sel);
const text = (): string => shell.el.textContent ?? "";
const button = (label: string): HTMLButtonElement | null =>
  Array.from(shell.el.querySelectorAll<HTMLButtonElement>(".view-compose button"))
    .find((b) => (b.textContent ?? "").trim().startsWith(label) && !/later/i.test(b.textContent ?? "")) ?? null;
const saves = (): EngineMutation[] => shell.sent.filter((m) => m.kind === "draft_save");
const sends = (): EngineMutation[] => shell.sent.filter((m) => m.kind === "mail_send");

async function typeSubject(value: string): Promise<void> {
  const input = q<HTMLInputElement>("#compose-subject")!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const pause = async (ms: number): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

/** Open the letter from Drafts, as the tester did, and let the other device's send arrive. */
async function openThenSentElsewhere(): Promise<void> {
  shell = await mountShell("#/drafts", [], [letter()]);
  await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
  await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
  await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
  shell.remote.push(sentElsewhere());
  await act(async () => { await shell.engine.syncOnce().catch(() => undefined); });
  await waitFor(() => (shell.engine.read().get<{ status?: string }>("draft", D)?.status) === "sent", "the delta applied");
}

beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); stubDom(); });
afterEach(async () => { await unmountAll(); });

describe("a draft sent from another device while it is open here", () => {
  it("says so at once, and stops promising to save", async () => {
    await openThenSentElsewhere();
    await waitFor(() => text().includes(compose.sentElsewhere ?? "\u0000"), "the sentence", 20).catch(() => undefined);
    expect({ says: text().includes(compose.sentElsewhere ?? "\u0000"), promises: text().includes(compose.draftNote!) },
      "the editor stayed silent over a sent letter, or still promised a save").toEqual({ says: true, promises: false });
  }, 30_000);

  it("keeps what is typed afterwards as a NEW draft, and never writes to the sent row", async () => {
    await openThenSentElsewhere();
    const before = saves().length;
    await typeSubject("Plans for Friday, and Saturday");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > before, "a save of the new text", 40).catch(() => undefined);
    const after = saves().slice(before) as Array<{ draftId?: string | null; subject?: string }>;
    expect(after.map((m) => ({ row: m.draftId ?? null, subject: m.subject })),
      "the words typed after the send were not kept, or were written to the sent row")
      .toEqual([{ row: null, subject: "Plans for Friday, and Saturday" }]);
  }, 30_000);

  it("Send says why, never sends the sent row again, and offers the new text as a new letter", async () => {
    await openThenSentElsewhere();
    await typeSubject("Plans for Friday, and Saturday");
    await press(button("Send"), "Send");
    await pause(200);
    expect({ sentRowAgain: sends().filter((m) => (m as { draftId?: string }).draftId === D).length, why: text().includes(compose.sentElsewhereSend ?? "\u0000") },
      "Send did nothing in silence, or sent the sent row again").toEqual({ sentRowAgain: 0, why: true });
    const offer = button(compose.sendAsNew ?? "\u0000");
    expect(offer, "no offer to send the new text as a new letter").not.toBeNull();
    await press(offer, "send as a new letter");
    await waitFor(() => sends().length > 0, "the new letter on the wire");
    const m = sends()[0] as { draftId?: string | null; subject?: string };
    expect({ row: m.draftId === D ? "the sent row" : "a new row", subject: m.subject })
      .toEqual({ row: "a new row", subject: "Plans for Friday, and Saturday" });
  }, 30_000);

  it("an unchanged sent letter is not offered again: Send says it already went", async () => {
    await openThenSentElsewhere();
    await press(button("Send"), "Send");
    await pause(200);
    expect({ sends: sends().length, why: text().includes(compose.sentElsewhereSend ?? "\u0000"), offer: button(compose.sendAsNew ?? "\u0000") !== null })
      .toEqual({ sends: 0, why: true, offer: false });
  }, 30_000);

  it("Cancel states the true state: the letter was sent, nothing stays in Drafts", async () => {
    await openThenSentElsewhere();
    await press(q<HTMLButtonElement>(".compose-foot .compose-cancel, .compose-cancel"), "Cancel");
    const what = q<HTMLElement>("#compose-cancel-what")?.textContent ?? "";
    expect(what, "Cancel said the sent letter stays in Drafts").toBe(compose.cancelWhatSentElsewhere);
  }, 30_000);

  it("a reload brings nothing back as a draft: the unchanged sent letter leaves this browser's buffer", async () => {
    await openThenSentElsewhere();
    const { readComposeDraft, readComposeRow } = await import("../app/shell/compose.js");
    await waitFor(() => text().includes(compose.sentElsewhere!), "the sentence");
    expect({ subject: readComposeDraft().subject, row: readComposeRow() }, "a reload would restore the sent letter and save it as a draft")
      .toEqual({ subject: "", row: null });
  }, 30_000);

  it("words typed before the send's word arrived, and never saved, are kept as the new draft", async () => {
    shell = await mountShell("#/drafts", [], [letter()]);
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
    await typeSubject("Plans for Friday, typed in the pause");
    shell.remote.push(sentElsewhere());
    await act(async () => { await shell.engine.syncOnce().catch(() => undefined); });
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > 0, "a save of the typed words", 40).catch(() => undefined);
    expect((saves() as Array<{ draftId?: string | null; subject?: string }>).map((m) => ({ row: m.draftId ?? null, subject: m.subject })),
      "the words typed in the pause were counted as the sent letter and dropped")
      .toEqual([{ row: null, subject: "Plans for Friday, typed in the pause" }]);
    expect(text().includes(compose.sentElsewhere!)).toBe(true);
  }, 30_000);

  it("Discard after typing deletes only the new draft, and says what it deletes", async () => {
    await openThenSentElsewhere();
    await typeSubject("Plans for Friday, and Saturday");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > 0, "the new draft");
    const fresh = (shell.sent.find((m) => m.kind === "draft_save") as { draftId?: string | null }).draftId ?? null;
    expect(fresh, "premise: the new draft is a create").toBeNull();
    await press(q<HTMLButtonElement>(".compose-cancel"), "Cancel");
    expect(q<HTMLElement>("#compose-cancel-what")?.textContent).toBe(compose.cancelWhatSentElsewhereTyped);
    const confirm = Array.from(shell.el.querySelectorAll<HTMLButtonElement>(".compose-confirm button"))
      .find((b) => (b.textContent ?? "").trim() === compose.cancelConfirm) ?? null;
    await press(confirm, "Discard message");
    await waitFor(() => shell.sent.some((m) => m.kind === "draft_discard"), "the delete");
    const gone = shell.sent.filter((m) => m.kind === "draft_discard").map((m) => (m as { draftId?: string }).draftId);
    expect(gone.length === 1 && gone[0] !== D, `the delete named ${String(gone)}`).toBe(true);
  }, 30_000);
});

describe("CONTROLS — nothing here is called sent elsewhere", () => {
  it("editing offline: the save waits on the outbox, the ordinary sentence stands, nothing is called sent", async () => {
    shell = await mountShell("#/drafts", [], [letter()]);
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
    shell.offline.on = true;
    await typeSubject("Plans for Friday, written offline");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await act(async () => { await shell.engine.syncOnce().catch(() => undefined); });
    await waitFor(() => shell.engine.pendingMutations().length > 0, "the save on the outbox");
    expect({ note: text().includes(compose.draftNote!), elsewhere: text().includes(compose.sentElsewhere!) })
      .toEqual({ note: true, elsewhere: false });
  }, 30_000);

  it("an ordinary open letter autosaves to its own row and says the ordinary sentence", async () => {
    shell = await mountShell("#/drafts", [], [letter()]);
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
    await act(async () => { await shell.engine.syncOnce().catch(() => undefined); });
    await typeSubject("Plans for Friday, edited");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > 0, "the save");
    expect((saves() as Array<{ draftId?: string }>).map((m) => m.draftId)).toEqual([D]);
    expect({ note: text().includes(compose.draftNote!), elsewhere: text().includes(compose.sentElsewhere ?? "\u0000") })
      .toEqual({ note: true, elsewhere: false });
  }, 30_000);

  it("this tab's own send is not 'sent from another device'", async () => {
    shell = await mountShell("#/drafts", [], [letter()]);
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
    await press(button("Send"), "Send");
    await waitFor(() => sends().length === 1, "the send");
    await pause(300);
    expect((sends()[0] as { draftId?: string }).draftId).toBe(D);
    expect(text().includes(compose.sentElsewhere ?? "\u0000"), "our own send was called another device's").toBe(false);
  }, 30_000);

  it("this tab's own send, the server's sent row arriving on /sync before the send's answer", async () => {
    shell = await mountShell("#/drafts", [], [letter()]);
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
    let answer: () => void = () => {};
    shell.sendGate.wait = new Promise<void>((r) => { answer = r; });
    await press(button("Send"), "Send");
    await waitFor(() => sends().length === 1, "the send on the wire");
    shell.remote.push(sentElsewhere());
    await act(async () => { await shell.engine.syncOnce().catch(() => undefined); });
    await pause(300);
    expect(text().includes(compose.sentElsewhere!), "this tab's own send, still on the wire, was called another device's").toBe(false);
    shell.sendGate.wait = null;
    await act(async () => { answer(); });
    await pause(300);
    expect(text().includes(compose.sentElsewhere!)).toBe(false);
  }, 30_000);

  it("Discard of a live draft still deletes it, and says so", async () => {
    shell = await mountShell("#/drafts", [], [letter()]);
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
    await press(q<HTMLButtonElement>(".compose-cancel"), "Cancel");
    expect(q<HTMLElement>("#compose-cancel-what")?.textContent).toBe(compose.cancelWhat);
    const confirm = Array.from(shell.el.querySelectorAll<HTMLButtonElement>(".compose-confirm button"))
      .find((b) => (b.textContent ?? "").trim() === compose.cancelConfirm) ?? null;
    await press(confirm, "Discard message");
    await waitFor(() => shell.sent.some((m) => m.kind === "draft_discard"), "the delete");
    expect(shell.sent.filter((m) => m.kind === "draft_discard").map((m) => (m as { draftId?: string }).draftId)).toEqual([D]);
  }, 30_000);
});

/**
 * COMPOSE NEVER OPENS A LETTER ANOTHER DEVICE SENT. Two devices over one server: A is this shell, B a
 * headless engine. The tester's report: A started a letter, B sent it, Compose on A reopened it with
 * its words and recipients, and a new letter typed into it went to both audiences with the old words.
 */
describe("Compose after the letter went from another device", () => {
  type Send = { draftId?: string | null; to?: Array<{ address: string }>; subject?: string; body?: string };
  let server: DraftServer;
  const reply = (): string => replySurface(shell.el)?.textContent ?? "";
  const listed = (): string[] => draftsList(shell.engine.read(), NOW).map((d) => d.subject);
  const toasts = (): string => [...document.querySelectorAll(".toast, .toast-held")].map((n) => n.textContent ?? "").join(" | ");
  const go = async (hash: string): Promise<void> => { await act(async () => { window.location.hash = hash; }); await pause(200); };
  const drain = async (): Promise<void> => { await act(async () => { await shell.engine.syncOnce().catch(() => undefined); }); await pause(300); };
  const field = (id: string): string => q<HTMLInputElement>(`#${id}`)?.value ?? "";
  const surface = (): HTMLElement | null => q<HTMLElement>(".view-compose .rte-surface");
  async function setField(id: string, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(q<HTMLInputElement>(`#${id}`)!, value); q(`#${id}`)!.dispatchEvent(new Event("input", { bubbles: true })); });
  }
  async function write(to: string, subject: string, body: string): Promise<void> {
    await go("#/compose");
    await waitFor(() => surface() !== null, "the composer");
    await setField("compose-to", `${to}, `);
    await setField("compose-subject", subject);
    await act(async () => { typeInto(surface()! as never, body); });
    await settleEditor();
  }
  /** A writes a letter and its pause saves it to the server; the row is returned. */
  async function started(): Promise<EngineDraft> {
    server = new DraftServer();
    shell = await mountShell("#/ohbox", [message("m1")], [], { server });
    await write("lena@example.invalid", "Plans for Friday", "Shall we meet at noon?");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => server.rows.size === 1, "the letter saved to the server");
    return [...server.rows.values()][0]!;
  }
  /** B, another device, sends the row with what it holds. */
  async function sentOnB(row: EngineDraft): Promise<void> {
    const b = await server.device();
    const held = server.rows.get(row.id)!;
    const r = await b.mutate({
      kind: "mail_send", inReplyTo: null, draftId: row.id, mailboxId: "mb1", subject: held.subject, body: held.body ?? "",
      to: held.to, cc: [], bcc: [],
    } as EngineMutation);
    expect(r.status, "premise: B's send went").toBe("confirmed");
  }

  it("closed on A, sent on B: Compose on A is blank, and a new letter carries only its own audience and words", async () => {
    const row = await started();
    await go("#/ohbox");
    await sentOnB(row);
    await drain();
    await go("#/compose");
    await waitFor(() => surface() !== null, "the composer");
    expect({ to: field("compose-to"), subject: field("compose-subject"), body: surface()?.textContent ?? "", note: text().includes(compose.sentElsewhere!) },
      "Compose reopened the letter B sent").toEqual({ to: "", subject: "", body: "", note: false });
    await write("bo@example.invalid", "Lunch", "Lunch on Monday?");
    await press(button("Send"), "Send");
    await waitFor(() => sends().length === 1, "A's send");
    const m = sends()[0] as Send;
    expect({ row: m.draftId === row.id, to: m.to?.map((a) => a.address), subject: m.subject, body: m.body })
      .toEqual({ row: false, to: ["bo@example.invalid"], subject: "Lunch", body: "Lunch on Monday?" });
  }, 60_000);

  it("open on A when B sends: the note shows; closed, Compose is blank and nothing is kept", async () => {
    const row = await started();
    await sentOnB(row);
    await drain();
    await waitFor(() => text().includes(compose.sentElsewhere!), "the note");
    await go("#/ohbox");
    await go("#/compose");
    await waitFor(() => surface() !== null, "the composer");
    expect({ subject: field("compose-subject"), note: text().includes(compose.sentElsewhere!), drafts: listed() })
      .toEqual({ subject: "", note: false, drafts: [] });
  }, 60_000);

  const movedSaid = (): Promise<boolean> =>
    waitFor(() => toasts().includes(compose.sentElsewhereMovedToDrafts!), "the toast").then(() => true, () => false);
  /** Compose on A after the close: blank, no note, the typed words in Drafts once, and said. */
  async function composeAfterClose(toast: boolean): Promise<unknown> {
    await drain();
    await go("#/compose");
    await waitFor(() => surface() !== null, "the composer");
    return { subject: field("compose-subject"), note: text().includes(compose.sentElsewhere!), drafts: listed(), toast };
  }

  it("open on A when B sends, words typed after the note and closed inside the pause: Compose is blank, Drafts holds them", async () => {
    const row = await started();
    await sentOnB(row);
    await drain();
    await waitFor(() => text().includes(compose.sentElsewhere!), "the note");
    await setField("compose-subject", "A new plan for Monday");
    await go("#/ohbox");
    const said = await movedSaid();
    await pause(AUTOSAVE_DELAY_MS);
    expect(await composeAfterClose(said)).toEqual({ subject: "", note: false, drafts: ["A new plan for Monday"], toast: true });
  }, 60_000);

  it("the close's save held on the wire while the drain bringing B's send lands: Compose is blank, Drafts holds the words", async () => {
    const row = await started();
    await sentOnB(row);
    await setField("compose-subject", "Plans for Friday and Saturday");
    let release: () => void = () => {};
    shell.saveGate.wait = new Promise<void>((r) => { release = r; });
    const before = saves().length;
    await go("#/ohbox");
    await waitFor(() => saves().length > before, "the close's save on the wire");
    await drain();
    shell.saveGate.wait = null;
    await act(async () => { release(); });
    expect(await composeAfterClose(await movedSaid())).toEqual({ subject: "", note: false, drafts: ["Plans for Friday and Saturday"], toast: true });
  }, 60_000);

  it("Send as a new letter, handed off: no toast says the words are in Drafts, and the composer stays bound until it settles", async () => {
    server = new DraftServer([letter()]);
    shell = await mountShell("#/drafts", [message("m1")], [], { server, handOff: true });
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
    await waitFor(() => field("compose-subject") === "Plans for Friday", "the editor on the letter");
    await sentOnB(letter());
    await drain();
    await waitFor(() => text().includes(compose.sentElsewhere!), "the note");
    await setField("compose-subject", "Plans for Friday, and Saturday");
    await pause(AUTOSAVE_DELAY_MS + 500);
    await waitFor(() => [...server.rows.values()].some((d) => d.status === "draft"), "the words kept as a new draft");
    const kept = [...server.rows.values()].find((d) => d.status === "draft")!.id;
    await press(button("Send"), "Send");
    await pause(200);
    let release: () => void = () => {};
    shell.sendGate.wait = new Promise<void>((r) => { release = r; });
    await press(button(compose.sendAsNew!), "Send as a new letter");
    await waitFor(() => q(".view-compose") === null, "handed off");
    await pause(400);
    const { readComposeRow } = await import("../app/shell/compose.js");
    const whileSending = { toast: toasts().includes(compose.sentElsewhereMovedToDrafts!), bound: readComposeRow() === kept };
    shell.sendGate.wait = null;
    await act(async () => { release(); });
    await pause(1500);
    expect({ whileSending, toast: toasts().includes(compose.sentElsewhereMovedToDrafts!), rows: [...server.rows.values()].map((d) => d.status) })
      .toEqual({ whileSending: { toast: false, bound: true }, toast: false, rows: ["sent", "sent"] });
  }, 60_000);

  it("A's words saved offline are refused on reconnect: Compose is blank, Drafts holds them once, the sent row never", async () => {
    const row = await started();
    shell.offline.on = true;
    await setField("compose-subject", "Plans for Friday and Saturday");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => shell.engine.pendingMutations().some((p) => p.mutation.kind === "draft_save"), "A's save waiting");
    await go("#/ohbox");
    await sentOnB(row);
    shell.offline.on = false;
    const seen: string[][] = [];
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await act(async () => { await shell.engine.flushPending(); });
    seen.push(listed());
    await drain();
    seen.push(listed());
    await pause(AUTOSAVE_DELAY_MS);
    await act(async () => { await shell.engine.flushPending(); });
    await drain();
    seen.push(listed());
    await go("#/compose");
    await waitFor(() => surface() !== null, "the composer");
    const sentRow = [...server.rows.values()].filter((d) => d.status === "sent").map((d) => d.id);
    expect({
      subject: field("compose-subject"), drafts: listed(), sentRow, sentListed: seen.some((l) => l.includes("Plans for Friday")),
      toast: toasts().includes(compose.sentElsewhereMovedToDrafts ?? "\u0000"),
    }).toEqual({ subject: "", drafts: ["Plans for Friday and Saturday"], sentRow: [row.id], sentListed: false, toast: true });
  }, 60_000);

  it("control: an ordinary unfinished letter is still resumed by Compose", async () => {
    await started();
    await go("#/ohbox");
    await drain();
    await go("#/compose");
    await waitFor(() => surface() !== null, "the composer");
    expect({ subject: field("compose-subject"), body: surface()?.textContent ?? "" })
      .toEqual({ subject: "Plans for Friday", body: "Shall we meet at noon?" });
  }, 60_000);

  /** A reply written on A and closed; its row saved to the server. */
  async function replied(words: string): Promise<EngineDraft> {
    server = new DraftServer();
    shell = await mountShell("#/ohbox", [message("m1")], [], { server });
    await waitFor(() => q(".view-ohbox .row[data-id='m1']") != null, "the row");
    await press(q(".view-ohbox .row[data-id='m1']"), "the row");
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true })); });
    await settleEditor();
    await waitFor(() => replySurface(shell.el) != null, "the reply editor");
    await act(async () => { typeInto(replySurface(shell.el)!, words); });
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => server.rows.size === 1, "the reply saved to the server");
    return [...server.rows.values()][0]!;
  }
  const replyAgain = async (): Promise<void> => {
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true })); });
    await settleEditor();
    await waitFor(() => replySurface(shell.el) != null, "the reply editor again");
    await pause(300);
  };
  const closeReply = async (): Promise<void> => {
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await settleEditor();
    await waitFor(() => replySurface(shell.el) == null, "the reply closed");
  };

  it("the reply door — written on A, closed, sent on B: Reply on A opens an empty reply", async () => {
    const row = await replied("Thursday works for me");
    await closeReply();
    await sentOnB(row);
    await drain();
    await replyAgain();
    expect(reply(), "Reply reopened the words B sent").toBe("");
  }, 60_000);

  it("the reply door — words typed on A that its row never held are kept as a new draft, and said", async () => {
    const row = await replied("Thursday works for me");
    await closeReply();
    // A tab that died inside the pause leaves its words in the scratch only.
    window.localStorage.setItem("ohmail.ui.reply:m1", "Thursday works for me, at ten");
    await sentOnB(row);
    await drain();
    await replyAgain();
    expect({ reply: reply(), said: toasts().includes(messages.reply.sentElsewhereKept ?? "\u0000") })
      .toEqual({ reply: "Thursday works for me, at ten", said: true });
  }, 60_000);
});
