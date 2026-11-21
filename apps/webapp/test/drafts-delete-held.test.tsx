/** @vitest-environment jsdom */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineDraft } from "@ohmail/wire";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";
import { COMPOSE_SEND_KEY } from "@ohmail/app-logic/writing/mail-send";
import { claimSendLock, SEND_LOCK_FORMAT, sendRecordsNaming } from "@ohmail/app-logic/writing/send-lock";
import messages from "../messages/en.json";
import { DraftServer, mountShell, stubDom, unmountAll, waitFor } from "./_draft-shell.js";
import { sliceOfDeclaration } from "./source-anchor.js";

const OWNER = "acc-discard-held";
const SUBJECT = "Bis Montag";
const ATTEMPT = "held-attempt";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setStorageOwner(OWNER);
  stubDom();
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
});

afterEach(async () => {
  vi.useRealTimers();
  await unmountAll();
  resetStorageOwnerForTest();
});

describe("Deleting a draft this browser holds a send record for", () => {
  it("the discard goes through, the row leaves, and the record that held it is released", async () => {
    const server = new DraftServer();
    const { sent, store } = await mountShell("#/ohbox", [], [], { server });
    const rail = within(await screen.findByRole("navigation", { name: /places/i }));
    fireEvent.click(rail.getByRole("button", { name: /^Write/ }));
    const recipient = await screen.findByRole("combobox", { name: messages.compose.to });
    fireEvent.change(recipient, { target: { value: "lena@atelier.example, " } });
    fireEvent.change(screen.getByRole("textbox", { name: messages.compose.subject }), {
      target: { value: SUBJECT },
    });
    const drafts = () => rail.getByRole("button", { name: /^Drafts/ });
    fireEvent.click(drafts());
    await waitFor(() => [...server.rows.values()].some((row) => row.subject === SUBJECT), "the new letter reaches the server");
    const { id, contentRevision } = [...server.rows.values()].find((row) => row.subject === SUBJECT)!;
    const draft = { name: /Bis Montag/ };
    expect(await screen.findByRole("option", draft)).toBeTruthy();
    const records = () => sendRecordsNaming(COMPOSE_SEND_KEY, id, null, OWNER).map((record) => record.key);
    claimSendLock({
      v: SEND_LOCK_FORMAT, lane: COMPOSE_SEND_KEY, key: ATTEMPT, fp: ATTEMPT, at: Date.now(),
      draftId: id, subject: `draft:${id}`, unverified: true,
    }, () => false, OWNER);

    fireEvent.click(rail.getByRole("button", { name: /^Ohbox/ }));
    fireEvent.click(drafts());
    fireEvent.click(await screen.findByRole("option", draft));
    expect(await screen.findByRole("button", { name: messages.drafts.sendAgain })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^It was sent/ })).toBeTruthy();
    fireEvent.click(drafts());
    const discard = () => within(screen.getByRole("listbox", { name: messages.drafts.title }))
      .getByRole("button", { name: messages.drafts.discard });
    const mutations = () => sent.filter((mutation) => mutation.kind === "draft_discard" || mutation.kind === "mail_send");
    const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    fireEvent.click(discard());
    await advance(0);
    expect(screen.queryByRole("option", draft)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: messages.drafts.reportUndo }));
    await advance(UNDO_MS);
    expect(screen.getByRole("option", draft)).toBeTruthy();
    expect(mutations()).toEqual([]);
    expect(records()).toEqual([ATTEMPT]);

    fireEvent.click(discard());
    await advance(0);
    expect(screen.queryByRole("option", draft)).toBeNull();
    await advance(UNDO_MS - 1);
    expect(screen.queryByRole("option", draft)).toBeNull();
    expect(mutations()).toEqual([]);
    expect(server.rows.has(id)).toBe(true);
    expect(records()).toEqual([ATTEMPT]);
    await advance(1);
    vi.useRealTimers();
    await waitFor(() => records().length === 0, "the server confirmed the discard and the held record was released");

    expect(mutations()).toEqual([{ kind: "draft_discard", draftId: id, ifContentRevision: contentRevision }]);
    expect(server.rows.has(id)).toBe(false);
    expect(store.get<EngineDraft>("draft", id)).toBeUndefined();
    expect(screen.queryByRole("option", draft)).toBeNull();
    expect(screen.queryByText(/Not discarded/)).toBeNull();
  }, 30_000);

  it("asks about the compose session only for the row the composer is holding", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const shell = readFileSync(
      resolve(process.cwd(), "packages/app-logic/src/writing/shell-compose.ts"), "utf8",
    );
    const decision = sliceOfDeclaration(shell, "decideDraftDiscard");
    expect(decision, "one draft's unresolved compose session must not refuse another draft's Discard")
      .toContain("session: heldRow === draftId ? composeSessionId(scope) : null,");
    const commit = sliceOfDeclaration(shell, "discardDraftRow");
    expect(commit).toContain("const decision = decideDraftDiscard(draftId);");
    expect(commit).toMatch(
      /res\.status === "rolled_back" && res\.error\?\.code === "send_recorded"\) \{\s*return \{ kind: "blocked", why: "still-sending" \};/,
    );
    const report = sliceOfDeclaration(shell, "discardDraft");
    expect(report).toMatch(/case "blocked": setDiscardRefusal\(\{ draftId: listed, why: v\.why, at: Date\.now\(\) \}\)/);
  });
});
