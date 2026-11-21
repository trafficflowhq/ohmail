/** @vitest-environment jsdom */
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import type { CalendarEventAct, CalendarEventRecord, CalendarSuggestionRecord } from "@ohmail/wire";
import { calendarRecord, connectionRecord } from "../../../packages/app/test/calsetup/world.js";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { clickMounted, withMountedSender } from "./fixtures/mounted-sender-sheet.js";
import { ISO, act, tick, warmScreeningWeb } from "./fixtures/screening-web.js";

const from = personalAt("fixture.ada", "sender.example");
const start = { kind: "instant" as const, value: "20260910T160000Z" };
const invitation: CalendarEventRecord = {
  id: "invitation", calendarId: "cal-1", uid: "invitation", recurrenceId: "",
  thisAndFuture: false, sequence: 0, status: "confirmed", title: "Tech check",
  notes: null, place: null, callLink: null, start, end: { ...start, value: "20260910T170000Z" },
  duration: null, startsAt: "2026-09-10T16:00:00Z", endsAt: "2026-09-10T17:00:00Z",
  occurrenceAt: null, repeat: null, busy: true, private: false, organizer: { address: from, name: "Ada" },
  myAnswer: "none", heldBack: false, invitees: [], alarms: [], cut: false, writes: [], updatedAt: ISO,
};
const suggestion: CalendarSuggestionRecord = {
  id: "suggestion", messageId: "current-letter", mailboxId: "mb_1", evidence: "calendar",
  proposed: { title: "From the letter", start: { ...start, value: "20260911T140000Z" },
    end: { ...start, value: "20260911T150000Z" }, place: null },
  sourceWords: null, createdAt: ISO, updatedAt: ISO,
};

function calendarAnswer(path: string) {
  if (path === "/api/hello") return Response.json({ product: "ohmail", flavor: "managed", needsSetup: false, features: { calendar: true } });
  if (path === "/api/calendar/settings") return Response.json({
    enabledAt: ISO, newEventsCalendarId: "cal-1", secondZone: null, weekNumbers: false,
    dayFromMinute: null, dayToMinute: null,
  });
}

function calendarWrites(creates: CalendarEventAct[]) {
  return (path: string, _query: URLSearchParams, method: string, init?: RequestInit) => {
    if (path !== "/api/calendar/writes" || method !== "POST") return calendarAnswer(path);
    creates.push(JSON.parse(String(init?.body)) as CalendarEventAct);
    return Response.json({ write: null, events: [] });
  };
}

async function startEvent(sheet: ReturnType<typeof within>, title: string) {
  await clickMounted(sheet.getByRole("menuitem", { name: "New event" }));
  await tick(500);
  await act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: "Event title" }), { target: { value: title } });
  });
  return within(screen.getByRole("dialog", { name: "New event" }));
}

const records = {
  settings: { id: "settings", calendarEnabledAt: ISO },
  calendar_connection: connectionRecord(),
  calendar: calendarRecord(),
  calendar_event: invitation,
  calendar_suggestion: suggestion,
};
const extraSync = Object.entries(records).map(([type, entity]) => ({
  type, entity, id: entity.id, op: "create", updatedAt: ISO,
}));

beforeAll(warmScreeningWeb, 120_000);

describe("the calendar on a contact card", () => {
  it("adds an event from the contact without sending an invitation", async () => {
    const creates: CalendarEventAct[] = [];
    await withMountedSender(async ({ sheet }) => {
      const editor = await startEvent(sheet, "A private appointment");
      expect(editor.getByRole("button", { name: "Invite Ada" })).toBeTruthy();
      await clickMounted(editor.getByRole("button", { name: "Add" }));
      await tick(1000);
      expect(creates).toEqual([expect.objectContaining({
        kind: "calendar_event_create", event: expect.objectContaining({ title: "A private appointment", invitees: [] }),
      })]);
    }, { extraSync, rules: ["INBOX"], answer: calendarWrites(creates) });
  });

  it("sends an invitation only after Invite and the separate confirmation", async () => {
    const creates: CalendarEventAct[] = [];
    await withMountedSender(async ({ sheet, sender }) => {
      const editor = await startEvent(sheet, "A planning appointment");
      await clickMounted(editor.getByRole("button", { name: "Invite Ada" }));
      expect(editor.getByText("Guest: Ada")).toBeTruthy();
      expect(creates).toEqual([]);
      await clickMounted(editor.getByRole("button", { name: "Add" }));
      await tick(500);
      const confirmation = () => within(screen.getByRole("dialog", { name: /Send an invitation to Ada/ }));
      expect(creates).toEqual([]);
      await clickMounted(confirmation().getByRole("button", { name: "Cancel" }));
      await tick(500);
      expect(creates).toEqual([]);
      expect(screen.queryByRole("dialog", { name: /Send an invitation to Ada/ })).toBeNull();
      await clickMounted(editor.getByRole("button", { name: "Add" }));
      await clickMounted(confirmation().getByRole("button", { name: "Send invitation" }));
      await tick(1000);
      expect(creates).toEqual([expect.objectContaining({
        kind: "calendar_event_create",
        event: expect.objectContaining({ title: "A planning appointment", invitees: [
          { address: sender, name: "Ada", role: "required" },
        ] }),
      })]);
    }, { extraSync, rules: ["INBOX"], answer: calendarWrites(creates) });
  });

  it("keeps counts, placement, audit and mail-derived events in the clicked mailbox", async () => {
    const otherSuggestion = {
      ...suggestion, id: "other-suggestion", messageId: "other-mailbox-letter", mailboxId: "mb_2",
      proposed: { ...suggestion.proposed, title: "An event from the other mailbox" },
    };
    await withMountedSender(async ({ sheet }) => {
      expect.soft(sheet.getByRole("radio", { name: /^This address/ }).textContent).toContain("1 message");
      expect.soft(sheet.getByRole("radio", { name: /^Everyone at/ }).textContent).toContain("1 message · 1 sender");
      const placement = sheet.getByText(/^Now in/);
      expect.soft(placement.textContent).toBe("Now in Ohbox");
      expect.soft(placement.getAttribute("aria-description")).toBe("1 message — now in Ohbox");
      expect.soft(sheet.getByText("From the letter")).toBeTruthy();
      expect.soft(sheet.queryByText("An event from the other mailbox")).toBeNull();
      await clickMounted(sheet.getByRole("button", { name: /^See all/ }));
      const audit = within(screen.getByRole("dialog"));
      expect.soft(audit.getByText("A note from Ada")).toBeTruthy();
      expect.soft(audit.queryByText("From the other mailbox")).toBeNull();
    }, {
      answer: calendarAnswer, rules: ["INBOX"], secondMailbox: true,
      extraSync: [...extraSync, { type: "calendar_suggestion", entity: otherSuggestion, id: otherSuggestion.id, op: "create", updatedAt: ISO }],
    });
  });

  it("shows the calendar actions only when the account has a calendar", async () => {
    await withMountedSender(async ({ sheet }) => {
      expect(sheet.queryByRole("heading", { name: "Coming up" })).toBeNull();
      expect(sheet.queryByRole("menuitem", { name: "All events" })).toBeNull();
      expect(sheet.queryByRole("menuitem", { name: "New event" })).toBeNull();
    });
  });

  for (const [label, route, actionRole] of [
    [/Tech check.*To answer/i, /#\/cal\/week\/2026-09-10\/e\/invitation/, "button"],
    [/From the letter.*From mail/i, /#\/cal\/from-mail\/e\/suggestion/, "button"],
    ["All events", /#\/cal\/find/, "menuitem"],
    ["New event", /#\/cal\/week\?panel=new/, "menuitem"],
  ] as const) {
    it(`opens the calendar's existing action for ${label}`, async () => {
      await withMountedSender(async ({ sheet }) => {
        expect(sheet.getByRole("heading", { name: "Coming up" })).toBeTruthy();
        await clickMounted(sheet.getByRole(actionRole, { name: label }));
        await tick(500);
        expect(window.location.hash).toMatch(route);
        if (label === "New event") expect(screen.getByRole("button", { name: "Invite Ada" })).toBeTruthy();
      }, { answer: calendarAnswer, extraSync, rules: ["INBOX"] });
    });
  }
});

describe("the mail links on a contact card", () => {
  it("goes to the address place for the contact", async () => {
    await withMountedSender(async ({ sheet, sender, id }) => {
      await clickMounted(sheet.getByRole("menuitem", { name: "All mail" }));
      expect(window.location.hash).toBe(`#/address/${encodeURIComponent(sender)}/m/${id}`);
    });
  });

  it("opens Write addressed to the contact", async () => {
    await withMountedSender(async ({ sheet, sender }) => {
      await clickMounted(sheet.getByRole("menuitem", { name: "Write" }));
      await tick(500);
      expect(window.location.hash).toBe("#/compose");
      const letter = within(screen.getByRole("region", { name: "New message" }));
      expect(letter.getByRole("button", { name: (name) => name.startsWith("Ada") && name.includes(sender) })).toBeTruthy();
    });
  });
});
