/** @vitest-environment jsdom */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineDraft } from "@ohmail/wire";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";
import { COMPOSE_SEND_KEY } from "@ohmail/app-logic/writing/mail-send";
import { readComposeRow, readComposeSession } from "@ohmail/app-logic/writing/compose";
import { claimSendLock, holdOf, SEND_LOCK_FORMAT, sendRecordsNaming } from "@ohmail/app-logic/writing/send-lock";
import messages from "../messages/en.json";
import { mountShell, stubDom, unmountAll, waitFor, type DraftShell } from "./_draft-shell.js";
import { typeInto } from "./fixtures/rich-editor-driver.js";

const OWNER = "acc-draft-endings";
const SUBJECT = "Bis Montag";
const BODY = "The saved words of this letter.";
const ROW = { name: /Bis Montag/ };
const records = (id: string) => sendRecordsNaming(COMPOSE_SEND_KEY, id, null, OWNER);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setStorageOwner(OWNER);
  stubDom();
});

afterEach(async () => {
  vi.useRealTimers();
  await unmountAll();
  resetStorageOwnerForTest();
});

async function saveLetter(s: DraftShell): Promise<string> {
  const rail = within(await screen.findByRole("navigation", { name: /places/i }));
  fireEvent.click(rail.getByRole("button", { name: /^Write/ }));
  const recipient = await screen.findByRole("combobox", { name: messages.compose.to });
  fireEvent.change(recipient, { target: { value: "lena@atelier.example" } });
  fireEvent.keyDown(recipient, { key: "Enter" });
  fireEvent.change(screen.getByRole("textbox", { name: messages.compose.subject }), {
    target: { value: SUBJECT },
  });
  const body = await screen.findByRole("textbox", { name: "Message" });
  await act(async () => { typeInto(body, BODY); });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled,
    "the original message was ready to send before it was held").toBe(false);
  fireEvent.click(rail.getByRole("button", { name: /^Drafts/ }));
  const saved = () => s.store.list<EngineDraft>("draft").find((row) => row.subject === SUBJECT);
  await waitFor(() => saved() !== undefined, "the draft reached the account");
  expect(saved()?.to).toHaveLength(1);
  expect(saved()?.body).toBe(BODY);
  return saved()!.id;
}

function installRecord(id: string, at: number): void {
  claimSendLock({
    v: SEND_LOCK_FORMAT, lane: COMPOSE_SEND_KEY, key: "held-by-another-window", fp: "held-attempt",
    at, draftId: id, subject: `draft:${id}`, unverified: true,
  }, () => false, OWNER);
}

describe("a row's server-answered ending releases its record, whichever window pressed the send", () => {
  for (const [label, when] of [["another window, after this view", "now"], ["an earlier session (the control)", "hour"]] as const) {
    for (const verb of ["Send again", "It was sent — dismiss", "Delete"] as const) {
      it(`${verb} over a record from ${label}`, async () => {
        const s = await mountShell("#/ohbox", [], [], { versions: true });
        const id = await saveLetter(s);
        const saved = s.store.get<EngineDraft>("draft", id);
        const revision = saved?.contentRevision;
        expect(typeof revision).toBe("string");
        expect(typeof saved?.updatedAt).toBe("string");
        const rail = within(screen.getByRole("navigation", { name: /places/i }));
        expect(await screen.findByRole("option", ROW)).toBeTruthy();
        installRecord(id, when === "now" ? Date.now() : Date.now() - 60 * 60 * 1000);
        expect(records(id)).toHaveLength(1);
        fireEvent.click(rail.getByRole("button", { name: /^Ohbox/ }));
        await waitFor(() => window.location.hash === "#/ohbox", "the Ohbox after leaving Drafts");
        fireEvent.click(rail.getByRole("button", { name: /^Drafts/ }));
        await waitFor(() => window.location.hash === "#/drafts", "the new Drafts visit");
        fireEvent.click(await screen.findByRole("option", ROW));
        expect(window.location.hash).toBe(`#/drafts/m/${id}`);

        if (verb === "Delete") {
          const list = within(screen.getByRole("listbox", { name: messages.drafts.title }));
          vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
          fireEvent.click(list.getByRole("button", { name: messages.drafts.discard }));
          await act(async () => { await vi.advanceTimersByTimeAsync(0); });
          expect(screen.getByRole("button", { name: messages.drafts.reportUndo })).toBeTruthy();
          expect(records(id)).toHaveLength(1);
          expect(s.sent.some((mutation) => mutation.kind === "draft_discard")).toBe(false);
          await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_MS); });
          vi.useRealTimers();
        } else {
          const actions = within(await screen.findByRole("toolbar", { name: messages.drafts.heldActs }));
          const name = verb === "Send again" ? messages.drafts.sendAgain : messages.drafts.heldItWasSent;
          fireEvent.click(actions.getByRole("button", { name }));
        }
        await waitFor(() => records(id).length === 0, "the exact row's server answer released its record");

        const endings = s.sent.filter((mutation) =>
          mutation.kind === "draft_discard" || mutation.kind === "draft_resolve" || mutation.kind === "mail_send"
        );
        const outcome = verb === "Send again" ? "not_arrived" : "arrived";
        expect(endings).toEqual([
          verb === "Delete"
            ? { kind: "draft_discard", draftId: id, ifContentRevision: revision }
            : { kind: "draft_resolve", draftId: id, outcome, ifUpdatedAt: saved?.updatedAt },
        ]);
        if (verb === "Send again") {
          const editor = within(await screen.findByRole("region", { name: "New message" }));
          expect(window.location.hash).toBe("#/compose");
          expect(editor.getByRole<HTMLInputElement>("textbox", { name: messages.compose.subject }).value).toBe(SUBJECT);
          expect(editor.getByRole("textbox", { name: "Message" }).textContent).toBe(BODY);
          expect(s.store.get<EngineDraft>("draft", id)).toMatchObject({ status: "draft", contentRevision: revision });
          expect(readComposeRow(OWNER)).toBe(id);
          expect(holdOf(s.engine, { lane: COMPOSE_SEND_KEY, draftId: id, session: readComposeSession(OWNER) }, OWNER)).toEqual({ kind: "free" });
          expect(editor.queryByText(/We're not sure this was sent/)).toBeNull();
          expect(editor.queryByText(messages.compose.changedElsewhere)).toBeNull();
          expect(editor.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled,
            "the reopened message is ready to send").toBe(false);
        } else {
          expect(screen.queryByRole("option", ROW)).toBeNull();
        }
      }, 30_000);
    }
  }
});
