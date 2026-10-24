/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineDraft } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import { act, message, mountShell, press, replyDraft, replySurface, stubDom, unmountAll, waitFor, type DraftShell } from "./_draft-shell.js";

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
