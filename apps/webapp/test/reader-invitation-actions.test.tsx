/** @vitest-environment jsdom */
import { Blob } from "node:buffer";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CalendarAccess, CalendarEventAct, CalendarEventRecord, MessageInvitationDTO } from "@ohmail/wire";
import { GOOGLE } from "../../../packages/core/test/fixtures/invite-shapes";
import { calendarOf, connection, event } from "../../../packages/app-logic/test/calendar/invitations/fixtures";
import { json } from "./account/account-harness";
import { ACCOUNT, ISO, MAILBOX, act, calendarSnapshot, closeMailPage, mountMailPage, prepareMailPage, scopedSyncResponse, tick } from "./fixtures/mounted-mail-page";

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
  invitees: [{ address: MAILBOX.address, name: null, role: "required", answer: "none" }] as const,
};
Element.prototype.animate ??= () => ({ cancel() {} }) as Animation;
afterEach(closeMailPage);

async function reader({ invitation = asks, native = false, nativeSequence, nativeAccess = "owner", nativeAnswer = "none", nativeShown = true, writablePersonal = true, collision = false, duplicate = false, metadataOnly = false, selfhost = false, connected = true, calendarEnabled = true, copy, refuseUpdate = false, refuseWrite = false, keepWrite = false, text = GOOGLE.text, place, title }:
  { invitation?: MessageInvitationDTO; native?: boolean; nativeSequence?: number; nativeAccess?: CalendarAccess; nativeAnswer?: CalendarEventRecord["myAnswer"]; nativeShown?: boolean; writablePersonal?: boolean; collision?: boolean; duplicate?: boolean; metadataOnly?: boolean; selfhost?: boolean; connected?: boolean; calendarEnabled?: boolean; copy?: CalendarEventRecord; refuseUpdate?: boolean; refuseWrite?: boolean; keepWrite?: boolean; text?: string; place?: string; title?: string } = {}) {
  const id = "calendar-letter";
  const parts = (metadataOnly ? [] : selfhost ? GOOGLE.parts.slice(0, 1) : GOOGLE.parts).map((part) => ({
    ...part,
    bytes: part.bytes.replace("METHOD:REQUEST", `METHOD:${invitation.method}`).replace("SEQUENCE:0", `SEQUENCE:${invitation.sequence}`),
  }));
  if (!metadataOnly && !selfhost) parts.push({
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
  const providerCopy = {
    ...nativeEvent, sequence: nativeSequence ?? invitation.sequence, myAnswer: nativeAnswer,
    ...(place && { place }), ...(title && { title }),
  };
  const providerConnection = connection({ ...(selfhost && { provider: "caldav" }), grantMailboxId: selfhost ? null : MAILBOX.id });
  const rows = [
    ["message", letter],
    ["rule", { id: "trust", kind: "sender", match: organiser, destination: "INBOX", enabled: true, createdAt: ISO }],
    ["settings", { id: ACCOUNT, accountId: ACCOUNT, calendarEnabledAt: ISO, updatedAt: ISO }],
    ...(connected ? [
      ["calendar_connection", providerConnection],
      ["calendar", { ...studio, access: nativeAccess, shown: nativeShown }],
      ["calendar", writablePersonal ? personal : { ...personal, access: "reader" }],
    ] as const : []),
    ...(copy ? [["calendar_event", copy]] as const : []),
    ...(native ? [["calendar_event", providerCopy]] as const : []),
    ...(collision ? [["calendar_event", { ...nativeEvent, id: "other-event", uid: "other", myAnswer: null, title: "Workshop" }] as const] : []),
  ] as const;
  const body = { text, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null };
  let savedCopy = copy;
  let lastAnswer: MessageInvitationDTO["answer"] = invitation.answer;
  const server: Awaited<ReturnType<typeof prepareMailPage>> = await prepareMailPage({
    "GET /api/hello": () => json({ product: "ohmail", flavor: selfhost ? "selfhost" : "managed", needsSetup: false, features: { calendar: calendarEnabled } }),
    "GET /api/calendar/settings": () => scopedSyncResponse({
      enabledAt: ISO, unconfigured: !connected, newEventsCalendarId: connected ? studio.id : null, secondZone: null, weekNumbers: false,
      dayFromMinute: null, dayToMinute: null,
    }),
    "GET /api/sync/snapshot": () => calendarSnapshot(rows),
    "GET /api/sync": () => scopedSyncResponse({
      changes: { creates: rows.map(([type, entity], index) => ({ type, entity, id: entity.id, seq: index + 1, op: "create", updatedAt: ISO })),
        updates: [], moves: [], deletes: [] }, cursor: "calendar-letter", hasMore: false, serverTime: ISO,
    }),
    [`GET /api/messages/${id}/body`]: () => scopedSyncResponse(body),
    "GET /api/messages/bodies": () => scopedSyncResponse({ items: [{ messageId: id, ...body }] }),
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
    [`POST /api/messages/${id}/invitation/answer`]: () => {
      lastAnswer = (server.on(`POST /api/messages/${id}/invitation/answer`).at(-1)!.body as { answer: typeof lastAnswer }).answer;
      return scopedSyncResponse({ status: "sent", answer: lastAnswer });
    },
    "POST /api/calendar/writes/refused-update/retry": () => {
      savedCopy = { ...savedCopy!, busy: false, writes: [] };
      const response = scopedSyncResponse({
        write: { id: "refused-update", state: "applied", reason: null }, events: [savedCopy],
      });
      response.headers.set("x-sync-seq", "32");
      return response;
    },
    "POST /api/calendar/writes": () => {
      const act = server.on("POST /api/calendar/writes").at(-1)!.body as CalendarEventAct;
      if (
        native && connected && act.kind === "calendar_event_create" && act.invitationMessageId === id &&
        providerCopy.uid === invitation.uid && providerCopy.recurrenceId === invitation.recurrenceId &&
        providerCopy.organizer.address.toLowerCase() === invitation.organizer?.toLowerCase() &&
        providerCopy.myAnswer !== null &&
        (providerConnection.grantMailboxId === MAILBOX.id ||
          (providerConnection.grantMailboxId === null &&
            providerCopy.invitees.some(({ address }) => address.toLowerCase() === invitation.invitedAddress?.toLowerCase())))
      ) {
        return json({ error: { code: "calendar_read_only", message: "The invitation already has a calendar copy" } }, 409);
      }
      const refused = refuseWrite || (refuseUpdate && act.kind === "calendar_event_update");
      const records: CalendarEventRecord[] = [];
      if (keepWrite && act.kind === "calendar_event_create") {
        savedCopy = event(act.eventId, "20261027", {
          calendarId: act.calendarId, start: act.event.start, end: act.event.end,
          title: act.event.title, busy: act.event.busy, mailAnswer: lastAnswer ?? undefined,
        });
        records.push(savedCopy);
      }
      if (savedCopy && refused && act.kind === "calendar_event_update") {
        savedCopy = {
          ...savedCopy, mailAnswer: lastAnswer ?? undefined,
          writes: [{ id: "refused-update", key: "update-key", state: "refused", reason: "forbidden", act, part: null, at: ISO }],
        };
        records.push(savedCopy);
      }
      const response = scopedSyncResponse({
        write: { id: refused && act.kind === "calendar_event_update" ? "refused-update" : "queued", state: refused ? "refused" : keepWrite ? "applied" : "pending",
          reason: refused ? "forbidden" : null },
        events: records,
      });
      if (records.length) response.headers.set("x-sync-seq", act.kind === "calendar_event_create" ? "30" : "31");
      return response;
    },
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
    get savedCopy() { return savedCopy; },
    get retries() { return server.on("POST /api/calendar/writes/refused-update/retry"); },
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

/** An invitation Exchange sent as an Outlook Web App link: no calendar part, the event is in the person's Microsoft calendar. */
const OWA_STUB = [
  "Microsoft Outlook Web Access:",
  "https://outlook.office365.com/owa/tenant.example/?itemid=AAMkADJh%2FTaHJ8AAV95f1jAAA%3D&exvsurl=1&path=/calendar/item",
  "",
  "To receive meeting invitations as .iCalendar attachments instead of Outlook Web App links, go to",
  "https://outlook.office365.com/owa/tenant.example/?path=/options/popandimap and select Send meeting invitations in iCalendar format.",
].join("\n");

it("an invitation that came as an Outlook Web App link shows its card and answers through the provider calendar", async () => {
  const result = await reader({ native: true, metadataOnly: true, text: OWA_STUB, place: "Room 4", title: "Quarterly planning, floor 3" });
  const { card } = result;
  expect(card.getByRole("heading", { name: "Quarterly planning, floor 3" })).toBeTruthy();
  expect(card.getByText(/is on Studio/)).toBeTruthy();
  expect(card.getByText("Room 4")).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Yes" }));
  await tick(1_000);
  expect(result.writes).toMatchObject([{ kind: "calendar_event_answer", eventId: nativeEvent.id, answer: "accepted" }]);
  expect(result.replies).toEqual([]);
});

const choices = [
  ["Yes", "accepted"], ["Maybe", "tentative"], ["No", "declined"],
] as const;

it.each(choices)("puts the self-hosted mail answer %s on the calendar copy", async (label, answer) => {
  const result = await reader({ selfhost: true, keepWrite: true });
  fireEvent.click(result.card.getByRole("button", { name: label }));
  await tick(1_200);
  expect(result.replies).toEqual([{ answer, basis: null }]);
  expect(result.writes).toMatchObject([{
    kind: "calendar_event_create", calendarId: studio.id, event: { busy: answer !== "declined", invitees: [] },
  }]);
  expect(result.card.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("true");
  expect(result.card.queryByRole("alert")).toBeNull();
  fireEvent.click(result.card.getByRole("button", { name: "Show in calendar" }));
  await tick(500);
  const opened = within(screen.getByRole("dialog", { name: "Quarterly planning" }));
  expect(opened.getByText(new RegExp(`you said ${label.toLowerCase()}`, "i"))).toBeTruthy();
  expect(opened.queryByText("to answer")).toBeNull();
});

it.each([
  ["older", { nativeSequence: 0 }],
  ["read-only", { nativeAccess: "reader" as const }],
  ["hidden", { nativeShown: false }],
] as const)("mails the answer without creating a duplicate when the provider calendar copy is %s", async (_case, provider) => {
  const result = await reader({
    selfhost: true, native: true, keepWrite: true, invitation: { ...asks, sequence: 1 }, ...provider,
  });
  fireEvent.click(result.card.getByRole("button", { name: "Yes" }));
  await tick(1_200);
  expect(result.replies).toEqual([{ answer: "accepted", basis: null }]);
  expect(result.writes).toEqual([]);
  expect(result.card.getByRole("button", { name: "Yes" }).getAttribute("aria-pressed")).toBe("true");
  expect(result.card.queryByRole("alert")).toBeNull();
  expect(result.card.queryByRole("button", { name: "Add to calendar" })).toBeNull();
});

it.each([
  ["Yes", "accepted", true],
  ["Maybe", "tentative", false],
] as const)("can answer %s from a letter whose read-only provider copy was declined", async (label, answer, writablePersonal) => {
  const result = await reader({
    selfhost: true, native: true, nativeAccess: "reader", nativeAnswer: "declined", writablePersonal,
  });
  fireEvent.click(result.card.getByRole("button", { name: label }));
  await tick(1_200);
  expect(result.replies).toEqual([{ answer, basis: null }]);
  expect(result.writes).toEqual([]);
  expect(result.card.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("true");
  expect(result.card.queryByRole("alert")).toBeNull();
  expect(result.card.queryByRole("button", { name: "Add to calendar" })).toBeNull();
});

it("offers calendar setup before any answer on a self-host without a connection", async () => {
  const result = await reader({ selfhost: true, connected: false });
  for (const [label] of choices) expect(result.card.queryByRole("button", { name: label })).toBeNull();
  fireEvent.click(result.card.getByRole("button", { name: "Connect a calendar" }));
  await tick(500);
  expect(location.hash).toContain("/calendars");
  expect(result.replies).toEqual([]);
  expect(result.writes).toEqual([]);
});

it.each(choices)("does not send a second reply when the connected calendar refuses %s", async (label) => {
  const result = await reader({ selfhost: true, native: true, refuseWrite: true });
  fireEvent.click(result.card.getByRole("button", { name: label }));
  await tick(1_200);
  expect(result.card.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("false");
  expect(result.replies).toEqual([]);
  expect(result.writes).toHaveLength(1);
});

it.each(choices)("explains the failed calendar filing after %s and can retry without sending", async (label, answer) => {
  const result = await reader({ selfhost: true, refuseWrite: true });
  fireEvent.click(result.card.getByRole("button", { name: label }));
  await tick(1_200);
  expect(result.card.getByText(/Your reply was sent. The event could not be added to your calendar./)).toBeTruthy();
  fireEvent.click(result.card.getByRole("button", { name: "Add to calendar" }));
  await tick(1_200);
  expect(result.replies).toEqual([{ answer, basis: null }]);
  expect(result.writes).toHaveLength(2);
});

it("adds an invitation that was already answered by mail without another reply", async () => {
  const result = await reader({ selfhost: true, keepWrite: true, invitation: {
    ...asks, answer: "accepted", answeredAt: ISO,
  } });
  expect(result.card.getByRole("button", { name: "Yes" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(result.card.getByRole("button", { name: "Add to calendar" }));
  await tick(1_200);
  expect(result.replies).toEqual([]);
  expect(result.writes).toMatchObject([{ kind: "calendar_event_create", calendarId: studio.id }]);
  expect(result.card.queryByRole("button", { name: "Add to calendar" })).toBeNull();
});

it.each(choices)("mails %s when the self-host has no calendar service", async (label, answer) => {
  const result = await reader({ selfhost: true, connected: false, calendarEnabled: false });
  expect(result.card.getByText(/Calendar is unavailable on this server/)).toBeTruthy();
  expect(result.card.queryByRole("button", { name: "Connect a calendar" })).toBeNull();
  fireEvent.click(result.card.getByRole("button", { name: label }));
  await tick(1_200);
  expect(result.replies).toEqual([{ answer, basis: null }]);
  expect(result.writes).toEqual([]);
  expect(result.card.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("true");
  expect(result.card.getByText(/Your reply was sent. The event could not be added to your calendar/)).toBeTruthy();
});

it("mails an answer when only the invitation metadata is available", async () => {
  const result = await reader({ selfhost: true, metadataOnly: true });
  expect(result.card.getByText(/event details needed to save this invitation/)).toBeTruthy();
  fireEvent.click(result.card.getByRole("button", { name: "Yes" }));
  await tick(1_200);
  expect(result.replies).toEqual([{ answer: "accepted", basis: null }]);
  expect(result.writes).toEqual([]);
  expect(result.card.getByText(/Your reply was sent. The event could not be added to your calendar/)).toBeTruthy();
});

it("retries a refused change to free time after reopening the reader, without replying again", async () => {
  const result = await reader({ selfhost: true, keepWrite: true, refuseUpdate: true });
  fireEvent.click(result.card.getByRole("button", { name: "Yes" }));
  await tick(1_200);
  fireEvent.click(result.card.getByRole("button", { name: "No" }));
  await tick(1_200);
  expect(result.replies).toEqual([
    { answer: "accepted", basis: null },
    { answer: "declined", basis: "accepted" },
  ]);
  expect(result.writes).toMatchObject([
    { kind: "calendar_event_create", event: { busy: true } },
    { kind: "calendar_event_update", change: { busy: false } },
  ]);
  expect(result.savedCopy).toMatchObject({ busy: true, mailAnswer: "declined", writes: [{ state: "refused" }] });

  closeMailPage();
  const reopened = await reader({
    selfhost: true, metadataOnly: true, copy: result.savedCopy,
    invitation: { ...asks, answer: "declined", answeredAt: ISO },
  });
  expect(reopened.card.getByText(/The change could not be saved to your calendar/)).toBeTruthy();
  fireEvent.click(reopened.card.getByRole("button", { name: "Retry calendar update" }));
  await tick(1_200);
  expect(reopened.replies).toEqual([]);
  expect(reopened.writes).toEqual([]);
  expect(reopened.retries).toHaveLength(1);
  expect(reopened.savedCopy).toMatchObject({ busy: false, mailAnswer: "declined", writes: [] });
  expect(reopened.card.queryByRole("button", { name: "Retry calendar update" })).toBeNull();
});

const filedInvitation = { ...asks, answer: "accepted", answeredAt: ISO } as const;
const filedEvent = event(asks.calendarEventId, "20261027", {
  title: "Quarterly planning", start: time("13"), end: time("14"), mailAnswer: "accepted",
});
const move: CalendarEventAct = {
  kind: "calendar_event_update", eventId: filedEvent.id, base: filedEvent.updatedAt,
  scope: { kind: "record" }, change: { start: time("15"), end: time("16") },
};

it.each(["pending", "refused"] as const)("leaves a %s calendar move out of the invitation reply", async (state) => {
  const result = await reader({
    selfhost: true, invitation: filedInvitation,
    copy: { ...filedEvent, writes: [{
      id: "calendar-move", key: "move-key", state, reason: state === "refused" ? "forbidden" : null,
      act: move, part: null, at: ISO,
    }] },
  });
  expect(result.card.queryByRole("button", { name: "Retry calendar update" })).toBeNull();
  expect(result.card.queryByRole("alert")).toBeNull();
  fireEvent.click(result.card.getByRole("button", { name: "Maybe" }));
  await tick(1_200);
  expect(result.replies).toEqual([{ answer: "tentative", basis: "accepted" }]);
  expect(result.retries).toEqual([]);
});

it.each(["version_stale", "earlier_refused"] as const)("explains a %s filing refusal without offering to replay it", async (reason) => {
  const act = {
    ...move, change: { busy: true }, invitationMessageId: "calendar-letter",
  };
  const result = await reader({
    selfhost: true, invitation: filedInvitation,
    copy: { ...filedEvent, writes: [{
      id: "refused-update", key: "update-key", state: "refused", reason, act, part: null, at: ISO,
    }] },
  });
  expect(result.card.getByText(/The change could not be saved to your calendar/)).toBeTruthy();
  expect(result.card.queryByRole("button", { name: "Retry calendar update" })).toBeNull();
});
