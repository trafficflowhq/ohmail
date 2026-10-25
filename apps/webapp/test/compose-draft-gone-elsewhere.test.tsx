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
import { act, message, mountShell, NOW, press, stubDom, unmountAll, waitFor, type DraftShell } from "./_draft-shell.js";

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

describe("a save that waited offline, then the row was deleted on another device", () => {
  const creates = (): Array<{ row: string | null; subject?: string }> => rows(saves()).filter((m) => m.row === null);
  const online = async (): Promise<void> => { await act(async () => { window.dispatchEvent(new Event("online")); }); };
  /** Typed offline: the pause's save waits on the outbox, and lands when the connection is back. */
  async function editThroughTheQueue(words: string, leave = false): Promise<void> {
    shell.offline.on = true;
    await typeSubject(words);
    await pause(AUTOSAVE_DELAY_MS + 400);
    if (leave) {
      await act(async () => { window.location.hash = "#/ohbox"; });
      await pause(300);
    }
    shell.offline.on = false;
    await online();
    await waitFor(() => saves().some((m) => m.draftId === D && m.subject === words), "the queued save landed", 200);
    await pause(AUTOSAVE_DELAY_MS + 400);
  }
  async function reload(hash: string): Promise<void> {
    shell.offline.on = true;
    handOffComposer();
    await unmountAll();
    window.sessionStorage.clear();
    resetComposerForTest();
    stubDom();
    shell = await mountShell(hash, [], [], { serverGone: [D] });
    await sync();
    await pause(AUTOSAVE_DELAY_MS + 400);
    await sync();
    await pause(AUTOSAVE_DELAY_MS + 400);
  }

  it("landed before the tab closed: a reload clears the letter and makes no draft", async () => {
    await openLetter();
    await editThroughTheQueue("Plans for Friday, edited offline");
    await reload("#/compose");
    expect({ creates: creates(), form: q<HTMLInputElement>("#compose-subject")?.value ?? null, row: readComposeRow(), kept: text().includes(compose.deletedElsewhereKept!) },
      "a letter whose every word reached the deleted row was made again").toEqual({ creates: [], form: "", row: null, kept: false });
  }, 60_000);

  it("landed after the composer was left: a reload makes no draft", async () => {
    await openLetter();
    await editThroughTheQueue("Plans for Friday, written on the train", true);
    await reload("#/ohbox");
    expect({ creates: creates(), row: readComposeRow() }).toEqual({ creates: [], row: null });
  }, 60_000);

  it("landed, then the delete arrives while the tab is open: nothing is made again", async () => {
    await openLetter();
    await editThroughTheQueue("Plans for Friday, edited offline");
    shell.remote.push(deletedElsewhere());
    await sync();
    await waitFor(() => shell.store.isTombstoned("draft", D), "the delete applied");
    await pause(AUTOSAVE_DELAY_MS + 400);
    expect(creates(), "a letter whose every word reached the deleted row was made again").toEqual([]);
  }, 60_000);

  it("still waiting when the delete arrives here: the words stay, and no draft is made of them", async () => {
    await openLetter();
    shell.offline.on = true;
    await typeSubject("Plans for Friday, maybe saved");
    await pause(AUTOSAVE_DELAY_MS + 400);
    shell.remote.push(deletedElsewhere());
    await sync();
    await waitFor(() => shell.store.isTombstoned("draft", D), "the delete applied");
    shell.offline.on = false;
    await online();
    await pause(AUTOSAVE_DELAY_MS + 400);
    expect({ creates: creates(), form: q<HTMLInputElement>("#compose-subject")?.value ?? null, says: text().includes(compose.deletedElsewhere!) })
      .toEqual({ creates: [], form: "Plans for Friday, maybe saved", says: true });
  }, 60_000);

  it("still waiting when the tab closed: the words stay, no draft is made until they change, and none is claimed unsaved", async () => {
    await openLetter();
    shell.offline.on = true;
    await typeSubject("Plans for Friday, maybe saved");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await reload("#/compose");
    const first = { creates: creates().length, form: q<HTMLInputElement>("#compose-subject")?.value ?? null, kept: text().includes(compose.deletedElsewhereKept!), says: text().includes(compose.deletedElsewhere!) };
    await reload("#/compose");
    const second = { creates: creates().length, form: q<HTMLInputElement>("#compose-subject")?.value ?? null };
    shell.offline.on = false;
    await typeSubject("Plans for Friday, maybe saved, and more");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => creates().length > 0, "the changed words saved", 40).catch(() => undefined);
    expect({ first, second, then: creates() }).toEqual({
      first: { creates: 0, form: "Plans for Friday, maybe saved", kept: false, says: true },
      second: { creates: 0, form: "Plans for Friday, maybe saved" },
      then: [{ row: null, subject: "Plans for Friday, maybe saved, and more" }],
    });
  }, 90_000);
});

describe("a draft changed on another device while it is open here", () => {
  const creates = (): Array<{ row: string | null; subject?: string }> => rows(saves()).filter((m) => m.row === null);
  async function openVersioned(): Promise<void> {
    shell = await mountShell("#/drafts", [], [letter()], { versions: true });
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
  }

  it("typing over the other version keeps both texts: the row keeps theirs, what was typed here is a new draft, and it says so", async () => {
    await openVersioned();
    await shell.editElsewhere(D, { body: "Written on the other device." });
    await typeSubject("Plans for Friday, typed here");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => creates().length > 0, "the typed words saved as a new draft", 40).catch(() => undefined);
    await sync();
    expect({
      creates: creates(), theirs: shell.store.get<EngineDraft>("draft", D)?.body,
      says: text().includes(compose.changedElsewhere ?? "\u0000"),
    }, "the other device's words were overwritten, or the typed words were lost in silence").toEqual({
      creates: [{ row: null, subject: "Plans for Friday, typed here" }], theirs: "Written on the other device.", says: true,
    });
  }, 30_000);

  it("Send over the other version sends nothing; Send as new sends what is on screen", async () => {
    await openVersioned();
    await shell.editElsewhere(D, { body: "Written on the other device." });
    await typeSubject("Plans for Friday, typed here");
    await press(button("Send"), "Send");
    await waitFor(() => text().includes(compose.changedElsewhere ?? "\u0000"), "the fork said", 40).catch(() => undefined);
    await pause(200);
    await press(button("Send"), "Send again");
    await pause(200);
    expect({ note: text().includes(compose.changedElsewhereSend ?? "\u0000"), took: sends().length },
      "a press sent the other version, or nothing said why").toEqual({ note: true, took: 1 });
    await press(button(compose.sendAsNew!), "Send as new");
    await waitFor(() => sends().length === 2, "the words on screen sent");
    const m = sends()[1] as { draftId?: string | null; subject?: string };
    expect({ row: m.draftId === D ? "theirs" : "new", subject: m.subject }).toEqual({ row: "new", subject: "Plans for Friday, typed here" });
  }, 30_000);

  it("Send handed off over the other version: the words typed since the last save become a new draft and stay in the buffer", async () => {
    shell = await mountShell("#/drafts", [], [letter()], { versions: true, handOff: true });
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open the letter");
    await waitFor(() => q<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the editor on the letter");
    await shell.editElsewhere(D, { body: "Written on the other device." });
    await sync();
    await typeSubject("Plans for Friday, typed here");
    await press(button("Send"), "Send");
    await waitFor(() => creates().length > 0, "the typed words saved as a new draft", 120).catch(() => undefined);
    expect({ took: sends().length, creates: creates(), buffer: readComposeDraft().subject, says: text().includes(compose.changedElsewhere!) },
      "the line said the words were kept as a new draft, and none was made").toEqual({
      took: 1, creates: [{ row: null, subject: "Plans for Friday, typed here" }], buffer: "Plans for Friday, typed here", says: true,
    });
  }, 30_000);

  it("autosaved, then the other device's write, then Send: what is on screen becomes a new draft, and the buffer keeps it", async () => {
    await openVersioned();
    await typeSubject("Plans for Friday, typed here");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length >= 1, "the autosave", 40);
    await shell.editElsewhere(D, { body: "Written on the other device." });
    await sync();
    await press(button("Send"), "Send");
    await waitFor(() => creates().length > 0, "the words on screen saved as a new draft", 120).catch(() => undefined);
    expect({ creates: creates(), buffer: readComposeDraft().subject, says: text().includes(compose.changedElsewhere!) })
      .toEqual({ creates: [{ row: null, subject: "Plans for Friday, typed here" }], buffer: "Plans for Friday, typed here", says: true });
  }, 30_000);

  it("until the new draft is saved, nothing says it is kept", async () => {
    await openVersioned();
    await shell.editElsewhere(D, { body: "Written on the other device." });
    await sync();
    await typeSubject("Plans for Friday, typed here");
    let open: () => void = () => {};
    shell.saveGate.wait = new Promise<void>((r) => { open = r; });
    await press(button("Send"), "Send");
    await waitFor(() => creates().length > 0, "the new draft on the wire", 120).catch(() => undefined);
    const waiting = { kept: text().includes(compose.changedElsewhere!), unsaved: text().includes(compose.changedElsewhereUnsaved ?? "\u0000") };
    shell.saveGate.wait = null;
    open();
    await waitFor(() => text().includes(compose.changedElsewhere!), "the new draft said kept", 120).catch(() => undefined);
    expect({ waiting, saved: text().includes(compose.changedElsewhere!) }, "it said kept before anything was saved")
      .toEqual({ waiting: { kept: false, unsaved: true }, saved: true });
  }, 30_000);

  it("a save queued offline and refused at reconnect, the composer closed: its words become a new draft, said once", async () => {
    await openVersioned();
    shell.offline.on = true;
    await typeSubject("Plans for Friday, typed offline");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await act(async () => { window.location.hash = "#/drafts"; });
    await pause(300);
    await shell.editElsewhere(D, { body: "Written on the other device." });
    shell.offline.on = false;
    await act(async () => { await shell.engine.flushPending().catch(() => undefined); });
    await sync();
    await pause(300);
    expect({
      creates: creates(), theirs: shell.store.get<EngineDraft>("draft", D)?.body,
      said: text().split(compose.keptAsNewElsewhere ?? "\u0000").length - 1,
    }, "the words typed offline were dropped in silence").toEqual({
      creates: [{ row: null, subject: "Plans for Friday, typed offline" }], theirs: "Written on the other device.", said: 1,
    });
  }, 30_000);

  it("a save queued offline and refused at reconnect, the composer open: it takes the new draft, and later words save to it", async () => {
    await openVersioned();
    shell.offline.on = true;
    await typeSubject("Plans for Friday, typed offline");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await shell.editElsewhere(D, { body: "Written on the other device." });
    shell.offline.on = false;
    await act(async () => { await shell.engine.flushPending().catch(() => undefined); });
    await sync();
    await typeSubject("Plans for Friday, typed offline, and after");
    await pause(AUTOSAVE_DELAY_MS + 400);
    const after = rows(saves()).filter((m) => m.subject === "Plans for Friday, typed offline, and after");
    expect({
      creates: creates(), after: after.map((m) => (m.row === null ? "create" : m.row === D ? "theirs" : "the new draft")),
      says: text().includes(compose.changedElsewhere!),
    }).toEqual({ creates: [{ row: null, subject: "Plans for Friday, typed offline" }], after: ["the new draft"], says: true });
  }, 30_000);

  it("this tab's own saves, one after another, never fork", async () => {
    await openVersioned();
    await typeSubject("Plans for Friday, once");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await typeSubject("Plans for Friday, twice");
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => saves().length >= 2, "both saves", 40).catch(() => undefined);
    expect({ rows: rows(saves()), says: text().includes(compose.changedElsewhere ?? "\u0000") })
      .toEqual({ rows: [{ row: D, subject: "Plans for Friday, once" }, { row: D, subject: "Plans for Friday, twice" }], says: false });
  }, 30_000);
});

describe("a save refused, then a draft opened from Drafts", () => {
  const B = "d-other";
  const other = letter({ id: B, subject: "Invoice" });
  const TYPED = "Plans for Friday, typed here";
  const field = (): string | null => q<HTMLInputElement>("#compose-subject")?.value ?? null;
  async function openRow(id: string): Promise<void> {
    await act(async () => { window.location.hash = "#/drafts"; });
    await waitFor(() => q(`.draft-row[data-id="${id}"] .draft-open`) !== null, `${id} in Drafts`);
    await press(q(`.draft-row[data-id="${id}"] .draft-open`), `open ${id}`);
    await pause(300);
  }
  /** The letter open here, and a save of these words the account refused for good. */
  async function refused(opts: { versions?: boolean } = {}): Promise<void> {
    shell = await mountShell("#/drafts", [], [letter(), other], opts);
    await openRow(D);
    await waitFor(() => field() === "Plans for Friday", "the editor on the letter");
    shell.refuseSave.add(D);
    await typeSubject(TYPED);
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => text().includes(compose.draftNotSaved!), "the refusal said", 60);
  }

  it("the same row: the words on screen stay, in the field and in the buffer", async () => {
    await refused();
    await openRow(D);
    expect({ field: field(), buffer: readComposeDraft().subject }).toEqual({ field: TYPED, buffer: TYPED });
  }, 60_000);

  it("another row: not opened over them, and it says why", async () => {
    await refused();
    await openRow(B);
    const toast = [...document.querySelectorAll(".toast, .toast-held")].map((n) => n.textContent ?? "").join(" | ");
    expect({ buffer: readComposeDraft().subject, said: toast.includes(drafts.reopenBlockedUnsaved!) }).toEqual({ buffer: TYPED, said: true });
  }, 60_000);

  for (const target of [D, B]) {
    it(`a save queued offline and refused when it lands, then ${target === D ? "the same row" : "another row"} opened: the words stay`, async () => {
      shell = await mountShell("#/drafts", [], [letter(), other]);
      await openRow(D);
      await waitFor(() => field() === "Plans for Friday", "the editor on the letter");
      shell.offline.on = true;
      await typeSubject(TYPED);
      await pause(AUTOSAVE_DELAY_MS + 400);
      shell.refuseSave.add(D);
      shell.offline.on = false;
      await act(async () => { window.dispatchEvent(new Event("online")); await shell.engine.flushPending().catch(() => undefined); });
      await pause(300);
      await openRow(target);
      const toast = [...document.querySelectorAll(".toast, .toast-held")].map((n) => n.textContent ?? "").join(" | ");
      expect({ buffer: readComposeDraft().subject, said: toast.includes(drafts.reopenBlockedUnsaved!) })
        .toEqual({ buffer: TYPED, said: target === B });
      if (target === D) expect(field()).toBe(TYPED);
    }, 60_000);
  }

  it("a save still on its way: the reopen shows the newest words (the control)", async () => {
    shell = await mountShell("#/drafts", [], [letter(), other]);
    await openRow(D);
    await waitFor(() => field() === "Plans for Friday", "the editor on the letter");
    let land!: () => void;
    shell.saveGate.wait = new Promise<void>((r) => { land = r; });
    await typeSubject(TYPED);
    await pause(AUTOSAVE_DELAY_MS + 200);
    await act(async () => { window.location.hash = "#/drafts"; });
    await waitFor(() => q(`.draft-row[data-id="${D}"] .draft-open`) !== null, "the letter in Drafts");
    await press(q(`.draft-row[data-id="${D}"] .draft-open`), "open it again");
    await act(async () => { shell.saveGate.wait = null; land(); });
    await pause(300);
    expect({ field: field(), buffer: readComposeDraft().subject }).toEqual({ field: TYPED, buffer: TYPED });
  }, 60_000);

  it("the row changed elsewhere: the words become a new draft, and the row opens with the other version (the control)", async () => {
    shell = await mountShell("#/drafts", [], [letter(), other], { versions: true });
    await openRow(D);
    await waitFor(() => field() === "Plans for Friday", "the editor on the letter");
    await shell.editElsewhere(D, { subject: "Their plans" });
    await sync();
    await typeSubject(TYPED);
    await openRow(D);
    await waitFor(() => field() === "Their plans", "the other version on screen", 60);
    expect(rows(saves()).filter((m) => m.row === null)).toEqual([{ row: null, subject: TYPED }]);
  }, 60_000);

  it("saved words, the row changed elsewhere since: reopening it shows the other version (the control)", async () => {
    shell = await mountShell("#/drafts", [], [letter(), other], { versions: true });
    await openRow(D);
    await waitFor(() => field() === "Plans for Friday", "the editor on the letter");
    await typeSubject(TYPED);
    await pause(AUTOSAVE_DELAY_MS + 400);
    await shell.editElsewhere(D, { subject: "Their plans" });
    await sync();
    await openRow(D);
    await waitFor(() => field() === "Their plans", "the other version on screen", 60);
  }, 60_000);

  it("saved words open another row as before (the control)", async () => {
    shell = await mountShell("#/drafts", [], [letter(), other]);
    await openRow(D);
    await waitFor(() => field() === "Plans for Friday", "the editor on the letter");
    await typeSubject(TYPED);
    await pause(AUTOSAVE_DELAY_MS + 400);
    await openRow(B);
    await waitFor(() => field() === "Invoice", "the other row opened", 60);
  }, 60_000);

  it("a held letter does not keep another draft from opening (the control)", async () => {
    shell = await mountShell("#/drafts", [], [letter(), other]);
    await openRow(D);
    await waitFor(() => field() === "Plans for Friday", "the editor on the letter");
    Object.assign(shell.refuseSend, { on: true, unverified: true });
    await press(button("Send"), "Send");
    await waitFor(() => text().includes(compose.statusUnverified!), "the send held", 60);
    await openRow(B);
    await waitFor(() => field() === "Invoice", "the other row opened", 60);
  }, 60_000);

  it("Write to a contact over refused words is refused too", async () => {
    const m1 = message("m1", { to: [{ address: "me@example.invalid", name: "Me" }, { address: "kim@example.invalid", name: "Kim Lee" }] } as never);
    shell = await mountShell("#/drafts", [m1], [letter(), other]);
    await openRow(D);
    await waitFor(() => field() === "Plans for Friday", "the editor on the letter");
    shell.refuseSave.add(D);
    await typeSubject(TYPED);
    await pause(AUTOSAVE_DELAY_MS + 400);
    await waitFor(() => text().includes(compose.draftNotSaved!), "the refusal said", 60);
    await act(async () => { window.location.hash = "#/ohbox"; });
    await waitFor(() => q(".view-ohbox .row[data-id='m1']") != null, "the row m1");
    await press(q(".view-ohbox .row[data-id='m1']"), "the row m1");
    const click = async (node: Element | undefined): Promise<void> => {
      await act(async () => { node?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    };
    const kim = (): Element | undefined => [...shell.el.querySelectorAll(".rcpt-chip")].find((c) => (c.textContent ?? "").includes("Kim"));
    await waitFor(() => kim() !== undefined, "Kim's chip");
    await click(kim());
    await waitFor(() => q(".cpop") != null, "the contact popover");
    await click([...shell.el.querySelectorAll('.cpop [role="menuitem"]')].find((i) => (i.textContent ?? "").includes("Write")));
    await pause(300);
    expect({ buffer: readComposeDraft().subject, to: readComposeDraft().to.includes("kim@") }).toEqual({ buffer: TYPED, to: false });
  }, 60_000);
});
