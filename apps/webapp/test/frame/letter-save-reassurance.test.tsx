/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import type { EngineDraft } from "@ohmail/wire";
import { afterEach, beforeEach, expect, it } from "vitest";
import en from "../../messages/en.json";
import { act, mountShell, press, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

const draft: EngineDraft = {
  id: "friday-draft",
  mailboxId: "mb1",
  threadId: null,
  inReplyToMessageId: null,
  subject: "Plans for Friday",
  body: "Written in this tab.",
  to: [],
  cc: [],
  bcc: [],
  rationale: null,
  status: "draft",
  createdAt: "2026-09-27T08:40:00.000Z",
  updatedAt: "2026-09-27T08:40:00.000Z",
} as EngineDraft;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  stubDom();
});
afterEach(unmountAll);

it.each([false, true])("reassures about an ordinary draft while offline is %s", async (offline) => {
  const shell = await mountShell("#/drafts", [], [draft]);
  const page = within(shell.el);
  const row = () => page.queryByRole("option", { name: /Plans for Friday/ });
  await waitFor(() => row() !== null, "the letter in Drafts");
  await press(row(), "open the letter");
  const subject = () => page.queryByRole<HTMLInputElement>("textbox", { name: en.write.subject });
  await waitFor(() => subject()?.value === draft.subject, "the editor on the letter");
  await act(async () => { await shell.engine.syncOnce(); });
  shell.offline.on = offline;
  await act(async () => {
    fireEvent.change(subject()!, { target: { value: "Plans for Friday, edited" } });
  });

  const saves = () => shell.sent.filter((m) => m.kind === "draft_save");
  if (offline) {
    await waitFor(() => shell.engine.pendingMutations().length > 0, "the save on the outbox");
  } else {
    await waitFor(() => saves().length > 0, "the save on the wire");
    expect(saves().map((m) => m.draftId)).toEqual([draft.id]);
  }
  expect(page.queryByText(en.compose.sentElsewhere)).toBeNull();
  expect(page.queryByText(en.compose.draftNote)).not.toBeNull();
}, 30_000);
