/** @vitest-environment jsdom */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import type { EngineDraft, EngineMutation } from "@ohmail/wire";
import { MutationRejectedError } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { act, DraftServer, mountShell, replyDraft, stubDom, unmountAll } from "./_draft-shell.js";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  stubDom();
});
afterEach(async () => {
  vi.useRealTimers();
  await unmountAll();
});

it.each(["synced", "unsynced", "offline"] as const)("keeps a newer save during Undo when the list is %s", async (connection) => {
  const row = { ...replyDraft("saved-draft", "unused", "First version"), subject: "Friday plans" };
  const server = new DraftServer([row]);
  const editor = await server.device();
  const newer = "Newer text from the editor.";
  try {
    const list = await mountShell("#/drafts", [], [], { server });
    const app = within(list.el);
    const visibleDraft = () => app.queryByRole("option", { name: /Friday plans/ });
    const reports = () => app.getAllByRole("status").map((report) => report.textContent);
    const discard = await app.findByRole("button", { name: "Discard" });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    list.syncHeld.on = connection !== "synced";
    list.offline.on = connection === "offline";
    fireEvent.click(discard);
    await advance(0);
    expect(visibleDraft()).toBeNull();

    const saved = await editor.mutate({
      kind: "draft_save", draftId: row.id, subject: row.subject, body: newer,
      to: row.to, cc: row.cc, bcc: row.bcc,
    });
    expect(saved.status).toBe("confirmed");
    if (connection === "synced") {
      await act(async () => { await list.engine.syncOnce(); });
      expect(visibleDraft()).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
      expect(reports()).toContain(messages.drafts.discardChanged);
    } else {
      expect(list.store.get<EngineDraft>("draft", row.id)?.body).toBe(row.body);
    }

    await advance(UNDO_MS);
    if (connection === "offline") {
      const pending = list.engine.pendingMutations().find((p) => p.mutation.kind === "draft_discard");
      if (!pending) throw new Error("Discard did not wait in the outbox");
      expect(visibleDraft()).toBeNull();
      list.offline.on = false;
      await act(async () => { await list.engine.retryQueued(pending.id); });
    }

    expect(server.rows.get(row.id)?.body).toBe(newer);
    expect(list.sent.some((m) => m.kind === "draft_discard")).toBe(connection !== "synced");
    expect(visibleDraft()).toBeTruthy();
    if (connection !== "synced") expect(reports()).toContain(messages.drafts.discardChanged);

    list.syncHeld.on = false;
    await act(async () => { await list.engine.syncOnce(); });
    expect(list.store.get<EngineDraft>("draft", row.id)?.body).toBe(newer);
  } finally {
    editor.dispose();
  }
}, 20_000);

it.each([false, true])("restores a draft when guarded Discard is unsupported (queued: %s)", async (offline) => {
  const row = { ...replyDraft("saved-draft", "unused", "Keep these words"), subject: "Friday plans" };
  class OlderServer extends DraftServer {
    override answer(m: EngineMutation): ReturnType<DraftServer["answer"]> {
      if (m.kind === "draft_discard" && m.ifContentRevision !== undefined) {
        throw new MutationRejectedError("conditional discard is unsupported", {
          status: 404, code: "discard_unsupported", retryable: false,
        });
      }
      return super.answer(m);
    }
  }
  const server = new OlderServer([row]);
  const list = await mountShell("#/drafts", [], [], { server });
  const app = within(list.el);
  const visibleDraft = () => app.queryByRole("option", { name: /Friday plans/ });
  const discard = await app.findByRole("button", { name: "Discard" });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  list.offline.on = offline;
  fireEvent.click(discard);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(visibleDraft()).toBeNull();

  await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
  if (offline) {
    const pending = list.engine.pendingMutations().find((p) => p.mutation.kind === "draft_discard");
    if (!pending) throw new Error("Discard did not wait in the outbox");
    list.offline.on = false;
    await act(async () => { await list.engine.retryQueued(pending.id); });
  }
  expect(list.engine.pendingMutations().filter((p) => p.mutation.kind === "draft_discard")).toEqual([]);
  expect(visibleDraft()).toBeTruthy();
  expect(server.rows.get(row.id)?.body).toBe(row.body);
  expect(app.getAllByRole("status").map((report) => report.textContent)).toContain(messages.drafts.discardUnsupported);
});
