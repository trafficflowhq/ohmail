/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { act, mountShell, replyDraft, stubDom, unmountAll, waitFor } from "./_draft-shell.js";

beforeEach(() => {
  localStorage.clear();
  stubDom();
  Element.prototype.animate ??= () =>
    ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(unmountAll);

it("Undo restores the draft's subject, recipients and preview without deleting it", async () => {
  const draft = {
    ...replyDraft("d1", "parent", "Hi both — attaching the revised sheet."),
    inReplyToMessageId: null,
    subject: "Quarterly numbers, revised",
    to: [{ name: "Petra", address: "petra@example.invalid" }],
  };
  const shell = await mountShell("#/drafts", [], [draft]);
  const view = within(shell.el);
  const row = () => view.queryByRole("option", { name: /Petra.*Quarterly numbers/ });
  await waitFor(() => row() !== null, "the draft is listed");

  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Discard" }));
  });
  expect(row()).toBeNull();
  expect(view.getByText("Discarded").closest('[role="status"]')).not.toBeNull();
  expect(shell.sent.filter((mutation) => mutation.kind === "draft_discard")).toEqual([]);

  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Undo" }));
  });
  expect(row()?.textContent).toContain("Quarterly numbers");
  expect(row()?.textContent).toContain("Petra");
  expect(row()?.textContent).toContain("revised sheet");
  expect(shell.sent.filter((mutation) => mutation.kind === "draft_discard")).toEqual([]);
});
