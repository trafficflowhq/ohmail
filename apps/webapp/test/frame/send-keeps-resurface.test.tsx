/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { MutationRejectedError } from "@ohmail/client-engine";
import { onReplyPress } from "@ohmail/app-logic/writing/sent-reveal";
import type { EngineMessage, MessageStateDTO } from "@ohmail/wire";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import { settleEditor } from "../_first-paint.js";
import { typeInto } from "../fixtures/rich-editor-driver";
import { act, DraftServer, message, mountShell, NOW, press, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

vi.setConfig({ testTimeout: 60_000 });

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  stubDom();
});
afterEach(unmountAll);

const id = "booked-letter";
const subject = "Friday's booking";

async function reply(
  state: MessageStateDTO["state"],
  refuseFiling = false,
  disconnectAt?: "booking" | "read",
  otherBooking?: string,
) {
  const at = new Date(NOW.getTime() - 1000).toISOString();
  const scheduled = state === "bubbled_up";
  const threadId = refuseFiling ? "booked-conversation" : null;
  const filingConnection = { offline: disconnectAt !== undefined };
  class FilingWire extends DraftServer {
    override answer(m: Parameters<DraftServer["answer"]>[0]): ReturnType<DraftServer["answer"]> {
      const clearBooking = m.kind === "triage_set" && m.messageId === id && m.state === "none";
      const deliberateRead = m.kind === "mark_seen" && m.via !== "glance";
      if (filingConnection.offline && (disconnectAt === "booking" ? clearBooking : deliberateRead)) {
        throw new MutationRejectedError("no signal", { code: "network", retryable: true });
      }
      if (deliberateRead && disconnectAt === undefined) {
        throw new MutationRejectedError("Filing refused", { status: 403, code: "forbidden", retryable: false });
      }
      return null;
    }
  }
  const bubbleUpAt = scheduled ? "2099-10-01T10:00:00Z" : null;
  const shell = await mountShell(scheduled && !refuseFiling ? "#/triage/resurface" : "#/ohbox", [
    message(id, {
      subject, threadId, ...(disconnectAt === "read" ? { unread: true } : {}), ...(refuseFiling ? { date: new Date(NOW.getTime() - 2000).toISOString() } : {}),
      triage: { messageId: id, state, setAt: at, updatedAt: at, bubbleUpAt },
    }),
    ...(otherBooking ? [message(otherBooking, {
      subject, threadId, date: new Date(NOW.getTime() - 3000).toISOString(), unread: true,
      triage: { messageId: otherBooking, state, setAt: at, updatedAt: at, bubbleUpAt },
    })] : []),
    ...(refuseFiling ? [message("new-letter", { subject, threadId, date: NOW.toISOString() })] : []),
  ], [], refuseFiling ? { server: new FilingWire() } : {});
  const page = within(shell.el);
  const row = () => page.queryByRole("option", { name: /Friday's booking/ });
  await waitFor(() => row() !== null, "the booked or resurfaced row");
  await press(row(), subject);
  const open = () => page.queryByRole("region", { name: "Open message" });
  await waitFor(() => open() !== null, "the booked letter in the reader", 240);
  const reader = () => within(open()!);
  await waitFor(() => reader().queryByRole("button", { name: en.reader.verb.reply }) !== null, "Reply");
  await press(reader().queryByRole("button", { name: en.reader.verb.reply }), "Reply");
  await settleEditor();
  const body = () => reader().queryByRole("textbox", { name: en.write.reply.text });
  await waitFor(() => body() !== null, "the reply editor");
  await act(async () => { typeInto(body()!, "Thursday works too."); });
  return { shell, page, open, reader, body: body()!, row, filingConnection };
}

async function sendThrough(editor: HTMLElement, shiftKey: boolean) {
  await act(async () => {
    editor.focus();
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true, shiftKey });
  });
}

it.each([
  { state: "resurfaced", key: false },
  { state: "resurfaced", key: true },
  { state: "bubbled_up", key: false },
] as const)("plain Send preserves a $state booking with keyboard $key", async ({ state, key }) => {
  const { shell, open, reader, body, row } = await reply(state);
  const start = shell.sent.length;
  const notes: string[] = [];
  const off = onReplyPress((messageId) => notes.push(messageId));
  try {
    if (key) await sendThrough(body, false);
    else await press(reader().queryByRole("button", { name: en.write.send }), "Send");
    await waitFor(() => shell.sent.slice(start).some((op) => op.kind === "mail_send"), "the send");
    await waitFor(() => open() === null || reader().queryByRole("textbox", { name: en.write.reply.text }) === null, "the send settles", 240);
    expect(shell.sent.slice(start).filter((op) => op.kind !== "draft_save").map((op) => op.kind)).toEqual(["mail_send"]);
    expect(notes).toEqual([id]);
    expect(row()).not.toBeNull();
    expect(shell.el.textContent).not.toContain(en.reply.toastSentAndDone);
  } finally {
    off();
  }
});

it.each([false, true])("Send + Done deliberately files the resurfaced letter with keyboard %s", async (key) => {
  const { shell, page, reader, body } = await reply("resurfaced");
  const start = shell.sent.length;
  if (key) await sendThrough(body, true);
  else await press(reader().queryByRole("button", { name: en.reply.sendAndDone }), en.reply.sendAndDone);
  const writes = () => shell.sent.slice(start);
  await waitFor(() => writes().some((op) => op.kind === "mark_seen"), "the deliberate read");
  expect(writes().filter((op) => op.kind === "mail_send")).toHaveLength(1);
  const read = writes().filter((op) => op.kind === "mark_seen");
  expect(read).toHaveLength(1);
  expect(read[0]).toMatchObject({ messageIds: [id] });
  expect(read[0]?.via).toBeUndefined();
  const undo = () => page.queryByRole("button", { name: /^Undo\b/ });
  await waitFor(() => undo() !== null, "the filing report offers Undo");
  expect(shell.el.textContent).toContain(en.reply.toastSentAndDone);
  const pinned = () => page.queryByRole("listbox", { name: "Resurfaced" });
  await waitFor(
    () => shell.engine.read().get<EngineMessage>("message", id)?.triage?.state === "none",
    "the provider's cleared pin",
  );
  await waitFor(() => pinned() === null, "the filed row leaves Resurfaced");
  await press(undo(), "Undo");
  await waitFor(() => pinned() !== null, "Undo restores the resurfaced row");
}, 60_000);

it("reports a sent reply and lets Undo restore a booking when the filing read is refused", async () => {
  const { shell, page, reader } = await reply("bubbled_up", true);
  const start = shell.sent.length;
  const writes = () => shell.sent.slice(start);
  await press(reader().getByRole("button", { name: en.reply.sendAndDone }), en.reply.sendAndDone);
  await waitFor(() => writes().some((op) => op.kind === "mark_seen" && op.via !== "glance"), "the deliberate read");
  expect(writes().filter((op) => op.kind === "mail_send")).toHaveLength(1);
  expect(writes().filter((op) => op.kind === "mark_seen" && op.via !== "glance")).toHaveLength(1);
  expect(writes()).toContainEqual({ kind: "triage_set", messageId: id, state: "none" });
  expect(shell.engine.read().get<EngineMessage>("message", id)?.triage?.state ?? "none").toBe("none");

  const undo = await page.findByRole("button", { name: /^Undo\b/ });
  expect(shell.el.textContent).toContain(en.reply.toastSentFilingIncomplete);
  await press(undo, "Undo");
  await waitFor(
    () => shell.engine.read().get<EngineMessage>("message", id)?.triage?.state === "bubbled_up",
    "Undo restores the original booking",
  );
  expect(writes().filter((op) => op.kind === "mark_seen" && op.via !== "glance")).toHaveLength(1);
  expect(shell.engine.read().get<EngineMessage>("message", id)?.triage?.bubbleUpAt).toBe("2099-10-01T10:00:00Z");
});

it("offers Undo when the queued booking clear confirms after reconnect", async () => {
  const { shell, page, reader, filingConnection } = await reply("bubbled_up", true, "booking");
  const start = shell.sent.length;
  const writes = () => shell.sent.slice(start);
  const booking = () => shell.store.get<EngineMessage>("message", id)?.triage;
  const undo = () => page.queryByRole("button", { name: /^Undo\b/ });
  await press(reader().getByRole("button", { name: en.reply.sendAndDone }), en.reply.sendAndDone);
  await waitFor(() => shell.engine.pendingMutations().some(
    ({ mutation }) => mutation.kind === "triage_set" && mutation.messageId === id && mutation.state === "none",
  ), "the queued booking clear");
  expect(booking()?.state).toBe("bubbled_up");
  expect(undo()).toBeNull();
  expect(shell.el.textContent).toContain(en.reply.toastSentFilingIncomplete);

  filingConnection.offline = false;
  await act(async () => {
    const results = await shell.engine.flushPending();
    expect(results.some((result) => result.status === "confirmed")).toBe(true);
  });
  await waitFor(() => (booking()?.state ?? "none") === "none", "the confirmed booking clear");
  expect(writes().filter((m) => m.kind === "mail_send")).toHaveLength(1);
  expect(writes().filter((m) => m.kind === "triage_set" && m.messageId === id && m.state === "none")).toHaveLength(2);
  expect(writes().filter((m) => m.kind === "mark_seen" && m.via !== "glance")).toHaveLength(0);
  await waitFor(() => undo() !== null, "the confirmed booking clear offers Undo");
  expect(shell.el.textContent).toContain(en.reply.toastSentFilingIncomplete);
  await press(undo(), "Undo");
  await waitFor(() => booking()?.state === "bubbled_up", "Undo restores the confirmed booking");
  expect(booking()?.bubbleUpAt).toBe("2099-10-01T10:00:00Z");
});

it.each([false, true])("keeps Undo for the last filing step after reconnect, with prior Undo used=%s", async (useEarlyUndo) => {
  const { shell, page, reader, filingConnection } = await reply("bubbled_up", true, "read");
  const before = shell.sent.length;
  const booking = () => shell.store.get<EngineMessage>("message", id);
  const undo = () => page.queryByRole("button", { name: /^Undo\b/ });
  await press(reader().getByRole("button", { name: en.reply.sendAndDone }), en.reply.sendAndDone);
  await waitFor(() => shell.engine.pendingMutations().some(
    ({ mutation }) => mutation.kind === "mark_seen" && mutation.via !== "glance" && mutation.messageIds.includes(id),
  ), "the queued deliberate read");
  await waitFor(() => undo() !== null, "Undo for the confirmed booking clear");
  expect(shell.el.textContent).toContain(en.reply.toastSentFilingIncomplete);
  expect(booking()?.unread).toBe(true);

  if (useEarlyUndo) {
    await press(undo(), "Undo the booking clear");
    await waitFor(() => booking()?.triage?.state === "bubbled_up", "the earlier Undo restores the booking");
  }
  filingConnection.offline = false;
  await act(async () => { await shell.engine.flushPending(); });
  await waitFor(() => booking()?.unread === false, "the confirmed read");
  await waitFor(() => shell.el.textContent?.includes(en.reply.toastSentAndDone) === true, "the completed filing report");
  await press(undo(), "Undo the completed filing");
  await waitFor(() => booking()?.unread === true && booking()?.triage?.state === "bubbled_up", "Undo restores both changes");
  const writes = shell.sent.slice(before);
  expect(writes.filter((m) => m.kind === "mail_send")).toHaveLength(1);
  expect(writes.filter((m) => m.kind === "triage_set" && m.messageId === id && m.state === "bubbled_up")).toHaveLength(1);
});

it("Undo after reconnect leaves messages taken over by a newer read alone", async () => {
  const other = "another-booked-letter";
  const { shell, page, reader, filingConnection } = await reply("bubbled_up", true, "read", other);
  const confirmed = (messageId: string) => shell.store.get<EngineMessage>("message", messageId);
  await press(reader().getByRole("button", { name: en.reply.sendAndDone }), en.reply.sendAndDone);
  await waitFor(() => shell.engine.pendingMutations().some(({ mutation }) =>
    mutation.kind === "mark_seen" && mutation.messageIds.includes(other) && mutation.messageIds.includes(id),
  ), "filing queues the read of both letters");
  expect(confirmed(other)?.unread).toBe(true);
  expect(confirmed(id)?.unread).toBe(true);

  filingConnection.offline = false;
  await act(async () => {
    const ownRead = await shell.engine.mutate({ kind: "mark_seen", unread: false, messageIds: [other] });
    expect(ownRead.status).toBe("confirmed");
    await shell.engine.flushPending();
  });
  await waitFor(() => confirmed(id)?.unread === false, "filing's remaining read confirms");
  const reads = shell.sent.flatMap((m) => m.kind === "mark_seen" && m.via !== "glance" ? [m.messageIds] : []);
  expect(reads.slice(-2)).toEqual([[other], [id]]);
  const undo = await page.findByRole("button", { name: /^Undo\b/ });
  expect(shell.el.textContent).toContain(en.reply.toastSentFilingIncomplete);
  await press(undo, "Undo the confirmed filing changes");
  await waitFor(() => confirmed(id)?.unread === true, "Undo restores filing's read");
  expect(confirmed(other)?.unread).toBe(false);
});
