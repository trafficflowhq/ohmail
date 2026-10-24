/** @vitest-environment jsdom */
/**
 * THE TWO ROWS THE SENT-ELSEWHERE FIX LEFT OPEN, through the shipped shell and a real `/sync` delta.
 * A draft open here that another device DELETES: the editor stayed bound to a gone row, promised a
 * save it could not make, and Send went nowhere in silence. And a draft another device SENT while
 * this tab was closed: reopening cleared the words typed here that the row never held.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineDraft, EngineMutation, SyncChange } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { AUTOSAVE_DELAY_MS } from "../app/shell/compose-autosave";
import { composeSessionId, handOffComposer, readComposeDraft, readComposeRow, resetComposerForTest } from "../app/shell/compose";
import { COMPOSE_SEND_KEY } from "../app/shell/mail-send";
import { claimSendLock, SEND_LOCK_FORMAT, type SendLock } from "../app/shell/send-lock";
import { act, mountShell, NOW, press, stubDom, unmountAll, waitFor, type DraftShell } from "./_draft-shell.js";

const compose = messages.compose as unknown as Record<string, string>;
const drafts = messages.drafts as unknown as Record<string, string>;
const D = "d-gone";

const letter = (over: Partial<EngineDraft> = {}): EngineDraft => ({
  id: D, mailboxId: "mb1", threadId: null, inReplyToMessageId: null,
  subject: "Plans for Friday", body: "Written in this tab.",
  to: [{ name: null, address: "lena@example.invalid" }], cc: [], bcc: [],
  rationale: null, status: "draft",
  createdAt: "2026-09-27T08:40:00.000Z", updatedAt: "2026-09-27T08:40:00.000Z",
  ...over,
} as unknown as EngineDraft);

/** The server's delta for a delete another device made of this row. */
const deletedElsewhere = (): SyncChange => ({
  type: "draft", op: "delete", id: D, seq: 0, updatedAt: NOW.toISOString(), entity: null,
} as unknown as SyncChange);

let shell: DraftShell;
const q = <T extends Element>(sel: string): T | null => shell.el.querySelector<T>(sel);
const text = (): string => shell.el.textContent ?? "";
const button = (label: string): HTMLButtonElement | null =>
  Array.from(shell.el.querySelectorAll<HTMLButtonElement>(".view-compose button"))
    .find((b) => (b.textContent ?? "").trim().startsWith(label) && !/later/i.test(b.textContent ?? "")) ?? null;
const saves = (): Array<{ draftId?: string | null; subject?: string }> =>
  shell.sent.filter((m) => m.kind === "draft_save") as Array<{ draftId?: string | null; subject?: string }>;
const sends = (): EngineMutation[] => shell.sent.filter((m) => m.kind === "mail_send");
const rows = (list: Array<{ draftId?: string | null; subject?: string }>): Array<{ row: string | null; subject?: string }> =>
  list.map((m) => ({ row: m.draftId ?? null, subject: m.subject }));

async function typeSubject(value: string): Promise<void> {
  const input = q<HTMLInputElement>("#compose-subject")!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const pause = async (ms: number): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const sync = async (): Promise<void> => { await act(async () => { await shell.engine.syncOnce().catch(() => undefined); }); };

async function openLetter(over: Partial<EngineDraft> = {}): Promise<void> {
  shell = await mountShell("#/drafts", [], [letter(over)]);
  await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
  await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
  await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
}

/** This tab's Delete in the Drafts list, confirmed, while the editor holds the row. */
async function deleteFromDrafts(): Promise<void> {
  await act(async () => { window.location.hash = "#/drafts"; });
  await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-discard`) !== null, "the row in Drafts");
  await press(q(`.draft-row[data-id="${D}"] .draft-discard`), "Delete");
  const confirm = Array.from(shell.el.querySelectorAll<HTMLButtonElement>(".draft-confirm button"))
    .find((b) => (b.textContent ?? "").trim() === drafts.discardConfirm) ?? null;
  await press(confirm, "confirm the delete");
}

/** Open the letter, then let another device's delete arrive on `/sync`. */
async function openThenDeletedElsewhere(): Promise<void> {
  await openLetter();
  shell.remote.push(deletedElsewhere());
  await sync();
  await waitFor(() => shell.store.isTombstoned("draft", D), "the delete applied");
}

/** Close the tab as `pagehide` does, then reopen Compose in a new tab over a mirror where the row is sent. */
async function reopenSent(
  subject = "Plans for Friday", mirror: "sent" | "draft" | "empty" = "sent", ownRecord = false,
): Promise<void> {
  handOffComposer();
  await unmountAll();
  window.sessionStorage.clear();
  resetComposerForTest();
  stubDom();
  const sent = letter({ subject, status: "sent" as never, body: null as never });
  shell = await mountShell("#/compose", [], mirror === "sent" ? [sent] : mirror === "draft" ? [letter()] : []);
  if (mirror === "sent") return;
  // THIS BROWSER'S OWN SEND, its tab gone before the answer: the record the press wrote, unanswered.
  if (ownRecord) {
    claimSendLock({
      v: SEND_LOCK_FORMAT, lane: COMPOSE_SEND_KEY, key: "KEY-OWN", at: Date.now(), draftId: D,
      fp: "fp-own", session: composeSessionId(),
    } as SendLock, () => false);
  }
  // The send reaches this tab on `/sync`, after it has opened — past the first pause when nothing
  // is bound (the restored form's save waited on the row and ran for nothing).
  await pause(mirror === "empty" ? AUTOSAVE_DELAY_MS + 400 : 300);
  shell.remote.push({ type: "draft", op: mirror === "draft" ? "update" : "create", id: D, seq: 0, updatedAt: NOW.toISOString(), entity: sent } as unknown as SyncChange);
  await sync();
}

beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); resetComposerForTest(); stubDom(); });
afterEach(async () => { await unmountAll(); });

describe("a draft deleted on another device while it is open here", () => {
  it("says so at once, and stops promising to save", async () => {
    await openThenDeletedElsewhere();
    await waitFor(() => text().includes(compose.deletedElsewhere ?? "\u0000"), "the sentence", 20).catch(() => undefined);
    expect({ says: text().includes(compose.deletedElsewhere ?? "\u0000"), promises: text().includes(compose.draftNote!) },
      "the editor stayed silent over a deleted draft, or still promised a save").toEqual({ says: true, promises: false });
  }, 30_000);

  it("keeps what is typed afterwards as a NEW draft, and never writes to the deleted row", async () => {
    await openThenDeletedElsewhere();
    const before = saves().length;
    await typeSubject("Plans for Friday, and Saturday");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > before, "a save of the new text", 40).catch(() => undefined);
    expect(rows(saves().slice(before)), "the words typed after the delete were not kept, or went to the deleted row")
      .toEqual([{ row: null, subject: "Plans for Friday, and Saturday" }]);
  }, 30_000);

  it("words typed before the delete arrived, and never saved, are kept as the new draft", async () => {
    await openLetter();
    await typeSubject("Plans for Friday, typed in the pause");
    shell.remote.push(deletedElsewhere());
    await sync();
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > 0, "a save of the typed words", 40).catch(() => undefined);
    expect(rows(saves()), "the words typed in the pause went to the deleted row, or nowhere")
      .toEqual([{ row: null, subject: "Plans for Friday, typed in the pause" }]);
    expect(text().includes(compose.deletedElsewhere ?? "\u0000")).toBe(true);
  }, 30_000);

  it("Send says why and offers the letter as a new one, unchanged or not", async () => {
    await openThenDeletedElsewhere();
    await press(button("Send"), "Send");
    await pause(200);
    expect({ sentGoneRow: sends().filter((m) => (m as { draftId?: string }).draftId === D).length, why: text().includes(compose.deletedElsewhereSend ?? "\u0000") },
      "Send went nowhere in silence, or sent the deleted row").toEqual({ sentGoneRow: 0, why: true });
    const offer = button(compose.sendAsNew!);
    expect(offer, "no offer to send the letter as a new one").not.toBeNull();
    await press(offer, "send as a new letter");
    await waitFor(() => sends().length > 0, "the new letter on the wire");
    const m = sends()[0] as { draftId?: string | null; subject?: string };
    expect({ row: m.draftId === D ? "the deleted row" : "a new row", subject: m.subject })
      .toEqual({ row: "a new row", subject: "Plans for Friday" });
  }, 30_000);

  it("a delete of this tab's that the server refused does not hide a later delete from another device", async () => {
    await openLetter();
    shell.refuseDiscard.on = true;
    await deleteFromDrafts();
    await waitFor(() => shell.sent.some((m) => m.kind === "draft_discard"), "the refused delete");
    await pause(200);
    shell.refuseDiscard.on = false;
    // The refused Discard emptied the editor; the letter is opened again from Drafts.
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter still in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter again");
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
    shell.remote.push(deletedElsewhere());
    await sync();
    await act(async () => { window.location.hash = "#/compose"; });
    await waitFor(() => text().includes(compose.deletedElsewhere ?? "\u0000"), "the sentence", 20).catch(() => undefined);
    expect(text().includes(compose.deletedElsewhere ?? "\u0000"), "a refused delete of this tab's masked the real one").toBe(true);
  }, 30_000);

  it("Cancel says what it closes: the draft is already gone", async () => {
    await openThenDeletedElsewhere();
    await press(q<HTMLButtonElement>(".compose-cancel"), "Cancel");
    expect(q<HTMLElement>("#compose-cancel-what")?.textContent, "Cancel promised to delete a draft that is gone")
      .toBe(compose.cancelWhatDeletedElsewhere);
  }, 30_000);

  it("the server's 404 to this editor's own save says so before any /sync does, and the words become a new draft", async () => {
    await openLetter();
    shell.serverGone.add(D);
    await typeSubject("Plans for Friday, after the delete");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length >= 2, "the refused save and the new draft", 40).catch(() => undefined);
    expect(rows(saves()), "the 404 left the editor bound to the gone row, or the words were lost")
      .toEqual([
        { row: D, subject: "Plans for Friday, after the delete" },
        { row: null, subject: "Plans for Friday, after the delete" },
      ]);
    expect(text().includes(compose.deletedElsewhere ?? "\u0000"), "the editor said nothing about the 404").toBe(true);
  }, 30_000);
});

describe("a draft deleted on another device across a full resync (410)", () => {
  /* DRAFT-DELETED-ELSEWHERE-ACROSS-A-RESYNC-STAYS-SILENT: the re-bootstrap's replay simply lacks the
     row, so no tombstone arrives and no 404 comes back to a save the mirror refuses locally. */
  it("asks the server once after the drain, says so, and keeps what is typed as a new draft", async () => {
    await openLetter();
    shell.serverGone.add(D);
    shell.resync.armed = true;
    await sync();
    await waitFor(() => text().includes(compose.deletedElsewhere ?? "\u0000"), "the sentence", 40).catch(() => undefined);
    expect(text().includes(compose.deletedElsewhere ?? "\u0000"), "the editor stayed silent over a row the resync dropped").toBe(true);
    const before = saves().length;
    await typeSubject("Plans for Friday, after the resync");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > before, "a save of the new text", 40).catch(() => undefined);
    expect(rows(saves().slice(before)), "the words typed after the resync were not kept as a new draft")
      .toEqual([{ row: null, subject: "Plans for Friday, after the resync" }]);
  }, 30_000);

  it("CONTROL: a row the server still holds is not called deleted when the resync leaves it out", async () => {
    await openLetter();
    shell.resync.armed = true;
    await sync();
    await pause(300);
    await sync();
    await pause(300);
    expect(text().includes(compose.deletedElsewhere ?? "\u0000"), "a held row was called deleted").toBe(false);
  }, 30_000);
});

describe("a draft sent from another device while this tab was closed", () => {
  it("keeps the words typed here that the row never held, as a new draft, and says why", async () => {
    await openLetter();
    await typeSubject("Plans for Friday, typed before closing");
    await reopenSent();
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > 0, "a save of the kept words", 40).catch(() => undefined);
    expect({ form: q<HTMLInputElement>("#compose-subject")?.value ?? null, saves: rows(saves()) },
      "the reconcile cleared words the sent row never held")
      .toEqual({ form: "Plans for Friday, typed before closing", saves: [{ row: null, subject: "Plans for Friday, typed before closing" }] });
    expect(text().includes(compose.sentElsewhereKept ?? "\u0000"), "the editor did not say why").toBe(true);
  }, 30_000);
});

describe("a draft sent from another device while this tab was closed, told on /sync after it reopened", () => {
  for (const mirror of ["empty", "draft"] as const) {
    it(`mirror ${mirror} at the reopen: the words the row never held are kept as a new draft`, async () => {
      await openLetter();
      await typeSubject("Plans for Friday, typed before closing");
      await reopenSent("Plans for Friday", mirror);
      await pause(AUTOSAVE_DELAY_MS + 400);
      await waitFor(() => saves().some((m) => (m.draftId ?? null) === null), "a save of the kept words", 40).catch(() => undefined);
      expect({ saves: rows(saves()), kept: text().includes(compose.sentElsewhereKept ?? "\u0000") },
        "the words typed before closing were dropped once the send arrived")
        .toEqual({ saves: [{ row: null, subject: "Plans for Friday, typed before closing" }], kept: true });
    }, 30_000);
  }

  it("this browser's own send, its tab gone before the answer, is not another device's: nothing is kept", async () => {
    await openLetter();
    await typeSubject("Plans for Friday, as sent");
    await reopenSent("Plans for Friday, as sent", "draft", true);
    await pause(AUTOSAVE_DELAY_MS + 400);
    expect({ creates: saves().filter((m) => (m.draftId ?? null) === null).length, kept: text().includes(compose.sentElsewhereKept ?? "\u0000") },
      "a send of this browser's was kept as a new draft, and offered again").toEqual({ creates: 0, kept: false });
  }, 30_000);

  it("mirror draft at the reopen, nothing typed since the last save: cleared, no draft made", async () => {
    await openLetter();
    await typeSubject("Plans for Friday, saved");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > 0, "the save");
    await reopenSent("Plans for Friday, saved", "draft");
    await pause(AUTOSAVE_DELAY_MS + 400);
    expect({ creates: saves().filter((m) => (m.draftId ?? null) === null).length, kept: text().includes(compose.sentElsewhereKept ?? "\u0000"), buffer: readComposeDraft().subject },
      "a sent letter with nothing new was kept as a draft").toEqual({ creates: 0, kept: false, buffer: "" });
  }, 30_000);
});

describe("CONTROLS — nothing here is called deleted elsewhere, and nothing sent is kept", () => {
  it("this tab's own delete from Drafts, of the row the editor holds, is not 'deleted on another device'", async () => {
    await openLetter();
    await deleteFromDrafts();
    await waitFor(() => shell.store.isTombstoned("draft", D), "the delete confirmed");
    await act(async () => { window.location.hash = "#/compose"; });
    await pause(300);
    expect(text().includes(compose.deletedElsewhere ?? "\u0000"), "this tab's own delete was called another device's").toBe(false);
  }, 30_000);

  it("a full resync, mid-snapshot, is not a delete: the editor stays on its row and saves to it", async () => {
    await openLetter();
    let refill: () => void = () => {};
    shell.resync.gate = new Promise<void>((r) => { refill = r; });
    shell.resync.armed = true;
    let drain: Promise<unknown> = Promise.resolve();
    await act(async () => { drain = shell.engine.syncOnce().catch(() => undefined); });
    await waitFor(() => shell.resync.phase === 0 && shell.engine.read().get("draft", D) == null, "the mirror emptied mid-snapshot");
    await typeSubject("Plans for Friday, during the resync");
    await pause(AUTOSAVE_DELAY_MS + 400);
    const mid = text().includes(compose.deletedElsewhere ?? "\u0000");
    shell.remote.push({ type: "draft", op: "create", id: D, seq: 0, updatedAt: NOW.toISOString(), entity: letter() } as unknown as SyncChange);
    await act(async () => { refill(); await drain; });
    await waitFor(() => shell.engine.read().get("draft", D) != null, "the row back");
    await typeSubject("Plans for Friday, after the resync");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().some((m) => m.subject === "Plans for Friday, after the resync"), "the save after", 40).catch(() => undefined);
    expect({ mid, after: text().includes(compose.deletedElsewhere ?? "\u0000"), creates: saves().filter((m) => (m.draftId ?? null) === null).length },
      "an emptied mirror was read as a delete").toEqual({ mid: false, after: false, creates: 0 });
    expect(saves().filter((m) => m.subject === "Plans for Friday, after the resync").map((m) => m.draftId)).toEqual([D]);
  }, 30_000);

  it("a send of this tab's the server could not confirm is not 'deleted elsewhere' when its row goes", async () => {
    await openLetter();
    shell.refuseSend.on = true;
    shell.refuseSend.unverified = true;
    await press(button("Send"), "Send");
    await waitFor(() => sends().length === 1, "the unconfirmed send");
    await pause(300);
    shell.remote.push(deletedElsewhere());
    await sync();
    await pause(300);
    expect(text().includes(compose.deletedElsewhere ?? "\u0000"), "a send this browser is still waiting on was offered again").toBe(false);
  }, 30_000);

  it("typed, then erased back to what was saved: nothing new, so the letter sent elsewhere is cleared", async () => {
    await openLetter();
    await typeSubject("Plans for Friday, saved");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > 0, "the save");
    await typeSubject("Plans for Friday, saved, and more");
    await typeSubject("Plans for Friday, saved");
    await reopenSent("Plans for Friday, saved");
    await pause(AUTOSAVE_DELAY_MS + 400);
    expect({ buffer: readComposeDraft().subject, saves: saves().length, kept: text().includes(compose.sentElsewhereKept ?? "\u0000") },
      "the buffer lost what the row held, and the sent letter was kept as a draft").toEqual({ buffer: "", saves: 0, kept: false });
  }, 30_000);

  it("opened and closed unchanged: the letter sent elsewhere is cleared, and no draft is made of it", async () => {
    await openLetter();
    await reopenSent();
    await pause(AUTOSAVE_DELAY_MS + 400);
    expect({ buffer: readComposeDraft().subject, saves: saves().length, kept: text().includes(compose.sentElsewhereKept ?? "\u0000") },
      "an unchanged sent letter was kept as a draft").toEqual({ buffer: "", saves: 0, kept: false });
  }, 30_000);

  it("nothing typed since the last save: the letter sent elsewhere is cleared, and no draft is made of it", async () => {
    await openLetter();
    await typeSubject("Plans for Friday, saved");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > 0, "the save");
    await reopenSent("Plans for Friday, saved");
    await pause(AUTOSAVE_DELAY_MS + 400);
    expect({ buffer: readComposeDraft().subject, saves: saves().length, kept: text().includes(compose.sentElsewhereKept ?? "\u0000") },
      "a sent letter with nothing new was kept as a draft").toEqual({ buffer: "", saves: 0, kept: false });
  }, 30_000);
});

describe("this tab's Discard in Drafts of the letter the editor holds", () => {
  const creates = (): Array<{ row: string | null; subject?: string }> => rows(saves()).filter((m) => m.row === null);
  const reload = async (drafts: EngineDraft[] = []): Promise<void> => {
    await unmountAll();
    resetComposerForTest();
    stubDom();
    shell = await mountShell("#/drafts", [], drafts);
  };

  it("empties the editor: the next Compose is blank and nothing is written for the letter", async () => {
    await openLetter();
    await deleteFromDrafts();
    await waitFor(() => shell.store.isTombstoned("draft", D), "the delete confirmed");
    await act(async () => { window.location.hash = "#/compose"; });
    await pause(AUTOSAVE_DELAY_MS + 400);
    expect({
      subject: q<HTMLInputElement>("#compose-subject")?.value ?? null,
      resumed: text().includes(compose.resumedNote!),
      buffer: readComposeDraft().subject, row: readComposeRow(), creates: creates(),
    }, "the discarded letter came back in Compose").toEqual({ subject: "", resumed: false, buffer: "", row: null, creates: [] });
  }, 30_000);

  it("a reload after the Discard brings nothing back and creates nothing", async () => {
    await openLetter();
    await deleteFromDrafts();
    await waitFor(() => shell.store.isTombstoned("draft", D), "the delete confirmed");
    await reload();
    await sync();
    await pause(AUTOSAVE_DELAY_MS + 400);
    expect({ creates: creates(), buffer: readComposeDraft().subject }, "the reload re-saved the discarded letter")
      .toEqual({ creates: [], buffer: "" });
  }, 30_000);

  it("a Discard the server refuses (a send running) leaves the editor empty, the row listed, nothing written", async () => {
    await openLetter();
    shell.refuseDiscard.on = true;
    await deleteFromDrafts();
    await waitFor(() => shell.sent.some((m) => m.kind === "draft_discard"), "the refused delete");
    await pause(200);
    const listed = q(`.draft-row[data-id="${D}"]`) !== null;
    await act(async () => { window.location.hash = "#/compose"; });
    await pause(AUTOSAVE_DELAY_MS + 400);
    expect({ listed, subject: q<HTMLInputElement>("#compose-subject")?.value ?? null, saves: saves().length, row: readComposeRow() },
      "a refused Discard put the letter back in the editor, or wrote it").toEqual({ listed: true, subject: "", saves: 0, row: null });
  }, 30_000);
});

describe("a reload whose stored letter names a row deleted while the tab was closed", () => {
  const creates = (): Array<{ row: string | null; subject?: string }> => rows(saves()).filter((m) => m.row === null);
  async function reopenGone(): Promise<void> {
    handOffComposer();
    await unmountAll();
    window.sessionStorage.clear();
    resetComposerForTest();
    stubDom();
    shell = await mountShell("#/compose", [], [], { serverGone: [D] });
    await sync();
    await pause(AUTOSAVE_DELAY_MS + 400);
  }

  it("nothing typed since the last save: the stored copy is cleared and no draft is made", async () => {
    await openLetter();
    await typeSubject("Plans for Friday, saved");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > 0, "the save");
    await reopenGone();
    expect({ form: q<HTMLInputElement>("#compose-subject")?.value ?? null, buffer: readComposeDraft().subject, row: readComposeRow(), creates: creates() },
      "the reload re-saved a letter deleted on another device").toEqual({ form: "", buffer: "", row: null, creates: [] });
  }, 30_000);

  it("words typed after the last save are kept as a new draft, and the editor says why", async () => {
    await openLetter();
    await typeSubject("Plans for Friday, saved");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length > 0, "the save");
    await typeSubject("Plans for Friday, typed before closing");
    await reopenGone();
    await waitFor(() => creates().length > 0, "the kept words saved", 40).catch(() => undefined);
    expect({ creates: creates(), toGone: saves().filter((m) => m.draftId === D && m.subject?.includes("closing")).length },
      "the words typed before closing were lost, or written to the deleted row")
      .toEqual({ creates: [{ row: null, subject: "Plans for Friday, typed before closing" }], toGone: 0 });
    expect(text().includes(compose.deletedElsewhereKept ?? "\u0000"), "the editor did not say why").toBe(true);
  }, 30_000);
});
