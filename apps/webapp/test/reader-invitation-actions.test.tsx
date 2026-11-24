/** @vitest-environment jsdom */
import { Blob } from "node:buffer";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MessageInvitationDTO } from "@ohmail/wire";
import { GOOGLE } from "../../../packages/core/test/fixtures/invite-shapes";
import { calendarOf, connection, event } from "../../../packages/app-logic/test/calendar/invitations/fixtures";
import { json } from "./account/account-harness";
import { ACCOUNT, ISO, MAILBOX, act, closeMailPage, mountMailPage, prepareMailPage, scopedSyncResponse, tick } from "./fixtures/mounted-mail-page";

const organiser = "ada" + "@example.test";
const asks = {
  method: "REQUEST", uid: "7kq2fixture0google" + "@example.test", recurrenceId: "", sequence: 0,
  start: "20261027T140000", startsAt: "2026-10-27T13:00:00Z",
  organizer: organiser, invitedAddress: MAILBOX.address, answer: null, answeredAt: null,
  calendarEventId: "289a737c-b4a7-45eb-a9f2-e4192d3d6650",
} satisfies MessageInvitationDTO;
const studio = calendarOf({ name: "Studio" });
const personal = calendarOf({ id: "personal", name: "Personal" });
const time = (hour: string) => ({ kind: "instant" as const, value: `20261027T${hour}0000Z` });
const nativeEvent = {
  ...event("provider-event", "20261027"),
  id: "provider-event", uid: asks.uid, start: time("13"), end: time("14"),
  title: "Quarterly planning", organizer: { address: organiser, name: "Ada Organizer" },
  myAnswer: "none", sequence: 0,
};
Element.prototype.animate ??= () => ({ cancel() {} }) as Animation;
afterEach(closeMailPage);

async function reader({ invitation = asks, native = false, collision = false, duplicate = false, metadataOnly = false }:
  { invitation?: MessageInvitationDTO; native?: boolean; collision?: boolean; duplicate?: boolean; metadataOnly?: boolean } = {}) {
  const id = "calendar-letter";
  const parts = (metadataOnly ? [] : GOOGLE.parts).map((part) => ({
    ...part,
    bytes: part.bytes.replace("METHOD:REQUEST", `METHOD:${invitation.method}`).replace("SEQUENCE:0", `SEQUENCE:${invitation.sequence}`),
  }));
  if (!metadataOnly) parts.push({
    ...parts[1]!, id: "meeting-notes", filename: "Meeting notes.txt", contentType: "text/plain", bytes: "Notes",
  });
  if (duplicate) parts.push({ ...parts[1]!, id: "duplicate-invite", filename: "meeting.ics" });
  const letter = {
    id, accountId: ACCOUNT, mailboxId: MAILBOX.id, threadId: null, folder: "INBOX",
    subject: "Quarterly planning", from: { name: "Ada Organizer", address: organiser }, to: [], cc: [],
    date: ISO, unread: false, snippet: "Come to quarterly planning", hasAttachments: true,
    attachmentCount: metadataOnly ? 0 : duplicate ? 3 : 2, sensitivity: {}, labels: [], remoteContent: "none", updatedAt: ISO,
    invitation,
  };
  const rows = [
    ["message", letter],
    ["rule", { id: "trust", kind: "sender", match: organiser, destination: "INBOX", enabled: true, createdAt: ISO }],
    ["settings", { id: ACCOUNT, accountId: ACCOUNT, calendarEnabledAt: ISO, updatedAt: ISO }],
    ["calendar_connection", connection({ grantMailboxId: MAILBOX.id })],
    ["calendar", studio], ["calendar", personal],
    ...(native ? [["calendar_event", { ...nativeEvent, sequence: invitation.sequence }] as const] : []),
    ...(collision ? [["calendar_event", { ...nativeEvent, id: "other-event", uid: "other", myAnswer: null, title: "Workshop" }] as const] : []),
  ] as const;
  const server = await prepareMailPage({
    "GET /api/hello": () => json({ product: "ohmail", flavor: "managed", needsSetup: false, features: { calendar: true } }),
    "GET /api/calendar/settings": () => scopedSyncResponse({
      enabledAt: ISO, newEventsCalendarId: studio.id, secondZone: null, weekNumbers: false,
      dayFromMinute: null, dayToMinute: null,
    }),
    "GET /api/sync": () => scopedSyncResponse({
      changes: { creates: rows.map(([type, entity], index) => ({ type, entity, id: entity.id, seq: index + 1, op: "create", updatedAt: ISO })),
        updates: [], moves: [], deletes: [] }, cursor: "calendar-letter", hasMore: false, serverTime: ISO,
    }),
    [`GET /api/messages/${id}/body`]: () => scopedSyncResponse({
      text: GOOGLE.text, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
    }),
    [`GET /api/messages/${id}/attachments`]: () => scopedSyncResponse({
      items: parts.map((part) => ({ id: part.id, messageId: id, filename: part.filename,
        contentType: part.contentType, sizeBytes: part.bytes.length, inline: part.inline, contentId: part.contentId })),
    }),
    ...Object.fromEntries(parts.map((part) => [`GET /api/attachments/${part.id}`, () => {
      const bytes = new Response(part.bytes, { headers: { "content-type": "application/octet-stream", "X-Ohmail-Account": ACCOUNT } });
      // Node's Blob reads the bytes like the browser does. jsdom's Blob lacks text().
      Object.defineProperty(bytes, "blob", { value: async () => new Blob([part.bytes], { type: "application/octet-stream" }) });
      return bytes;
    }])),
    [`POST /api/messages/${id}/invitation/answer`]: () => scopedSyncResponse({ status: "sent" }),
    "POST /api/calendar/writes": () => scopedSyncResponse({ write: { id: "queued", state: "pending", reason: null }, events: [] }),
  });
  vi.stubGlobal("matchMedia", (media: string) => ({
    media, matches: media.includes("prefers-reduced-motion"), addEventListener() {}, removeEventListener() {},
  }));
  await mountMailPage();
  await act(async () => {
    window.location.hash = `#/ohbox/m/${id}`;
    window.dispatchEvent(new Event("hashchange"));
  });
  await tick(2_500);
  const sheet = screen.getByRole("region", { name: "Open message" });
  return { sheet, card: within(sheet),
    get replies() { return server.on(`POST /api/messages/${id}/invitation/answer`).map(({ body }) => body); },
    get writes() { return server.on("POST /api/calendar/writes").map(({ body }) => body); },
  };
}

it("puts the invitation after the letter and hides only its calendar file", async () => {
  const { card, sheet } = await reader();
  const body = sheet.querySelector("[data-read-body]")!;
  const invitation = card.getByRole("button", { name: "Yes" });
  expect(body.textContent).toMatch(/Ada Organizer has invited you|Come to quarterly planning/);
  expect(body.compareDocumentPosition(invitation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(card.queryByText(GOOGLE.parts[1]!.filename!)).toBeNull();
  expect(card.getByText("Meeting notes.txt")).toBeTruthy();
});

it("answers a mail invitation, saves it in the chosen calendar and shows the answer", async () => {
  const result = await reader();
  const { card } = result;
  expect(card.getByText(/From Ada/)).toBeTruthy();
  expect(card.getByRole("button", { name: "No" })).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Studio" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Personal" }));
  fireEvent.click(card.getByRole("button", { name: "Maybe" }));
  await tick(1_200);
  expect(result.replies).toEqual([{ answer: "tentative", basis: null }]);
  expect(result.writes).toMatchObject([{ kind: "calendar_event_create", calendarId: personal.id, event: { invitees: [] } }]);
  expect(card.getByRole("button", { name: "Maybe" }).getAttribute("aria-pressed")).toBe("true");
});

it("opens a pending invitation on its day and shows an overlapping event", async () => {
  const { card } = await reader({ collision: true });
  expect(card.getByText("overlaps")).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Show in calendar" }));
  await tick(500);
  expect(location.hash).toContain("#/cal/day/2026-10-27");
  const chip = screen.getAllByRole("button", { name: /Quarterly planning/ })
    .find((button) => button.dataset.state === "to-answer");
  expect(chip).toBeDefined();
  expect(chip?.querySelector(".oh-csq")).toBeNull();
  const pending = within(screen.getByRole("dialog", { name: "Quarterly planning" }));
  expect(pending.getByText("Goes to")).toBeTruthy();
  expect(pending.getByRole("button", { name: "Maybe" })).toBeTruthy();
});

it("opens the provider event and answers it through the provider calendar", async () => {
  const result = await reader({ native: true });
  const { card } = result;
  expect(card.getByText(/is on Studio/)).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Yes" }));
  await tick(1_000);
  expect(result.writes).toMatchObject([{ kind: "calendar_event_answer", eventId: nativeEvent.id, answer: "accepted" }]);
  expect(result.replies).toEqual([]);
  fireEvent.click(card.getByRole("button", { name: "Show in calendar" }));
  await tick(500);
  expect(location.hash).toContain("/e/provider-event");
});

it("shows the former time on the changed invitation and leaves at most one calendar tile", async () => {
  const result = await reader({ invitation: {
    ...asks, sequence: 1, previous: { start: "20261027T110000Z", startsAt: "2026-10-27T11:00:00Z" },
  }, duplicate: true });
  const { card, sheet } = result;
  expect(card.getByText("Changed")).toBeTruthy();
  expect(sheet.querySelector("s")?.textContent).toContain("11:00");
  expect(sheet.querySelectorAll(".oh-file")).toHaveLength(1);
  fireEvent.click(card.getByRole("button", { name: "No" }));
  await tick(1_000);
  expect(result.replies).toEqual([{ answer: "declined", basis: null }]);
});

it("shows the cancellation and removes the existing event from the local calendar", async () => {
  const result = await reader({ invitation: { ...asks, method: "CANCEL", sequence: 1 }, native: true });
  const { card } = result;
  expect(card.getByText("Cancelled")).toBeTruthy();
  expect(card.queryByRole("button", { name: "Yes" })).toBeNull();
  fireEvent.click(card.getByRole("button", { name: "Remove from my calendar" }));
  await tick(30_000);
  expect(result.writes).toMatchObject([{ kind: "calendar_event_delete", eventId: nativeEvent.id, localOnly: true }]);
  expect(result.replies).toEqual([]);
});


it("shows and removes a cancellation without an attached event time", async () => {
  const result = await reader({ invitation: { ...asks, method: "CANCEL", sequence: 1, start: null, startsAt: null },
    native: true, metadataOnly: true });
  expect(result.card.getByText("Cancelled")).toBeTruthy();
  expect(result.card.getByRole("button", { name: "Show in calendar" })).toBeTruthy();
  expect(result.card.getByRole("button", { name: "Remove from my calendar" })).toBeTruthy();
});
