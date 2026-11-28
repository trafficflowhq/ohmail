/** @vitest-environment jsdom */
import { fireEvent, screen, within } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import {
  COMPOSER_KEY, EMPTY_COMPOSE, composeRowKey, composeSessionId,
  handOffComposer, markComposeRowHolds, resetComposerForTest, writeComposeDraft, writeComposeRow,
} from "@ohmail/app-logic/writing/compose";
import { claimSendLock, sendLocksKey, SEND_LOCK_FORMAT } from "@ohmail/app-logic/writing/send-lock";
import { AUTOSAVE_DELAY_MS, holdsSig } from "@ohmail/app-logic/writing/compose-autosave";
import { COMPOSE_SEND_KEY } from "@ohmail/app-logic/writing/mail-send";
import { settleFirstPaint } from "./_first-paint.js";
import { resetStorageOwnerForTest, setStorageOwner, storageOwner } from "@ohmail/app-logic/storage/storage-owner";
import { DraftServer, mountShell as mountWithDraftServer, press as pressInShell, storeWith, stubDom, unmountAll, waitFor } from "./_draft-shell.js";
import { holdTheWire, letter, navigate } from "./_handoff-steps.js";

/**
 * THE PLAIN COMPOSE DOOR SAYS IT RESUMED A MESSAGE. `#/compose` opens the message left unfinished
 * — decided, and right — but said nothing, so a person who meant to start a new one found the old
 * one and edited it. The composer now says so, and not when a door put a message there on purpose
 * (a draft opened from Drafts) nor over a held message, whose own sentence says more.
 * Mutation: the note's condition made false → cases 1 and 4 red; the seeded mark ignored → case 2 red.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const RECIPIENT = "lena@atelier.example";
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const composer = () => within(host!).getByRole("region", { name: messages.write.letter });
const subjectField = () => within(composer()).getByRole<HTMLTextAreaElement>("textbox", { name: "Subject" });
const press = async (el: HTMLElement): Promise<void> => { await act(async () => { el.click(); }); };
const settle = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); });
};

async function goto(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settle(6);
  await settleFirstPaint();
}

async function mountShell(): Promise<void> {
  const { MailShell } = await import("./_mail-shell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-09-27T09:00:00.000Z"),
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(ToastHost, { children: h(MailShell, { demo: true }) }),
      }),
    }));
  });
  await settle(10);
}

async function makeADraft(): Promise<string> {
  await goto("#/compose");
  const to = within(composer()).getByRole("combobox", { name: "To" });
  await act(async () => {
    fireEvent.change(to, { target: { value: `${RECIPIENT}, ` } });
    fireEvent.change(subjectField(), { target: { value: "Bis Montag" } });
  });
  await act(async () => { await new Promise((r) => setTimeout(r, AUTOSAVE_DELAY_MS + 400)); });
  await settle(10);
  const id = window.localStorage.getItem(composeRowKey(storageOwner()));
  expect(id, "the compose never wrote a row").not.toBeNull();
  return id!;
}

/** A send record naming the row, its outcome unknown — what a browser holds after a lost answer. */
function parkTheRow(draftId: string): void {
  window.localStorage.setItem(sendLocksKey(storageOwner()), JSON.stringify([{
    v: SEND_LOCK_FORMAT, lane: "compose", key: "KEY-HELD", at: Date.now(),
    draftId, fp: "fp-held", subject: `draft:${draftId}`, unverified: true,
  }]));
}

const notes = (): string[] =>
  within(composer()).queryAllByRole("status").map((n) => n.textContent ?? "");
const compose = messages.compose as unknown as Record<string, string>;

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* blocked storage */ }
  window.sessionStorage.removeItem(COMPOSER_KEY);
  resetComposerForTest();
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

describe("the plain compose door, over a message left unfinished", () => {
  it("1 — says it resumed that message", async () => {
    await mountShell();
    await makeADraft();
    await goto("#/ohbox");
    await goto("#/compose");
    expect(notes(), "the composer resumed a message without saying so").toContain(compose.resumedNote);
  }, 30_000);

  it("2 — says nothing over a draft a person opened from Drafts", async () => {
    await mountShell();
    const id = await makeADraft();
    await goto("#/drafts");
    const drafts = within(host!).getByRole("listbox", { name: messages.drafts.title });
    const open = within(drafts).getByRole("option", { name: `${RECIPIENT}: Bis Montag` });
    expect(open.dataset.id).toBe(id);
    await press(open);
    await settle(6);
    await settleFirstPaint();
    expect(window.location.hash).toBe("#/compose");
    expect(notes(), "a draft opened on purpose was announced as resumed").not.toContain(compose.resumedNote);
  }, 30_000);

  it("3 — gives way to a held message's own sentence", async () => {
    await mountShell();
    const id = await makeADraft();
    parkTheRow(id);
    await goto("#/ohbox");
    await goto("#/compose");
    expect(notes().some((line) => line.startsWith(messages.write.status.unverified))).toBe(true);
    expect(notes(), "the resumed line stood over a held message").not.toContain(compose.resumedNote);
  }, 30_000);

  it("4 — a reload that brings the message back on the compose door says it too", async () => {
    await mountShell();
    await makeADraft();
    await act(async () => { root!.unmount(); });
    host?.remove();
    window.location.hash = "#/compose";
    await mountShell();
    await settle(10);
    await settleFirstPaint();
    expect(subjectField().value, "the reload did not restore the message").toBe("Bis Montag");
    expect(notes(), "the restored message was not said as resumed").toContain(compose.resumedNote);
  }, 30_000);

  it("CONTROL: an empty composer says nothing about resuming", async () => {
    await mountShell();
    await goto("#/compose");
    expect(notes()).not.toContain(compose.resumedNote);
  }, 30_000);

  it.each(["Write", "keyboard shortcut"])("starts empty from %s after opening a saved draft", async (door) => {
    await mountShell();
    const id = await makeADraft();
    await goto("#/drafts");
    const drafts = within(host!).getByRole("listbox", { name: messages.drafts.title });
    await press(within(drafts).getByRole("option", { name: `${RECIPIENT}: Bis Montag` }));
    await settleFirstPaint();
    expect(subjectField().value).toBe("Bis Montag");
    const earlierSession = composeSessionId(storageOwner());

    if (door === "Write") await press(within(host!).getByRole("button", { name: /^Write$/ }));
    else {
      await goto("#/ohbox");
      await act(async () => { fireEvent.keyDown(document, { key: "c", code: "KeyC" }); });
    }
    await settle();
    await settleFirstPaint();
    expect(subjectField().value).toBe("");
    expect(composeSessionId(storageOwner())).not.toBe(earlierSession);
    expect(window.localStorage.getItem(composeRowKey(storageOwner()))).toBeNull();

    await goto("#/drafts");
    const stillKept = within(host!).getByRole("listbox", { name: messages.drafts.title });
    expect(within(stillKept).getByRole("option", { name: `${RECIPIENT}: Bis Montag` }).dataset.id).toBe(id);
  }, 30_000);

  it("offers the words from a closed tab through a restore action", async () => {
    await mountShell();
    await act(async () => { root!.unmount(); });
    host?.remove();
    const scope = storageOwner();
    composeSessionId(scope);
    writeComposeDraft({ ...EMPTY_COMPOSE, subject: "Garden notes", body: "The seedlings are ready." }, scope);
    handOffComposer();
    resetComposerForTest();
    window.sessionStorage.setItem(COMPOSER_KEY, "another-tab");
    window.location.hash = "#/ohbox";

    await mountShell();
    expect(within(host!).queryByRole("region", { name: messages.write.letter })).toBeNull();
    const restore = within(document.body).getByRole("button", { name: "Restore draft" });
    await press(restore);
    await settleFirstPaint();
    expect(subjectField().value).toBe("Garden notes");
    expect(within(document.body).queryByRole("button", { name: "Restore draft" })).toBeNull();
  }, 30_000);
});


describe("recovering and ending a draft", () => {
  const owner = "account-garden";
  const subject = "Garden notes";
  const words = "The seedlings are ready.";
  const recipient = { name: "Gardener", address: "peer@example.invalid" };
  const fields = { ...EMPTY_COMPOSE, subject, body: words };
  const heldWords = (text = words): boolean => Object.values(window.localStorage).some((value) => value.includes(text));
  const form = async () => within(await screen.findByRole("region", { name: messages.write.letter }));

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetComposerForTest();
    setStorageOwner(owner);
    stubDom();
  });

  afterEach(async () => {
    await unmountAll();
    resetStorageOwnerForTest();
  });

  it.each([
    { scenario: "one closed tab", closeOrder: ["editing-tab"] },
    { scenario: "two tabs with the older copy first", closeOrder: ["older-tab", "editing-tab"] },
    { scenario: "two tabs with the older copy last", closeOrder: ["editing-tab", "older-tab"] },
  ])("keeps recovered edits when opening their older Drafts row with $scenario", async ({ closeOrder }) => {
    const id = "saved-draft";
    const latest = words + " Use the south gate.";
    const server = new DraftServer([letter(id, subject, words, recipient)]);
    const saved = { ...fields, to: recipient.address, fromMailboxId: "mb1" };
    const tab = (name: string) => {
      resetComposerForTest();
      window.sessionStorage.setItem(COMPOSER_KEY, name);
    };
    const openSavedVersion = (name: string) => {
      tab(name);
      composeSessionId(owner);
      writeComposeDraft(saved, owner);
      writeComposeRow(id, owner);
      markComposeRowHolds({
        row: id, sig: holdsSig(saved), fromMailboxId: saved.fromMailboxId, rev: server.rows.get(id)!.contentRevision,
      }, owner);
    };
    if (closeOrder.length > 1) openSavedVersion("older-tab");
    openSavedVersion("editing-tab");
    writeComposeDraft({ ...saved, body: latest }, owner);
    for (const name of closeOrder) {
      tab(name);
      handOffComposer();
    }
    tab("next-tab");
    if (closeOrder.length > 1) {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: {
          request: async (_name: string, _options: unknown, run: (lock: object) => unknown) => run({}),
          query: async () => ({ held: [], pending: [] }),
        },
      });
      onTestFinished(() => { Reflect.deleteProperty(navigator, "locks"); });
    }

    const shell = await mountWithDraftServer("#/drafts", [], [], { server });
    const list = await screen.findByRole("listbox", { name: messages.drafts.title });
    await pressInShell(within(list).getByRole("option", { name: new RegExp(subject) }), "open the saved draft");
    const body = (await form()).getByRole("textbox", { name: messages.write.text });
    expect(body.textContent).toContain(latest);
    await waitFor(() => server.rows.get(id)?.body === latest, "the recovered edit to reach the draft");
    expect(shell.sent.filter((m) => m.kind === "draft_save" && m.draftId === null)).toEqual([]);

    await navigate("#/drafts");
    const drafts = await screen.findByRole("listbox", { name: messages.drafts.title });
    await pressInShell(within(drafts).getByRole("option", { name: new RegExp(subject) }), "reopen the saved draft");
    expect((await form()).getByRole("textbox", { name: messages.write.text }).textContent).toContain(latest);

    await act(async () => { handOffComposer(); });
    await unmountAll();
    tab("another-fresh-tab");
    await mountWithDraftServer("#/drafts", [], [], { server });
    const restore = await screen.findByRole("button", { name: messages.compose.restoreDraft });
    await pressInShell(restore, "restore the draft in another fresh tab");
    expect((await form()).getByRole("textbox", { name: messages.write.text }).textContent).toContain(latest);
  }, 30_000);

  it("Send uses the first save's row when the recipient was entered while that save was answering", async () => {
    const server = new DraftServer();
    const shell = await mountWithDraftServer("#/compose", [], [], { server });
    const editor = await form();
    let answer!: () => void;
    shell.saveGate.wait = new Promise<void>((resolve) => { answer = resolve; });
    const body = editor.getByRole("textbox", { name: messages.write.text }) as HTMLElement & { editor: Editor };
    await act(async () => {
      fireEvent.change(editor.getByRole("textbox", { name: messages.write.subject }), { target: { value: subject } });
      body.editor.commands.insertContent(words);
    });
    await waitFor(() => shell.sent.some((m) => m.kind === "draft_save" && m.draftId === null), "the first save on the wire");
    await act(async () => {
      fireEvent.change(editor.getByRole("combobox", { name: messages.write.to }), { target: { value: recipient.address } });
    });
    await pressInShell(editor.getByRole("button", { name: messages.write.send }), "send the letter");
    await act(async () => { answer(); });
    await waitFor(() => [...server.rows.values()].some((row) => row.status === "sent"), "the sent row");
    expect(shell.sent.find((m) => m.kind === "mail_send")?.draftId).toBeTruthy();
    expect([...server.rows.values()].map((row) => row.status)).toEqual(["sent"]);
  }, 30_000);

  it.each(["send", "discard"])("a %s after pagehide removes the copy left for another tab", async (action) => {
    const server = new DraftServer([letter("saved-row", subject, words, recipient)]);
    const row = server.rows.get("saved-row")!;
    composeSessionId(owner);
    const saved = { ...fields, to: recipient.address };
    writeComposeDraft(saved, owner);
    writeComposeRow(row.id, owner);
    markComposeRowHolds({ row: row.id, sig: holdsSig(saved), rev: row.contentRevision }, owner);
    writeComposeDraft({ ...fields, body: "Another account's words" }, "another-account");
    const shell = await mountWithDraftServer("#/compose", [], [], { server });
    const editor = await form();
    if (action === "send") {
      const finish = holdTheWire(shell);
      await pressInShell(editor.getByRole("button", { name: messages.write.send }), "send the draft");
      await waitFor(() => shell.sent.some((m) => m.kind === "mail_send"), "the send on the wire");
      await act(async () => { handOffComposer(); });
      expect(heldWords()).toBe(true);
      await act(async () => { finish(); });
    } else {
      await act(async () => { handOffComposer(); });
      expect(heldWords()).toBe(true);
      await pressInShell(editor.getByRole("button", { name: messages.write.discard }), "discard the draft");
    }
    await waitFor(() => !heldWords(), "the recovery copy to clear");
    expect(heldWords("Another account's words")).toBe(true);
    expect([...server.rows.values()].map((draft) => draft.status)).toEqual(action === "send" ? ["sent"] : []);
  }, 30_000);

  it.each(["same revision", "later revision", "different session", "unsent correction", "different sent revision"])("checks proof before removing a leftover row with %s", async (state) => {
    const earlierWords = state === "unsent correction" ? words + " Please use the side door." : words;
    const earlier = { ...letter("old-row", subject, earlierWords, recipient), to: [] };
    const sent = { ...letter("sent-row", subject, words, recipient), status: "sent" as const };
    const server = new DraftServer([earlier, sent]);
    // The initial sync omits sent text. The single-row read must match its revision.
    const store = await storeWith([], [server.rows.get(earlier.id)!, {
      ...server.rows.get(sent.id)!, body: null, html: null, bodyOmitted: "sent",
    }]);
    if (state === "different sent revision") {
      server.rows.set(sent.id, { ...server.rows.get(sent.id)!, contentRevision: "different-sent-revision" });
    }
    const savedRevision = server.rows.get(earlier.id)!.contentRevision!;
    const session = composeSessionId(owner)!;
    const buffer = { ...fields, body: earlierWords };
    writeComposeDraft(buffer, owner);
    writeComposeRow(earlier.id, owner);
    markComposeRowHolds({ row: earlier.id, sig: holdsSig(buffer), rev: state === "later revision" ? "earlier-revision" : savedRevision }, owner);
    claimSendLock({
      v: 1, lane: COMPOSE_SEND_KEY, key: "sent-key", at: Date.now(), draftId: sent.id,
      fp: "pressed-words", session: state === "different session" ? "other-session" : session,
    }, () => false, owner);
    let readSentBody = false;
    const shell = await mountWithDraftServer("#/compose", [], [], { server, store, prepareEngine(engine) {
      const readDraftBody = engine.readDraftBody.bind(engine);
      vi.spyOn(engine, "readDraftBody").mockImplementation(async (id) => {
        const content = await readDraftBody(id);
        if (id === sent.id) readSentBody = true;
        return content;
      });
    } });
    if (state === "same revision") {
      await waitFor(() => !heldWords(), "the proven copy to clear");
      expect(shell.sent).toContainEqual({ kind: "draft_discard", draftId: earlier.id, ifContentRevision: savedRevision });
      expect([...server.rows.values()].map((row) => row.status)).toEqual(["sent"]);
    } else {
      const editor = await form();
      const body = editor.getByRole("textbox", { name: messages.write.text });
      if (state === "unsent correction" || state === "different sent revision") {
        await waitFor(() => readSentBody || !server.rows.has(earlier.id), "the sent body check or the attempted cleanup");
      }
      await waitFor(() => body.textContent?.includes(earlierWords) === true || !server.rows.has(earlier.id),
        "the recovered words or the attempted cleanup");
      expect(shell.sent.filter((m) => m.kind === "draft_discard")).toEqual([]);
      expect(heldWords()).toBe(true);
      expect(server.rows.has(earlier.id)).toBe(true);
    }
  }, 30_000);

  it.each([
    { name: "an empty handoff", body: "", offered: false },
    { name: "a handoff holding only whitespace", body: "  ", offered: false },
    { name: "a handoff with words", body: words, offered: true },
  ])("updates the open composer when sync deletes the draft behind $name", async ({ body, offered }) => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, run: (lock: object) => unknown) => run({}),
        query: async () => ({ held: [], pending: [] }),
      },
    });
    onTestFinished(() => { Reflect.deleteProperty(navigator, "locks"); });
    const draftId = "saved-draft";
    const offer = () => screen.queryByRole("button", { name: "Restore draft" });
    const hasRecovery = () => Object.values(window.localStorage).some((value) => value.includes(draftId));
    const server = new DraftServer([{ ...letter(draftId, "", body), to: [], html: null }]);
    const fields = { ...EMPTY_COMPOSE, body };
    window.sessionStorage.setItem(COMPOSER_KEY, "leaving-tab");
    composeSessionId(owner);
    writeComposeDraft(fields, owner);
    writeComposeRow(draftId, owner);
    markComposeRowHolds({ row: draftId, sig: holdsSig(fields), rev: server.rows.get(draftId)!.contentRevision }, owner);
    handOffComposer();
    expect(hasRecovery()).toBe(true);

    resetComposerForTest();
    window.sessionStorage.setItem(COMPOSER_KEY, "next-tab");
    const { engine } = await mountWithDraftServer("#/compose", [], [], { server });
    expect.soft(offer() !== null, "Restore before sync").toBe(offered);
    expect.soft(hasRecovery(), "recovery storage before sync").toBe(offered);
    expect(engine.confirmedDraft(draftId)?.status).toBe("draft");

    server.answer({ kind: "draft_discard", draftId });
    await act(async () => { await engine.syncOnce(); });

    expect(engine.confirmedDraft(draftId)).toBeUndefined();
    expect.soft(offer()).toBeNull();
    expect(hasRecovery()).toBe(false);
  });
});
