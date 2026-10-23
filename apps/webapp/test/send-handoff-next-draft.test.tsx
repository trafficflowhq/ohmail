/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineDraft, EngineMutation } from "@ohmail/client-engine";
import en from "../messages/en.json";
import {
  act, message, mountShell, press, replyDraft, replySurface, stubDom, unmountAll, waitFor, type DraftShell,
} from "./_draft-shell.js";
import {
  composeSend, composeSubject, composerOn, discards, drainRow, dropSendOverlay, footLine, holdTheWire, key, letter,
  navigate, openDraftRow, replyOn, replySend, rounds, sends,
} from "./_handoff-steps.js";

/**
 * THE NEXT DRAFT OPENED AS A SEND FINISHES KEEPS ITS ROW AND ITS WORDS (PR #198 review, HIGH).
 * The hand-off sends the person to the Ohbox at the press with the composer still bound to the sent
 * message, so going to Drafts and opening the next draft while the first one finishes is the
 * ordinary flow. The settlement that clears the composer acts on the message it was about, or on
 * nothing: it used to judge whatever row the composer held 600 ms after the confirmation (the sent
 * beat) and DELETE it as a phantom copy, empty the form and move the person to the Ohbox.
 */

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
});
afterEach(async () => { await unmountAll(); });

const A = letter("d-a", "Plans for Friday", "Shall we meet at noon?");
const B = letter("d-b", "Quarterly notes", "Three paragraphs I spent an hour on", { name: "Noor", address: "noor@example.invalid" });

/** A sent from the composer with the wire held; the person is in Drafts with B listed when this returns. */
async function sendA(s: DraftShell, handOff: boolean): Promise<() => void> {
  await composerOn(s, "d-a", "Plans for Friday");
  const release = holdTheWire(s);
  await press(composeSend(s.el)!, "Send A");
  if (handOff) await waitFor(() => s.el.querySelector(".view-compose") == null, "the composer let go of A");
  else await rounds(4);
  await navigate("#/drafts");
  await waitFor(() => s.el.querySelector(".draft-row[data-id='d-b'] .draft-open") != null, "B in Drafts");
  return release;
}

/** What became of B, a second past everything: its row, the composer and the route. */
async function afterwards(s: DraftShell): Promise<{ discards: string[]; bKept: boolean; composer: string | null; hash: string }> {
  await rounds(48);
  return {
    discards: discards(s),
    bKept: s.store.get<EngineDraft>("draft", "d-b") != null,
    composer: composeSubject(s.el),
    hash: window.location.hash,
  };
}
const KEPT = { discards: [], bKept: true, composer: "Quarterly notes", hash: "#/compose" };

describe("a compose send handed off, then the next draft opened as it finishes", () => {
  it("B opened right as A confirms keeps its row, its words and its place", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    const release = await sendA(s, true);
    await act(async () => { release(); });
    await composerOn(s, "d-b", "Quarterly notes");
    expect(await afterwards(s)).toEqual(KEPT);
  }, 60_000);

  it("B opened inside the beat, after the foot said Sent, keeps its row", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    const release = await sendA(s, true);
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.sendingLine.sent), "Sent on the foot line");
    await navigate("#/drafts");
    await composerOn(s, "d-b", "Quarterly notes");
    expect(await afterwards(s)).toEqual(KEPT);
  }, 60_000);

  it("B's open pressed before the confirmation, its text answering just after it, keeps its row", async () => {
    // B's text is not in the mirror, so its open waits on `GET /drafts/:id`, held past the confirmation.
    const s = await mountShell("#/drafts", [message("m1")], [A, { ...B, body: null } as unknown as EngineDraft], { handOff: true });
    let answer!: () => void;
    const held = new Promise<void>((r) => { answer = r; });
    const read = s.engine.readDraftBody.bind(s.engine);
    (s.engine as unknown as { readDraftBody: (id: string) => Promise<string | null> }).readDraftBody =
      async (id: string) => { if (id === "d-b") await held; return read(id); };
    const release = await sendA(s, true);
    await openDraftRow(s, "d-b");
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.sendingLine.sent), "Sent on the foot line");
    await rounds(6);
    await act(async () => { answer(); });
    await waitFor(() => composeSubject(s.el) === "Quarterly notes", "the composer on B");
    const r = await afterwards(s);
    expect({ discards: r.discards, bKept: r.bKept, composer: r.composer }).toEqual({ discards: [], bKept: true, composer: "Quarterly notes" });
  }, 60_000);

  it("with no hand-off, the waiting composer left by hand and B opened inside the beat, B keeps its row", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: false });
    const release = await sendA(s, false);
    await act(async () => { release(); });
    await rounds(2);
    await composerOn(s, "d-b", "Quarterly notes");
    expect(await afterwards(s)).toEqual(KEPT);
  }, 60_000);

  it("control: B opened after the beat", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    const release = await sendA(s, true);
    await act(async () => { release(); });
    await rounds(48);
    await composerOn(s, "d-b", "Quarterly notes");
    expect(await afterwards(s)).toEqual(KEPT);
  }, 60_000);

  it("control: B opened well past the beat, after the foot settled", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    const release = await sendA(s, true);
    await act(async () => { release(); });
    await waitFor(() => footLine() === "", "the foot line settled away", 200);
    await composerOn(s, "d-b", "Quarterly notes");
    expect(await afterwards(s)).toEqual(KEPT);
  }, 60_000);

  it("control: B opened before the confirmation", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    const release = await sendA(s, true);
    await composerOn(s, "d-b", "Quarterly notes");
    await act(async () => { release(); });
    expect(await afterwards(s)).toEqual(KEPT);
  }, 60_000);

  it("a handed-off send nobody shows settles at its confirmation: the composer opened right after holds none of it", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    const release = await sendA(s, true);
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.sendingLine.sent), "Sent on the foot line");
    await navigate("#/compose");
    await waitFor(() => s.el.querySelector(".view-compose") != null, "the composer");
    expect(composeSubject(s.el), "the delivered message waited a beat in the composer").toBe("");
    expect(composeSend(s.el)?.textContent ?? "", "a Sent beat over an empty composer").not.toMatch(/^Sent/);
  }, 60_000);

  it("the settled send still clears its own message: A leaves Drafts' composer and the form", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    const release = await sendA(s, true);
    await act(async () => { release(); });
    await rounds(48);
    await navigate("#/compose");
    await waitFor(() => s.el.querySelector(".view-compose") != null, "the composer");
    expect(composeSubject(s.el), "the delivered message still sat in the composer").toBe("");
    expect(discards(s), "a settled send deleted a row").toEqual([]);
  }, 60_000);
});

describe("a handed-off reply settles at its confirmation", () => {
  it("Reply pressed again right after the foot said Sent opens a ready dock, not a Sent beat", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await replyOn(s, "m1", "See you on Thursday");
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => footLine().includes(en.sendingLine.sent), "Sent on the foot line");
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the dock again");
    const label = ([...s.el.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button")]
      .find((b) => /^Sen/.test(b.textContent ?? ""))?.textContent ?? "").trim();
    expect(label, "the reopened dock stood on the last reply's Sent beat").toMatch(/^Send/);
  }, 60_000);

  it("its own row leaving Drafts mid-flight, then Reply pressed again: the delivered reply's dock closes", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await replyOn(s, "m1", "See you on Thursday at noon");
    await waitFor(() => s.sent.some((m) => m.kind === "draft_save"), "the reply's own row", 240);
    await rounds(8);
    const row = s.engine.read().list<EngineDraft>("draft").find((d) => d.inReplyToMessageId === "m1")!;
    const release = holdTheWire(s);
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => replySurface(s.el) == null, "the dock closed at the hand-off");
    // The server's reservation flips the row to sending, and the drain takes it out of Drafts.
    await drainRow(s, { ...row, status: "sending" } as EngineDraft);
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the dock again");
    await act(async () => { release(); });
    await dropSendOverlay(s, row.id);
    await waitFor(() => replySurface(s.el) == null, "the delivered reply's dock closed", 120);
    expect(sends(s), "the delivered words went twice").toHaveLength(1);
  }, 60_000);
});

describe("a reply seeded from a draft, then another reply draft opened into its dock before it settles", () => {
  const m1 = message("m1");
  const first = replyDraft("r-first", "m1", "The first answer");
  const second = { ...replyDraft("r-second", "m1", "A second, longer answer"), updatedAt: "2026-09-27T08:41:00.000Z" } as EngineDraft;

  for (const handOff of [true, false]) {
    it(`the second row survives the first reply's settlement (hand-off ${handOff ? "on" : "off"})`, async () => {
      const s = await mountShell("#/drafts", [m1], [first, second], { handOff });
      await openDraftRow(s, "r-first");
      await waitFor(() => (replySurface(s.el)?.textContent ?? "").includes("The first answer"), "the first row in the dock");
      const release = holdTheWire(s);
      await act(async () => { replySend(s.el)!.click(); });
      await rounds(4);
      await navigate("#/drafts");
      await openDraftRow(s, "r-second");
      await waitFor(() => (replySurface(s.el)?.textContent ?? "").includes("A second, longer answer"), "the second row in the dock");
      await act(async () => { release(); });
      await rounds(48);
      const sent = s.sent.filter((m) => m.kind === "mail_send") as Array<EngineMutation & { draftId?: string }>;
      expect(sent.map((m) => m.draftId), "the send went from the first row").toEqual(["r-first"]);
      expect(discards(s), "the settlement deleted the row opened after the press").not.toContain("r-second");
      expect(s.store.get<EngineDraft>("draft", "r-second"), "the second row is gone").toBeDefined();
    }, 60_000);
  }
});
