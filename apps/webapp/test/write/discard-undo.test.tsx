/** @vitest-environment jsdom */
/**
 * DISCARD WITHOUT ASKING, WITH UNDO, on the composition's own doors: the discard goes at the press as the shipped
 * Cancel does after its question, and Undo puts the words back through the new-letter door, as a new row. Today's Cancel
 * (the old view's question, then the press) offers nothing back.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_COMPOSE, readComposeDraft, resetComposerForTest } from "@ohmail/app-logic/writing/compose";
import { UNDO_MS } from "@ohmail/app-logic/press";
import en from "../../messages/en.json";
import { act, message, stubDom } from "../_draft-shell.js";
import { letter } from "../_handoff-steps.js";
import { mountWriting, rounds, unmountWritings } from "../_write-1-writing.js";

const LETTER = { ...EMPTY_COMPOSE, to: "lena@example.invalid, ", subject: "Friday", body: "Shall we meet at noon?" };

beforeEach(() => {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    /* storage blocked */
  }
  stubDom();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
});
afterEach(async () => {
  await unmountWritings();
  resetComposerForTest();
});

describe("a new letter's discard", () => {
  it("goes at once, says so with Undo for the press window, and Undo puts the words back", async () => {
    const w = await mountWriting();
    await act(async () => w.now().onComposeFields(LETTER));
    await rounds(4);
    await act(async () => w.now().discardCompose());
    await rounds(6);
    expect(w.now().compose.body).toBe("");
    expect(readComposeDraft("acc-1")?.body ?? "").toBe("");
    const said = w.reports.find((r) => r.message === en.compose.toastDiscard);
    expect(said?.options?.action).toBe(en.ohbox.undo);
    expect(said?.options?.duration).toBe(UNDO_MS);
    await act(async () => said!.options!.onAction!());
    await rounds(6);
    expect(window.location.hash).toBe("#/compose");
    expect({ to: w.now().compose.to, subject: w.now().compose.subject, body: w.now().compose.body }).toEqual({
      to: LETTER.to,
      subject: LETTER.subject,
      body: LETTER.body,
    });
    expect(readComposeDraft("acc-1")?.body).toBe(LETTER.body);
  });

  it("offers nothing back for an empty letter, nor for today's Cancel", async () => {
    const w = await mountWriting();
    await act(async () => w.now().discardCompose());
    await rounds(6);
    expect(w.reports.filter((r) => r.options?.onAction)).toEqual([]);
    window.location.hash = "#/compose";
    await act(async () => w.now().onComposeFields(LETTER));
    await rounds(4);
    await act(async () => w.now().cancelCompose());
    await rounds(6);
    expect(w.now().compose.body).toBe("");
    expect(w.reports.filter((r) => r.options?.onAction)).toEqual([]);
  });
});

describe("a letter whose send is not confirmed", () => {
  it("is kept: its discard says it is not confirmed and offers nothing back", async () => {
    const row = letter("d-a", "Plans for Friday", "Shall we meet at noon?");
    const w = await mountWriting({ drafts: [row] });
    await act(async () => w.now().openDraft(row));
    await rounds(6);
    Object.assign(w.refuseSend, { on: true, unverified: true });
    await act(async () => w.now().sendCompose());
    await rounds(30);
    expect(w.now().discardKeepsCompose()).toBe("held");
    await act(async () => w.now().discardCompose());
    await rounds(6);
    expect(w.reports.map((r) => r.message)).toContain(en.compose.discardHeld);
    expect(w.reports.filter((r) => r.message === en.compose.toastDiscard)).toEqual([]);
  });
});

describe("a reply's discard", () => {
  it("closes the reply, says so with Undo, and Undo opens it again with its words", async () => {
    const w = await mountWriting({ messages: [message("m1")], hash: "#/ohbox" });
    await act(async () => w.now().openReply("m1"));
    await rounds(4);
    await act(async () => w.now().onReplyBody({ text: "Noon works.", html: "" }));
    await rounds(4);
    await act(async () => w.now().discardReply());
    await rounds(6);
    expect(w.replyTo()).toBeNull();
    const said = w.reports.find((r) => r.message === en.compose.toastDiscard);
    expect(said?.options?.duration).toBe(UNDO_MS);
    await act(async () => said!.options!.onAction!());
    await rounds(6);
    expect(w.replyTo()).toBe("m1");
    expect(w.now().replyBody.text).toBe("Noon works.");
  });

  it("offers nothing back for a reply with no words", async () => {
    const w = await mountWriting({ messages: [message("m1")], hash: "#/ohbox" });
    await act(async () => w.now().openReply("m1"));
    await rounds(4);
    await act(async () => w.now().discardReply());
    await rounds(6);
    expect(w.replyTo()).toBeNull();
    expect(w.reports.filter((r) => r.options?.onAction)).toEqual([]);
  });
});
