/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Editor } from "@tiptap/react";
import { listSeat } from "../places/list-seat.js";
import { letter } from "../reader/support/mail.js";

const id = "later-letter";
const date = "2026-11-14T09:00:00.000Z";
const laterLetter = letter(id, {
  subject: "Reply about the kiln",
  unread: false,
  date,
  triage: { messageId: id, state: "reply_later", setAt: date, updatedAt: date, bubbleUpAt: null },
});

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(cleanup);

async function readyToSend() {
  const { mail } = listSeat({ first: "#/triage", letters: [laterLetter] });
  fireEvent.click(await screen.findByRole("button", { name: "Reply Run" }));
  const run = await screen.findByRole("dialog", { name: "Reply run" });
  const body = await within(run).findByRole("textbox", { name: "Reply body" });
  await act(async () => {
    (body as HTMLElement & { editor: Editor }).editor.commands.setContent("<p>Thursday works.</p>");
  });
  return {
    run,
    sends: () => mail.mutations.filter((mutation) => mutation.kind === "mail_send"),
  };
}

async function sendFrom(target: HTMLElement) {
  await act(async () => {
    target.focus();
    expect(document.activeElement).toBe(target);
    fireEvent.keyDown(target, { key: "Enter", ctrlKey: true });
  });
}

it("does not send with focus on the Parked segment outside Reply Run", async () => {
  const { run, sends } = await readyToSend();
  const parked = within(screen.getByRole("group", { name: "Piles" })).getByRole("button", {
    name: /^Parked/,
  });
  expect(run.contains(parked)).toBe(false);
  await sendFrom(parked);
  expect(sends()).toHaveLength(0);
});

it("sends exactly once with focus in the Reply Run toolbar", async () => {
  const { run, sends } = await readyToSend();
  const toolbar = within(run).getByRole("toolbar", { name: "Reply run" });
  await sendFrom(within(toolbar).getByRole("button", { name: "Skip" }));
  await waitFor(() => expect(sends()).toMatchObject([{ inReplyTo: id }]));
});
