/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MutationRejectedError, draftsList, type EngineDraft, type EngineMutation } from "@ohmail/client-engine";
import { sendFingerprint } from "@ohmail/client-engine/send-fingerprint";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import en from "../messages/en.json";
import {
  DraftServer, FORWARD_PARTS, NOW, act, fillForward, forwardDock, message, mountShell, openForward, press, pressRestart, replyDraft, replySurface,
  stubDom, typeForwardTo, unmountAll, waitFor, type DraftShell,
} from "./_draft-shell.js";

/**
 * A REPLY STARTED INLINE IS A DRAFT ON THE ACCOUNT (tester round 24). The web's inline editor kept
 * an unsent reply only in this browser's storage, while Drafts says drafts are "saved to your
 * account, so they're here on every device". The editor now writes a row after the same pause as
 * the composer, keeps writing that one row, reopens it on Reply on another device, and Send sends it.
 */

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
});
afterEach(unmountAll);

type Save = Extract<EngineMutation, { kind: "draft_save" }>;
const saves = (s: DraftShell): Save[] => s.sent.filter((m): m is Save => m.kind === "draft_save");
const sends = (s: DraftShell) => s.sent.filter((m) => m.kind === "mail_send") as Array<Extract<EngineMutation, { kind: "mail_send" }>>;
const rowsFor = (s: DraftShell, id: string): EngineDraft[] =>
  s.store.list<EngineDraft>("draft").filter((d) => d.inReplyToMessageId === id && d.status === "draft");
/** Past the composer's two-second pause, in real time: this harness runs real timers. */
const PAUSE_ROUNDS = 200;

async function key(k: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await settleEditor();
}

async function openReplyOn(s: DraftShell, id: string): Promise<void> {
  await waitFor(() => s.el.querySelector(`.view-ohbox .row[data-id='${id}']`) != null, "the row");
  await press(s.el.querySelector(`.view-ohbox .row[data-id='${id}']`), "the row");
  await key("r");
  await waitFor(() => replySurface(s.el) != null, "the reply editor");
}

async function typeAndPause(s: DraftShell, text: string, nth: number): Promise<Save> {
  await act(async () => { typeInto(replySurface(s.el)!, text); });
  await waitFor(() => saves(s).length >= nth, `draft save ${nth} on the wire`, PAUSE_ROUNDS);
  return saves(s)[nth - 1]!;
}

async function route(hash: string): Promise<void> {
  await act(async () => { window.location.hash = hash; window.dispatchEvent(new Event("hashchange")); });
}

/** Another device sent the row: the next `/sync` brings it back `sent`. */
async function sentElsewhere(s: DraftShell, row: string): Promise<void> {
  const d = s.store.get<EngineDraft>("draft", row)!;
  s.remote.push({ type: "draft", op: "update", id: row, seq: 0, updatedAt: NOW.toISOString(), entity: { ...d, status: "sent" } } as never);
  await act(async () => { await s.engine.syncOnce().catch(() => undefined); });
  await waitFor(() => s.store.get<EngineDraft>("draft", row)?.status === "sent", "the row sent elsewhere");
}

const sendButton = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button")]
    .find((b) => (b.textContent ?? "").startsWith("Send"));

describe("a reply typed inline is a draft on the account", () => {
  it("the pause writes one row, and the next pause writes that row again", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(s, "m1");

    const first = await typeAndPause(s, "See you on Thursday", 1);
    expect([first.draftId, first.inReplyToMessageId, first.body]).toEqual([null, "m1", "See you on Thursday"]);
    const rows = rowsFor(s, "m1");
    expect(rows.map((d) => d.body), "the account holds no draft of the reply").toEqual(["See you on Thursday"]);

    const second = await typeAndPause(s, "See you on Thursday at ten", 2);
    expect(second.draftId, "the second pause made a second row").toBe(rows[0]!.id);
    expect(rowsFor(s, "m1").map((d) => d.body)).toEqual(["See you on Thursday at ten"]);
  }, 30_000);

  it("closed and opened again with Reply, it is the same row", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(s, "m1");
    await typeAndPause(s, "Thursday works", 1);
    const row = rowsFor(s, "m1")[0]!.id;
    await key("Escape");
    await waitFor(() => replySurface(s.el) == null, "the editor closed");

    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the reply editor again");
    expect(replySurface(s.el)!.textContent).toContain("Thursday works");
    const again = await typeAndPause(s, "Thursday works, at ten", 2);
    expect(again.draftId, "Reply again made a second row").toBe(row);
    expect(rowsFor(s, "m1").map((d) => d.id)).toEqual([row]);
  }, 30_000);

  it("another device lists it, opens it on Reply, keeps writing it and sends it", async () => {
    const first = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(first, "m1");
    await typeAndPause(first, "Thursday works", 1);
    const written = first.store.list<EngineDraft>("draft");
    const row = rowsFor(first, "m1")[0]!.id;
    await unmountAll();

    // Another device: the account's rows, none of this browser's storage.
    try { window.localStorage.clear(); } catch { /* storage blocked */ }
    stubDom();
    const other = await mountShell("#/drafts", [message("m1")], written);
    await waitFor(() => other.el.querySelector(`.draft-row[data-id='${row}']`) != null, "the reply listed in Drafts");
    // …and in the shared list the phone's Drafts is drawn from.
    expect(draftsList(other.store, NOW).map((d) => d.id), "the phone's Drafts would not list it").toContain(row);

    await act(async () => {
      window.location.hash = "#/ohbox";
      window.dispatchEvent(new Event("hashchange"));
    });
    await openReplyOn(other, "m1");
    expect(replySurface(other.el)!.textContent, "Reply did not open the account's draft").toContain("Thursday works");
    for (let i = 0; i < 100; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(saves(other), "opening the draft wrote it").toEqual([]);

    const more = await typeAndPause(other, "Thursday works, I will bring the samples", 1);
    expect(more.draftId, "the other device made a second row").toBe(row);
    await act(async () => { sendButton(other.el)!.click(); });
    await waitFor(() => sends(other).length === 1, "the send on the wire");
    expect(sends(other)[0]!.draftId, "the send made a row of its own").toBe(row);
  }, 40_000);

  it("Send while the first save is in the air leaves no copy of the sent reply", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(s, "m1");
    let release: () => void = () => {};
    s.saveGate.wait = new Promise<void>((r) => { release = r; });
    await typeAndPause(s, "On my way", 1);
    await act(async () => { sendButton(s.el)!.click(); });
    s.saveGate.wait = null;
    await act(async () => { release(); });
    await waitFor(() => sends(s).length === 1, "the send on the wire");
    await waitFor(() => s.sent.some((m) => m.kind === "draft_discard"), "the copy undone");
    expect(rowsFor(s, "m1"), "a draft of the sent reply stayed in Drafts").toEqual([]);
  }, 30_000);

  it("a reply edited on another device since opens here with that device's text", async () => {
    const first = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(first, "m1");
    await typeAndPause(first, "Thursday works", 1);
    const row = rowsFor(first, "m1")[0]!;
    await unmountAll();

    // This browser keeps its storage; the phone has since written the row.
    stubDom();
    const edited = { ...row, body: "Thursday works, the phone says ten", updatedAt: "2026-09-27T09:10:00.000Z" };
    const back = await mountShell("#/ohbox", [message("m1")], [edited]);
    await openReplyOn(back, "m1");
    expect(replySurface(back.el)!.textContent, "this browser's older text won over the phone's")
      .toContain("the phone says ten");
    for (let i = 0; i < 100; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(saves(back), "opening the phone's text wrote it back").toEqual([]);
  }, 40_000);

  it("typing this browser never saved, beside a draft written elsewhere, writes over neither", async () => {
    const first = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(first, "m1");
    // Typed and closed inside the pause: the words are in this browser only.
    await act(async () => { typeInto(replySurface(first.el)!, "the words typed here"); });
    await unmountAll();
    expect(saves(first), "the words reached the account after all").toEqual([]);

    stubDom();
    const phone = { ...replyDraft("d-phone", "m1", "the words typed on the phone"), updatedAt: "2026-09-27T09:10:00.000Z" };
    const back = await mountShell("#/ohbox", [message("m1")], [phone]);
    await openReplyOn(back, "m1");
    expect(replySurface(back.el)!.textContent).toContain("the words typed here");
    const saved = await typeAndPause(back, "the words typed here, and more", 1);
    expect(saved.draftId, "this browser's words were written over the phone's draft").toBeNull();
    expect(rowsFor(back, "m1").map((d) => d.body).sort())
      .toEqual(["the words typed here, and more", "the words typed on the phone"]);
  }, 40_000);

  it("Send before the pause sends the text and leaves no draft behind", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(s, "m1");
    await act(async () => { typeInto(replySurface(s.el)!, "On my way"); });
    await act(async () => { sendButton(s.el)!.click(); });
    await waitFor(() => sends(s).length === 1, "the send on the wire");
    for (let i = 0; i < 120; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(saves(s), "the pause wrote the sent text as a draft").toEqual([]);
    expect(sends(s)[0]!.draftId ?? null).toBeNull();
  }, 30_000);
});

/**
 * A FORWARD LEFT UNFINISHED IS A DRAFT ON THE ACCOUNT TOO (tester report): the dock kept its note and
 * file choice only in this browser, dropped its To on a reload, and another device opened a fresh one.
 * The forward is now one row on the account: the original, the kept files, the To and the note.
 */
describe("a forward typed inline is a draft on the account", () => {
  const TO = "colleague@example.net";
  const NOTE = "Have a look at these two";
  const [PART_A, PART_B] = FORWARD_PARTS.map((p) => p.id);
  const withFiles = (id: string, over: Record<string, unknown> = {}) =>
    message(id, { hasAttachments: true, attachmentCount: 3, ...over } as never);
  const dock = (s: DraftShell): HTMLElement | null => s.el.querySelector<HTMLElement>(".read-col .reply[data-reply-for]");
  const surface = (s: DraftShell): HTMLElement => dock(s)!.querySelector<HTMLElement>(".rte-surface")!;
  const shown = (s: DraftShell): string =>
    `${dock(s)?.textContent ?? ""} ${dock(s)?.querySelector<HTMLInputElement>(".rcp-input")?.value ?? ""}`;
  const listed = (s: DraftShell): string[] =>
    [...(dock(s)?.querySelectorAll<HTMLElement>("[data-forward-part]") ?? [])].map((r) => r.dataset.forwardPart!);
  const forwards = (s: DraftShell): EngineDraft[] =>
    s.store.list<EngineDraft>("draft").filter((d) => d.forwardOfMessageId === "m1" && d.status === "draft");
  const fwdSend = (s: DraftShell): HTMLButtonElement =>
    [...dock(s)!.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").startsWith("Send"))!;
  const rounds = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  };

  const forwardOn = openForward;
  const typeTo = typeForwardTo;
  const fill = (s: DraftShell): Promise<void> => fillForward(s, TO, NOTE);
  const reload = async (s: DraftShell): Promise<DraftShell> => {
    const store = s.store;
    await unmountAll();
    stubDom();
    return mountShell("#/ohbox", [withFiles("m1")], [], { store, parts: true });
  };

  it("the pause writes one forward row, and the next pause writes that row", async () => {
    const s = await mountShell("#/ohbox", [withFiles("m1")], [], { parts: true });
    await fill(s);
    await waitFor(() => saves(s).length === 1, "the forward's first save", PAUSE_ROUNDS);
    const first = saves(s)[0]!;
    expect([first.draftId, first.forwardOfMessageId, first.inReplyToMessageId ?? null, first.to.map((a) => a.address), first.body, first.forwardParts])
      .toEqual([null, "m1", null, [TO], NOTE, [PART_A, PART_B]]);
    const row = forwards(s).map((d) => d.id);
    expect(row).toHaveLength(1);
    await act(async () => { typeInto(surface(s), " and the plan"); });
    await waitFor(() => saves(s).length === 2, "the second save", PAUSE_ROUNDS);
    expect(saves(s)[1]!.draftId, "the second pause made a second row").toBe(row[0]);
    expect(forwards(s).map((d) => d.id)).toEqual(row);
  }, 40_000);

  it("Esc and a reload bring back the To, the note and the trim; typing on writes the same row", async () => {
    const s = await mountShell("#/ohbox", [withFiles("m1")], [], { parts: true });
    await fill(s);
    await waitFor(() => saves(s).length === 1, "the first save", PAUSE_ROUNDS);
    const row = forwards(s)[0]!.id;
    await key("Escape");
    const back = await reload(s);
    await forwardOn(back);
    await waitFor(() => listed(back).length === 2, "the trim after a reload");
    expect([surface(back).textContent?.includes(NOTE), shown(back).includes(TO)], "the note and the To after a reload").toEqual([true, true]);
    await rounds(110);
    expect(saves(back), "opening the forward wrote it").toEqual([]);
    await act(async () => { typeInto(surface(back), " and more"); });
    await waitFor(() => saves(back).length === 1, "the save after the reload", PAUSE_ROUNDS);
    expect(saves(back)[0]!.draftId, "the reopened forward made a second row").toBe(row);
    expect(forwards(back).map((d) => d.id)).toEqual([row]);
  }, 60_000);

  it("another device lists it, opens it whole on Forward, and Send sends that row with the kept files", async () => {
    const first = await mountShell("#/ohbox", [withFiles("m1")], [], { parts: true });
    await fill(first);
    await waitFor(() => saves(first).length === 1, "the first save", PAUSE_ROUNDS);
    const written = first.store.list<EngineDraft>("draft");
    const row = forwards(first)[0]!.id;
    await unmountAll();
    try { window.localStorage.clear(); } catch { /* storage blocked */ }
    stubDom();
    const other = await mountShell("#/drafts", [withFiles("m1")], written, { parts: true });
    await waitFor(() => other.el.querySelector(`.draft-row[data-id='${row}']`) != null, "the forward listed in Drafts");
    await act(async () => { window.location.hash = "#/ohbox"; window.dispatchEvent(new Event("hashchange")); });
    await forwardOn(other);
    await waitFor(() => listed(other).length === 2, "the trim on the other device");
    expect([surface(other).textContent?.includes(NOTE), shown(other).includes(TO)], "the note and the To there").toEqual([true, true]);
    await rounds(110);
    expect(saves(other), "opening the row wrote it").toEqual([]);
    await act(async () => { fwdSend(other).click(); });
    await waitFor(() => sends(other).length === 1, "the send on the wire");
    const m = sends(other)[0]!;
    expect([m.draftId, m.forwardOf, m.forwardParts, m.to?.map((a) => a.address)]).toEqual([row, "m1", [PART_A, PART_B], [TO]]);
  }, 60_000);

  it("Send while the first save is in the air leaves no forward draft", async () => {
    const s = await mountShell("#/ohbox", [withFiles("m1")], [], { parts: true });
    let release: () => void = () => {};
    s.saveGate.wait = new Promise<void>((r) => { release = r; });
    await fill(s);
    await waitFor(() => saves(s).length === 1, "the create in the air", PAUSE_ROUNDS);
    await act(async () => { fwdSend(s).click(); });
    s.saveGate.wait = null;
    await act(async () => { release(); });
    await waitFor(() => sends(s).length === 1, "the send on the wire");
    await waitFor(() => forwards(s).length === 0, "no draft of the sent forward", PAUSE_ROUNDS);
  }, 40_000);

  it("Send before the pause leaves no draft, and Forward again opens empty", async () => {
    const s = await mountShell("#/ohbox", [withFiles("m1")], [], { parts: true });
    await fill(s);
    await act(async () => { fwdSend(s).click(); });
    await waitFor(() => sends(s).length === 1, "the send on the wire");
    await rounds(120);
    expect([saves(s), forwards(s)], "the pause wrote the sent forward as a draft").toEqual([[], []]);
    await forwardOn(s);
    await waitFor(() => dock(s) != null, "a new forward");
    expect([shown(s).includes(TO), surface(s).textContent?.includes(NOTE)]).toEqual([false, false]);
  }, 40_000);

  it("a reply and a forward on one message are two rows", async () => {
    const s = await mountShell("#/ohbox", [withFiles("m1")], [], { parts: true });
    await fill(s);
    await waitFor(() => saves(s).length === 1, "the forward's save", PAUSE_ROUNDS);
    await key("Escape");
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the reply editor");
    await typeAndPause(s, "Thanks, will do", 2);
    const rows = s.store.list<EngineDraft>("draft").filter((d) => d.status === "draft");
    expect(rows.map((d) => [d.inReplyToMessageId ?? null, d.forwardOfMessageId ?? null]).sort()).toEqual([[null, "m1"], ["m1", null]]);
  }, 40_000);

  it("a reload inside the pause shows this browser's To and note", async () => {
    const s = await mountShell("#/ohbox", [withFiles("m1")], [], { parts: true });
    await forwardOn(s);
    await waitFor(() => dock(s) != null, "the forward dock");
    await typeTo(s, `${TO}, `);
    await act(async () => { typeInto(surface(s), "Words of this browser"); });
    await rounds(4);
    expect(saves(s), "the pause had already run").toEqual([]);
    const back = await reload(s);
    await forwardOn(back);
    await waitFor(() => dock(back) != null, "the forward dock again");
    expect([surface(back).textContent?.includes("Words of this browser"), shown(back).includes(TO)]).toEqual([true, true]);
  }, 40_000);

  it("a forward row retitled elsewhere is not taken by the dock and never written", async () => {
    const retitled = {
      id: "d-fwd", mailboxId: "mb1", threadId: null, inReplyToMessageId: null, forwardOfMessageId: "m1",
      subject: "Re-titled plans", body: "Their words", html: null, to: [{ address: TO, name: null }], cc: [], bcc: [],
      rationale: null, status: "draft", createdAt: "2026-09-27T08:40:00.000Z", updatedAt: "2026-09-27T08:40:00.000Z",
    } as unknown as EngineDraft;
    const s = await mountShell("#/ohbox", [withFiles("m1")], [retitled], { parts: true });
    await forwardOn(s);
    await waitFor(() => dock(s) != null, "the forward dock");
    expect(surface(s).textContent ?? "").not.toContain("Their words");
    await act(async () => { typeInto(surface(s), "A forward of my own"); });
    await waitFor(() => saves(s).length === 1, "the dock's own save", PAUSE_ROUNDS);
    expect(saves(s).map((x) => x.draftId), "the dock wrote over the retitled forward").toEqual([null]);
  }, 40_000);

  it("with the sensitive ask unanswered nothing is written; once answered, the forward is a row", async () => {
    window.localStorage.setItem("ohmail.ui.reply:fwd:m1", "Seeded note");
    const s = await mountShell("#/ohbox", [withFiles("m1", {
      sensitivity: { sensitive: true, category: "otp", no_ai: true, no_forward: true, no_kb: true, priority: true },
    })], [], { parts: true });
    await forwardOn(s);
    await waitFor(() => s.el.querySelector('[role="alertdialog"].reply-ask') != null, "the ask");
    await rounds(110);
    expect(saves(s), "the forward was saved before the ask was answered").toEqual([]);
    const ask = s.el.querySelector<HTMLElement>('[role="alertdialog"].reply-ask')!;
    const yes = [...ask.querySelectorAll("button")].find((x) => x.textContent === en.reply.forwardAsk.confirm)!;
    await act(async () => { yes.click(); });
    await waitFor(() => dock(s)?.querySelector(".rcp-input") != null, "the editor after the answer");
    await typeTo(s, `${TO}, `);
    await waitFor(() => saves(s).length === 1, "the answered forward's save", PAUSE_ROUNDS);
    expect([saves(s)[0]!.forwardOfMessageId, saves(s)[0]!.inReplyToMessageId ?? null]).toEqual(["m1", null]);
  }, 40_000);

  it("once the composer holds the forward row, Forward starts a new forward and never writes that row", async () => {
    const s = await mountShell("#/ohbox", [withFiles("m1")], [], { parts: true });
    await fill(s);
    await waitFor(() => saves(s).length === 1, "the first save", PAUSE_ROUNDS);
    const row = forwards(s)[0]!.id;
    await key("Escape");
    await act(async () => { window.location.hash = "#/drafts"; window.dispatchEvent(new Event("hashchange")); });
    await waitFor(() => s.el.querySelector(`.draft-row[data-id='${row}'] .draft-open`) != null, "the forward in Drafts");
    await press(s.el.querySelector(`.draft-row[data-id='${row}'] .draft-open`), "the forward draft");
    await waitFor(() => window.location.hash.startsWith("#/compose"), "the composer");
    await act(async () => { window.location.hash = "#/ohbox"; window.dispatchEvent(new Event("hashchange")); });
    await rounds(4);
    const n = saves(s).length;
    await forwardOn(s);
    await waitFor(() => dock(s) != null, "the forward dock");
    expect(surface(s).textContent ?? "", "the dock opened the composer's forward").not.toContain(NOTE);
    await typeTo(s, `${TO}, `);
    await act(async () => { typeInto(surface(s), "Second forward"); });
    await waitFor(() => saves(s).length > n, "the second forward's save", PAUSE_ROUNDS);
    expect(saves(s).slice(n).map((x) => x.draftId), "the dock wrote the composer's row").not.toContain(row);
  }, 60_000);

  it("a forward row the composer edited and left opens on Forward with the composer's words, and keeps them", async () => {
    const other = { ...replyDraft("d-other", "m9", "Another draft"), inReplyToMessageId: null, subject: "Another letter" } as EngineDraft;
    const s = await mountShell("#/ohbox", [withFiles("m1")], [other], { parts: true });
    await fill(s);
    await waitFor(() => saves(s).length === 1, "the first save", PAUSE_ROUNDS);
    const row = forwards(s)[0]!.id;
    await key("Escape");
    const openFromDrafts = async (id: string): Promise<void> => {
      await route("#/drafts");
      await waitFor(() => s.el.querySelector(`.draft-row[data-id='${id}'] .draft-open`) != null, `${id} in Drafts`);
      await press(s.el.querySelector(`.draft-row[data-id='${id}'] .draft-open`), id);
      await waitFor(() => s.el.querySelector(".view-compose .rte-surface") != null, "the composer", 400);
    };
    await openFromDrafts(row);
    const n = saves(s).length;
    await act(async () => { typeInto(s.el.querySelector<HTMLElement>(".view-compose .rte-surface")!, "Composer words, "); });
    await waitFor(() => saves(s).length > n, "the composer's save", PAUSE_ROUNDS);
    await openFromDrafts("d-other");
    await waitFor(() => s.el.querySelector<HTMLInputElement>("#compose-subject")?.value === "Another letter", "the other draft");
    await route("#/ohbox");
    await forwardOn(s);
    await waitFor(() => (dock(s) ? surface(s).textContent ?? "" : "").includes("Composer words"), "the composer's words in the dock");
    await act(async () => { typeInto(surface(s), `${surface(s).textContent ?? ""} from the dock`); });
    await waitFor(() => saves(s).at(-1)?.body.endsWith("from the dock") === true, "the dock's save", PAUSE_ROUNDS);
    expect(s.store.get<EngineDraft>("draft", row)?.body, "the dock wrote its older words over the composer's").toContain("Composer words");
    await act(async () => { fwdSend(s).click(); });
    await waitFor(() => sends(s).length === 1, "the send on the wire");
    expect(sends(s)[0]!.body, "the send carried the dock's older words").toContain("Composer words");
  }, 90_000);

  it("a forward sent from another device while its dock is open closes the dock, says so, and is not sent again", async () => {
    const s = await mountShell("#/ohbox", [withFiles("m1")], [], { parts: true });
    await fill(s);
    await waitFor(() => saves(s).length === 1, "the first save", PAUSE_ROUNDS);
    await sentElsewhere(s, forwards(s)[0]!.id);
    await waitFor(() => dock(s) == null, "the dock closed");
    expect(document.body.textContent ?? "").toContain(en.reply.forwardSentElsewhere);
    await forwardOn(s);
    await waitFor(() => dock(s) != null, "a new forward");
    expect([sends(s), shown(s).includes(TO), surface(s).textContent?.includes(NOTE)]).toEqual([[], false, false]);
  }, 40_000);
});

describe("a reply's row sent from another device while its editor is open", () => {
  it("closes the editor, says so, and is not sent again", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(s, "m1");
    await typeAndPause(s, "See you Thursday", 1);
    await sentElsewhere(s, rowsFor(s, "m1")[0]!.id);
    await waitFor(() => replySurface(s.el) == null, "the editor closed");
    expect(document.body.textContent ?? "").toContain(en.reply.sentElsewhere);
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "a new reply");
    expect([sends(s), replySurface(s.el)!.textContent]).toEqual([[], ""]);
  }, 40_000);
});

describe("Restart to install saves an inline reply or forward first", () => {
  it("the words typed inside the pause are written before the restart", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(s, "m1");
    await act(async () => { typeInto(replySurface(s.el)!, "Typed just before the restart"); });
    const restarted = await pressRestart(s, () => rowsFor(s, "m1").map((d) => d.body));
    expect(await restarted(), "the restart went before the reply was written").toEqual(["Typed just before the restart"]);
  }, 30_000);

  it("a save on the wire is waited out, then the newer words go to the same row", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(s, "m1");
    let release: () => void = () => {};
    s.saveGate.wait = new Promise<void>((r) => { release = r; });
    await typeAndPause(s, "First words", 1);
    await act(async () => { typeInto(replySurface(s.el)!, "First words and the newer ones"); });
    const restarted = await pressRestart(s, () => ({ rows: rowsFor(s, "m1").map((d) => d.body), saves: saves(s).length }));
    s.saveGate.wait = null;
    await act(async () => { release(); });
    const at = await restarted();
    expect(at, "the newer words were not written, or went to a second row").toEqual({ rows: ["First words and the newer ones"], saves: 2 });
    expect(saves(s)[1]!.draftId).toBe(rowsFor(s, "m1")[0]!.id);
  }, 30_000);

  it("an inline forward's note is written before the restart", async () => {
    const s = await mountShell("#/ohbox", [message("m1", { hasAttachments: true, attachmentCount: 3 } as never)], [], { parts: true });
    await fillForward(s, "colleague@example.net", "Have a look at these two");
    expect(forwardDock(s.el)).not.toBeNull();
    const restarted = await pressRestart(s, () =>
      s.store.list<EngineDraft>("draft").filter((d) => d.forwardOfMessageId === "m1" && d.status === "draft").map((d) => d.body));
    expect(await restarted(), "the restart went before the forward was written").toEqual(["Have a look at these two"]);
  }, 40_000);
});

describe("a reply closed inside the pause is a draft on the account at once", () => {
  /** Well inside the two-second pause: a write seen by then is the close's. */
  const SOON = 30;
  const BODY = "Thirty-two characters of a reply";
  const inPlace = (el: HTMLElement) => el.querySelector<HTMLElement>(".view-receipts .scast.in-place .reply[data-reply-for] .rte-surface");
  const openInPlace = async (s: DraftShell): Promise<void> => {
    await waitFor(() => s.el.querySelector(".view-receipts .scast[data-sid]") != null, "the receipt", PAUSE_ROUNDS);
    await press(s.el.querySelector(".view-receipts .scast[data-sid]"), "the receipt");
    await press([...s.el.querySelectorAll<HTMLButtonElement>(".view-receipts button")]
      .find((b) => (b.textContent ?? "").trim().startsWith("Reply")) ?? null, "Reply");
    await waitFor(() => inPlace(s.el) != null, "the reply in place", PAUSE_ROUNDS);
  };

  it.each([["#/ohbox", "m1"], ["#/receipts", "p1"]])("%s: words, Esc, another view at once: the reply's one row holds them", async (at, id) => {
    const s = await mountShell(at, [message(id, (at === "#/receipts" ? { folder: "ohmail/Receipts" } : {}) as never)]);
    if (at === "#/ohbox") await openReplyOn(s, id); else await openInPlace(s);
    await act(async () => { typeInto((at === "#/ohbox" ? replySurface(s.el) : inPlace(s.el))!, BODY); });
    await key("Escape");
    await route("#/screener");
    await waitFor(() => rowsFor(s, id).length === 1, "the reply's row", SOON);
    expect([saves(s).map((x) => [x.draftId, x.inReplyToMessageId, x.body]), rowsFor(s, id).map((d) => d.body)]).toEqual([[[null, id, BODY]], [BODY]]);
  }, 40_000);

  it("a forward closed inside the pause keeps its To, files and note in its row", async () => {
    const s = await mountShell("#/ohbox", [message("m1", { hasAttachments: true, attachmentCount: 3 } as never)], [], { parts: true });
    await fillForward(s, "colleague@example.net", "Have a look at these two");
    await key("Escape");
    await route("#/screener");
    const fwd = (): EngineDraft[] => s.store.list<EngineDraft>("draft").filter((d) => d.forwardOfMessageId === "m1" && d.status === "draft");
    await waitFor(() => fwd().length === 1, "the forward's row", SOON);
    expect([fwd()[0]!.body, fwd()[0]!.to.map((a) => a.address), fwd()[0]!.forwardParts?.length]).toEqual(["Have a look at these two", ["colleague@example.net"], 2]);
  }, 40_000);

  it.each(["the pause fires", "Esc closes it"])("%s while the first save is on the wire: the newer words reach that row", async (how) => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await openReplyOn(s, "m1");
    let release: () => void = () => {};
    s.saveGate.wait = new Promise<void>((r) => { release = r; });
    await typeAndPause(s, "First words", 1);
    await act(async () => { typeInto(replySurface(s.el)!, "First words and the newer ones"); });
    if (how === "Esc closes it") await key("Escape");
    else for (let i = 0; i < 120; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    s.saveGate.wait = null;
    await act(async () => { release(); });
    await waitFor(() => saves(s).length === 2, "the newer words", SOON);
    expect([saves(s)[1]!.draftId, rowsFor(s, "m1").map((d) => d.body)]).toEqual([rowsFor(s, "m1")[0]!.id, ["First words and the newer ones"]]);
  }, 30_000);

  it.each(["reply", "forward"])("a %s sent at once offline, then cancelled: one row holds its words, opened and left again", async (what) => {
    const fwd = what === "forward";
    const s = await mountShell("#/ohbox", [message("m1", (fwd ? { hasAttachments: true, attachmentCount: 3 } : {}) as never)], [], { parts: fwd });
    const rows = (): Array<string | null> => s.store.list<EngineDraft>("draft")
      .filter((d) => d.status === "draft" && (fwd ? d.forwardOfMessageId : d.inReplyToMessageId) === "m1").map((d) => d.body);
    const button = (word: string): HTMLButtonElement =>
      [...s.el.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button")].find((b) => (b.textContent ?? "").trim().startsWith(word))!;
    s.offline.on = true;
    if (fwd) await fillForward(s, "colleague@example.net", BODY);
    else { await openReplyOn(s, "m1"); await act(async () => { typeInto(replySurface(s.el)!, BODY); }); }
    await act(async () => { button("Send").click(); });
    await waitFor(() => (s.el.querySelector(".reply .send-status")?.textContent ?? "").includes(en.reply.statusQueued), "Not sent yet");
    // Offline the Cancel is owed; back online, the server answers it withdrawn.
    await act(async () => { button("Cancel").click(); });
    await waitFor(() => [...document.querySelectorAll(".toast, .toast-held")].some((n) => n.textContent?.includes(en.compose.cancelUnreachable)), "the owed Cancel");
    s.withdrawAnswer.outcome = "withdrawn";
    s.offline.on = false;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => s.el.querySelector(".reply[data-reply-for]") == null, "the dock closed on the answer");
    await waitFor(() => rows().length === 1, "the cancelled words in a row", PAUSE_ROUNDS);
    if (fwd) await openForward(s); else await key("r");
    await waitFor(() => (s.el.querySelector(".reply[data-reply-for] .rte-surface")?.textContent ?? "").includes(BODY), "the words again");
    await key("Escape");
    await route("#/screener");
    for (let i = 0; i < 40; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect([sends(s).length, rows(), saves(s).filter((x) => x.draftId === null).length]).toEqual([0, [BODY], 1]);
  }, 60_000);
});

type MutateOpts = { createdRow?: { id: string }; onDraftRow?: (row: { id: string; revision: string | null; fingerprint: string }) => Promise<void> };
/**
 * THE SERVER MAKES THE ROW AND DOES NOT SEND: a press with no row creates one first (the adapter's
 * POST /drafts), reports it, and every attempt is then refused retryably, as a drop or a 5xx is.
 */
function sendMakesItsRow(s: DraftShell, server: DraftServer): void {
  const adapter = (s.engine as unknown as { adapter: { mutate: (m: EngineMutation, o?: MutateOpts) => Promise<unknown> } }).adapter;
  const real = adapter.mutate;
  adapter.mutate = async (m, o) => {
    if (m.kind !== "mail_send" || s.offline.on) return real(m, o);
    s.sent.push(m);
    if (!m.draftId && o?.createdRow === undefined) {
      const made = server.answer({
        kind: "draft_save", draftId: null, mailboxId: m.mailboxId ?? "mb1", threadId: m.threadId ?? null, inReplyToMessageId: m.inReplyTo,
        subject: m.subject ?? "", body: m.body, html: m.html ?? null, to: m.to ?? [], cc: m.cc ?? [], bcc: m.bcc ?? [],
      } as EngineMutation)!;
      await s.store.applyChanges(made.changes);
      await o?.onDraftRow?.({ id: made.entityId!, revision: made.revision ?? null, fingerprint: sendFingerprint(m) });
    }
    throw new MutationRejectedError("not sent yet", { status: 409, code: "send_failed", retryable: true });
  };
}

describe("a reply, forward or letter whose Send made its row, cancelled while it waits, is that one draft", () => {
  const BODY = "Thirty-two characters of a reply";
  const MORE = `${BODY}, and two more`;
  const button = (s: DraftShell, word: string): HTMLButtonElement =>
    [...s.el.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button")].find((b) => (b.textContent ?? "").trim().startsWith(word))!;
  const held = (server: DraftServer): Array<[string, string | null]> => [...server.rows.values()].map((d) => [d.status, d.body]);

  it.each([
    ["reply", "at once"], ["reply", "once back online"], ["reply", "in another window"],
    ["forward", "at once"], ["forward", "once back online"], ["forward", "in another window"],
  ])("a %s, Cancel answered %s: one draft holds the newest words, on another device too", async (what, when) => {
    const fwd = what === "forward";
    const server = new DraftServer();
    const s = await mountShell("#/ohbox", [message("m1", (fwd ? { hasAttachments: true, attachmentCount: 3 } : {}) as never)], [], { server, parts: fwd });
    sendMakesItsRow(s, server);
    const surface = (): HTMLElement => (fwd ? forwardDock(s.el)?.querySelector<HTMLElement>(".rte-surface") : replySurface(s.el))!;
    if (fwd) await fillForward(s, "colleague@example.net", BODY);
    else { await openReplyOn(s, "m1"); await act(async () => { typeInto(surface(), BODY); }); }
    await act(async () => { button(s, "Send").click(); });
    await waitFor(() => server.rows.size === 1
      && (s.el.querySelector(".reply .send-status")?.textContent ?? "").includes(en.reply.statusQueued), "the press's row, Not sent yet", PAUSE_ROUNDS);
    if (when === "at once") s.withdrawAnswer.outcome = "withdrawn";
    else if (when === "once back online") s.offline.on = true;
    // Another window's Cancel, answered there: this window's engine hears its notice (`heard`).
    const sendKey = s.engine.pendingMutations().find((p) => p.mutation.kind === "mail_send")?.key;
    if (when === "in another window") await act(async () => { await s.engine.withdrawQueued(sendKey!, { askedElsewhere: true, answered: "withdrawn" }); });
    else await act(async () => { button(s, "Cancel").click(); });
    if (when === "once back online") {
      await waitFor(() => [...document.querySelectorAll(".toast, .toast-held")].some((n) => n.textContent?.includes(en.compose.cancelUnreachable)), "the owed Cancel");
      s.withdrawAnswer.outcome = "withdrawn";
      s.offline.on = false;
      await act(async () => { window.dispatchEvent(new Event("online")); });
    }
    await waitFor(() => s.el.querySelector(".reply[data-reply-for]") == null, "the dock closed", PAUSE_ROUNDS);
    await route("#/screener");
    await waitFor(() => saves(s).length === 1, "the close's save", PAUSE_ROUNDS);
    for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    const cancelled = held(server);
    // Later: Reply (or Forward) again, more words, Esc and another view.
    await route("#/ohbox");
    if (fwd) await openForward(s); else await openReplyOn(s, "m1");
    await waitFor(() => (surface()?.textContent ?? "").includes(BODY), "the words again");
    await act(async () => { typeInto(surface(), MORE); });
    await key("Escape");
    await route("#/screener");
    await waitFor(() => held(server).some(([, body]) => body === MORE), "the newest words on the account", PAUSE_ROUNDS);
    const other = await server.device();
    expect({ cancelled, later: held(server), other: other.read().list<EngineDraft>("draft").map((d) => [d.status, d.body]) })
      .toEqual({ cancelled: [["draft", BODY]], later: [["draft", MORE]], other: [["draft", MORE]] });
  }, 60_000);

  it("a letter, Cancel answered once back online, then closed: the composer keeps it in that one draft", async () => {
    const server = new DraftServer();
    const s = await mountShell("#/ohbox", [message("m1")], [], { server });
    sendMakesItsRow(s, server);
    const set = async (sel: string, value: string): Promise<void> => {
      const input = s.el.querySelector<HTMLInputElement>(sel)!;
      const write = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => { write.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
    };
    await key("c");
    await waitFor(() => s.el.querySelector(".view-compose .rte-surface") != null, "the composer");
    await set("#compose-to", "lena@example.invalid, ");
    await set("#compose-subject", "A letter");
    await act(async () => { typeInto(s.el.querySelector<HTMLElement>(".view-compose .rte-surface")!, BODY); });
    await settleEditor();
    const send = [...s.el.querySelectorAll<HTMLButtonElement>(".view-compose .send-row button")]
      .find((b) => /^Send(?!.*later)/i.test((b.textContent ?? "").trim()))!;
    await act(async () => { send.click(); });
    await waitFor(() => server.rows.size === 1 && (s.el.textContent ?? "").includes(en.compose.statusQueued), "the press's row, Not sent yet", PAUSE_ROUNDS);
    s.offline.on = true;
    await press(s.el.querySelector(".compose-cancel"), "Cancel");
    await press([...s.el.querySelectorAll<HTMLButtonElement>(".compose-confirm button")].find((b) => (b.textContent ?? "").trim() === en.compose.cancelConfirm) ?? null, "Discard message");
    await waitFor(() => [...document.querySelectorAll(".toast, .toast-held")].some((n) => n.textContent?.includes(en.compose.cancelUnreachable)), "the owed Cancel");
    s.withdrawAnswer.outcome = "withdrawn";
    s.offline.on = false;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => !(s.el.textContent ?? "").includes(en.compose.statusQueued), "the Cancel answered", PAUSE_ROUNDS);
    await key("Escape");
    for (let i = 0; i < 80; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    const other = await server.device();
    expect({ account: held(server), other: other.read().list<EngineDraft>("draft").map((d) => [d.status, d.body]) })
      .toEqual({ account: [["draft", BODY]], other: [["draft", BODY]] });
  }, 60_000);
});
