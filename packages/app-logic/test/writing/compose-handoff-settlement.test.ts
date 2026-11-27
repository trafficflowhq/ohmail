/** @vitest-environment jsdom */
import { beforeEach, expect, it } from "vitest";
import { sha256Hex } from "@trafficflow/core/diagnostics";
import { draftRevisionInput } from "@trafficflow/core/outbound-text";
import {
  clearKnownComposeCopies,
  COMPOSER_KEY,
  EMPTY_COMPOSE,
  composeSessionId,
  handOffComposer,
  holdsSig,
  markComposeRowHolds,
  readComposeDraft,
  readComposeRow,
  readComposeRowHolds,
  resetComposerForTest,
  writeComposeDraft,
  writeComposeRow,
} from "@ohmail/app-logic/writing/compose";

const account = "invented-owner";

function openTab(id: string): void {
  resetComposerForTest();
  window.sessionStorage.setItem(COMPOSER_KEY, id);
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  openTab("first-tab");
});

it("a first save confirming after pagehide binds its row to the recovered words", () => {
  const session = composeSessionId(account);
  writeComposeDraft({ ...EMPTY_COMPOSE, subject: "Garden", body: "The seedlings are ready." }, account);
  handOffComposer();

  writeComposeRow("saved-row", account);
  markComposeRowHolds({ row: "saved-row", sig: "saved-words", rev: "saved-revision" }, account);

  openTab("first-tab");
  expect(readComposeDraft(account).body).toBe("The seedlings are ready.");
  expect(readComposeRow(account)).toBe("saved-row");
  expect(readComposeRowHolds(account)?.rev).toBe("saved-revision");
  expect(composeSessionId(account)).toBe(session);

  openTab("another-tab");
  expect(readComposeDraft(account)).toEqual(EMPTY_COMPOSE);
});

it.each([false, true])(
  "recovery after a confirmed draft ending with a changed From choice: %s",
  (changedFrom) => {
    const saved = {
      ...EMPTY_COMPOSE,
      subject: "Garden",
      body: "The seedlings are ready.",
      fromMailboxId: "garden-mailbox",
    };
    const revision = sha256Hex(
      draftRevisionInput({
        mailboxId: saved.fromMailboxId,
        inReplyToMessageId: null,
        subject: saved.subject,
        body: saved.body,
        html: null,
        to: [],
        cc: [],
        bcc: [],
      }),
    );
    writeComposeDraft(saved, account);
    writeComposeRow("saved-row", account);
    markComposeRowHolds({ row: "saved-row", sig: holdsSig(saved), rev: revision }, account);
    if (changedFrom) writeComposeDraft({ ...saved, fromMailboxId: "work-mailbox" }, account);
    handOffComposer();

    openTab("another-tab");
    clearKnownComposeCopies(account, (id) => (id === "saved-row" ? {} : undefined));
    expect(readComposeDraft(account)).toMatchObject(
      changedFrom ? { ...saved, fromMailboxId: "work-mailbox" } : EMPTY_COMPOSE,
    );
    expect(readComposeRow(account)).toBe(changedFrom ? "saved-row" : null);
  },
);
