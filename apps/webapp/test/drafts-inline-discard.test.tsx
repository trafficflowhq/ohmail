/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mountShell, press, replyDraft, stubDom, unmountAll } from "./_draft-shell.js";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  stubDom();
});
afterEach(unmountAll);

it("Discard beside the open saved draft closes the letter and Undo reopens it", async () => {
  const draft = {
    ...replyDraft("saved-draft", "unused", "My half-written letter"),
    inReplyToMessageId: null,
    threadId: null,
    subject: "Friday plans",
  };
  const shell = await mountShell("#/drafts", [], [draft]);
  const app = within(shell.el);
  const drafts = () => within(app.getByRole("listbox", { name: "Drafts" }));
  await press(await drafts().findByRole("option", { name: /Friday plans/ }), "open the saved draft");
  const subject = () => app.queryByRole<HTMLInputElement>("textbox", { name: "Subject" });
  expect(subject()?.value).toBe(draft.subject);
  await press(drafts().getByRole("button", { name: "Discard" }), "inline Discard");
  expect(subject()).toBeNull();
  const undo = await app.findByRole("button", { name: "Undo" });
  await press(undo, "Undo");
  expect(subject()?.value).toBe(draft.subject);
  expect(app.getByRole("textbox", { name: "Message" }).textContent).toContain(draft.body);
});
