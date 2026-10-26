/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineDraft, EngineMutation, SyncChange } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import { writeReplyDraft } from "../app/shell/mail-send";
import {
  act, FORWARD_PARTS, fillForward, forwardDock, message, mountShell, NOW, press, replyDraft, replySurface, stubDom, unmountAll, waitFor,
  type DraftShell,
} from "./_draft-shell.js";

/**
 * A REPLY DRAFT PRESSED IN DRAFTS OPENS ITS CONVERSATION WITH THE DRAFT IN THE EDITOR. The press
 * set the editor and navigated in one gesture, and the route transition — which closes every
 * overlay, the inline reply included — closed it again: the conversation came up with no editor,
 * and the draft could not be finished from there.
 * Mutation: the transition's pending reply not honoured → red on the missing editor.
 */

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
});
afterEach(unmountAll);

const DRAFT_TEXT = "Thursday works, I will bring the samples";

describe("a reply draft opens where it can be finished", () => {
  it("pressing it in Drafts opens the conversation with the draft in the reply editor", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [replyDraft("d1", "m1", DRAFT_TEXT)]);
    await waitFor(() => s.el.querySelector(".draft-row[data-id='d1'] .draft-open") != null, "the draft row");

    await press(s.el.querySelector(".draft-row[data-id='d1'] .draft-open"), "the draft's open button");

    await waitFor(() => window.location.hash.startsWith("#/ohbox"), "the conversation's view");
    await waitFor(() => replySurface(s.el) != null, "the reply editor, open on the conversation");
    expect(replySurface(s.el)!.textContent).toContain(DRAFT_TEXT);
    // …and focused, so typing goes on where the draft stopped.
    await waitFor(() => replySurface(s.el)!.contains(document.activeElement), "focus in the reply editor");
    // Nothing was sent or saved by opening it.
    expect(s.sent.filter((m) => m.kind === "mail_send" || m.kind === "draft_save")).toEqual([]);
  }, 15_000);

  it("a draft that is not a reply still opens in Compose (the control)", async () => {
    const plain = { ...replyDraft("d2", "m1", "a new message"), inReplyToMessageId: null, subject: "Plain" };
    const s = await mountShell("#/drafts", [message("m1")], [plain]);
    await waitFor(() => s.el.querySelector(".draft-row[data-id='d2'] .draft-open") != null, "the draft row");

    await press(s.el.querySelector(".draft-row[data-id='d2'] .draft-open"), "the draft's open button");

    await waitFor(() => window.location.hash === "#/compose", "the composer");
    expect(replySurface(s.el)).toBeNull();
  }, 15_000);
});

describe("a reply draft discarded in Drafts", () => {
  const unsent = (s: DraftShell): EngineDraft[] => s.store.list<EngineDraft>("draft").filter((d) => d.status === "draft");
  const key = async (k: string): Promise<void> => {
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
    await settleEditor();
  };
  const confirmDiscard = async (s: DraftShell, row: string): Promise<void> => {
    await act(async () => { window.location.hash = "#/drafts"; });
    await waitFor(() => s.el.querySelector(`.draft-row[data-id="${row}"] .draft-discard`) !== null, "the row in Drafts");
    await press(s.el.querySelector(`.draft-row[data-id="${row}"] .draft-discard`), "Delete");
    const confirm = Array.from(s.el.querySelectorAll<HTMLButtonElement>(".draft-confirm button"))
      .find((b) => (b.textContent ?? "").trim() === (messages.drafts as Record<string, string>).discardConfirm) ?? null;
    await press(confirm, "confirm");
    await waitFor(() => s.store.isTombstoned("draft", row), "the delete confirmed");
  };

  it("Reply afterwards opens empty and writes nothing", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "the row");
    await press(s.el.querySelector(".view-ohbox .row[data-id='m1']"), "the row");
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the reply editor");
    await act(async () => { typeInto(replySurface(s.el)!, "A reply I will throw away"); });
    await waitFor(() => unsent(s).some((d) => d.inReplyToMessageId === "m1"), "the reply row", 200);
    const row = unsent(s).find((d) => d.inReplyToMessageId === "m1")!.id;
    await key("Escape");
    await confirmDiscard(s, row);
    await act(async () => { window.location.hash = "#/ohbox"; });
    await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "the row again");
    await press(s.el.querySelector(".view-ohbox .row[data-id='m1']"), "the row");
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the reply editor again");
    for (let i = 0; i < 120; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect({ dock: (replySurface(s.el)?.textContent ?? "").includes("throw away"), rows: unsent(s).filter((d) => d.inReplyToMessageId === "m1").length },
      "the discarded reply came back in the editor, or was saved again").toEqual({ dock: false, rows: 0 });
  }, 60_000);

  it("opened from Drafts and edited, then discarded: Reply opens empty and nothing is saved after", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [replyDraft("d1", "m1", DRAFT_TEXT)]);
    await waitFor(() => s.el.querySelector(".draft-row[data-id='d1'] .draft-open") != null, "the draft row");
    await press(s.el.querySelector(".draft-row[data-id='d1'] .draft-open"), "open it");
    await waitFor(() => replySurface(s.el) != null, "the reply editor");
    await act(async () => { typeInto(replySurface(s.el)!, " and more"); });
    await confirmDiscard(s, "d1");
    const before = s.sent.filter((m) => m.kind === "draft_save").length;
    await act(async () => { window.location.hash = "#/ohbox"; });
    await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "the row");
    await press(s.el.querySelector(".view-ohbox .row[data-id='m1']"), "the row");
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the reply editor again");
    for (let i = 0; i < 120; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect({ dock: (replySurface(s.el)?.textContent ?? "").includes("and more"), saves: s.sent.filter((m) => m.kind === "draft_save").length - before },
      "the discarded reply came back in the editor, or was saved again").toEqual({ dock: false, saves: 0 });
  }, 60_000);
});

describe("a reply draft deleted on another device while ohmail was closed", () => {
  const unsent = (s: DraftShell): EngineDraft[] => s.store.list<EngineDraft>("draft").filter((d) => d.status === "draft");
  const rounds = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  };
  const key = async (k: string): Promise<void> => {
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
    await settleEditor();
  };
  const reply = async (s: DraftShell): Promise<void> => {
    await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "the row");
    await press(s.el.querySelector(".view-ohbox .row[data-id='m1']"), "the row");
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the reply editor");
  };
  /** Reply and type; the pause makes the row. `more` is typed after it and the tab dies: never handed to a save. */
  async function writeThenClose(more?: string): Promise<string> {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await reply(s);
    await act(async () => { typeInto(replySurface(s.el)!, "A reply deleted on the desktop"); });
    await waitFor(() => unsent(s).some((d) => d.inReplyToMessageId === "m1"), "the reply row", 200);
    await rounds(100);
    const row = unsent(s).find((d) => d.inReplyToMessageId === "m1")!.id;
    await key("Escape");
    await rounds(10);
    await unmountAll();
    stubDom();
    if (more !== undefined) writeReplyDraft("m1", { text: `A reply deleted on the desktop${more}`, html: "" });
    return row;
  }

  it("Reply opens empty and writes nothing", async () => {
    const row = await writeThenClose();
    const s = await mountShell("#/ohbox", [message("m1")], [], { serverGone: [row] });
    await reply(s);
    await rounds(120);
    expect({ dock: replySurface(s.el)?.textContent ?? "", saves: s.sent.filter((m) => m.kind === "draft_save").length },
      "a reply deleted on another device came back and was saved again").toEqual({ dock: "", saves: 0 });
  }, 60_000);

  it("words typed after its last save are kept as a new draft, and it says why", async () => {
    const row = await writeThenClose(" and a line never saved");
    const s = await mountShell("#/ohbox", [message("m1")], [], { serverGone: [row] });
    await reply(s);
    await waitFor(() => s.sent.some((m) => m.kind === "draft_save"), "the kept words saved", 200);
    const made = s.sent.filter((m) => m.kind === "draft_save").map((m) => ({ row: (m as { draftId?: string | null }).draftId ?? null, unsaved: ((m as { body?: string }).body ?? "").includes("never saved") }));
    expect({ made, says: (document.body.textContent ?? "").includes(messages.reply.deletedElsewhereKept) })
      .toEqual({ made: [{ row: null, unsaved: true }], says: true });
  }, 60_000);
});

describe("a reply whose last save went through the offline queue, then deleted on another device", () => {
  const LAST = " and a line saved while offline";
  const unsent = (s: DraftShell): EngineDraft[] => s.store.list<EngineDraft>("draft").filter((d) => d.status === "draft");
  const saves = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "draft_save");
  const rounds = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  };
  const key = async (k: string): Promise<void> => {
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
    await settleEditor();
  };
  const reply = async (s: DraftShell): Promise<void> => {
    await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "the row");
    await press(s.el.querySelector(".view-ohbox .row[data-id='m1']"), "the row");
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the reply editor");
  };
  /** The pause makes the row online; `LAST` is typed offline, its pause queued; `land` brings it online. */
  async function writeQueued(land: boolean): Promise<{ s: DraftShell; row: string }> {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await reply(s);
    await act(async () => { typeInto(replySurface(s.el)!, "A reply deleted on the desktop"); });
    await waitFor(() => unsent(s).some((d) => d.inReplyToMessageId === "m1"), "the reply row", 200);
    await rounds(100);
    const row = unsent(s).find((d) => d.inReplyToMessageId === "m1")!.id;
    s.offline.on = true;
    await act(async () => { typeInto(replySurface(s.el)!, LAST); });
    await rounds(120);
    if (land) {
      s.offline.on = false;
      await act(async () => { window.dispatchEvent(new Event("online")); });
      await waitFor(() => s.store.get<EngineDraft>("draft", row)?.body?.includes("saved while offline") === true, "the queued save landed", 200);
    }
    await key("Escape");
    await rounds(10);
    return { s, row };
  }
  /** Reply, read what it says while a toast still stands, then let every pause run. */
  async function replyAndWait(s: DraftShell, before: number): Promise<{ dock: string; made: number; said: string }> {
    await reply(s);
    await rounds(8);
    const said = document.body.textContent ?? "";
    await rounds(160);
    return { dock: replySurface(s.el)?.textContent ?? "", made: saves(s).length - before, said };
  }
  const says = (said: string) => ({
    kept: said.includes(messages.reply.deletedElsewhereKept), deleted: said.includes(messages.reply.deletedElsewhere),
  });

  it("the save landed, the tab closed: Reply opens empty, writes nothing, says nothing", async () => {
    const { row } = await writeQueued(true);
    await unmountAll();
    stubDom();
    const s = await mountShell("#/ohbox", [message("m1")], [], { serverGone: [row] });
    const o = await replyAndWait(s, 0);
    expect({ dock: o.dock, made: o.made, ...says(o.said) }, "a reply whose words all reached the deleted row came back")
      .toEqual({ dock: "", made: 0, kept: false, deleted: false });
  }, 90_000);

  it("the save landed, the tab open, the delete arrives: Reply opens empty and writes nothing", async () => {
    const { s, row } = await writeQueued(true);
    s.remote.push({ type: "draft", op: "delete", id: row, seq: 0, updatedAt: NOW.toISOString(), entity: null } as unknown as SyncChange);
    await act(async () => { await s.engine.syncOnce().catch(() => undefined); });
    await waitFor(() => s.store.isTombstoned("draft", row), "the delete applied");
    const before = saves(s).length;
    await act(async () => { window.location.hash = "#/drafts"; });
    await rounds(10);
    await act(async () => { window.location.hash = "#/ohbox"; });
    const o = await replyAndWait(s, before);
    expect({ dock: o.dock, made: o.made, ...says(o.said) }, "the deleted reply was made again without a keystroke")
      .toEqual({ dock: "", made: 0, kept: false, deleted: false });
  }, 90_000);

  it("the save was never seen to land: the words stay, nothing is saved, and it says the draft was deleted", async () => {
    const { row } = await writeQueued(false);
    await unmountAll();
    stubDom();
    const s = await mountShell("#/ohbox", [message("m1")], [], { serverGone: [row] });
    const o = await replyAndWait(s, 0);
    expect({ dock: o.dock.includes("saved while offline"), made: o.made, ...says(o.said) })
      .toEqual({ dock: true, made: 0, kept: false, deleted: true });
  }, 90_000);

  it("the delete arrives live before the queued save: Reply keeps the words and saves nothing", async () => {
    const { s, row } = await writeQueued(false);
    s.serverGone.add(row);
    s.remote.push({ type: "draft", op: "delete", id: row, seq: 0, updatedAt: NOW.toISOString(), entity: null } as unknown as SyncChange);
    await act(async () => { await s.engine.syncOnce().catch(() => undefined); });
    await waitFor(() => s.store.isTombstoned("draft", row), "the delete applied");
    s.offline.on = false;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await rounds(40);
    const before = saves(s).length;
    const o = await replyAndWait(s, before);
    expect({ dock: o.dock.includes("saved while offline"), made: o.made, ...says(o.said) })
      .toEqual({ dock: true, made: 0, kept: false, deleted: true });
  }, 90_000);
});

describe("a reply draft open here while another device changes it", () => {
  const OTHER = "Written on the other device.";
  const rounds = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  };
  const replies = (s: DraftShell): EngineDraft[] =>
    s.store.list<EngineDraft>("draft").filter((d) => d.status === "draft" && d.inReplyToMessageId === "m1");
  const saves = (s: DraftShell) => s.sent.filter((m) => m.kind === "draft_save") as Array<Extract<EngineMutation, { kind: "draft_save" }>>;
  const sends = (s: DraftShell) => s.sent.filter((m) => m.kind === "mail_send") as Array<Extract<EngineMutation, { kind: "mail_send" }>>;
  const said = (): string => document.body.textContent ?? "";
  const sendButton = (s: DraftShell): HTMLButtonElement | null => Array.from(s.el.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button"))
    .find((b) => (b.textContent ?? "").startsWith("Send")) ?? null;
  async function openD1(drafts = [replyDraft("d1", "m1", DRAFT_TEXT)]): Promise<DraftShell> {
    const s = await mountShell("#/drafts", [message("m1")], drafts, { versions: true });
    await waitFor(() => s.el.querySelector(".draft-row[data-id='d1'] .draft-open") != null, "the draft row");
    await press(s.el.querySelector(".draft-row[data-id='d1'] .draft-open"), "open it");
    await waitFor(() => replySurface(s.el) != null, "the reply editor");
    return s;
  }
  async function changedThere(s: DraftShell): Promise<void> {
    await s.editElsewhere("d1", { body: OTHER });
    await act(async () => { await s.engine.syncOnce().catch(() => undefined); });
    await waitFor(() => s.store.get<EngineDraft>("draft", "d1")?.body === OTHER, "their write here");
  }

  it("typing over their version keeps both drafts and says so", async () => {
    const s = await openD1();
    await changedThere(s);
    await act(async () => { typeInto(replySurface(s.el)!, " and typed here"); });
    await waitFor(() => replies(s).length === 2, "the words kept as a new draft", 200);
    const mine = replies(s).find((d) => d.id !== "d1")!;
    expect({
      stated: saves(s)[0]?.ifContentRevision, theirs: s.store.get<EngineDraft>("draft", "d1")?.body,
      mine: mine.body?.includes("typed here"), says: said().includes(messages.reply.changedElsewhere),
    }).toEqual({ stated: "rev-d1", theirs: OTHER, mine: true, says: true });
  }, 60_000);

  it("Send over their version sends nothing, keeps the words as a new draft, and the next Send goes once", async () => {
    const s = await openD1();
    await changedThere(s);
    await act(async () => { typeInto(replySurface(s.el)!, " and typed here"); });
    await press(sendButton(s), "Send");
    await waitFor(() => replies(s).length === 2, "the words kept as a new draft", 200);
    const mine = replies(s).find((d) => d.id !== "d1")!;
    expect({ refused: sends(s).map((m) => [m.draftId, m.ifContentRevision]), theirs: s.store.get<EngineDraft>("draft", "d1")?.body })
      .toEqual({ refused: [["d1", "rev-d1"]], theirs: OTHER });
    await rounds(10);
    await press(sendButton(s), "Send again");
    await rounds(40);
    expect(sends(s).slice(1).map((m) => [m.draftId, m.ifContentRevision === s.versions.get(mine.id) || m.ifContentRevision === undefined]))
      .toEqual([[mine.id, true]]);
    expect(s.store.get<EngineDraft>("draft", "d1")?.body).toBe(OTHER);
  }, 60_000);

  it("a save queued offline and refused on reconnect, then more typing: two drafts, never three", async () => {
    const s = await openD1();
    s.offline.on = true;
    await act(async () => { typeInto(replySurface(s.el)!, " typed offline"); });
    await rounds(120);
    await s.editElsewhere("d1", { body: OTHER });
    s.offline.on = false;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await act(async () => { await s.engine.flushPending().catch(() => undefined); });
    await act(async () => { await s.engine.syncOnce().catch(() => undefined); });
    await rounds(40);
    await act(async () => { typeInto(replySurface(s.el)!, " and more"); });
    await rounds(160);
    const rows = replies(s);
    expect({ count: rows.length, theirs: s.store.get<EngineDraft>("draft", "d1")?.body, mine: rows.some((d) => d.id !== "d1" && d.body?.includes("and more")) })
      .toEqual({ count: 2, theirs: OTHER, mine: true });
  }, 90_000);

  it("a second conflict after the draft was opened again never writes over the words the first one kept", async () => {
    const s = await openD1();
    s.offline.on = true;
    await act(async () => { typeInto(replySurface(s.el)!, " typed first"); });
    await rounds(120);
    await s.editElsewhere("d1", { body: "Theirs, first" });
    s.offline.on = false;
    await act(async () => { window.dispatchEvent(new Event("online")); await s.engine.flushPending().catch(() => undefined); });
    await act(async () => { await s.engine.syncOnce().catch(() => undefined); });
    await waitFor(() => replies(s).some((d) => d.id !== "d1" && d.body?.includes("typed first")), "the first conflict's words kept", 200);
    const first = replies(s).find((d) => d.id !== "d1")!.body;
    await act(async () => { window.location.hash = "#/drafts"; });
    await waitFor(() => s.el.querySelector(".draft-row[data-id='d1'] .draft-open") != null, "d1 in Drafts");
    await press(s.el.querySelector(".draft-row[data-id='d1'] .draft-open"), "open d1 again");
    await waitFor(() => (replySurface(s.el)?.textContent ?? "").includes("Theirs, first"), "their words in the editor", 120);
    await act(async () => { typeInto(replySurface(s.el)!, " and mine"); });
    await rounds(160);
    await s.editElsewhere("d1", { body: "Theirs, again" });
    await act(async () => { await s.engine.syncOnce().catch(() => undefined); });
    await rounds(20);
    await act(async () => { typeInto(replySurface(s.el)!, " and more"); });
    await rounds(200);
    expect({ first: replies(s).some((d) => d.body === first), count: replies(s).length }).toEqual({ first: true, count: 3 });
  }, 90_000);

  it("its own saves never fork (the control)", async () => {
    const s = await openD1();
    await act(async () => { typeInto(replySurface(s.el)!, " first"); });
    await waitFor(() => saves(s).length === 1, "the first save", 200);
    await rounds(10);
    await act(async () => { typeInto(replySurface(s.el)!, " second"); });
    await waitFor(() => saves(s).length === 2, "the second save", 200);
    await rounds(20);
    expect({ rows: replies(s).map((d) => d.id), stated: saves(s).every((m) => m.draftId === "d1" && m.ifContentRevision !== undefined), says: said().includes(messages.reply.changedElsewhere) })
      .toEqual({ rows: ["d1"], stated: true, says: false });
  }, 60_000);

  it("a reload over a row changed while the tab was closed opens their words, and its next save goes through", async () => {
    const first = await openD1();
    await act(async () => { typeInto(replySurface(first.el)!, " from yesterday"); });
    await waitFor(() => saves(first).length === 1, "the save", 200);
    await unmountAll();
    stubDom();
    const moved = { ...replyDraft("d1", "m1", OTHER), contentRevision: "rev-theirs", updatedAt: "2026-09-27T08:55:00.000Z" } as EngineDraft;
    const s = await openD1([moved]);
    expect(replySurface(s.el)!.textContent).toContain(OTHER);
    await act(async () => { typeInto(replySurface(s.el)!, " and today"); });
    await waitFor(() => saves(s).length === 1, "the save", 200);
    await rounds(20);
    expect({ stated: saves(s)[0]!.ifContentRevision, rows: replies(s).map((d) => d.id), says: said().includes(messages.reply.changedElsewhere) })
      .toEqual({ stated: "rev-theirs", rows: ["d1"], says: false });
  }, 60_000);
});

describe("an inline forward's draft changed on another device", () => {
  const TO = "colleague@example.net";
  const [PART_A, PART_B] = FORWARD_PARTS.map((p) => p.id);
  const forwards = (s: DraftShell): EngineDraft[] =>
    s.store.list<EngineDraft>("draft").filter((d) => d.status === "draft" && d.forwardOfMessageId === "m1");
  const saves = (s: DraftShell) => s.sent.filter((m) => m.kind === "draft_save") as Array<Extract<EngineMutation, { kind: "draft_save" }>>;
  const sends = (s: DraftShell) => s.sent.filter((m) => m.kind === "mail_send") as Array<Extract<EngineMutation, { kind: "mail_send" }>>;
  const said = (): string => [...document.querySelectorAll(".toast, .toast-held")].map((n) => n.textContent ?? "").join(" | ");
  /** The forward's row on the account, then another device's write of it, seen here. */
  async function forwardChangedThere(): Promise<{ s: DraftShell; row: string }> {
    const s = await mountShell("#/ohbox", [message("m1", { hasAttachments: true, attachmentCount: 3 } as never)], [], { versions: true, parts: true });
    await fillForward(s, TO, "Have a look");
    await waitFor(() => forwards(s).length === 1, "the forward's row", 200);
    const row = forwards(s)[0]!.id;
    await s.editElsewhere(row, { body: "Written on the other device." });
    await act(async () => { await s.engine.syncOnce().catch(() => undefined); });
    await waitFor(() => s.store.get<EngineDraft>("draft", row)?.body === "Written on the other device.", "their write here");
    return { s, row };
  }

  it("a save over it keeps their version, and the words go to a new forward row, said once", async () => {
    const { s, row } = await forwardChangedThere();
    await act(async () => { typeInto(forwardDock(s.el)!.querySelector<HTMLElement>(".rte-surface")!, " and the budget"); });
    await waitFor(() => forwards(s).length === 2, "the words kept as a new forward draft", 200);
    const mine = forwards(s).find((d) => d.id !== row)!;
    expect({
      theirs: s.store.get<EngineDraft>("draft", row)?.body, creates: saves(s).filter((m) => m.draftId === null).length,
      mine: [mine.inReplyToMessageId ?? null, mine.forwardParts, mine.to.map((a) => a.address), mine.body?.includes("and the budget")],
      said: said().split(messages.reply.forwardChangedElsewhere).length - 1,
    }).toEqual({ theirs: "Written on the other device.", creates: 2, mine: [null, [PART_A, PART_B], [TO], true], said: 1 });
  }, 60_000);

  it("Send over it is refused with the base stated, and the words go to a new forward row", async () => {
    const { s, row } = await forwardChangedThere();
    await press([...forwardDock(s.el)!.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").startsWith("Send")) ?? null, "Send");
    await waitFor(() => forwards(s).length === 2, "the words kept as a new forward draft", 200);
    const mine = forwards(s).find((d) => d.id !== row)!;
    expect({
      refused: sends(s).map((m) => [m.draftId, m.ifContentRevision !== undefined && m.ifContentRevision !== s.versions.get(row)]),
      theirs: s.store.get<EngineDraft>("draft", row)?.body, mine: [mine.forwardOfMessageId, mine.forwardParts],
    }).toEqual({ refused: [[row, true]], theirs: "Written on the other device.", mine: ["m1", [PART_A, PART_B]] });
  }, 60_000);
});
